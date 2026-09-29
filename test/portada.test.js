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

// Extrae un `const X = ...;` completo. Se para en el primer punto y coma que
// esté fuera de cualquier llave, corchete o paréntesis, para que no se corte a
// la mitad un arrow function con cuerpo de bloque.
function extractConst(name) {
  const i = SCRIPT.search(new RegExp('const\\s+' + name + '\\s*='));
  if (i === -1) throw new Error('no existe const ' + name);
  let depth = 0;
  for (let j = i; j < SCRIPT.length; j++) {
    const c = SCRIPT[j];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) return SCRIPT.slice(i, j + 1);
  }
  throw new Error('sentencia sin cerrar: ' + name);
}

// La regla de portada vive en index.html, que ESLint no cubre: se extrae el
// mismo bloque que ejecuta la página y se prueba suelto. Lo que se fija aquí es
// el criterio editorial, no el markup.
const PORTADA_SOURCE = [
  extractConst('FUTURE_DATE_TOLERANCE_MS'),
  extractConst('SITE_TIMEZONE'),
  extractConst('noteIsPublished'),
  extractConst('notePublishedAt'),
  extractConst('sortNotesByRecent'),
  extractFunction('timeAgo'),
  extractFunction('formatFullDate')
].join('\n\n');

function portadaSandbox() {
  const sandbox = { Date, Math, Number, String, isNaN };
  // En un vm los `const` viven en el ámbito del script y no se cuelgan en el
  // global, así que se devuelve explícitamente lo que hace falta probar.
  return vm.runInNewContext(
    '(function () {\n' + PORTADA_SOURCE +
    '\nreturn { noteIsPublished, notePublishedAt, sortNotesByRecent, timeAgo, formatFullDate, SITE_TIMEZONE, FUTURE_DATE_TOLERANCE_MS };\n})()',
    sandbox
  );
}

// sortNotesByRecent recibe el "ahora" para poder compararlo con un instante
// fijo; timeAgo usa el reloj real, así que sus fixtures también.
const AHORA = Date.parse('2026-03-10T15:00:00.000Z');
const hace = (minutos) => new Date(AHORA - minutos * 60000).toISOString();
const haceReal = (minutos) => new Date(Date.now() - minutos * 60000).toISOString();

test('portada: la nota principal es la más reciente, sin importar el orden de llegada', () => {
  const { sortNotesByRecent } = portadaSandbox();
  const notas = [
    { id: 'vieja', status: 'publicada', created_at: hace(60 * 24 * 30) },
    { id: 'reciente', status: 'publicada', created_at: hace(5) },
    { id: 'media', status: 'publicada', created_at: hace(60 * 24 * 3) }
  ];
  assert.deepEqual(sortNotesByRecent(notas, AHORA).map((n) => n.id), ['reciente', 'media', 'vieja']);

  // El mismo lote en otro orden da la misma principal: antes bastaba con que
  // Postgres devolviera las filas como le saliera.
  assert.equal(sortNotesByRecent(notas.slice().reverse(), AHORA)[0].id, 'reciente');
});

test('portada: borradores y archivadas nunca llegan a la principal', () => {
  const { sortNotesByRecent } = portadaSandbox();
  const notas = [
    { id: 'borrador-nuevo', status: 'borrador', created_at: hace(1) },
    { id: 'revision', status: 'en revisión', created_at: hace(2) },
    { id: 'archivada', status: 'publicada', archived: true, created_at: hace(3) },
    { id: 'publicada', status: 'publicada', created_at: hace(600) }
  ];
  assert.deepEqual(sortNotesByRecent(notas, AHORA).map((n) => n.id), ['publicada']);
});

test('portada: una nota con fecha futura no se publica sola, pero un desfase de reloj no borra la portada', () => {
  const { sortNotesByRecent, FUTURE_DATE_TOLERANCE_MS } = portadaSandbox();
  const dentro = new Date(AHORA + 5 * 60000).toISOString(); // reloj 5 min atrasado
  const muyLejos = new Date(AHORA + 30 * 24 * 3600000).toISOString(); // año escrito a mano

  const notas = sortNotesByRecent([
    { id: 'futura', status: 'publicada', created_at: muyLejos },
    { id: 'reciente', status: 'publicada', created_at: hace(5) }
  ], AHORA);
  assert.deepEqual(notas.map((n) => n.id), ['reciente']);

  // Con un margen de reloj de minutos, la nota sigue ahí: solo se cae la que
  // lleva días sin publicarse.
  assert.ok(FUTURE_DATE_TOLERANCE_MS >= 3600000);
  assert.equal(sortNotesByRecent([{ id: 'desfasada', status: 'publicada', created_at: dentro }], AHORA).length, 1);
});

test('portada: una nota sin fecha no se cuela como principal', () => {
  const { sortNotesByRecent } = portadaSandbox();
  const notas = sortNotesByRecent([
    { id: 'sin-fecha', status: 'publicada' },
    { id: 'con-fecha', status: 'publicada', created_at: hace(30) }
  ], AHORA);
  assert.deepEqual(notas.map((n) => n.id), ['con-fecha', 'sin-fecha']);
});

test('portada: el grid se queda con lo que sobra tras quitar la principal', () => {
  const { sortNotesByRecent } = portadaSandbox();
  const orden = sortNotesByRecent([
    { id: 'a', status: 'publicada', created_at: hace(90) },
    { id: 'b', status: 'publicada', created_at: hace(1) },
    { id: 'c', status: 'publicada', created_at: hace(45) }
  ], AHORA);

  // Lo que hace renderPublicCards: la principal es [0] y el grid usa slice(1).
  const principal = orden[0];
  const resto = orden.slice(1);
  assert.equal(principal.id, 'b');
  assert.equal(resto.some((n) => n.id === principal.id), false);
  assert.deepEqual(resto.map((n) => n.id), ['c', 'a']);
});

test('portada: sin notas publicadas la lista queda vacía y no revienta', () => {
  const { sortNotesByRecent } = portadaSandbox();
  // Se comprueba la longitud y no deepEqual: un array creado dentro del vm
  // tiene otro Array.prototype y deepStrictEqual los da por distintos.
  assert.equal(sortNotesByRecent([], AHORA).length, 0);
  assert.equal(sortNotesByRecent(undefined, AHORA).length, 0);
  assert.equal(sortNotesByRecent(null, AHORA).length, 0);
  assert.equal(sortNotesByRecent([{ id: 'borrador', status: 'borrador' }], AHORA).length, 0);
});

test('portada: la fecha relativa sale del created_at y no depende de la zona horaria', () => {
  const { timeAgo } = portadaSandbox();
  assert.equal(timeAgo(haceReal(0)), 'Ahora mismo');
  assert.equal(timeAgo(haceReal(1)), 'Hace 1 minuto');
  assert.equal(timeAgo(haceReal(45)), 'Hace 45 minutos');
  assert.equal(timeAgo(haceReal(60)), 'Hace 1 hora');
  assert.equal(timeAgo(haceReal(60 * 5)), 'Hace 5 horas');
  assert.equal(timeAgo(haceReal(60 * 24)), 'Hace 1 día');
  assert.equal(timeAgo(haceReal(60 * 24 * 8)), 'Hace 1 semana');
  // El texto no lleva hora, así que el mismo instante se lee igual en San José
  // que en Madrid: el cálculo es una duración, no una fecha de calendario.
  assert.equal(timeAgo(haceReal(60 * 24 * 3)), timeAgo(new Date(Date.now() - 60 * 24 * 3 * 60000).toISOString()));
  // Una nota con la hora por delante (reloj desfasado) no produce "Hace -1 hora".
  assert.equal(timeAgo(new Date(Date.now() + 60 * 60000).toISOString()), 'Ahora mismo');
  assert.equal(timeAgo(null), '');
  assert.equal(timeAgo('no-es-fecha'), '');
});

test('portada: la fecha absoluta se imprime en hora de Costa Rica', () => {
  const { formatFullDate, SITE_TIMEZONE } = portadaSandbox();
  assert.equal(SITE_TIMEZONE, 'America/Costa_Rica');

  // created_at llega en UTC. A las 03:30 UTC en San José son las 21:30 del día
  // anterior, y ese es el texto que debe ver el lector: no el suyo. Ojo que
  // es-CR usa reloj de 12 horas, así que la misma hora sale "9:30 p. m.".
  const iso = '2026-03-10T03:30:00.000Z';
  const esperado = new Intl.DateTimeFormat('es-CR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'America/Costa_Rica'
  }).format(new Date(iso));
  assert.equal(formatFullDate(iso), esperado);
  assert.match(formatFullDate(iso), /9 de marzo/);
  assert.match(formatFullDate(iso), /9:30/);

  // Y no puede ser la hora local de quien lee: si el equipo está en Costa Rica
  // la comparación de arriba basta; si está en otra zona, esto la remata.
  const horaLocal = new Intl.DateTimeFormat('es-CR', {
    dateStyle: 'full', timeStyle: 'short'
  }).format(new Date(iso));
  if (horaLocal !== esperado) assert.notEqual(formatFullDate(iso), horaLocal);

  assert.equal(formatFullDate(null), '');
  assert.equal(formatFullDate('no-es-fecha'), '');
});
