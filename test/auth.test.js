const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');

test('login: credenciales incorrectas rechazadas (401)', async () => {
  const res = await request(app)
    .post('/api/auth')
    .send({ email: 'editor@tribuna.test', password: 'clave-incorrecta' });
  assert.equal(res.status, 401);
  assert.ok(res.body.error);
});

test('login: email inválido también 401', async () => {
  const res = await request(app)
    .post('/api/auth')
    .send({ email: 'no-muy-valido', password: 'clave-incorrecta' });
  assert.equal(res.status, 401);
});

test('login: credenciales correctas devuelven token', async () => {
  const res = await request(app)
    .post('/api/auth')
    .send({ email: 'editor@tribuna.test', password: 'testpass' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.ok(res.body.expiresAt > Date.now());
});

test('login: sin contraseña devuelve 401', async () => {
  const res = await request(app).post('/api/auth').send({ email: 'editor@tribuna.test' });
  assert.equal(res.status, 401);
});