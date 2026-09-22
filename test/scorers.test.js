const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const {
  footballDataScorerToRow,
  decoratePromericaScorers,
  validateTopScorersRows
} = require('../server');

function fakeFetchResponse(json, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => json
  };
}

test('goleadores: liga no válida devuelve 400', async () => {
  const res = await request(app).get('/api/top-scorers/patinaje');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Liga no válida.');
});

test('goleadores: sin API key responde 500 elegante (sin crashear)', async () => {
  delete process.env.FOOTBALL_DATA_API_KEY;
  try {
    const res = await request(app).get('/api/top-scorers/bl1');
    assert.equal(res.status, 500);
    assert.ok(res.body.error);
  } finally {
    process.env.FOOTBALL_DATA_API_KEY = 'football-data-test-key';
  }
});

test('goleadores: API externa caída devuelve 503', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeFetchResponse({ message: 'API down' }, false);
  try {
    const res = await request(app).get('/api/top-scorers/cl');
    assert.equal(res.status, 503);
    assert.ok(res.body.error);
  } finally {
    global.fetch = originalFetch;
  }
});

test('goleadores: mapea un goleador de football-data', () => {
  const row = footballDataScorerToRow({
    player: { name: 'Erling Haaland', position: 'ATTACKER' },
    team: { name: 'Manchester City', crest: 'https://crest.example/mci.png' },
    goals: 21,
    assists: 5
  });
  assert.equal(row.jugador, 'Erling Haaland');
  assert.equal(row.equipo, 'Manchester City');
  assert.equal(row.escudo, 'https://crest.example/mci.png');
  assert.equal(row.goles, 21);
  assert.equal(row.asistencias, 5);
  assert.equal(row.posicion, 'ATTACKER');
});

test('goleadores: responde datos transformados con fetch simulado', async () => {
  const originalFetch = global.fetch;
  const payload = {
    scorers: [
      {
        player: { name: 'Kylian Mbappé', position: 'ATTACKER' },
        team: { name: 'Real Madrid', crest: 'https://crest.example/rm.png' },
        goals: 18,
        assists: 4
      }
    ]
  };
  global.fetch = async () => fakeFetchResponse(payload, true);
  try {
    const res = await request(app).get('/api/top-scorers/pd');
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].jugador, 'Kylian Mbappé');
    assert.equal(res.body.data[0].goles, 18);
  } finally {
    global.fetch = originalFetch;
  }
});

test('goleadores promerica: GET público sin DB responde 500 JSON elegante', async () => {
  const res = await request(app).get('/api/top-scorers/promerica');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('goleadores promerica: rutas del panel sin token responden 401', async () => {
  const list = await request(app).get('/api/top-scorers/promerica/admin');
  assert.equal(list.status, 401);
  const put = await request(app).put('/api/top-scorers/promerica').send({ rows: [] });
  assert.equal(put.status, 401);
});

test('goleadores promerica: decora ordenando por goles y resolviendo club', () => {
  const teams = [
    { slug: 'saprissa', nombre: 'Deportivo Saprissa', escudo: 'https://crest.example/sap.png' },
    { slug: 'alajuelense', nombre: 'Alajuelense', escudo: 'https://crest.example/ala.png' }
  ];
  const rows = [
    { equipo_slug: 'saprissa', jugador: 'Bruno Segundo', goles: 5, asistencias: 1 },
    { equipo_slug: 'alajuelense', jugador: 'Joel Campbell', goles: 9, asistencias: 3 },
    { equipo_slug: 'saprissa', jugador: 'David Ramírez', goles: 9, asistencias: 1 }
  ];
  const deco = decoratePromericaScorers(rows, teams);
  assert.equal(deco.length, 3);
  assert.equal(deco[0].jugador, 'Joel Campbell');
  assert.equal(deco[0].equipo, 'Alajuelense');
  assert.equal(deco[0].escudo, 'https://crest.example/ala.png');
  assert.equal(deco[1].jugador, 'David Ramírez');
  assert.ok(deco[2].goles < deco[1].goles);
});

test('goleadores promerica: validación rechaza payloads y filas inválidas', () => {
  const allowed = ['saprissa', 'alajuelense', 'herediano', 'cartagines', 'san-carlos', 'puntarenas', 'perez-zeledon', 'sporting-san-jose', 'escorpiones-belen', 'inter-san-carlos'];
  assert.equal(validateTopScorersRows(null, allowed).error, 'Se esperaba la lista de goleadores en "rows".');
  assert.equal(validateTopScorersRows({ rows: [] }, allowed).error, 'Se esperaba la lista de goleadores en "rows".');
  assert.ok(validateTopScorersRows({ rows: [{ jugador: 'X', equipo_slug: 'limon' }] }, allowed).error);
  assert.ok(validateTopScorersRows({ rows: [{ jugador: '', equipo_slug: 'saprissa' }] }, allowed).error);
  assert.ok(validateTopScorersRows({ rows: [{ jugador: 'X', equipo_slug: 'saprissa', goles: -3 }] }, allowed).error);
});

test('goleadores promerica: validación acepta una lista correcta', () => {
  const allowed = ['saprissa', 'alajuelense'];
  const res = validateTopScorersRows({ rows: [{ jugador: 'Joel Campbell', equipo_slug: 'alajuelense', goles: 9, asistencias: 3 }] }, allowed);
  assert.equal(res.error, undefined);
  assert.equal(res.data.length, 1);
});