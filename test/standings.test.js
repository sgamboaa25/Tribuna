const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');

function fakeFetchResponse(json, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => json
  };
}

test('standings: liga no válida devuelve 400', async () => {
  const res = await request(app).get('/api/standings/patinaje');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Liga no válida.');
});

test('standings: sin API key responde 500 elegante (sin crashear)', async () => {
  delete process.env.FOOTBALL_DATA_API_KEY;
  try {
    const res = await request(app).get('/api/standings/cl');
    assert.equal(res.status, 500);
    assert.ok(res.body.error);
  } finally {
    process.env.FOOTBALL_DATA_API_KEY = 'football-data-test-key';
  }
});

test('standings: API externa caída devuelve 503', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeFetchResponse({ message: 'API down' }, false);
  try {
    const res = await request(app).get('/api/standings/cl');
    assert.equal(res.status, 503);
    assert.ok(res.body.error);
  } finally {
    global.fetch = originalFetch;
  }
});

test('standings: respuesta correcta transformada y cacheada', async () => {
  const originalFetch = global.fetch;
  const payload = {
    standings: [
      {
        type: 'TOTAL',
        table: [
          {
            position: 1,
            team: { name: 'Real Madrid', crest: 'https://crest.example/madrid.png' },
            playedGames: 10,
            won: 8,
            draw: 1,
            lost: 1,
            goalsFor: 25,
            goalsAgainst: 6,
            goalDifference: 19,
            points: 25
          }
        ]
      }
    ]
  };
  global.fetch = async () => fakeFetchResponse(payload);
  try {
    const res = await request(app).get('/api/standings/cl');
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, false);
    const item = res.body.data[0];
    assert.equal(item.posicion, 1);
    assert.equal(item.equipo, 'Real Madrid');
    assert.equal(item.escudo, 'https://crest.example/madrid.png');
    assert.equal(item.jugados, 10);
    assert.equal(item.ganados, 8);
    assert.equal(item.empatados, 1);
    assert.equal(item.perdidos, 1);
    assert.equal(item.golesFavor, 25);
    assert.equal(item.golesContra, 6);
    assert.equal(item.diferencia, 19);
    assert.equal(item.puntos, 25);

    const cached = await request(app).get('/api/standings/cl');
    assert.equal(cached.status, 200);
    assert.equal(cached.body.stale, false);
    assert.deepEqual(cached.body.data, res.body.data);
  } finally {
    global.fetch = originalFetch;
  }
});