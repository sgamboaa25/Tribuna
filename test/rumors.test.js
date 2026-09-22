const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const { decorateRumors, validateRumor } = require('../server');

const TEAMS = [
  { slug: 'saprissa', nombre: 'Deportivo Saprissa', escudo: 'https://escudo.example/sap.png' },
  { slug: 'alajuelense', nombre: 'Alajuelense', escudo: 'https://escudo.example/lda.png' }
];

const PLAYERS = [
  { slug: 'christian-bolanos', nombre: 'Christian Bolaños', aliases: [] }
];

test('rumores: decoración une clubes (origen/destino) y resuelve slug de jugador', () => {
  const rumor = {
    id: 'abc',
    jugador: 'Christian Bolaños',
    posicion: 'Mediocampista',
    club_origen: 'Deportivo Saprissa',
    club_origen_slug: 'saprissa',
    club_destino: 'Pérez Zeledón',
    club_destino_slug: null,
    estado: 'avanzado',
    veracidad: 65,
    fuente: 'La Nación',
    detalle: 'Negociación en curso.',
    activo: true
  };
  const out = decorateRumors([rumor], TEAMS, PLAYERS)[0];
  assert.equal(out.origen.nombre, 'Deportivo Saprissa');
  assert.equal(out.origen.escudo, 'https://escudo.example/sap.png');
  assert.equal(out.destino.nombre, 'Pérez Zeledón');
  assert.equal(out.destino.escudo, '');
  assert.equal(out.jugador_slug, 'christian-bolanos');
  assert.equal(out.estado, 'avanzado');
  assert.equal(out.veracidad, 65);
  assert.equal(out.activo, true);
});

test('rumores: tolera nulls, slugs vacíos y preserva jugador_slug dado', () => {
  assert.deepEqual(decorateRumors(null, null, null), []);
  const out = decorateRumors(
    [{ jugador: 'Javon East', jugador_slug: 'javon-east' }],
    null,
    null
  )[0];
  assert.equal(out.jugador_slug, 'javon-east');
  assert.equal(out.origen.nombre, '');
  assert.equal(out.veracidad, 0);
  assert.equal(out.activo, true);
});

test('rumores: validación rechaza cuerpo inválido o sin jugador', () => {
  assert.equal(validateRumor(null, false).error, 'Cuerpo de petición inválido.');
  assert.equal(validateRumor([], false).error, 'Cuerpo de petición inválido.');
  assert.equal(validateRumor({ club_destino: 'Saprissa' }, false).error, 'Campo requerido: jugador.');
});

test('rumores: validación rechaza estado y veracidad fuera de rango y saneiza texto', () => {
  assert.equal(validateRumor({ jugador: 'X', estado: 'firmado' }, false).error, 'Estado de rumor no válido.');
  assert.equal(validateRumor({ jugador: 'X', veracidad: 150 }, false).error, 'La veracidad debe ser un número entre 0 y 100.');
  assert.equal(validateRumor({ jugador: 'X', veracidad: -1 }, false).error, 'La veracidad debe ser un número entre 0 y 100.');
  const { data } = validateRumor({ jugador: '<b>Marcelo</b>', detalle: '  Rumor seguro.  ' }, false);
  assert.equal(data.jugador, 'Marcelo');
  assert.equal(data.detalle, 'Rumor seguro.');
  assert.equal(data.estado, 'rumor');
  assert.equal(data.veracidad, 50);
});

test('rumores: rutas sin token responden 401 (panel y escrituras)', async () => {
  const manager = await request(app).get('/api/rumors/manager');
  assert.equal(manager.status, 401);
  const create = await request(app).post('/api/rumors').send({ jugador: 'X' });
  assert.equal(create.status, 401);
  const update = await request(app).put('/api/rumors/00000000-0000-0000-0000-000000000000').send({ jugador: 'X' });
  assert.equal(update.status, 401);
  const remove = await request(app).delete('/api/rumors/00000000-0000-0000-0000-000000000000');
  assert.equal(remove.status, 401);
});

test('rumores: sin DB disponible responde 500 JSON elegante', async () => {
  const res = await request(app).get('/api/rumors');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});