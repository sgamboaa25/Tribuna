const { spawn } = require('child_process');
const path = require('path');

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'testpass';
const WRONG = 'wrongpass';

let failures = 0;
const stderrLines = [];

function report(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

async function post(p, body, headers) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}

async function waitReady(child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(BASE + '/robots.txt');
      if (r.status) return true;
    } catch {}
    await new Promise(res => setTimeout(res, 200));
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      SUPABASE_URL: 'http://127.0.0.1:9',
      SUPABASE_SERVICE_ROLE_KEY: 'solo-para-pruebas-no-es-secreto',
      WRITER_PASSWORD: SECRET
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', d => stderrLines.push(String(d)));

  if (!(await waitReady(child))) {
    console.error('FAIL | el servidor no arrancó. stderr:\n' + stderrLines.join(''));
    process.exit(1);
  }

  const good = { email: 'editor@tribuna.test', password: SECRET };
  const bad = { email: 'editor@tribuna.test', password: WRONG };

  const robotsRes = await fetch(BASE + '/robots.txt');
  const robots = await robotsRes.text();
  report('robots.txt 200 + referencia sitemap', robotsRes.status === 200 && robots.includes('/sitemap.xml'), 'status=' + robotsRes.status);

  const smRes = await fetch(BASE + '/sitemap.xml');
  const sm = await smRes.text();
  report('sitemap sin DB real -> XML minimo valido 200', smRes.status === 200 && sm.includes('<urlset'), 'status=' + smRes.status);
  report('sitemap sin anclas #note- (Google no las indexa)', !sm.includes('#note-'), 'tiene=#note-');

  // --- Google News ---
  // El alta en Google News Publisher Center pide este archivo. Se comprueba la
  // estructura aunque no haya notas: un XML vacio pero bien formado es el
  // estado correcto con la base de datos caida, y no un 500.
  const nsmRes = await fetch(BASE + '/news-sitemap.xml');
  const nsm = await nsmRes.text();
  report('news-sitemap.xml 200 + namespace de Google News',
    nsmRes.status === 200 &&
      nsm.includes('xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"') &&
      nsm.includes('<urlset') &&
      nsm.includes('</urlset>'),
    'status=' + nsmRes.status);
  // Un news sitemap con lastmod/changefreq/priority es un XML invalido para
  // Google: esos campos solo existen en el sitemap normal.
  report('news-sitemap.xml sin lastmod/changefreq/priority',
    !nsm.includes('<lastmod>') && !nsm.includes('<changefreq>') && !nsm.includes('<priority>'),
    'trae campos del sitemap normal');
  report('news-sitemap.xml sin anclas #note-', !nsm.includes('#note-'), 'tiene=#note-');
  report('robots.txt declara tambien el news sitemap', robots.includes('/news-sitemap.xml'), 'falta en robots.txt');

  // El RSS y la API publica comparten el mismo dato que el sitemap: si uno se
  // queda con "/#note-<id>", el enlace plano vuelve a apuntar a la portada.
  const rss = await (await fetch(BASE + '/rss.xml')).text();
  report('rss sin anclas #note-', !rss.includes('#note-'), 'tiene=#note-');
  // Con la base de datos caida el feed puede no traer items, y eso es correcto:
  // lo que no se puede es afirmar sobre URLs que no estan ahi.
  const rssItems = (rss.match(/<item>/g) || []).length;
  report('rss usa las URLs de nota (solo si trae items)',
    rssItems === 0 || rss.includes('/nota/'),
    'items=' + rssItems + ' con/nota/=' + rss.includes('/nota/'));

  // --- SEO: iconos, metadatos por ruta y JSON-LD ---
  // Antes /favicon.ico caia en el catch-all de la SPA y devolvia index.html,
  // por eso el navegador (y el service worker) lo guardaban como una pagina.
  const ico = await fetch(BASE + '/favicon.ico');
  const icoType = ico.headers.get('content-type') || '';
  const icoBody = Buffer.from(await ico.arrayBuffer());
  report('favicon.ico -> imagen real, no el HTML de la SPA',
    ico.status === 200 && /image\//.test(icoType) && icoBody.subarray(0, 4).toString('latin1') !== '<!DO',
    'status=' + ico.status + ' ct=' + icoType);
  report('favicon.ico declara tamano real (multiples entradas)',
    icoBody.readUInt16LE(2) === 1 && icoBody.readUInt16LE(4) >= 3, 'entradas=' + icoBody.readUInt16LE(4));

  for (const alias of ['/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']) {
    const a = await fetch(BASE + alias);
    const at = a.headers.get('content-type') || '';
    report('alias ' + alias + ' -> imagen 200', a.status === 200 && /image\//.test(at), 'status=' + a.status + ' ct=' + at);
  }

  const home = await fetch(BASE + '/');
  const homeHtml = await home.text();
  report('portada: HTML sin cache para que Google no lea una copia vieja',
    /no-store/.test(home.headers.get('cache-control') || ''), 'cc=' + home.headers.get('cache-control'));
  report('portada: <title> no vacio en la respuesta inicial',
    /<title>\s*[^<\s][^<]*<\/title>/.test(homeHtml), 'sin title');

  // El JSON-LD tiene que venir en el HTML inicial, no solo despues de que
  // corra el script del cliente.
  const ldMatch = homeHtml.match(/<script type="application\/ld\+json" id="schemaScript">([\s\S]*?)<\/script>/);
  let ldTypes = '';
  if (ldMatch) { try { ldTypes = JSON.parse(ldMatch[1]).map((x) => x['@type']).join('+'); } catch (e) { ldTypes = 'JSON invalido'; } }
  report('portada: JSON-LD en el HTML inicial y parseable', ldTypes.includes('WebSite'), 'tipos=' + (ldTypes || 'ausente'));

  // Cada ruta fija su propio canonical. Si todas apuntan a la raiz, Google
  // descarta /categoria/futbol, /quienes-somos, etc. por duplicado.
  for (const [ruta, esperado] of [['/categoria/futbol', 'Noticias de Fútbol'], ['/quienes-somos', 'Quiénes somos'], ['/etiquetas', 'Etiquetas']]) {
    const p = await fetch(BASE + ruta);
    const html = await p.text();
    const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '';
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    report('ruta ' + ruta + ': canonical propio + title propio',
      canon.endsWith(ruta) && title.includes(esperado), 'canon=' + canon + ' title=' + title);
  }

  const nota = await fetch(BASE + '/nota/11111111-2222-3333-4444-555555555555');
  report('ruta /nota/:id cae en la SPA (200 html)',
    nota.status === 200 && /text\/html/.test(nota.headers.get('content-type') || ''), 'status=' + nota.status);

  // La ruta del plugin esta escrita a mano en index.html. Si se mueve el archivo
  // y nadie actualiza la etiqueta, los botones de compartir quedan mudos y solo
  // se nota en produccion.
  const share = await fetch(BASE + '/public/plugins/share.js');
  const shareBody = await share.text();
  report('plugin share.js se sirve y el HTML lo carga',
    share.status === 200 &&
      /javascript/.test(share.headers.get('content-type') || '') &&
      /register\('share'/.test(shareBody) &&
      homeHtml.includes('/public/plugins/share.js'),
    'status=' + share.status + ' ct=' + share.headers.get('content-type'));

  let r = await post('/api/newsletter/subscribe', { email: 'bot@bot.com', website: 'http://spam.example' }, {});
  report('newsletter honeypot: 201 ok sin guardar', r.status === 201 && r.data.ok === true, 'status=' + r.status);

  r = await post('/api/newsletter/subscribe', { email: 'no-es-email', website: '' }, {});
  report('newsletter email invalido: 400', r.status === 400, 'status=' + r.status);

  let blocked = false, status6 = null;
  for (let i = 0; i < 6; i++) {
    const r2 = await post('/api/auth', bad, { 'X-Forwarded-For': '7.7.7.7' });
    status6 = r2.status;
    if (r2.status === 429) { blocked = true; break; }
  }
  report('login: 5 fallos -> 6to intento bloqueado (misma IP)', blocked && status6 === 429, 'status6=' + status6);

  r = await post('/api/auth', bad, { 'X-Forwarded-For': '8.8.8.8' });
  report('login: email bloqueado desde otra IP', r.status === 429, 'status=' + r.status);

  r = await post('/api/auth', good, { 'X-Forwarded-For': '9.9.9.9' });
  report('login: email bloqueado -> aun con clave correcta 429', r.status === 429, 'status=' + r.status);

  const ok2 = await post('/api/auth', { email: 'otro@tribuna.test', password: WRONG }, { 'X-Forwarded-For': '10.0.0.1' });
  const ok3 = await post('/api/auth', { email: 'otro@tribuna.test', password: SECRET }, { 'X-Forwarded-For': '10.0.0.1' });
  report('login: 1 fallo + acierto -> 200 + token', ok2.status === 401 && ok3.status === 200 && !!ok3.data.token, 'fail=' + ok2.status + ' ok=' + ok3.status);

  r = await post('/api/auth', { email: 'limpi@tribuna.test', password: SECRET }, { 'X-Forwarded-For': '9.9.9.9' });
  report('login correcto (email limpio): 200 + token', r.status === 200 && !!r.data.token, 'status=' + r.status);

  const wRes = await fetch(BASE + '/widget/posiciones');
  const w = await wRes.text();
  const frameOk = wRes.status === 200 &&
    !wRes.headers.get('x-frame-options') &&
    /frame-ancestors\s+\*/i.test(wRes.headers.get('content-security-policy') || '') &&
    w.includes('Datos por Tribuna');
  report('widget posiciones: HTML 200, sin X-Frame-Options, frame-ancestors * y crédito', frameOk, 'status=' + wRes.status);

  const w2 = await fetch(BASE + '/widget/posiciones?liga=pd');
  report('widget posiciones con ?liga=pd 200', w2.status === 200, 'status=' + w2.status);

  const teamsRes = await fetch(BASE + '/api/teams');
  report('/api/teams sin DB real -> 500 JSON', teamsRes.status === 500, 'status=' + teamsRes.status);

  const hubRes = await fetch(BASE + '/equipo/alajuelense');
  report('ruta /equipo/:slug devuelve index.html (SPA)', hubRes.status === 200 && hubRes.headers.get('content-type')?.includes('text/html'), 'status=' + hubRes.status + ' ct=' + hubRes.headers.get('content-type'));

  const playerRes = await fetch(BASE + '/jugador/christian-bolanos');
  report('ruta /jugador/:slug devuelve index.html (SPA)', playerRes.status === 200 && playerRes.headers.get('content-type')?.includes('text/html'), 'status=' + playerRes.status + ' ct=' + playerRes.headers.get('content-type'));

  const smBody = await fetch(BASE + '/sitemap.xml').then(r => r.text());
  report('sitemap incluye /mercado, /videos y /etiquetas', smBody.includes('/mercado') && smBody.includes('/videos') && smBody.includes('/etiquetas'), 'mercado=' + smBody.includes('/mercado') + ' videos=' + smBody.includes('/videos') + ' etiquetas=' + smBody.includes('/etiquetas'));

  const playerRes2 = await fetch(BASE + '/etiquetas');
  report('ruta /etiquetas devuelve index.html (SPA)', playerRes2.status === 200 && playerRes2.headers.get('content-type')?.includes('text/html'), 'status=' + playerRes2.status);

  const tagRes = await fetch(BASE + '/tag/municipal');
  report('ruta /tag/:slug devuelve index.html (SPA)', tagRes.status === 200 && tagRes.headers.get('content-type')?.includes('text/html'), 'status=' + tagRes.status);

  const mercadoRes = await fetch(BASE + '/mercado');
  report('ruta /mercado devuelve index.html (SPA)', mercadoRes.status === 200 && mercadoRes.headers.get('content-type')?.includes('text/html'), 'status=' + mercadoRes.status);

  // El feed no puede generarse sin DB, pero tampoco debe caer al catch-all de la
  // SPA: si devolviera index.html con status 200, cualquier agregador guardaría
  // HTML como si fuera un canal RSS.
  const rssRes = await fetch(BASE + '/rss.xml');
  report('/rss.xml sin DB real -> 503 (no HTML de la SPA)', rssRes.status === 503 && !rssRes.headers.get('content-type')?.includes('text/html'), 'status=' + rssRes.status + ' ct=' + rssRes.headers.get('content-type'));

  const rssRedirect = await fetch(BASE + '/feed', { redirect: 'manual' });
  report('/feed redirige 301 a /rss.xml', rssRedirect.status === 301 && rssRedirect.headers.get('location') === '/rss.xml', 'status=' + rssRedirect.status);

  // El contador de lecturas valida el UUID antes de tocar la DB: un id basura
  // devuelve 400, no 500.
  const viewBad = await post('/api/notes/no-es-uuid/view', {}, {});
  report('POST /api/notes/:id/view con id invalido -> 400', viewBad.status === 400, 'status=' + viewBad.status);

  const rumorsPublic = await fetch(BASE + '/api/rumors');
  report('/api/rumors sin DB real -> 500 JSON', rumorsPublic.status === 500, 'status=' + rumorsPublic.status);

  const rumorsManager = await fetch(BASE + '/api/rumors/manager');
  report('/api/rumors/manager sin token -> 401', rumorsManager.status === 401, 'status=' + rumorsManager.status);

  const fotoHoneypot = await post('/api/reader-photos', { autor: 'Bot', foto: 'https://x.example/f.jpg', website: 'http://spam.example' }, {});
  report('foto lector honeypot: 201 ok sin guardar', fotoHoneypot.status === 201 && fotoHoneypot.data.ok === true, 'status=' + fotoHoneypot.status);

  const fotosManager = await fetch(BASE + '/api/reader-photos/manager');
  report('/api/reader-photos/manager sin token -> 401', fotosManager.status === 401, 'status=' + fotosManager.status);

  const settingsPublic = await fetch(BASE + '/api/settings/public');
  report('/api/settings/public sin DB real -> 500 JSON', settingsPublic.status === 500, 'status=' + settingsPublic.status);

  const settingsPut = await fetch(BASE + '/api/settings', { method: 'PUT', body: '{"next_transfer_window":"x"}' });
  report('/api/settings PUT sin token -> 401', settingsPut.status === 401, 'status=' + settingsPut.status);

  const socialPublic = await fetch(BASE + '/api/social-posts');
  report('/api/social-posts sin DB real -> 500 JSON', socialPublic.status === 500, 'status=' + socialPublic.status);

  const socialManager = await fetch(BASE + '/api/social-posts/manager');
  report('/api/social-posts/manager sin token -> 401', socialManager.status === 401, 'status=' + socialManager.status);

  const socialPost = await post('/api/social-posts', { url: 'https://facebook.com/tribuna/posts/1' }, {});
  report('POST /api/social-posts sin token -> 401', socialPost.status === 401, 'status=' + socialPost.status);

  // La CSP tiene que dejar pasar los embeds de X e Instagram; si se toca la
  // lista de helmet sin acordarse de esto, la sección "En redes" se queda en
  // blanco sin que nada falle visiblemente.
  const cspRes = await fetch(BASE + '/');
  const csp = cspRes.headers.get('content-security-policy') || '';
  report(
    'CSP permite widgets.js de X y embed.js de Instagram',
    /script-src[^;]*platform\.twitter\.com/i.test(csp) && /script-src[^;]*instagram\.com/i.test(csp) &&
      /frame-src[^;]*(platform|syndication)\.twitter\.com/i.test(csp) && /frame-src[^;]*instagram\.com/i.test(csp),
    'csp=' + csp.slice(0, 160)
  );

  const promericaPub = await fetch(BASE + '/api/standings/promerica');
  report('/api/standings/promerica sin DB real -> 500 JSON', promericaPub.status === 500, 'status=' + promericaPub.status);

  const promericaAdmin = await fetch(BASE + '/api/standings/promerica/admin');
  report('/api/standings/promerica/admin sin token -> 401', promericaAdmin.status === 401, 'status=' + promericaAdmin.status);

  const promericaPut = await fetch(BASE + '/api/standings/promerica', { method: 'PUT', body: '{"rows":[]}' });
  report('/api/standings/promerica PUT sin token -> 401', promericaPut.status === 401, 'status=' + promericaPut.status);

  const scorersPromPub = await fetch(BASE + '/api/top-scorers/promerica');
  report('/api/top-scorers/promerica sin DB real -> 500 JSON', scorersPromPub.status === 500, 'status=' + scorersPromPub.status);

  const scorersPromAdmin = await fetch(BASE + '/api/top-scorers/promerica/admin');
  report('/api/top-scorers/promerica/admin sin token -> 401', scorersPromAdmin.status === 401, 'status=' + scorersPromAdmin.status);

  const scorersPromPut = await fetch(BASE + '/api/top-scorers/promerica', { method: 'PUT', body: '{"rows":[]}' });
  report('/api/top-scorers/promerica PUT sin token -> 401', scorersPromPut.status === 401, 'status=' + scorersPromPut.status);

  child.kill();
  await new Promise(res => setTimeout(res, 300));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('TEST CRASH', e.message || e, '\nstderr:\n' + stderrLines.join(''));
  process.exit(1);
});