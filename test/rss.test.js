const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, app } = require('./setup');
const { rssText } = require('../server');

test('rss: escapa los caracteres que romperían un nodo XML', () => {
  // El texto de la nota llega con etiquetas, así que rssText las quita antes de
  // escapar: '<b>' desaparece en vez de quedar como texto.
  assert.equal(rssText('Saprissa & "quotes" <b>'), 'Saprissa &amp; &quot;quotes&quot;');
  assert.equal(rssText('apóstrof'), 'apóstrof');
  // El ampersand va primero: si se escapara al final, un &amp; ya escapado
  // pasaría a &amp;amp; (doblemente escapado, visible como texto en el lector).
  assert.equal(rssText('a & <b>'), 'a &amp;');
  // Un "<" suelto que no forma etiqueta sí se escapa: si se colara, rompería el
  // documento XML entero.
  assert.equal(rssText('5 < 6 puntos'), '5 &lt; 6 puntos');
});

test('rss: quita el HTML del body y colapsa espacios', () => {
  // El body es HTML; escaparlo sin limpiar mostraría &lt;p&gt; en el lector.
  assert.equal(rssText('<p>Hola <strong>mundo</strong></p>'), 'Hola mundo');
  assert.equal(rssText('  con\n\nsaltos   de  línea '), 'con saltos de línea');
  assert.equal(rssText('<p>Uno</p><p>Dos</p>'), 'Uno Dos');
});

test('rss: tolera null, undefined y objetos', () => {
  assert.equal(rssText(null), '');
  assert.equal(rssText(undefined), '');
  assert.equal(rssText({}), '[object Object]');
  assert.equal(rssText(0), '0');
});

test('rss: /rss.xml responde 503 sin DB en vez de caer en la SPA', async () => {
  const res = await request(app).get('/rss.xml');
  // Lo importante: NO es 200 con index.html, porque un agregador guardaría HTML
  // como si fuera un canal y dejaría de reintentar.
  assert.equal(res.status, 503);
  assert.ok(!String(res.text).includes('<html'));
});

test('rss: /feed redirige a /rss.xml', async () => {
  const res = await request(app).get('/feed');
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, '/rss.xml');
});
