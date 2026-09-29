const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHARE_PLUGIN = fs.readFileSync(path.join(ROOT, 'public', 'plugins', 'share.js'), 'utf8');
const INLINE = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');

function cutBalanced(src, from) {
  let depth = 0;
  let started = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '[' || c === '(') { depth++; started = true; }
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (started && depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error('bloque sin cerrar');
}

// El registro y el plugin se ejecutan de verdad, no se reimplementan: si el
// código de index.html o de share.js cambia, el test mide lo quechanged.
const REGISTRY_SRC = (() => {
  const at = INLINE.indexOf('window.TribunaPlugins =');
  if (at === -1) throw new Error('index.html no define window.TribunaPlugins');
  const brace = INLINE.indexOf('{', at);
  // El largo que devuelve cutBalanced es relativo a la llave, asi que hay que
  // concatenar el prefijo con el objeto, no sumar los indices.
  return INLINE.slice(at, brace) + cutBalanced(INLINE, brace);
})();

function makeSandbox() {
  const elements = new Map();
  const sandbox = {
    console,
    // Sin navigator.share: es el caso de escritorio, donde los botones de cada
    // red se quedan visibles.
    navigator: { share: undefined, clipboard: { writeText: () => Promise.resolve() } },
    document: {
      querySelector(sel) {
        if (!elements.has(sel)) {
          elements.set(sel, {
            href: '',
            style: {},
            dataset: {},
            attrs: {},
            classList: { add() {}, remove() {} },
            setAttribute(k, v) { this.attrs[k] = v; },
            addEventListener() {}
          });
        }
        return elements.get(sel);
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, elements };
}

const CTX = {
  noteUrl: (n) => `https://tribuna.test/nota/${n.id}`,
  siteUrl: () => 'https://tribuna.test/',
  escapeHtml: (s) => String(s)
};

function boot(plugins = []) {
  const { sandbox, elements } = makeSandbox();
  vm.runInContext(REGISTRY_SRC, sandbox);
  for (const src of plugins) vm.runInContext(src, sandbox);
  return { registry: sandbox.TribunaPlugins, sandbox, elements };
}

test('plugins: el registro acepta, lista y arranca plugins', () => {
  const { registry } = boot();
  let arrancado = false;
  registry.register('demo', { start() { arrancado = true; } });

  assert.equal(registry.get('demo').start !== undefined, true);
  // El array viene del vm y su prototipo es de otro realm: se copia con spread
  // para que deepStrictEqual no falle por eso y no por el contenido.
  assert.deepEqual([...registry.list()], ['demo']);

  registry.start(CTX);
  assert.equal(arrancado, true);
});

test('plugins: un plugin que revienta no impide que arranquen los demas', () => {
  const { registry, sandbox } = boot();
  let llegoAlUltimo = false;
  registry.register('roto', {
    start() { throw new Error('boom'); }
  });
  registry.register('sano', { start() { llegoAlUltimo = true; } });

  registry.start(CTX);
  assert.equal(llegoAlUltimo, true, 'el plugin sano debio arrancar igual');
});

test('plugins: registrar sin nombre o sin objeto no rompe el registro', () => {
  const { registry } = boot();
  registry.register('', { start() {} });
  registry.register('vacio', null);
  assert.deepEqual([...registry.list()], []);
});

test('share: el enlace usa la URL de la nota, no la de la barra de direcciones', () => {
  const { registry, elements } = boot([SHARE_PLUGIN]);
  registry.start(CTX);
  const share = registry.get('share');
  assert.ok(share, 'el plugin share deberia estar registrado');

  share.setNote({ id: 'abc-123', title: 'Bryan Ruiz vuelve' }, CTX);
  const st = share.getState();

  // Esta es la regresion que fija el test: al abrir una nota desde la portada,
  // location.href sigue siendo la portada, y se compartia el link equivocado.
  assert.equal(st.url, 'https://tribuna.test/nota/abc-123');
  assert.ok(!st.url.includes('#note-'), 'no debe usar el ancla vieja');
  assert.ok(!st.url.endsWith('/'), 'no debe quedarse en la raiz');

  // Los href van percent-encoded, que es lo correcto para un parametro de query:
  // se comparan ya decodificados, que es lo que ve el sitio destino.
  for (const red of ['wa', 'x', 'fb']) {
    const seen = decodeURIComponent(st.links[red]);
    assert.ok(seen.includes('/nota/abc-123'), `${red} debe llevar la nota, no la portada`);
    assert.ok(!seen.includes('#note-'), `${red} no debe llevar el ancla`);
  }
  assert.ok(decodeURIComponent(st.links.wa).includes('Bryan Ruiz vuelve'), 'WhatsApp debe llevar el titulo');

  for (const sel of ['#shareWa', '#shareX', '#shareFb']) {
    assert.ok(
      decodeURIComponent(elements.get(sel).href).includes('/nota/abc-123'),
      `${sel} en el DOM debe apuntar a la nota`
    );
  }
});

test('share: al volver a la portada se limpia el enlace de la nota anterior', () => {
  const { registry, elements } = boot([SHARE_PLUGIN]);
  registry.start(CTX);
  const share = registry.get('share');

  share.setNote({ id: 'abc-123', title: 'Una nota' }, CTX);
  share.setNote(null, CTX);

  assert.equal(share.getState().url, 'https://tribuna.test/');
  const href = decodeURIComponent(elements.get('#shareWa').href);
  assert.ok(href.includes('https://tribuna.test/'), 'debe apuntar a la portada');
  assert.ok(!href.includes('abc-123'), 'no debe quedar la nota anterior');
});

test('share: los botones_native se esconden si no hay Web Share API', () => {
  const { registry, elements } = boot([SHARE_PLUGIN]);
  registry.start(CTX);
  assert.equal(elements.get('#shareNative').style.display, 'none');
});

test('share: el titulo va escapado, no se rompe la query ni se inyecta markup', () => {
  const { registry } = boot([SHARE_PLUGIN]);
  registry.start(CTX);
  const share = registry.get('share');

  share.setNote({ id: 'x1', title: 'Colón & "quotes" <b>' }, CTX);
  const st = share.getState();

  // Nunca < ni > crudos: permitirian inyectar markup en el destino. El & si
  // aparece, pero unicamente como separador entre parametros, que es legitimo.
  for (const red of ['wa', 'x', 'fb']) {
    assert.ok(!/[<>]/.test(st.links[red]), `${red} tiene angulares sin escapar: ${st.links[red]}`);
  }
  // El & del titulo tiene que haber quedado %26, no un separador accidental.
  assert.ok(st.links.wa.includes('%26'), 'el ampersand del titulo debe quedar %26');
  // Un solo & en X: el que separa text de url.
  assert.equal((st.links.x.match(/&/g) || []).length, 1, 'X debe tener un solo separador');
  assert.ok(st.links.x.includes('%3Cb%3E'), 'los angulares deben quedar escapados');
});

test('share: no quedan restos del cableado viejo en index.html', () => {
  // El comportamiento viejo vivia en index.html con location.href. Si alguien
  // lo restaura, el enlace vuelve a compartir la portada.
  assert.ok(!INLINE.includes('currentShareUrl'), 'sobro currentShareUrl');
  assert.ok(!INLINE.includes('setupShare'), 'sobro setupShare');
  assert.ok(!INLINE.includes('twitter.com/intent'), 'sobro el enlace a X escrito a mano');
});
