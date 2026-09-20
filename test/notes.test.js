const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');

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