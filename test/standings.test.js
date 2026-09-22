const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const { decoratePromericaStandings, validateStandingsRows, mergeStandingsRoster } = require('../server');

// ===== Ruta original /api/standings/:liga (football-data) =====

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

// ===== Posiciones Liga Promérica (actualización manual) =====

const SLUGS = ['saprissa', 'alajuelense', 'herediano'];
const TEAMS = [
  { slug: 'saprissa', nombre: 'Deportivo Saprissa', escudo: 'https://x.example/saprissa.png' },
  { slug: 'alajuelense', nombre: 'Alajuelense', escudo: 'https://x.example/lda.png' },
  { slug: 'herediano', nombre: 'Herediano', escudo: '' }
];

test('standings promerica: calcula pts (3G+E) y DIF, y ordena por pts > dif > gf', () => {
  const rows = decoratePromericaStandings([
    { equipo_slug: 'herediano', pj: 5, g: 2, e: 1, p: 2, gf: 4, gc: 3 },
    { equipo_slug: 'alajuelense', pj: 5, g: 3, e: 1, p: 1, gf: 8, gc: 4 },
    { equipo_slug: 'saprissa', pj: 5, g: 2, e: 2, p: 1, gf: 7, gc: 5 }
  ], TEAMS);
  assert.deepEqual(rows.map((r) => r.slug), ['alajuelense', 'saprissa', 'herediano']);
  assert.equal(rows[0].pts, 10);
  assert.equal(rows[0].dif, 4);
  assert.equal(rows[1].pts, 8);
  assert.equal(rows[1].dif, 2);
  assert.equal(rows[2].pts, 7);
  assert.equal(rows[0].equipo, 'Alajuelense');
  assert.equal(rows[0].escudo, 'https://x.example/lda.png');
});

test('standings promerica: desempata por DIF y luego por GF', () => {
  const rows = decoratePromericaStandings([
    { equipo_slug: 'saprissa', pj: 3, g: 1, e: 1, p: 1, gf: 2, gc: 2 },
    { equipo_slug: 'alajuelense', pj: 3, g: 1, e: 1, p: 1, gf: 4, gc: 4 }
  ], TEAMS);
  assert.deepEqual(rows.map((r) => r.slug), ['alajuelense', 'saprissa']);
});

test('standings promerica: club ausente del catálogo no rompe y usa el slug como nombre', () => {
  const rows = decoratePromericaStandings([
    { equipo_slug: 'desconocido', pj: 1, g: 1, e: 0, p: 0, gf: 3, gc: 0 }
  ], TEAMS);
  assert.equal(rows[0].equipo, 'desconocido');
  assert.equal(rows[0].escudo, '');
  assert.equal(rows[0].pts, 3);
});

test('standings promerica: validación rechaza payloads y filas inválidas', () => {
  assert.equal(validateStandingsRows(null, SLUGS).error, 'Se esperaba la lista de equipos en "rows".');
  assert.equal(validateStandingsRows({ rows: [] }, SLUGS).error, 'Se esperaba la lista de equipos en "rows".');
  assert.equal(validateStandingsRows({ rows: [null] }, SLUGS).error, 'Fila inválida en la tabla.');
  assert.equal(validateStandingsRows({ rows: [{ slug: 'desconocido', pj: 1 }] }, SLUGS).error, 'Equipo no válido: "desconocido".');
  assert.equal(validateStandingsRows({ rows: [{ slug: 'saprissa', pj: -1 }] }, SLUGS).error, 'Valor inválido en "saprissa" (pj).');
  assert.equal(validateStandingsRows({ rows: [{ slug: 'saprissa', pj: 1.5 }] }, SLUGS).error, 'Valor inválido en "saprissa" (pj).');
});

test('standings promerica: validación exige que PJ cuadre con G+E+P', () => {
  const res = validateStandingsRows({ rows: [{ slug: 'saprissa', pj: 5, g: 2, e: 1, p: 1 }] }, SLUGS);
  assert.match(res.error, /"saprissa"/);
});

test('standings promerica: validación acepta una fila correcta y normaliza vacíos a cero', () => {
  const { data } = validateStandingsRows(
    { rows: [{ slug: 'saprissa', pj: 5, g: 2, e: 1, p: 2, gf: 6, gc: 3 }] },
    SLUGS
  );
  assert.equal(data.length, 1);
  assert.equal(data[0].slug, 'saprissa');
  assert.equal(data[0].gf, 6);
});

test('standings promerica: mergeStandingsRoster devuelve los 10 clubes con ceros si no hay datos', () => {
  const merged = mergeStandingsRoster(TEAMS, []);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].pj, 0);
  assert.equal(merged[0].updated_at, null);
});

test('standings promerica: mergeStandingsRoster preserva las estadísticas guardadas por equipo', () => {
  const merged = mergeStandingsRoster(TEAMS, [
    { equipo_slug: 'saprissa', pj: 5, g: 3, e: 1, p: 1, gf: 8, gc: 4, updated_at: '2026-09-21T10:00:00Z' }
  ]);
  assert.equal(merged.length, 3);
  const saprissa = merged.find((r) => r.equipo_slug === 'saprissa');
  assert.equal(saprissa.pj, 5);
  assert.equal(saprissa.gf, 8);
  assert.equal(saprissa.updated_at, '2026-09-21T10:00:00Z');
  const resto = merged.filter((r) => r.equipo_slug !== 'saprissa');
  assert.equal(resto.every((r) => r.pj === 0), true);
});

test('standings promerica: usa DIF y Pts guardados cuando existen', () => {
  const rows = decoratePromericaStandings([
    { equipo_slug: 'saprissa', pj: 5, g: 3, e: 1, p: 1, gf: 8, gc: 4, dif: 5, pts: 11 }
  ], TEAMS);
  assert.equal(rows[0].dif, 5);
  assert.equal(rows[0].pts, 11);
});

test('standings promerica: validación acepta DIF negativo y rechaza fuera de rango', () => {
  const ok = validateStandingsRows(
    { rows: [{ slug: 'saprissa', pj: 5, g: 1, e: 1, p: 3, gf: 2, gc: 5, dif: -3, pts: 4 }] },
    SLUGS
  );
  assert.equal(ok.error, undefined);
  assert.equal(ok.data[0].dif, -3);
  const badDif = validateStandingsRows(
    { rows: [{ slug: 'saprissa', pj: 5, g: 1, e: 1, p: 3, gf: 2, gc: 99, dif: -1000, pts: 4 }] },
    SLUGS
  );
  assert.match(badDif.error, /\(dif\)/);
  const badPts = validateStandingsRows(
    { rows: [{ slug: 'saprissa', pj: 5, g: 1, e: 1, p: 3, gf: 2, gc: 2, dif: 0, pts: 1000 }] },
    SLUGS
  );
  assert.match(badPts.error, /\(pts\)/);
});

test('standings promerica: GET público sin DB responde 500 JSON elegante', async () => {
  const res = await request(app).get('/api/standings/promerica');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('standings promerica: rutas del panel sin token responden 401', async () => {
  const admin = await request(app).get('/api/standings/promerica/admin');
  assert.equal(admin.status, 401);
  const put = await request(app)
    .put('/api/standings/promerica')
    .send({ rows: [{ slug: 'saprissa', pj: 1, g: 1, e: 0, p: 0, gf: 1, gc: 0 }] });
  assert.equal(put.status, 401);
});