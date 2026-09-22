const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const { validateReaderPhoto } = require('../server');

const PREFIX = `${String(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/storage/v1/object/public/notes-images/lectores/`;

test('fotos: validación rechaza cuerpos inválidos y autor ausente', () => {
  assert.equal(validateReaderPhoto(null).error, 'Cuerpo de petición inválido.');
  assert.equal(validateReaderPhoto([]).error, 'Cuerpo de petición inválido.');
  assert.equal(validateReaderPhoto('x').error, 'Cuerpo de petición inválido.');
  assert.equal(validateReaderPhoto({ autor: '', foto: PREFIX + 'a.jpg' }).error, 'Campo requerido: autor.');
});

test('fotos: validación rechaza URL fuera del prefijo de subida', () => {
  assert.equal(
    validateReaderPhoto({ autor: 'Ana', foto: 'https://evil.example/x.jpg' }).error,
    'La imagen debe subirse desde el sitio.'
  );
  const long = validateReaderPhoto({ autor: 'Ana', foto: PREFIX + 'x'.repeat(600) });
  assert.equal(long.error, 'URL de imagen no válida.');
});

test('fotos: validación acepta foto del bucket y saneiza el texto', () => {
  const { data } = validateReaderPhoto({
    autor: '  <b>Ana</b> Pérez  ',
    titulo: '  Golazo desde la grada.  ',
    foto: PREFIX + 'foto.jpg'
  });
  assert.equal(data.autor, 'Ana Pérez');
  assert.equal(data.titulo, 'Golazo desde la grada.');
  assert.equal(data.estado, 'en_revision');
  assert.ok(data.foto.startsWith(PREFIX));
});

test('fotos: honeypot responde 201 sin guardar nada', async () => {
  const res = await request(app)
    .post('/api/reader-photos')
    .send({ autor: 'Bot', foto: PREFIX + 'foto.jpg', website: 'http://spam.example' });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
});

test('fotos: post inválido responde 400', async () => {
  const res = await request(app)
    .post('/api/reader-photos')
    .send({ autor: '', foto: PREFIX + 'foto.jpg' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Campo requerido: autor.');
});

test('fotos: post válido sin DB responde 500 JSON elegante', async () => {
  const res = await request(app)
    .post('/api/reader-photos')
    .send({ autor: 'Ana Pérez', foto: PREFIX + 'foto.jpg' });
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('fotos: rutas del panel sin token responden 401', async () => {
  const manager = await request(app).get('/api/reader-photos/manager');
  assert.equal(manager.status, 401);
  const update = await request(app)
    .put('/api/reader-photos/00000000-0000-0000-0000-000000000000')
    .send({ estado: 'publicada' });
  assert.equal(update.status, 401);
  const remove = await request(app).delete('/api/reader-photos/00000000-0000-0000-0000-000000000000');
  assert.equal(remove.status, 401);
});