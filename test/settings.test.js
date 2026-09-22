const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const { validateTransferWindow, loadSettingsPublic } = require('../server');

test('settings: validación saneza el texto de la ventana', () => {
  const { data } = validateTransferWindow('  5 de enero de 2027  ');
  assert.equal(data, '5 de enero de 2027');
  const clean = validateTransferWindow('<b>15</b> de febrero');
  assert.equal(clean.data, '15 de febrero');
  assert.equal(validateTransferWindow('').data, '');
  assert.equal(validateTransferWindow(undefined).data, '');
});

test('settings: validación rechaza una fecha demasiado larga', () => {
  const res = validateTransferWindow('x'.repeat(61));
  assert.ok(res.error);
  assert.equal(validateTransferWindow('x'.repeat(60)).error, undefined);
});

test('settings: GET público sin DB responde 500 JSON elegante', async () => {
  const res = await request(app).get('/api/settings/public');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('settings: PUT sin token responde 401', async () => {
  const res = await request(app)
    .put('/api/settings')
    .send({ next_transfer_window: '5 de enero de 2027' });
  assert.equal(res.status, 401);
});

test('settings: loadSettingsPublic arroja sin DB para no mentir con caché', async () => {
  await assert.rejects(loadSettingsPublic());
});