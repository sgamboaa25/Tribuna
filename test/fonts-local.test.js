const request = require('supertest');

// Reusa la app sin levantarla en un puerto: mismo módulo que server.js.
const server = require('../server.js');

const FONTES = [
  'fraunces-latin.woff2',
  'fraunces-latin-ext.woff2',
  'fraunces-italic-latin.woff2',
  'fraunces-italic-latin-ext.woff2',
  'inter-latin.woff2',
  'inter-latin-ext.woff2'
];

(async () => {
  let fallos = 0;
  const ok = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} | ${msg}`);
    if (!cond) fallos++;
  };

  for (const f of FONTES) {
    const r = await request(server).get(`/public/fonts/${f}`);
    ok(
      r.status === 200 &&
        /font\/woff2/.test(r.headers['content-type']) &&
        r.body.length > 1000,
      `fuente ${f} se sirve como woff2 | status=${r.status} ct=${r.headers['content-type']} bytes=${r.body.length}`
    );
  }

  const html = await request(server).get('/');
  const body = html.text;
  // Solomiramos el markup: los comentarios que explican por qué ya no se
  // cargan desde Google pueden nombrar el dominio sin pedirle nada.
  const pide = (re) => (body.match(re) || []).length > 0;
  ok(!pide(/(?:src|href)\s*=\s*["'][^"']*fonts\.googleapis\.com/i), 'el HTML no enlaza a fonts.googleapis.com');
  ok(!pide(/(?:src|href)\s*=\s*["'][^"']*fonts\.gstatic\.com/i), 'el HTML no enlaza a fonts.gstatic.com');
  ok(!pide(/@import[^;]*fonts\.(googleapis|gstatic)\.com/i), 'el CSS no importa nada del CDN de Google');
  ok(
    (body.match(/\/public\/fonts\/[a-z-]+\.woff2/g) || []).length >= 6,
    'el CSS inline declara las 6 fuentes locales'
  );

  const csp = html.headers['content-security-policy'];
  ok(!csp.includes('fonts.gstatic.com'), 'la CSP principal ya no abre font-src a Google');
  ok(csp.includes("font-src 'self'"), 'la CSP principal deja font-src en self');

  const widget = await request(server).get('/widget/posiciones');
  ok(
    !/(?:src|href)\s*=\s*["'][^"']*fonts\.(googleapis|gstatic)\.com/i.test(widget.text),
    'el widget ya no enlaza al CDN de Google Fonts'
  );
  ok(
    !widget.headers['content-security-policy'].includes('fonts.gstatic.com'),
    'la CSP del widget ya no abre font-src a Google'
  );

  console.log(fallos ? `\n${fallos} FAIL` : '\nALL PASS');
  process.exit(fallos ? 1 : 0);
})().catch((err) => {
  console.error('fallo la comprobación:', err);
  process.exit(1);
});