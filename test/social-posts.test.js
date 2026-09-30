const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { request, app } = require('./setup');
const {
  socialNetworkForUrl,
  validateSocialPost,
  selectSocialPosts,
  socialTimelineConfig,
  loadSocialPostsPublic
} = require('../server');

async function loginToken() {
  const res = await request(app)
    .post('/api/auth')
    .send({ email: 'redaccion@tribuna.test', password: 'testpass' });
  return res.body.token;
}

// ============ Servidor ============

test('en redes: la red se deduce del dominio, con o sin www', () => {
  assert.equal(socialNetworkForUrl('https://x.com/tribunadepts/status/123').network, 'x');
  assert.equal(socialNetworkForUrl('https://www.x.com/tribunadepts/status/123').network, 'x');
  assert.equal(socialNetworkForUrl('http://twitter.com/tribunadepts/status/123').network, 'x');
  assert.equal(socialNetworkForUrl('https://mobile.twitter.com/tribunadepts/status/1').network, 'x');
  assert.equal(socialNetworkForUrl('https://www.instagram.com/p/ABC123/').network, 'instagram');
  assert.equal(socialNetworkForUrl('https://instagr.am/p/ABC123/').network, 'instagram');
});

test('en redes: rechaza cualquier dominio que no sea de X o Instagram', () => {
  const fuera = [
    'https://facebook.com/tribuna/posts/1',
    'https://tiktok.com/@tribuna/video/1',
    'https://tribuna.example.com/nota/1',
    'https://x.com.atacante.example/post/1',
    'https://instagram.com.atacante.example/p/1/',
    'https://notx.com/post/1',
    'no-es-una-url',
    ''
  ];
  fuera.forEach((url) => {
    assert.equal(socialNetworkForUrl(url), null, 'debía rechazar: ' + url);
    assert.equal(socialNetworkForUrl(url), null);
  });
});

test('en redes: rechaza esquemas que no sean http(s)', () => {
  assert.equal(socialNetworkForUrl('javascript:alert(1)'), null);
  assert.equal(socialNetworkForUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(socialNetworkForUrl('file:///etc/passwd'), null);
});

test('en redes: normaliza la URL para que sea segura de attributear', () => {
  // URL() percent-escapea comillas y espacios: lo que sale del validador ya se
  // puede poner en un atributo del HTML sin escapar a mano.
  const { href } = socialNetworkForUrl('  https://x.com/t/status/1?s=20&t=abc  ');
  assert.equal(href, 'https://x.com/t/status/1?s=20&t=abc');
  assert.ok(!href.includes('"'));
});

test('en redes: la validación guarda la red deducida e ignora la que mande el cliente', () => {
  const ok = validateSocialPost({ url: 'https://x.com/tribunadepts/status/1', red: 'instagram' });
  assert.equal(ok.data.red, 'x');

  const ig = validateSocialPost({ url: 'https://www.instagram.com/p/ABC/', destacada: true });
  assert.equal(ig.data.red, 'instagram');
  assert.equal(ig.data.destacada, true);

  // Sin body, sin url o con url en blanco: siempre el mismo error.
  assert.ok(validateSocialPost(null).error);
  assert.ok(validateSocialPost([]).error);
  assert.ok(validateSocialPost({}).error);
  assert.ok(validateSocialPost({ url: '   ' }).error);
  assert.ok(validateSocialPost({ url: 42 }).error);
});

test('en redes: la validación rechaza una URL de otra red', () => {
  const res = validateSocialPost({ url: 'https://facebook.com/tribuna/posts/1' });
  assert.ok(res.error);
  assert.match(res.error, /x\.com/);
});

test('en redes: las fijadas van primero y el tope se aplica después de ordenar', () => {
  const posts = [
    { url: 'https://x.com/a', creada: 1 },
    { url: 'https://x.com/b', destacada: true },
    { url: 'https://x.com/c' },
    { url: 'https://x.com/d', destacada: true },
    { url: 'https://x.com/e' },
    { url: 'https://x.com/f' },
    { url: 'https://x.com/g' },
    { url: 'https://x.com/h' }
  ];
  const out = selectSocialPosts(posts);
  assert.equal(out.length, 6);
  // Las dos fijadas entran sí o sí; el resto se completa con las más recientes.
  assert.deepEqual(out.slice(0, 2).map((p) => p.url), ['https://x.com/b', 'https://x.com/d']);
  assert.deepEqual(out.map((p) => p.url), [
    'https://x.com/b',
    'https://x.com/d',
    'https://x.com/a',
    'https://x.com/c',
    'https://x.com/e',
    'https://x.com/f'
  ]);
});

test('en redes: la selección tolera basura y una lista corta no inventa tarjetas', () => {
  assert.deepEqual(selectSocialPosts([]), []);
  assert.deepEqual(selectSocialPosts(null), []);
  // Sin url no hay nada que montar: se descarta en vez de romper el render.
  assert.deepEqual(selectSocialPosts([null, {}, { url: '' }]), []);
  assert.equal(selectSocialPosts([{ url: 'https://x.com/a' }]).length, 1);
  assert.equal(selectSocialPosts([{ url: 'https://x.com/a' }, { url: 'https://x.com/b' }], 1).length, 1);
});

test('en redes: el timeline está apagado salvo que se pida con un handle válido', () => {
  const originalEnabled = process.env.X_TIMELINE_ENABLED;
  const originalHandle = process.env.X_TIMELINE_HANDLE;
  try {
    delete process.env.X_TIMELINE_ENABLED;
    delete process.env.X_TIMELINE_HANDLE;
    assert.deepEqual(socialTimelineConfig(), { enabled: false, handle: '' });

    // Apagado aunque el handle sea bueno.
    process.env.X_TIMELINE_ENABLED = 'false';
    process.env.X_TIMELINE_HANDLE = 'tribunadepts';
    assert.equal(socialTimelineConfig().enabled, false);

    // Encendido pero sin handle (o con uno que no es handle) no arranca.
    process.env.X_TIMELINE_ENABLED = 'true';
    delete process.env.X_TIMELINE_HANDLE;
    assert.equal(socialTimelineConfig().enabled, false);
    process.env.X_TIMELINE_HANDLE = 'no es un handle';
    assert.equal(socialTimelineConfig().enabled, false);

    // La arroba se quita sola: en el embed va sin ella.
    process.env.X_TIMELINE_HANDLE = '@tribunadepts';
    assert.deepEqual(socialTimelineConfig(), { enabled: true, handle: 'tribunadepts' });
  } finally {
    if (originalEnabled === undefined) delete process.env.X_TIMELINE_ENABLED;
    else process.env.X_TIMELINE_ENABLED = originalEnabled;
    if (originalHandle === undefined) delete process.env.X_TIMELINE_HANDLE;
    else process.env.X_TIMELINE_HANDLE = originalHandle;
  }
});

test('en redes: GET público sin DB responde 500 JSON elegante', async () => {
  const res = await request(app).get('/api/social-posts');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('en redes: las rutas del panel responden 401 sin token', async () => {
  assert.equal((await request(app).get('/api/social-posts/manager')).status, 401);
  assert.equal(
    (await request(app).post('/api/social-posts').send({ url: 'https://x.com/a/status/1' })).status,
    401
  );
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal((await request(app).put(`/api/social-posts/${id}`).send({ destacada: true })).status, 401);
  assert.equal((await request(app).delete(`/api/social-posts/${id}`)).status, 401);
});

test('en redes: PUT y DELETE rechazan un id que no es UUID sin tocar la DB', async () => {
  const token = await loginToken();
  const id = 'no-es-un-uuid';
  const put = await request(app)
    .put(`/api/social-posts/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ destacada: true });
  assert.equal(put.status, 400);
  assert.match(put.body.error, /ID no válido/);

  const del = await request(app)
    .delete(`/api/social-posts/${id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(del.status, 400);
});

test('en redes: el PUT exige el campo destacada y no acepta cambiar la url', async () => {
  const token = await loginToken();
  const id = '11111111-1111-4111-8111-111111111111';
  const sinCampo = await request(app)
    .put(`/api/social-posts/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(sinCampo.status, 400);

  // Una URL nueva llega a la validación y se rechaza: cambiar el enlace es
  // borrar y pegar de nuevo, no editar la fila a medio hacer.
  const conUrl = await request(app)
    .post('/api/social-posts')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: 'https://facebook.com/tribuna/posts/1' });
  assert.equal(conUrl.status, 400);
});

test('en redes: loadSocialPostsPublic arroja sin DB para no mentir con caché', async () => {
  await assert.rejects(loadSocialPostsPublic());
});

// ============ Cliente (index.html) ============
// Estas reglas viven en el script inline, que ESLint no cubre. Se aísla el
// mismo bloque que ejecuta la página y se prueba suelto en un vm, igual que
// hace test/portada.test.js con las suyas.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SCRIPT = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');

function extractFunction(name) {
  const i = SCRIPT.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('no existe function ' + name);
  let depth = 0;
  let started = false;
  for (let j = SCRIPT.indexOf('{', i); j < SCRIPT.length; j++) {
    const c = SCRIPT[j];
    if (c === '{') {
      depth++;
      started = true;
    } else if (c === '}') {
      depth--;
      if (started && depth === 0) return SCRIPT.slice(i, j + 1);
    }
  }
  throw new Error('bloque sin cerrar: ' + name);
}

const CLIENT_SOURCE = [
  'const SOCIAL_NET_NAME = { x: "X", instagram: "Instagram" };',
  extractFunction('socialNetFromUrl'),
  extractFunction('socialNetOf'),
  extractFunction('socialFallbackMarkup')
].join('\n\n');

function clientSandbox() {
  return vm.runInNewContext(
    '(function () {\n' +
      CLIENT_SOURCE +
      '\nreturn { socialNetFromUrl, socialNetOf, socialFallbackMarkup };\n})()',
    // socialFallbackMarkup arma HTML usando escapeHtml; acá se le pasa una
    // versión mínima equivalente, que es lo que importa para las aserciones.
    { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;') }
  );
}

test('en redes (cliente): la red se lee del dominio aunque el servidor no la mande', () => {
  const { socialNetFromUrl, socialNetOf } = clientSandbox();
  assert.equal(socialNetFromUrl('https://x.com/tribunadepts/status/1'), 'x');
  assert.equal(socialNetFromUrl('https://www.twitter.com/tribunadepts/status/1'), 'x');
  assert.equal(socialNetFromUrl('https://www.instagram.com/p/ABC/'), 'instagram');
  assert.equal(socialNetFromUrl('https://instagr.am/p/ABC/'), 'instagram');
  assert.equal(socialNetFromUrl('https://facebook.com/tribuna'), null);
  assert.equal(socialNetFromUrl(''), null);
  assert.equal(socialNetFromUrl(undefined), null);

  // Con red ausente o corrupta, la URL manda: el enlace de respaldo tiene que
  // llevar a la red correcta aunque la fila venga mal formada.
  assert.equal(socialNetOf({ url: 'https://instagram.com/p/ABC/' }), 'instagram');
  assert.equal(socialNetOf({ url: 'https://x.com/a/status/1', red: 'instagram' }), 'x');
  assert.equal(socialNetOf({ url: '', red: 'instagram' }), 'instagram');
});

test('en redes (cliente): el respaldo nombra la red a la que llevar', () => {
  const { socialFallbackMarkup } = clientSandbox();
  const ig = socialFallbackMarkup({ url: 'https://instagram.com/p/ABC/' }, 'instagram');
  assert.match(ig, /Ver en Instagram/);
  assert.match(ig, /href="https:\/\/instagram\.com\/p\/ABC\/"/);

  const x = socialFallbackMarkup({ url: 'https://x.com/a/status/1' }, 'x');
  assert.match(x, /Ver en X/);
  assert.match(x, /href="https:\/\/x\.com\/a\/status\/1"/);
  assert.ok(!x.includes('Instagram'));
});