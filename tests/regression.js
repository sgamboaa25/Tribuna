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

  const rumorsPublic = await fetch(BASE + '/api/rumors');
  report('/api/rumors sin DB real -> 500 JSON', rumorsPublic.status === 500, 'status=' + rumorsPublic.status);

  const rumorsManager = await fetch(BASE + '/api/rumors/manager');
  report('/api/rumors/manager sin token -> 401', rumorsManager.status === 401, 'status=' + rumorsManager.status);

  const fotoHoneypot = await post('/api/reader-photos', { autor: 'Bot', foto: 'https://x.example/f.jpg', website: 'http://spam.example' }, {});
  report('foto lector honeypot: 201 ok sin guardar', fotoHoneypot.status === 201 && fotoHoneypot.data.ok === true, 'status=' + fotoHoneypot.status);

  const fotosManager = await fetch(BASE + '/api/reader-photos/manager');
  report('/api/reader-photos/manager sin token -> 401', fotosManager.status === 401, 'status=' + fotosManager.status);

  child.kill();
  await new Promise(res => setTimeout(res, 300));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('TEST CRASH', e.message || e, '\nstderr:\n' + stderrLines.join(''));
  process.exit(1);
});