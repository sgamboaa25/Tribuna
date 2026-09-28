const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function extractElementConst(name) {
  const i = SCRIPT.search(new RegExp('const\\s+' + name + '\\s*='));
  if (i === -1) throw new Error('no existe const ' + name);
  return SCRIPT.slice(i, SCRIPT.indexOf(';', i) + 1);
}

const escapeHtml = extractFunction('escapeHtml');

const TAGS_SOURCE = [
  extractFunction('normalizeStr'),
  extractFunction('noteTagList'),
  extractFunction('tagSlug'),
  extractFunction('noteHasTag'),
  extractConst('INTERNAL_TAGS')
].join('\n\n');

function tagsSandbox() {
  const sandbox = { escapeHtml };
  vm.runInNewContext(TAGS_SOURCE, sandbox);
  return sandbox;
}

test('etiquetas: el campo tags se parte por comas, punto y coma y saltos de linea', () => {
  const s = tagsSandbox();
  assert.deepEqual([...s.noteTagList({ tags: 'Municipal, Saprissa' })], ['Municipal', 'Saprissa']);
  assert.deepEqual([...s.noteTagList({ tags: 'A; B\nC' })], ['A', 'B', 'C']);
  // Sin etiquetas, o con separadores de sobra: lista vacía, no entradas fantasma.
  assert.deepEqual([...s.noteTagList({ tags: ' , ; ' })], []);
  assert.deepEqual([...s.noteTagList({})], []);
  assert.deepEqual([...s.noteTagList(null)], []);
});

test('etiquetas: el slug ignora acentos, mayusculas y signos', () => {
  const s = tagsSandbox();
  assert.equal(s.tagSlug('Puntarenas FC'), 'puntarenas-fc');
  assert.equal(s.tagSlug('Atlético'), 'atletico');
  assert.equal(s.tagSlug('  ¡Ya es hora!  '), 'ya-es-hora');
  assert.equal(s.tagSlug('---'), '');
  assert.equal(s.tagSlug('???'), '');
});

test('etiquetas: noteHasTag compara por slug, no por substring', () => {
  const s = tagsSandbox();
  const note = { tags: 'Municipal, Saprissa' };
  assert.equal(s.noteHasTag(note, 'municipal'), true);
  assert.equal(s.noteHasTag(note, 'saprissa'), true);
  // El bug que se quiere evitar: "muni" como prefijo de "municipal".
  assert.equal(s.noteHasTag(note, 'muni'), false);
  assert.equal(s.noteHasTag(note, 'alajuelense'), false);
});

// El código público del mercado se extrae y se ejecuta aparte del panel, que
// ya tiene su propio test. Lo que se comprueba aquí es la regla editorial: la
// veracidad se pinta como barra acotada y el estado como pastilla.
const MERCADO_SOURCE = [
  extractFunction('escapeHtml'),
  extractFunction('timeAgo'),
  extractConst('RUMOR_STATE_LABEL'),
  extractFunction('mercadoClubHTML'),
  extractFunction('mercadoCrestHTML'),
  extractFunction('mercadoRowHTML')
].join('\n\n');

function mercadoSandbox() {
  const sandbox = { String, Number, Math, Date };
  vm.runInNewContext(MERCADO_SOURCE, sandbox);
  return sandbox;
}

test('mercado: acota la veracidad al 0-100 antes de ponerla en el ancho de la barra', () => {
  const s = mercadoSandbox();
  // Una barra con width:400% se saldría de la fila: el dato llega de la
  // redacción, pero el ancho se calcula en el cliente.
  assert.ok(s.mercadoRowHTML({ veracidad: 400 }).includes('width:100%'));
  assert.ok(s.mercadoRowHTML({ veracidad: -20 }).includes('width:0%'));
  assert.ok(s.mercadoRowHTML({ veracidad: 65 }).includes('width:65%'));
  // Sin veracidad o con basura: 0, no NaN (que rompería el style).
  assert.ok(s.mercadoRowHTML({}).includes('width:0%'));
  assert.ok(s.mercadoRowHTML({ veracidad: 'abc' }).includes('width:0%'));
});

test('mercado: el estado sale con su etiqueta de RUMOR_STATE_LABEL', () => {
  const s = mercadoSandbox();
  assert.ok(s.mercadoRowHTML({ estado: 'confirmado' }).includes('Confirmado'));
  assert.ok(s.mercadoRowHTML({ estado: 'avanzado' }).includes('Negociación avanzada'));
  // Estado ausente: rumor por defecto, igual que el servidor.
  assert.ok(s.mercadoRowHTML({}).includes('status-badge status-rumor'));
  assert.ok(s.mercadoRowHTML({}).includes('>Rumor<'));
});

test('mercado: un estado desconocido no puede inyectar HTML en el class', () => {
  const s = mercadoSandbox();
  // El estado va dentro de class="...", sin escapar. Si se interpolara tal cual,
  // un valor con comillas cerraría el atributo y el resto se pintaría como HTML.
  const html = s.mercadoRowHTML({ estado: 'x" onmouseover="alert(1)' });
  assert.ok(html.includes('status-badge status-rumor'));
  assert.ok(!html.includes('onmouseover="alert(1)"'));
  assert.ok(!html.includes('class="status-badge status-x'));
});

test('mercado: el aviso de antigüedad se guía por el nivel que da el servidor', () => {
  const s = mercadoSandbox();
  const viejo = new Date(Date.now() - 90 * 86400000).toISOString();
  // rumorStaleness (server.js, con sus propios tests) solo marca los estados
  // abiertos: un confirmado o descartado llega con desactualizado = 0. Aquí se
  // comprueba que el cliente honra ese nivel en vez de recalcular la fecha por
  // su cuenta, que es lo que hace también el panel.
  assert.ok(s.mercadoRowHTML({ estado: 'rumor', updated_at: viejo, desactualizado: 2 }).includes('Sin revisar'));
  assert.ok(s.mercadoRowHTML({ estado: 'avanzado', updated_at: viejo, desactualizado: 1 }).includes('Sin revisar'));
  assert.ok(!s.mercadoRowHTML({ estado: 'descartado', updated_at: viejo, desactualizado: 0 }).includes('Sin revisar'));
  // Sin nivel y sin fecha no sale el aviso, aunque la fecha sea viejísima.
  assert.ok(!s.mercadoRowHTML({ estado: 'confirmado', updated_at: viejo }).includes('Sin revisar'));
  assert.ok(!s.mercadoRowHTML({ estado: 'confirmado' }).includes('Sin revisar'));
});

test('mercado: sin escudo ni slug el club no se enlaza a la nada', () => {
  const s = mercadoSandbox();
  // Un <a> sin destino real es peor que texto plano: parece navegable y no lo es.
  assert.ok(!s.mercadoClubHTML({ nombre: 'San Carlos', slug: '', escudo: '' }, '?').includes('<a'));
  assert.ok(s.mercadoClubHTML({ nombre: 'San Carlos', slug: '', escudo: '' }, '?').includes('San Carlos'));
  const conSlug = s.mercadoClubHTML({ nombre: 'Saprissa', slug: 'saprissa', escudo: 'https://x/e.png' }, '?');
  assert.ok(conSlug.includes('href="/equipo/saprissa"'));
});

test('mercado: el jugador con slug enlaza a su ficha, sin slug no', () => {
  const s = mercadoSandbox();
  assert.ok(s.mercadoRowHTML({ jugador: 'A', jugador_slug: 'a' }).includes('href="/jugador/a"'));
  assert.ok(!s.mercadoRowHTML({ jugador: 'A' }).includes('/jugador/'));
});

test('mercado: el nombre del jugador va escapado', () => {
  const s = mercadoSandbox();
  const html = s.mercadoRowHTML({ jugador: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});
