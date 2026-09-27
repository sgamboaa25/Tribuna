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

// --- Colores de club ---

const { sanitizeHexColor, indexTeamColors, colorForTeamName, applyTeamColors } = require('../server');

test('color hex: solo acepta #rrggbb y normaliza a minusculas', () => {
  assert.equal(sanitizeHexColor('#C8102E'), '#c8102e');
  assert.equal(sanitizeHexColor('  #C8102E  '), '#c8102e');
});

test('color hex: rechaza cualquier cosa que no sea #rrggbb', () => {
  const malos = [
    undefined, null, '', '   ', 'C8102E', '#FFF', '#GGGGGG', '#1234567',
    'red', 'rgb(1,2,3)', 'url(x)', '#fff; background:url(evil)',
    'expression(alert(1))', 'var(--x)', '#c8102e;color:red'
  ];
  for (const v of malos) assert.equal(sanitizeHexColor(v), '', `deberia rechazar: ${v}`);
});

test('colores: indexa por nombre y por alias, ignorando nulos e invalidos', () => {
  const map = indexTeamColors([
    { nombre: 'Arsenal', color: '#ef0107', aliases: ['arsenal fc'] },
    { nombre: 'Newcastle United', color: null, aliases: ['newcastle'] },
    { nombre: 'Bad', color: 'url(evil)', aliases: [] },
    { nombre: 'Real Madrid', color: '#00529F', aliases: ['real madrid cf'] }
  ]);
  assert.equal(map.get('arsenal'), '#ef0107');
  assert.equal(map.get('arsenal fc'), '#ef0107');
  assert.equal(map.get('real madrid cf'), '#00529f');
  assert.equal(map.has('newcastle'), false);
  assert.equal(map.has('newcastle united'), false);
  assert.equal(map.has('bad'), false);
});

test('colores: la primera fila gana si dos comparten alias', () => {
  const map = indexTeamColors([
    { nombre: 'A', color: '#111111', aliases: ['comun'] },
    { nombre: 'B', color: '#222222', aliases: ['comun'] }
  ]);
  assert.equal(map.get('comun'), '#111111');
});

test('colores: la busqueda ignora mayusculas y acentos', () => {
  const map = indexTeamColors([
    { nombre: 'Atlético Madrid', color: '#cb3524', aliases: [] },
    { nombre: 'Deportivo Alavés', color: '#0761af', aliases: ['alaves'] }
  ]);
  assert.equal(colorForTeamName(map, 'atlético madrid'), '#cb3524');
  assert.equal(colorForTeamName(map, 'ATLETICO MADRID'), '#cb3524');
  assert.equal(colorForTeamName(map, 'Deportivo Alaves'), '#0761af');
  assert.equal(colorForTeamName(map, 'Club Desconocido'), '');
  assert.equal(colorForTeamName(map, ''), '');
});

test('colores: applyTeamColors anade color y no muta la entrada', () => {
  const byName = indexTeamColors([{ nombre: 'Arsenal', color: '#ef0107', aliases: [] }]);
  const entrada = [{ local: { equipo: 'Arsenal', escudo: 'c.png' }, visitante: { equipo: 'Colchester', escudo: '' } }];
  const salida = applyTeamColors(entrada, byName);
  assert.equal(salida[0].local.color, '#ef0107');
  assert.equal(salida[0].visitante.color, undefined);
  assert.equal(entrada[0].local.color, undefined, 'no debe mutar la entrada');
  // El lado con color se copia; el que no tiene color se reutiliza tal cual
  // (no se muta, asi que compartir referencia es seguro).
  assert.notEqual(salida[0].local, entrada[0].local);
  assert.equal(salida[0].visitante, entrada[0].visitante);
});

test('colores: sin catalogo o sin color los fixtures salen intactos', () => {
  const entrada = [{ local: { equipo: 'Arsenal' }, visitante: { equipo: 'Chelsea' } }];
  assert.deepEqual(applyTeamColors(entrada, new Map()), entrada);
  assert.deepEqual(applyTeamColors(entrada, null), entrada);
  assert.equal(applyTeamColors(null, new Map()), null);
  assert.equal(applyTeamColors(entrada, indexTeamColors([{ nombre: 'Arsenal', color: null, aliases: [] }]))[0].local.color, undefined);
});

test('colores: tolera fixtures con lados ausentes', () => {
  const byName = indexTeamColors([{ nombre: 'Arsenal', color: '#ef0107', aliases: [] }]);
  const salida = applyTeamColors([{ local: null, visitante: undefined }], byName);
  assert.equal(salida[0].local, null);
  assert.equal(salida[0].visitante, undefined);
});