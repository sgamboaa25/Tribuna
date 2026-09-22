const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const { decoratePlayersWithTeams } = require('../server');

const TEAMS = [
  { slug: 'saprissa', nombre: 'Deportivo Saprissa', escudo: 'https://escudo.example/sap.png' }
];

test('players: decoración une jugador con su equipo (nombre y escudo)', () => {
  const player = {
    nombre: 'Christian Bolaños',
    slug: 'christian-bolanos',
    posicion: 'Mediocampista',
    dorsal: 8,
    foto: '',
    fecha_nacimiento: null,
    nacionalidad: 'Costa Rica',
    aliases: [],
    equipo_slug: 'saprissa'
  };
  const out = decoratePlayersWithTeams([player], TEAMS);
  assert.equal(out.length, 1);
  assert.equal(out[0].equipo.nombre, 'Deportivo Saprissa');
  assert.equal(out[0].equipo.escudo, 'https://escudo.example/sap.png');
  assert.equal(out[0].posicion, 'Mediocampista');
  assert.equal(out[0].dorsal, 8);
});

test('players: equipo desconocido devuelve equipo null sin romper', () => {
  const player = {
    nombre: 'Javon East',
    slug: 'javon-east',
    posicion: 'Delantero',
    dorsal: 9,
    foto: '',
    fecha_nacimiento: null,
    nacionalidad: 'Jamaica',
    aliases: [],
    equipo_slug: 'equipo-inexistente'
  };
  const out = decoratePlayersWithTeams([player], TEAMS);
  assert.equal(out[0].equipo, null);
  assert.equal(out[0].equipo_slug, 'equipo-inexistente');
});

test('players: tolera nulls y listas no-array (defensa)', () => {
  assert.deepEqual(decoratePlayersWithTeams(null, null), []);
  assert.deepEqual(decoratePlayersWithTeams([], null), []);
  const out = decoratePlayersWithTeams([{ slug: 'x' }], null);
  assert.equal(out[0].equipo, null);
  assert.equal(out[0].nombre, '');
  assert.equal(out[0].aliases.length, 0);
  assert.equal(out[0].dorsal, null);
});

test('players: sin BD disponible responde 500 JSON elegante', async () => {
  const res = await request(app).get('/api/players');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});