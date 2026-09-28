const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');

// El contador de lecturas no se puede probar contra una DB real aquí, pero sí
// lo que decide el servidor ANTES de tocar la DB: validar el id y no contar dos
// veces la misma lectura desde la misma IP. Ambas reglas son las que impiden
// que "más leídas" se infle a base de recargar la página.

const NOTA_UUID = '00000000-0000-0000-0000-000000000001';

test('vistas: id que no es UUID -> 400 sin tocar la DB', async () => {
  const res = await request(app).post('/api/notes/no-es-uuid/view');
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('vistas: un id mal formado tampoco consume el cupo de escrituras', async () => {
  // Si el endpoint no estuviera exento del writeLimiter, una ráfaga de vistas
  // inválidas devolvería 429 y parecería un fallo de permisos.
  for (let i = 0; i < 5; i++) {
    const res = await request(app).post('/api/notes/todo-basura/view');
    assert.equal(res.status, 400);
  }
});

test('vistas: la segunda lectura desde la misma IP no se cuenta dos veces', async () => {
  const ip = '203.0.113.9';
  // Sin DB la primera petición falla al leer, pero ya quedó registrada en el
  // mapa de dedupe: la segunda debe responderse 202 sin volver a intentarlo.
  const first = await request(app).post(`/api/notes/${NOTA_UUID}/view`).set('X-Forwarded-For', ip);
  assert.equal(first.status, 500);

  const second = await request(app).post(`/api/notes/${NOTA_UUID}/view`).set('X-Forwarded-For', ip);
  assert.equal(second.status, 202);
  assert.equal(second.body.counted, false);
});

test('vistas: otra IP sí cuenta la misma nota como nueva lectura', async () => {
  const first = await request(app)
    .post(`/api/notes/${NOTA_UUID}/view`)
    .set('X-Forwarded-For', '198.51.100.4');
  assert.equal(first.status, 500);

  // El dedupe es por IP+nota: si la ventana cubriera a todos, el contador
  // dependería del orden de llegada y no de cuántas personas leyeron.
  const other = await request(app)
    .post(`/api/notes/${NOTA_UUID}/view`)
    .set('X-Forwarded-For', '198.51.100.5');
  assert.equal(other.status, 500);
});

test('vistas: agotar el cupo de lecturas no bloquea la lectura del listado', async () => {
  const ip = '198.51.100.77';
  // El limiter de vistas va montado sobre /api/notes/:id/view, no sobre todo
  // /api/notes. Si se colgara del prefijo entero, el mismo cupo de 120 lo
  // consumirían los GET del listado y de la búsqueda, y un lector que recorre
  // muchas notas se quedaría sin noticias a media sesión.
  for (let i = 0; i < 125; i++) {
    const res = await request(app)
      .post(`/api/notes/${NOTA_UUID}/view`)
      .set('X-Forwarded-For', ip);
    if (res.status === 429) break;
  }
  // El cupo se agota (o no, si subiera el límite), pero lo importante es que el
  // listado siga respondiendo.
  const listado = await request(app).get('/api/notes').set('X-Forwarded-For', ip);
  assert.notEqual(listado.status, 429);
  // 500 = llegó al handler y falló solo por la DB ausente, que es lo esperado
  // en este entorno de pruebas.
  assert.equal(listado.status, 500);
});
