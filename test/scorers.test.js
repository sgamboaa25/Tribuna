const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const { footballDataScorerToRow, apiFootballScorerToRow } = require('../server');

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

test('goleadores: mapea un goleador de la Liga Promérica (API-Football)', () => {
  const row = apiFootballScorerToRow({
    player: { name: 'Joel Campbell' },
    statistics: [
      {
        team: { name: 'Alajuelense', logo: 'https://logo.example/ala.png' },
        goals: { total: 9, assists: 3 },
        games: { position: 'Attacker' }
      }
    ]
  });
  assert.equal(row.jugador, 'Joel Campbell');
  assert.equal(row.equipo, 'Alajuelense');
  assert.equal(row.escudo, 'https://logo.example/ala.png');
  assert.equal(row.goles, 9);
  assert.equal(row.asistencias, 3);
  assert.equal(row.posicion, 'Attacker');
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