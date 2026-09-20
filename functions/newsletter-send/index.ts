// Newsletter semanal de TRIBUNA.
// Se dispara cada domingo desde pg_cron (via pg_net.http_post) con la
// cabecera `x-tribuna-cron` = CRON_SECRET. Selecciona las notas
// publicadas de los últimos 7 días (máx 5), envía un correo por
// suscriptor por la API transaccional de Brevo y audita el envío en
// public.newsletter_sends.
//
// Secrets (Dashboard > Edge Functions > newsletter-send > Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY,
//   NEWSLETTER_FROM (correo remitente verificado en Brevo),
//   NEWSLETTER_FROM_NAME (opcional, default "Tribuna"),
//   CRON_SECRET, SITE_URL (opcional).

const env = Deno.env.toObject();

const SUPABASE_URL = env.SUPABASE_URL || '';
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY || '';
const BREVO_API_KEY = env.BREVO_API_KEY || '';
const FROM_EMAIL = env.NEWSLETTER_FROM || '';
const FROM_NAME = env.NEWSLETTER_FROM_NAME || 'Tribuna';
const CRON_SECRET = env.CRON_SECRET || '';
const SITE_URL = env.SITE_URL || 'https://tribuna-idgt.onrender.com';

const MAX_NOTES = Number(env.MAX_NOTES || 5);
const WINDOW_DAYS = Number(env.WINDOW_DAYS || 7);

type NoteRow = {
  id: string;
  sport: string;
  title: string;
  intro: string;
  author: string;
  image?: string;
  created_at: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function supabaseFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}

async function getNotes(): Promise<NoteRow[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000).toISOString();
  const params = new URLSearchParams({
    select: 'id,sport,title,intro,author,image,created_at',
    'status': 'eq.publicada',
    'archived': 'eq.false',
    'created_at': `gte.${since}`,
    'order': 'created_at.desc',
    'limit': String(MAX_NOTES),
  });
  const res = await supabaseFetch(`/rest/v1/notes?${params.toString()}`);
  return await res.json() as NoteRow[];
}

async function getSubscribers(): Promise<string[]> {
  const params = new URLSearchParams({ select: 'email', 'confirmed': 'eq.true' });
  const res = await supabaseFetch(`/rest/v1/subscribers?${params.toString()}`);
  const rows = await res.json() as { email: string }[];
  return rows.map((r) => r.email);
}

function buildHtml(notes: NoteRow[]) {
  const items = notes
    .map((n: NoteRow) => {
      const url = `${SITE_URL}/#note-${n.id}`;
      const meta = [n.sport, n.author].filter(Boolean).join(' · ');
      return `
    <tr>
      <td style="padding:18px 0;border-bottom:1px solid #eee;">
        <a href="${url}" style="font-size:17px;font-weight:700;color:#A8321A;text-decoration:none;font-family:Arial,sans-serif;">${escapeHtml(n.title)}</a>
        <div style="margin-top:6px;font-size:13px;color:#8a8a8a;font-family:Arial,sans-serif;">${escapeHtml(meta)}</div>
        <p style="margin:8px 0 0;font-size:15px;line-height:1.5;color:#333;font-family:Arial,sans-serif;">${escapeHtml(n.intro)}</p>
        <a href="${url}" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:700;color:#A8321A;text-decoration:none;font-family:Arial,sans-serif;">Leer la historia →</a>
      </td>
    </tr>`;
    })
    .join('');

  return `<!doctype html><html lang="es">
<body style="margin:0;background:#f4f2ee;">
  <table role="presentation" width="100%" bgcolor="#f4f2ee" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr>
          <td style="background:#1a1a1a;padding:28px 32px;">
            <h1 style="margin:0;font-size:22px;color:#ffffff;font-family:Arial,sans-serif;">TRIBUNA</h1>
            <p style="margin:6px 0 0;font-size:13px;color:#cfcfcf;font-family:Arial,sans-serif;">Lo mejor de la semana · periodismo deportivo con contexto</p>
          </td>
        </tr>
        <tr><td style="padding:8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
        </td></tr>
        <tr>
          <td style="padding:24px 32px;background:#faf9f7;">
            <p style="margin:0;font-size:12px;color:#8a8a8a;font-family:Arial,sans-serif;">Recibes este correo porque te suscribiste al boletín de Tribuna.</p>
            <p style="margin:8px 0 0;font-size:12px;color:#8a8a8a;font-family:Arial,sans-serif;"><a href="${escapeHtml(unsubscribeUrlFor('EMAIL_PLACEHOLDER'))}" style="color:#A8321A;text-decoration:none;">Darme de baja</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function unsubscribeUrlFor(email: string): string {
  return `${SITE_URL}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}`;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s || '').replace(/[&<>"']/g, (c) => map[c] ?? c);
}

async function sendEmail(subject: string, html: string, email: string) {
  const body = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email }],
    subject,
    htmlContent: html.replace('EMAIL_PLACEHOLDER', email),
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrlFor(email)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  const results = new Array<Promise<void>>(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(workers);
  await Promise.all(results);
}

async function audit(weekStart: string, notesCount: number, recipientsCount: number, status: string, error: string | null) {
  try {
    await supabaseFetch('/rest/v1/newsletter_sends', {
      method: 'POST',
      body: JSON.stringify({ week_start: weekStart, notes_count: notesCount, recipients_count: recipientsCount, status, error: error || null }),
      headers: { Prefer: 'return=minimal' },
    });
  } catch (e) {
    console.error('No se pudo auditar el envío:', msg(e));
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
  if (!CRON_SECRET || req.headers.get('x-tribuna-cron') !== CRON_SECRET) {
    return json({ error: 'No autorizado.' }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_ROLE || !BREVO_API_KEY || !FROM_EMAIL) {
    return json({ error: 'Configuración incompleta: revisa los secrets de la función.' }, 500);
  }

  const weekStart = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000).toISOString().slice(0, 10);

  try {
    const [notes, subscribers] = await Promise.all([getNotes(), getSubscribers()]);

    if (!notes.length || !subscribers.length) {
      await audit(weekStart, notes.length, 0, 'ok', `sin notas (${notes.length}) o sin suscriptores (${subscribers.length})`);
      return json({ ok: true, notes: notes.length, recipients: 0, message: 'Nada que enviar.' });
    }

    const html = buildHtml(notes);
    const subject = `Tribuna · Lo mejor de esta semana`;
    let sent = 0;
    const errors: string[] = [];

    await mapLimit(subscribers, 10, async (email) => {
      try {
        await sendEmail(subject, html, email);
        sent += 1;
      } catch (e) {
        errors.push(`${email}: ${msg(e)}`);
      }
    });

    const status = errors.length === 0 ? 'ok' : errors.length === subscribers.length ? 'error' : 'parcial';
    const errorMsg = errors.length ? errors.join(' | ').slice(0, 4000) : null;
    await audit(weekStart, notes.length, subscribers.length, status, errorMsg);

    return json({ ok: status === 'ok' || status === 'parcial', notes: notes.length, recipients: subscribers.length, sent, failed: errors.length, error: errorMsg });
  } catch (e) {
    console.error('Newsletter falló:', msg(e));
    try { await audit(weekStart, 0, 0, 'error', msg(e).slice(0, 4000)); } catch {}
    return json({ error: msg(e) }, 500);
  }
});