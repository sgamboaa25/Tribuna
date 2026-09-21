const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');

const toPublicNote = require('../server').toPublicNote;

async function loginToken() {
  const res = await request(app)
    .post('/api/auth')
    .send({ email: 'notas@tribuna.test', password: 'testpass' });
  return res.body.token;
}

test('notes: bloqueado sin token (401)', async () => {
  const res = await request(app).post('/api/notes').send({ title: 'x' });
  assert.equal(res.status, 401);
});

test('notes: campos requeridos ausentes → 400 con detalle del campo', async () => {
  const token = await loginToken();
  const cases = [
    { body: {}, esperado: 'title' },
    { body: { title: 'Título' }, esperado: 'sport' },
    { body: { title: 'Título', sport: 'Fútbol' }, esperado: 'intro' },
    { body: { title: 'Título', sport: 'Fútbol', intro: 'Entradilla' }, esperado: 'author' },
    { body: { title: 'Título', sport: 'Fútbol', intro: 'Entradilla', author: 'Autor' }, esperado: 'email' },
    { body: { title: 'Título', sport: 'Fútbol', intro: 'Entradilla', author: 'Autor', email: 'a@x.com' }, esperado: 'body' }
  ];
  for (const c of cases) {
    const res = await request(app)
      .post('/api/notes')
      .set('Authorization', `Bearer ${token}`)
      .send(c.body);
    assert.equal(res.status, 400, `esperando 400 para ${c.esperado}`);
    assert.match(res.body.error, new RegExp(c.esperado), `error debe nombrar el campo ${c.esperado}`);
  }
});

test('notes: email mal formado → 400', async () => {
  const token = await loginToken();
  const res = await request(app)
    .post('/api/notes')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'T', sport: 'Fútbol', intro: 'I', author: 'A', email: 'no-es-email', body: 'B' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /correo/i);
});

test('notes: nota completa no crashea ante DB no disponible', async () => {
  const token = await loginToken();
  const res = await request(app)
    .post('/api/notes')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Nota de prueba',
      sport: 'Fútbol',
      intro: 'Entradilla',
      author: 'Redacción',
      email: 'redaccion@tribuna.test',
      body: '<p>Cuerpo</p>'
    });
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('notes: encuesta inválida → 400', async () => {
  const token = await loginToken();
  const base = { title: 'T', sport: 'Fútbol', intro: 'I', author: 'A', email: 'a@x.com', body: 'B' };
  const cases = [
    { ...base, reactions: { poll: { question: '', options: ['A', 'B'] } } },
    { ...base, reactions: { poll: { question: '¿Quién gana?', options: ['A'] } } },
    { ...base, reactions: { poll: { question: '¿Quién gana?', options: ['A', 'B', 'C', 'D', 'E'] } } },
    { ...base, reactions: { poll: { question: '¿Quién gana?' } } },
    { ...base, reactions: { poll: 'no-es-objeto' } },
    { ...base, reactions: { poll_votes: { a: -1 } } },
    { ...base, reactions: { poll: { question: '¿Quién gana?', options: ['A', 'B'] }, poll_votes: { 0: 'x' } } }
  ];
  for (const c of cases) {
    const res = await request(app)
      .post('/api/notes')
      .set('Authorization', `Bearer ${token}`)
      .send(c);
    assert.equal(res.status, 400, 'esperando 400');
    assert.match(res.body.error, /encuesta|voto/i, 'error debe mencionar la encuesta');
  }
});

test('api pública: mapeo de nota a JSON limpio', () => {
  const out = toPublicNote(
    { id: 'abc-123', title: 'Titular', intro: 'Entradilla', sport: 'Fútbol', author: 'Autor', created_at: '2026-01-02T03:04:05.000Z' },
    'https://tribuna.example'
  );
  assert.deepEqual(out, {
    id: 'abc-123',
    titulo: 'Titular',
    entradilla: 'Entradilla',
    categoria: 'Fútbol',
    autor: 'Autor',
    fecha: '2026-01-02T03:04:05.000Z',
    link: 'https://tribuna.example/#note-abc-123'
  });
});

test('api pública: mapeo tolerante ante campos ausentes', () => {
  const out = toPublicNote({ id: 'x' }, 'http://localhost:3000');
  assert.equal(out.titulo, '');
  assert.equal(out.link, 'http://localhost:3000/#note-x');
  assert.equal(toPublicNote(null, 'http://x').link, null);
});

test('api pública: /api/public/notes responde JSON aunque la DB no esté disponible', async () => {
  const res = await request(app).get('/api/public/notes');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
  assert.equal(typeof res.body, 'object');
});
