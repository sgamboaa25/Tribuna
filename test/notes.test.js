const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');

const toPublicNote = require('../server').toPublicNote;
const { computeEditStamp, validateNote } = require('../server');

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

test('notes: PUT/PATCH/DELETE con id que no es UUID → 400 sin tocar la DB', async () => {
  const token = await loginToken();
  const put = await request(app)
    .put('/api/notes/no-es-un-uuid')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'T', sport: 'Fútbol', intro: 'I', author: 'A', email: 'a@x.com', body: 'B' });
  assert.equal(put.status, 400);
  assert.match(put.body.error, /ID de nota/i);

  const patch = await request(app)
    .patch('/api/notes/no-es-un-uuid/status')
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'publicada' });
  assert.equal(patch.status, 400);

  const del = await request(app)
    .delete('/api/notes/no-es-un-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(del.status, 400);
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
    link: 'https://tribuna.example/nota/abc-123'
  });
});

test('api pública: mapeo tolerante ante campos ausentes', () => {
  const out = toPublicNote({ id: 'x' }, 'http://localhost:3000');
  assert.equal(out.titulo, '');
  // La URL tiene que ser la ruta de la nota, no "/#note-x": un ancla no la ve
  // Google, así que el enlace plano llevaba a la portada.
  assert.equal(out.link, 'http://localhost:3000/nota/x');
  assert.equal(toPublicNote(null, 'http://x').link, null);
});

test('stats: bloqueado sin token (401)', async () => {
  const res = await request(app).get('/api/stats');
  assert.equal(res.status, 401);
});

test('stats: con token responde JSON aunque la DB no esté disponible', async () => {
  const token = await loginToken();
  const res = await request(app).get('/api/stats').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('api pública: /api/public/notes responde JSON aunque la DB no esté disponible', async () => {
  const res = await request(app).get('/api/public/notes');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
  assert.equal(typeof res.body, 'object');
});

// --- Historial de ediciones (last_edited_at + edit_note) ---

const NOTA = {
  title: 'Titular',
  sport: 'Futbol',
  intro: 'Entradilla',
  author: 'Redaccion',
  email: 'redaccion@tribuna.test',
  body: '<p>Cuerpo</p>',
  status: 'publicada'
};

test('edit stamp: una nota ya publicada que cambia se sella', () => {
  const stamp = computeEditStamp(NOTA, { title: 'Otro titular' }, '2026-09-26T10:00:00.000Z');
  assert.equal(stamp, '2026-09-26T10:00:00.000Z');
});

test('edit stamp: publicar un borrador por primera vez NO se sella', () => {
  const borrador = { ...NOTA, status: 'borrador' };
  assert.equal(computeEditStamp(borrador, { title: 'Otro titular' }, '2026-09-26T10:00:00.000Z'), null);
  assert.equal(computeEditStamp(borrador, { status: 'publicada' }, '2026-09-26T10:00:00.000Z'), null);
});

test('edit stamp: guardar sin cambiar nada NO se sella', () => {
  const patch = { title: NOTA.title, intro: NOTA.intro, status: 'publicada' };
  assert.equal(computeEditStamp(NOTA, patch, '2026-09-26T10:00:00.000Z'), null);
});

test('edit stamp: los reactions no cuentan como edicion', () => {
  assert.equal(computeEditStamp(NOTA, { reactions: { clap: 99 } }, '2026-09-26T10:00:00.000Z'), null);
});

test('edit stamp: sin nota previa no se sella', () => {
  assert.equal(computeEditStamp(null, { title: 'x' }, '2026-09-26T10:00:00.000Z'), null);
  assert.equal(computeEditStamp(undefined, { title: 'x' }, '2026-09-26T10:00:00.000Z'), null);
});

test('edit stamp: genera ISO si no se pasa fecha', () => {
  const stamp = computeEditStamp(NOTA, { title: 'Otro' });
  assert.ok(!Number.isNaN(new Date(stamp).getTime()));
});

test('validateNote: acepta edit_note, permite vacio y corta a 200', () => {
  assert.equal(validateNote({ ...NOTA, edit_note: 'Se corrigio el marcador' }).error, undefined);
  assert.equal(validateNote({ ...NOTA, edit_note: '' }).error, undefined);
  const corto = validateNote({ ...NOTA, edit_note: 'x'.repeat(200) });
  assert.equal(corto.error, undefined);
  assert.equal(corto.data.edit_note.length, 200);
  const largo = validateNote({ ...NOTA, edit_note: 'x'.repeat(201) });
  assert.match(largo.error, /edit_note/);
});

test('validateNote: edit_note se sanea sin HTML', () => {
  assert.equal(validateNote({ ...NOTA, edit_note: '<b>Marcador</b> corregido' }).data.edit_note, 'Marcador corregido');
  // El contenido de <script> se descarta entero, no solo las etiquetas.
  assert.equal(validateNote({ ...NOTA, edit_note: '<script>alert(1)</script>Marcador' }).data.edit_note, 'Marcador');
});

test('validateNote: el cliente NO puede fijar last_edited_at', () => {
  const res = validateNote({ ...NOTA, last_edited_at: '2000-01-01T00:00:00.000Z' });
  assert.equal(res.data.last_edited_at, undefined);
});
