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

function futureUtcDate(days = 2) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

test('fixtures: liga no válida devuelve 400', async () => {
  const res = await request(app).get('/api/fixtures/patinaje');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Liga no válida.');
});

test('fixtures: sin API key (football-data) responde 500 elegante', async () => {
  delete process.env.FOOTBALL_DATA_API_KEY;
  try {
    const res = await request(app).get('/api/fixtures/ec');
    assert.equal(res.status, 500);
    assert.ok(res.body.error);
  } finally {
    process.env.FOOTBALL_DATA_API_KEY = 'football-data-test-key';
  }
});

test('fixtures: promerica sin API-Football key responde 500 elegante', async () => {
  const apiFootballKey = process.env.API_FOOTBALL_KEY;
  delete process.env.API_FOOTBALL_KEY;
  try {
    const res = await request(app).get('/api/fixtures/promerica');
    assert.equal(res.status, 500);
    assert.ok(res.body.error);
  } finally {
    if (apiFootballKey !== undefined) process.env.API_FOOTBALL_KEY = apiFootballKey;
  }
});

test('fixtures: API externa caída devuelve 503', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeFetchResponse({ message: 'API down' }, false);
  try {
    const res = await request(app).get('/api/fixtures/bl1');
    assert.equal(res.status, 503);
    assert.ok(res.body.error);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fixtures: respuesta correcta transformada y cacheada (football-data)', async () => {
  const originalFetch = global.fetch;
  const utc = futureUtcDate();
  const payload = {
    matches: [
      {
        utcDate: utc,
        status: 'SCHEDULED',
        matchday: 7,
        stage: '',
        competition: { name: 'Premier League' },
        homeTeam: { name: 'Arsenal', crest: 'https://crest.example/arsenal.png' },
        awayTeam: { name: 'Chelsea', crest: 'https://crest.example/chelsea.png' }
      }
    ]
  };
  global.fetch = async () => fakeFetchResponse(payload);
  try {
    const res = await request(app).get('/api/fixtures/pl');
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, false);
    const item = res.body.data[0];
    assert.equal(item.fecha, String(utc).slice(0, 10));
    assert.equal(item.fechaISO, utc);
    assert.equal(item.jornada, 'Jornada 7');
    assert.equal(item.liga, 'Premier League');
    assert.equal(item.estado, 'SCHEDULED');
    assert.equal(item.local.equipo, 'Arsenal');
    assert.equal(item.local.escudo, 'https://crest.example/arsenal.png');
    assert.equal(item.visitante.equipo, 'Chelsea');

    const cached = await request(app).get('/api/fixtures/pl');
    assert.equal(cached.status, 200);
    assert.equal(cached.body.stale, false);
    assert.deepEqual(cached.body.data, res.body.data);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fixtures: promerica se sirve vía API-Football y castea los últimos partidos', async () => {
  const originalFetch = global.fetch;
  const utc = futureUtcDate(2);
  const alreadyStarted = new Date(Date.now() - 7200000).toISOString();
  const payload = {
    errors: {},
    response: [
      {
        fixture: { id: 1, date: utc, status: { short: 'NS' } },
        league: { name: 'Liga Promérica', round: 'Apertura - Jornada 1' },
        teams: {
          home: { name: 'Saprissa', logo: 'https://logo.example/saprissa.png' },
          away: { name: 'Alajuelense', logo: 'https://logo.example/alu.png' }
        }
      },
      {
        fixture: { id: 2, date: alreadyStarted, status: { short: '1H' } },
        league: { name: 'Liga Promérica', round: 'Apertura - Jornada 1' },
        teams: {
          home: { name: 'Cartaginés', logo: '' },
          away: { name: 'Herediano', logo: '' }
        }
      }
    ]
  };
  global.fetch = async () => fakeFetchResponse(payload);
  try {
    const apiFootballKey = process.env.API_FOOTBALL_KEY;
    process.env.API_FOOTBALL_KEY = apiFootballKey || 'api-football-test-key';
    const res = await request(app).get('/api/fixtures/promerica');
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.data.length, 1);
    const item = res.body.data[0];
    assert.equal(item.liga, 'Liga Promérica');
    assert.equal(item.local.equipo, 'Saprissa');
    assert.equal(item.visitante.equipo, 'Alajuelense');
    assert.equal(item.estado, 'NS');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fixtures: API caída con caché previo devuelve datos obsoletos (stale)', async () => {
  const originalFetch = global.fetch;
  const utc = futureUtcDate();
  const payload = {
    matches: [
      {
        utcDate: utc,
        status: 'SCHEDULED',
        matchday: 3,
        stage: '',
        competition: { name: 'La Liga' },
        homeTeam: { name: 'Barcelona', crest: '' },
        awayTeam: { name: 'Real Madrid', crest: '' }
      }
    ]
  };
  global.fetch = async () => fakeFetchResponse(payload);
  try {
    const first = await request(app).get('/api/fixtures/sa');
    assert.equal(first.status, 200);
    assert.equal(first.body.stale, false);
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => fakeFetchResponse({ message: 'API down' }, false);
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 3600000;
  try {
    const res = await request(app).get('/api/fixtures/sa');
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, true);
    assert.deepEqual(res.body.data, [
      {
        fecha: String(utc).slice(0, 10),
        fechaISO: utc,
        jornada: 'Jornada 3',
        liga: 'La Liga',
        estado: 'SCHEDULED',
        local: { equipo: 'Barcelona', escudo: '' },
        visitante: { equipo: 'Real Madrid', escudo: '' }
      }
    ]);
  } finally {
    Date.now = realNow;
    global.fetch = originalFetch;
  }
});