const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SCRIPT = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');

// Corta un bloque contando llaves, no por indentacion: si alguien reindenta el
// panel, este test sigue funcionando en vez de romperse en silencio.
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
  throw new Error('bloque sin cerrar desde ' + from);
}

function extractFunction(name) {
  const i = SCRIPT.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('no existe function ' + name);
  const body = cutBalanced(SCRIPT, SCRIPT.indexOf('{', i));
  return SCRIPT.slice(i, SCRIPT.indexOf(body) + body.length);
}

function extractConst(name) {
  const i = SCRIPT.search(new RegExp('const\\s+' + name + '\\s*='));
  if (i === -1) throw new Error('no existe const ' + name);
  const eq = SCRIPT.indexOf('=', i);
  const end = cutBalanced(SCRIPT, eq + 1);
  return SCRIPT.slice(i, eq + 1) + end;
}

function extractElementConst(name) {
  const i = SCRIPT.search(new RegExp('const\\s+' + name + '\\s*='));
  if (i === -1) throw new Error('no existe const ' + name);
  return SCRIPT.slice(i, SCRIPT.indexOf(';', i) + 1);
}

// ---- DOM minimo, solo lo que el panel de rumores llega a tocar ---------
// className y classList son la misma cosa en un DOM real, asi que el stub
// los sincroniza; si no, el Set solo reflejaria classList.add.
function makeNode(tag) {
  const node = {
    tagName: tag,
    textContent: '',
    children: [],
    classes: new Set(),
    classList: {
      add(...c) { c.forEach((x) => node.classes.add(x)); node.className = [...node.classes].join(' '); }
    },
    append(...kids) { kids.forEach((k) => node.children.push(k)); },
    appendChild(k) { node.children.push(k); return k; },
    replaceChildren(...kids) { node.children = kids; },
    set innerHTML(v) { node._html = v; }, get innerHTML() { return node._html; },
    addEventListener() {}, scrollIntoView() {}
  };
  Object.defineProperty(node, 'className', {
    get() { return [...node.classes].join(' '); },
    set(v) { node.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  return node;
}

const RUMOR_SOURCE = [
  extractConst('RUMOR_STATE_LABEL'),
  extractFunction('timeAgo'),
  extractElementConst('rumorManagerListEl'),
  extractElementConst('rumorFormEl'),
  extractFunction('renderRumorManager')
].join('\n\n');

const haceDias = (n) => new Date(Date.now() - n * 86400000).toISOString();

// Devuelve las filas ya dibujadas, con los nodos常用 reexpuestos para assertar.
function renderRumors(rumors) {
  const byId = {};
  const sandbox = {
    console,
    document: {
      createElement: (t) => makeNode(t),
      getElementById: (id) => (byId[id] = byId[id] || makeNode('div'))
    },
    setRumorForm() {}, deleteRumor() {},
    Date, Math, Number, Object, Array, String, Boolean
  };
  vm.runInNewContext(RUMOR_SOURCE, sandbox);
  sandbox.allPanelRumors = rumors;
  sandbox.renderRumorManager();
  const list = byId['rumorManagerList'];
  assert.ok(list, 'rumorManagerList no se encontro en el DOM');
  return list.children.map((row) => {
    // El estado vacio no es una fila de rumor: solo lleva el div con su
    // innerHTML, asi que se devuelve marcado como tal.
    if (row.children.length < 2) return { vacio: true, clases: row.classes, html: row.innerHTML };
    const text = row.children[0];
    const name = text.children[0];
    return {
      vacio: false,
      clases: row.classes,
      nombre: name.textContent,
      badges: name.children,
      meta: text.children[1],
      notaAntiguedad: text.children[1].children.find((c) => c.tagName === 'span') || null
    };
  });
}

const RUMOR = (extra) => ({
  jugador: 'X', estado: 'rumor', veracidad: 50, fuente: 'BBC', activo: true,
  updated_at: haceDias(1), desactualizado: 0,
  origen: { nombre: 'A' }, destino: { nombre: 'B' }, ...extra
});

test('panel de rumores: dibuja una fila por rumor y no revienta', () => {
  // Regresión: RUMOR_STATE_LABEL se usaba sin estar definida y el ReferenceError
  // abortaba el forEach antes de append, dejando la lista en blanco.
  const filas = renderRumors([RUMOR({}), RUMOR({ jugador: 'Y' })]);
  assert.equal(filas.length, 2);
  assert.deepEqual(filas.map((f) => f.nombre), ['X', 'Y']);
  for (const f of filas) assert.ok(f.badges.length > 0, 'la fila debe llevar su pastilla de estado');
});

test('panel de rumores: cada estado sale con su etiqueta y su clase', () => {
  const filas = renderRumors([
    RUMOR({ estado: 'rumor' }),
    RUMOR({ estado: 'avanzado' }),
    RUMOR({ estado: 'confirmado' }),
    RUMOR({ estado: 'descartado' })
  ]);
  assert.deepEqual(
    filas.map((f) => [f.badges[0].textContent, f.badges[0].className]),
    [
      ['Rumor', 'status-badge status-rumor'],
      ['Negociación avanzada', 'status-badge status-avanzado'],
      ['Confirmado', 'status-badge status-confirmado'],
      ['Descartado', 'status-badge status-descartado']
    ]
  );
});

test('panel de rumores: el estado desconocido cae a la etiqueta cruda', () => {
  // El server no deja pasar un estado fuera de lista, pero si llegara uno el
  // panel no debe romperse ni quedarse sin texto.
  const filas = renderRumors([RUMOR({ estado: 'inventado' })]);
  assert.equal(filas[0].badges[0].textContent, 'inventado');
  assert.equal(filas[0].badges[0].className, 'status-badge status-inventado');
});

test('panel de rumores: la antigüedad se marca con el filo, no con otra pastilla', () => {
  const filas = renderRumors([
    RUMOR({ jugador: 'Fresco', desactualizado: 0 }),
    RUMOR({ jugador: 'Viejo', desactualizado: 1 }),
    RUMOR({ jugador: 'Muerto', desactualizado: 2 })
  ]);
  // El render reordena por nivel, asi que se busca por nombre y no por posicion.
  const por = (n) => filas.find((f) => f.nombre === n);
  assert.equal(por('Fresco').clases.has('rumor-stale'), false);
  assert.equal(por('Fresco').clases.has('rumor-stale-critical'), false);
  assert.equal(por('Viejo').clases.has('rumor-stale'), true);
  assert.equal(por('Viejo').clases.has('rumor-stale-critical'), false);
  assert.equal(por('Muerto').clases.has('rumor-stale-critical'), true);
  // Todas siguen siendo .draft-item, que es lo que aporta el borde y el padding.
  for (const f of filas) assert.ok(f.clases.has('draft-item'));
  assert.equal(por('Fresco').badges.length, 1, 'la fila al día no lleva badges extra');
});

test('panel de rumores: el aviso de antigüedad solo va en los abiertos', () => {
  const filas = renderRumors([
    RUMOR({ jugador: 'Viejo', desactualizado: 1, updated_at: haceDias(45) }),
    RUMOR({ jugador: 'Descartado', estado: 'descartado', desactualizado: 0, updated_at: haceDias(300) })
  ]);
  const por = (n) => filas.find((f) => f.nombre === n);
  const viejo = por('Viejo');
  const descartado = por('Descartado');
  assert.match(viejo.notaAntiguedad.textContent, /^ · Sin revisar hace /);
  assert.ok(viejo.notaAntiguedad.className.includes('rumor-age'));
  assert.equal(descartado.notaAntiguedad, null, 'un rumor cerrado no avisa de su edad');
});

test('panel de rumores: el orden pone arriba lo que hay que decidir', () => {  // Ordenar solo por fecha sacaba arriba un descartado de hace un año y tapaba
  // los rumors abiertos que sí exigen una decisión.
  const filas = renderRumors([
    RUMOR({ jugador: 'Cerrado viejo', estado: 'descartado', desactualizado: 0, updated_at: haceDias(300) }),
    RUMOR({ jugador: 'Fresco', desactualizado: 0, updated_at: haceDias(2) }),
    RUMOR({ jugador: 'Viejo', desactualizado: 1, updated_at: haceDias(45) }),
    RUMOR({ jugador: 'Muerto', desactualizado: 2, updated_at: haceDias(200) })
  ]);
  assert.deepEqual(
    filas.map((f) => f.nombre),
    ['Muerto', 'Viejo', 'Fresco', 'Cerrado viejo']
  );
});

test('panel de rumores: a igualdad va el más antiguo primero', () => {
  const filas = renderRumors([
    RUMOR({ jugador: 'Reciente', desactualizado: 1, updated_at: haceDias(40) }),
    RUMOR({ jugador: 'Antiguo', desactualizado: 1, updated_at: haceDias(55) })
  ]);
  assert.deepEqual(filas.map((f) => f.nombre), ['Antiguo', 'Reciente']);
});

test('panel de rumores: un rumor inactivo conserva la pastilla Oculto', () => {
  const [f] = renderRumors([RUMOR({ activo: false, desactualizado: 2 })]);
  const oculto = f.badges.find((b) => b.className === 'status-badge status-archived');
  assert.ok(oculto, 'falta la pastilla "Oculto"');
  assert.equal(oculto.textContent, 'Oculto');
});

test('panel de rumores: sin rumores muestra el estado vacio', () => {
  const filas = renderRumors([]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].vacio, true);
  assert.ok(filas[0].clases.has('draft-item'));
  assert.match(filas[0].html, /Sin rumores todav/);
});
