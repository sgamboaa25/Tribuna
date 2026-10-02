const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// El aviso de cookies decide qué terceros cargan. Todo lo que se carga antes
// del permiso es una infracción, así que la lógica se aísla aquí y se ejecuta
// en un sandbox: si alguien vuelve a atar los visores a "Aceptar todas", o
// muta CONSENT_NONE por accidente, revienta este test.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SCRIPT = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
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
  return SCRIPT.slice(i, eq + 1) + cutBalanced(SCRIPT, eq + 1);
}

// Para valores escalares (cutBalanced solo sirve con llaves/parentesis).
function extractScalar(name) {
  const i = SCRIPT.search(new RegExp('const\\s+' + name + '\\s*='));
  if (i === -1) throw new Error('no existe const ' + name);
  return SCRIPT.slice(i, SCRIPT.indexOf(';', i) + 1);
}

const SOURCE = [
  extractScalar('COOKIE_CONSENT_VERSION'),
  extractConst('CONSENT_ALL'),
  extractConst('CONSENT_NONE'),
  extractConst('CONSENT_OPTIONS'),
  extractFunction('setCheckboxes'),
  extractFunction('readCheckboxes'),
  extractFunction('grantConsentFor'),
  // Las const de un script no quedan en el global del sandbox: se copian a un
  // var para poder comprobar que CONSENT_NONE sigue intacto.
  'var EXPOSED = { CONSENT_ALL, CONSENT_NONE, CONSENT_OPTIONS };'
].join('\n\n');

// Un DOM mínimo: solo las tres casillas del aviso.
function fakeDom(marks = {}) {
  const els = {
    optAdvertising: { checked: !!marks.advertising },
    optAnalytics: { checked: !!marks.analytics },
    optEmbeds: { checked: !!marks.embeds }
  };
  return { els, getElementById: (id) => els[id] || null };
}

// Los objetos del vm tienen prototipos de otro realm, así que deepStrictEqual
// los rechaza por referencia de prototipo aunque sean iguales. Se pasan por
// JSON para compararlos en el realm del test.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Estado real de las tres casillas, en un array de este realm.
function checked(s) {
  return Array.from(s.EXPOSED.CONSENT_OPTIONS, (o) => s.document.getElementById(o.el).checked);
}

function consentSandbox({ stored = null, marks = {} } = {}) {
  const calls = { set: [], apply: [] };
  const sandbox = {
    console,
    document: fakeDom(marks),
    currentConsent: () => stored,
    setConsent: (c) => { stored = c; calls.set.push(c); },
    applyConsent: (c) => { calls.apply.push(c); }
  };
  vm.runInNewContext(SOURCE, sandbox);
  sandbox.__calls = calls;
  sandbox.__stored = () => stored;
  return sandbox;
}

test('consentimiento: el aviso ofrece una casilla por finalidad, no un solo interruptor', () => {
  const s = consentSandbox();
  // Publicidad, medición y visores son finalidades distintas. Si esta lista
  // pierde un elemento o gana otro, la casilla correspondiente se queda sin
  // gatear su tercero.
  assert.deepEqual(
    Array.from(s.EXPOSED.CONSENT_OPTIONS, (o) => o.key),
    ['advertising', 'analytics', 'embeds']
  );
  assert.deepEqual(
    Array.from(s.EXPOSED.CONSENT_OPTIONS, (o) => o.el),
    ['optAdvertising', 'optAnalytics', 'optEmbeds']
  );
});

test('consentimiento: marcar solo visores concede visores y nada más', () => {
  const s = consentSandbox({ marks: { embeds: true } });
  const c = s.readCheckboxes();
  // Esta es la garantía de fondo del art. 4.11 del RGPD: el consentimiento es
  // específico por finalidad. Ver un post de X no puede arrastrar publicidad.
  assert.equal(c.embeds, true);
  assert.equal(c.advertising, false);
  assert.equal(c.analytics, false);
  assert.equal(c.version, 2);
});

test('consentimiento: sin casillas marcadas no se concede nada', () => {
  const s = consentSandbox();
  const c = s.readCheckboxes();
  assert.equal(c.advertising, false);
  assert.equal(c.analytics, false);
  assert.equal(c.embeds, false);
  // Una casilla que no existe no puede concederse por descuido.
  const c2 = Object.assign({}, c);
  assert.equal(Object.keys(c2).length, 4);
});

test('consentimiento: reabrir el aviso muestra lo ya decidido, no un formulario en blanco', () => {
  const s = consentSandbox();
  // Alguien que ya aceptó las tres vuelve a abrir preferencias: deben verse
  // marcadas las que aprobó, o borraría su decisión sin querer.
  s.setCheckboxes(s.EXPOSED.CONSENT_ALL);
  assert.deepEqual(
    checked(s),
    [true, true, true]
  );
  // Y el round-trip: lo marcado es exactamente lo que se guarda.
  assert.deepEqual(plain(s.readCheckboxes()), plain(s.EXPOSED.CONSENT_ALL));
});

test('consentimiento: una casilla desmarcada se respeta al reabrir', () => {
  const s = consentSandbox();
  const previo = { version: 2, advertising: false, analytics: true, embeds: false };
  s.setCheckboxes(previo);
  assert.deepEqual(
    checked(s),
    [false, true, false]
  );
});

test('consentimiento: "Ver la publicación" enciende visores sin encender publicidad', () => {
  const s = consentSandbox();
  s.grantConsentFor('embeds');
  const guardado = s.__stored();
  assert.equal(guardado.embeds, true);
  assert.equal(guardado.advertising, false);
  assert.equal(guardado.analytics, false);
  // Y se aplica: es lo que dispara el montaje del embed.
  assert.equal(s.__calls.apply.length, 1);
  assert.equal(s.__calls.apply[0].embeds, true);
});

test('consentimiento: conceder visores conserva lo que ya se había aceptado', () => {
  const previo = { version: 2, advertising: true, analytics: false, embeds: false };
  const s = consentSandbox({ stored: previo });
  s.grantConsentFor('embeds');
  const guardado = s.__stored();
  // No se toca la publicidad que ya estaba autorizada.
  assert.equal(guardado.advertising, true);
  assert.equal(guardado.analytics, false);
  assert.equal(guardado.embeds, true);
  // Y no muta el objeto previo.
  assert.equal(previo.embeds, false);
});

test('consentimiento: conceder visores a un visitante nuevo no contamina "Rechazar todas"', () => {
  const s = consentSandbox();
  s.grantConsentFor('embeds');
  // Regression: grantConsentFor llegaba a mutar la constante CONSENT_NONE, con
  // lo que "Rechazar todas" empezaba a encender visores en el resto de la
  // sesión. Se comprueba contra la constante, no contra un objeto aparte.
  assert.deepEqual(
    plain(s.EXPOSED.CONSENT_NONE),
    { version: 2, advertising: false, analytics: false, embeds: false }
  );
  s.setCheckboxes(s.EXPOSED.CONSENT_NONE);
  assert.deepEqual(
    checked(s),
    [false, false, false]
  );
});