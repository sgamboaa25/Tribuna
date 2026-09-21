const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');

const { resolveTeamSlugs } = require('../server');

const TEAMS = [
  { slug: 'alajuelense', nombre: 'Alajuelense', aliases: ['lda', 'manudos'] },
  { slug: 'cartagines', nombre: 'Cartaginés', aliases: ['brumosos'] },
  { slug: 'saprissa', nombre: 'Deportivo Saprissa', aliases: ['saprissa', 'deportivo saprissa'] },
  { slug: 'escorpiones-belen', nombre: 'Escorpiones de Belén', aliases: ['escorpiones de belen', 'escorpiones', 'belen'] },
  { slug: 'herediano', nombre: 'Herediano', aliases: ['fluminense'] },
  { slug: 'inter-san-carlos', nombre: 'Inter de San Carlos', aliases: ['inter de san carlos', 'inter san carlos'] },
  { slug: 'perez-zeledon', nombre: 'Pérez Zeledón', aliases: ['perez zeledon', 'zeledon'] },
  { slug: 'puntarenas', nombre: 'Puntarenas', aliases: [] },
  { slug: 'san-carlos', nombre: 'San Carlos', aliases: [] },
  { slug: 'sporting-san-jose', nombre: 'Sporting San José', aliases: ['sporting'] }
];

function sortTeams(slugs) {
  return [...slugs].sort();
}

test('teams: resuelve slug por nombre con acentos', () => {
  assert.deepEqual(sortTeams(resolveTeamSlugs('Cartaginés', TEAMS)), ['cartagines']);
  assert.deepEqual(sortTeams(resolveTeamSlugs('Pérez Zeledón', TEAMS)), ['perez-zeledon']);
});

test('teams: resuelve mediante alias', () => {
  assert.deepEqual(sortTeams(resolveTeamSlugs('lda, manudos', TEAMS)), ['alajuelense']);
  assert.deepEqual(sortTeams(resolveTeamSlugs('saprissa', TEAMS)), ['saprissa']);
  assert.deepEqual(sortTeams(resolveTeamSlugs('brumosos', TEAMS)), ['cartagines']);
  assert.deepEqual(sortTeams(resolveTeamSlugs('sporting', TEAMS)), ['sporting-san-jose']);
});

test('teams: etiqueta compuesta con palabra suelta sí enlaza', () => {
  assert.deepEqual(sortTeams(resolveTeamSlugs('fútbol saprissa', TEAMS)), ['saprissa']);
});

test('teams: "inter de san carlos" no enlaza San Carlos por error', () => {
  assert.deepEqual(sortTeams(resolveTeamSlugs('inter de san carlos', TEAMS)), ['inter-san-carlos']);
});

test('teams: "san carlos" enlaza solo a San Carlos', () => {
  assert.deepEqual(sortTeams(resolveTeamSlugs('san carlos', TEAMS)), ['san-carlos']);
});

test('teams: sin coincidencias devuelve lista vacía', () => {
  assert.deepEqual(resolveTeamSlugs('análisis, fútbol', TEAMS), []);
});

test('teams: lista no-array devuelve vacío (defensa)', () => {
  assert.deepEqual(resolveTeamSlugs('saprissa', null), []);
  assert.deepEqual(resolveTeamSlugs('saprissa', 'no-array'), []);
});

test('api pública: /api/teams responde JSON 500 sin BD disponible', async () => {
  const res = await request(app).get('/api/teams');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});