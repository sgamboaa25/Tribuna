require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://cdn.jsdelivr.net',
          'https://cdnjs.cloudflare.com',
          "'unsafe-inline'"
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://jmsjbbubhyszrbgqrfio.supabase.co', 'https://*.supabase.co'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: []
      }
    }
  })
);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 400,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en unos minutos.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Espera unos minutos.' }
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones de escritura. Intenta de nuevo.' }
});

const standingsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo.' }
});

const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas suscripciones. Espera unos minutos.' }
});

app.use(express.json({ limit: '10mb' }));

app.use('/api/', globalLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/notes', writeLimiter);
app.use('/api/standings', standingsLimiter);
app.use('/api/newsletter', newsletterLimiter);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Faltan variables de entorno de Supabase. Copia .env.example a .env y completa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (service-role: Supabase > Settings > API keys).'
  );
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const activeSessions = new Map();

const loginAttempts = new Map();
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function loginClientKey(req) {
  return `ip::${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

function loginEmailKey(email) {
  return `mail::${String(email || '')
    .trim()
    .toLowerCase()}`;
}

function loginState(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec) return { blocked: false, failures: 0 };
  if (rec.blockedUntil && now < rec.blockedUntil) {
    return { blocked: true, retryAfter: Math.ceil((rec.blockedUntil - now) / 1000) };
  }
  if (now - rec.firstFailAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return { blocked: false, failures: 0 };
  }
  return { blocked: false, failures: rec.failures };
}

function registerLoginFailure(key) {
  const now = Date.now();
  let rec = loginAttempts.get(key);
  if (
    !rec ||
    now - rec.firstFailAt >= LOGIN_WINDOW_MS ||
    (rec.blockedUntil && now >= rec.blockedUntil)
  ) {
    rec = { failures: 0, firstFailAt: now };
  }
  rec.failures += 1;
  if (rec.failures >= LOGIN_MAX_FAILURES) {
    rec.blockedUntil = now + LOGIN_BLOCK_MS;
    rec.firstFailAt = now;
  }
  loginAttempts.set(key, rec);
}

function clearLoginState(key) {
  loginAttempts.delete(key);
}

const authenticateWriter = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acceso no autorizado: Token faltante.' });
  }

  const token = authHeader.split(' ')[1];
  const session = activeSessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    activeSessions.delete(token);
    return res.status(401).json({ error: 'Sesión expirada o no válida. Inicia sesión de nuevo.' });
  }

  req.writer = session.email;
  next();
};

const NOTE_ALLOWED_FIELDS = [
  'title',
  'sport',
  'intro',
  'author',
  'email',
  'tags',
  'body',
  'status',
  'urgent',
  'image',
  'reactions',
  'video_url'
];
const REQUIRED_FIELDS = ['title', 'sport', 'intro', 'author', 'email', 'body'];
const NOTE_LENGTHS = {
  title: 200,
  sport: 60,
  intro: 500,
  author: 120,
  email: 120,
  tags: 300,
  body: 100000,
  image: 500,
  video_url: 500
};
const VALID_STATUSES = ['borrador', 'en revisión', 'publicada'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'a',
  'img',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'figure',
  'figcaption',
  'span',
  'div'
];
const BODY_ALLOWED_ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  blockquote: ['class'],
  div: ['class'],
  span: ['class'],
  strong: ['class']
};
const SCORE_CLASSES = ['match-score', 'ms-team', 'ms-result', 'ms-meta'];
const POLL_QUESTION_MAX = 140;
const POLL_OPTION_MAX = 80;

function normalizePoll(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.question !== 'string') return null;
  const question = sanitizeText(value.question).slice(0, POLL_QUESTION_MAX);
  if (!question) return null;
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) {
    return null;
  }
  const options = value.options
    .map((o) => sanitizeText(o).slice(0, POLL_OPTION_MAX))
    .filter(Boolean);
  if (options.length < 2) return null;
  return { question, options };
}

function validatePollVotes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const votes = {};
  for (const k of Object.keys(value)) {
    if (Number.isNaN(Number(k))) return null;
    const n = Number(value[k]);
    if (!Number.isInteger(n) || n < 0) return null;
    votes[k] = n;
  }
  return votes;
}

function mapNoteToPublicApi(note, baseUrl) {
  const id = note && note.id;
  return {
    id,
    titulo: (note && note.title) || '',
    entradilla: (note && note.intro) || '',
    categoria: (note && note.sport) || '',
    autor: (note && note.author) || '',
    fecha: note && note.created_at ? new Date(note.created_at).toISOString() : null,
    link: id ? `${baseUrl}/#note-${id}` : null
  };
}

function restrictClasses(html) {
  const allowed = new Set(SCORE_CLASSES);
  return html.replace(/\sclass="([^"]*)"/g, (match, cls) => {
    const kept = cls
      .split(/\s+/)
      .filter((c) => allowed.has(c))
      .join(' ');
    return kept ? ` class="${kept}"` : '';
  });
}

function sanitizeText(value) {
  return sanitizeHtml(String(value), { allowedTags: [], allowedAttributes: {} }).trim();
}

function sanitizeBody(value) {
  return restrictClasses(
    sanitizeHtml(String(value), {
      allowedTags: BODY_ALLOWED_TAGS,
      allowedAttributes: BODY_ALLOWED_ATTRS,
      transformTags: {
        a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' })
      }
    })
  );
}

function validateNote(body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Cuerpo de petición inválido.' };
  }

  if (!partial) {
    for (const field of REQUIRED_FIELDS) {
      if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') {
        return { error: `Campo requerido: ${field}.` };
      }
    }
  }

  const clean = {};
  for (const key of Object.keys(body)) {
    if (!NOTE_ALLOWED_FIELDS.includes(key)) continue;
    clean[key] = body[key];
  }

  for (const field of [
    'title',
    'sport',
    'intro',
    'author',
    'email',
    'tags',
    'image',
    'video_url'
  ]) {
    if (clean[field] === undefined) continue;
    if (typeof clean[field] !== 'string') return { error: `El campo ${field} debe ser texto.` };
    clean[field] =
      field === 'email' || field === 'image' || field === 'video_url'
        ? clean[field].trim()
        : sanitizeText(clean[field]);
    if (clean[field] === '' && field !== 'tags' && field !== 'image' && field !== 'video_url') {
      return { error: `El campo ${field} no puede estar vacío.` };
    }
    if (clean[field].length > NOTE_LENGTHS[field]) {
      return {
        error: `El campo ${field} supera la longitud máxima permitida (${NOTE_LENGTHS[field]} caracteres).`
      };
    }
  }

  if (clean.email !== undefined && !EMAIL_RE.test(clean.email)) {
    return { error: 'El correo electrónico no es válido.' };
  }

  if (clean.image !== undefined && clean.image !== '') {
    try {
      const url = new URL(clean.image);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    } catch {
      return { error: 'La URL de la imagen no es válida.' };
    }
  }

  if (clean.video_url !== undefined && clean.video_url !== '') {
    try {
      const url = new URL(clean.video_url);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !/\.mp4$/i.test(url.pathname))
        throw new Error();
    } catch {
      return { error: 'La URL del video no es válida (debe apuntar a un archivo MP4).' };
    }
  }
  if (clean.video_url === '') delete clean.video_url;

  if (clean.body !== undefined) {
    if (typeof clean.body !== 'string') return { error: 'El cuerpo de la nota debe ser texto.' };
    clean.body = sanitizeBody(clean.body);
    if (clean.body.length > NOTE_LENGTHS.body) {
      return { error: 'El cuerpo de la nota supera la longitud máxima permitida.' };
    }
  }

  if (clean.status !== undefined && !VALID_STATUSES.includes(clean.status)) {
    return { error: 'Estado editorial no válido.' };
  }
  if (clean.status === undefined && !partial) clean.status = 'borrador';

  if (clean.urgent !== undefined) clean.urgent = Boolean(clean.urgent);

  if (clean.reactions !== undefined) {
    if (
      typeof clean.reactions !== 'object' ||
      clean.reactions === null ||
      Array.isArray(clean.reactions)
    ) {
      return { error: 'Reacciones no válidas.' };
    }
    const r = {};
    for (const k of ['clap', 'wow', 'angry']) {
      r[k] = Number(clean.reactions[k]) || 0;
      if (r[k] < 0) return { error: 'Reacciones no válidas.' };
    }
    const poll = normalizePoll(clean.reactions.poll);
    if (clean.reactions.poll !== undefined && poll === null) {
      return { error: 'Encuesta no válida: pregunta y entre 2 y 4 opciones.' };
    }
    if (poll) r.poll = poll;
    if (clean.reactions.poll_votes !== undefined) {
      const votes = validatePollVotes(clean.reactions.poll_votes);
      if (votes === null) return { error: 'Votos de la encuesta no válidos.' };
      r.poll_votes = votes;
    }
    clean.reactions = r;
  }

  if (Object.keys(clean).length === 0) {
    return { error: 'No se enviaron campos válidos para guardar.' };
  }

  return { data: clean };
}

app.post('/api/auth', (req, res) => {
  const serverPassword = process.env.WRITER_PASSWORD;
  if (!serverPassword) {
    return res.status(500).json({ error: 'Configuración interna del servidor incompleta.' });
  }

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  const ipKey = loginClientKey(req);
  const emailKey = email ? loginEmailKey(email) : null;

  const ipState = loginState(ipKey);
  if (ipState.blocked) {
    return res.status(429).json({
      error: 'Demasiados intentos de acceso. Espera unos minutos.',
      retryAfter: ipState.retryAfter
    });
  }
  if (emailKey) {
    const emailState = loginState(emailKey);
    if (emailState.blocked) {
      return res.status(429).json({
        error: 'Demasiados intentos para esta cuenta. Espera unos minutos.',
        retryAfter: emailState.retryAfter
      });
    }
  }

  if (!email || !password || password !== serverPassword) {
    registerLoginFailure(ipKey);
    if (emailKey) registerLoginFailure(emailKey);
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }

  clearLoginState(ipKey);
  if (emailKey) clearLoginState(emailKey);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;

  activeSessions.set(token, { email, expiresAt });

  return res.json({ token, expiresAt });
});

// GET Público: Obtiene solo las notas publicadas
app.get('/api/notes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('status', 'publicada')
      .eq('archived', false)
      .order('id', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Categoría Pública
app.get('/api/notes/category/:sport', async (req, res) => {
  const sportParam = req.params.sport.toLowerCase().replace(/-/g, ' ');

  try {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('status', 'publicada')
      .eq('archived', false)
      .order('id', { ascending: false });

    if (error) throw error;

    const filtered = (data || []).filter((note) => {
      const noteSport = (note.sport || note.deporte || '').toLowerCase();
      return (
        noteSport.normalize('NFD').replace(/[\u0300-\u036f]/g, '') ===
        sportParam.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      );
    });

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Etiqueta Pública
app.get('/api/notes/tag/:tag', async (req, res) => {
  const tagParam = req.params.tag.toLowerCase().replace(/-/g, ' ');

  try {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('status', 'publicada')
      .eq('archived', false)
      .order('id', { ascending: false });

    if (error) throw error;

    const filtered = (data || []).filter((note) => {
      const tags = (note.tags || note.etiquetas || '').toLowerCase();
      return tags.includes(tagParam);
    });

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Autor Público
app.get('/api/notes/author/:author', async (req, res) => {
  const authorParam = req.params.author.toLowerCase().replace(/-/g, ' ');

  try {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('status', 'publicada')
      .eq('archived', false)
      .order('id', { ascending: false });

    if (error) throw error;

    const filtered = (data || []).filter((note) => {
      const author = (note.author || note.autor || '').toLowerCase();
      return (
        author.normalize('NFD').replace(/[\u0300-\u036f]/g, '') ===
        authorParam.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      );
    });

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Búsqueda Pública
app.get('/api/notes/search', async (req, res) => {
  const term = (req.query.q || '').trim().toLowerCase();
  const sport = (req.query.sport || '').trim().toLowerCase();

  try {
    let query = supabase.from('notes').select('*').eq('status', 'publicada').eq('archived', false);

    if (sport) {
      query = query.ilike('sport', sport);
    }

    const { data, error } = await query.order('id', { ascending: false });
    if (error) throw error;

    let results = data || [];
    if (term) {
      results = results.filter((note) => {
        const title = (note.title || note.titulo || '').toLowerCase();
        const intro = (note.intro || note.entradilla || '').toLowerCase();
        const tags = (note.tags || note.etiquetas || '').toLowerCase();
        return title.includes(term) || intro.includes(term) || tags.includes(term);
      });
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Público: Feed JSON limpio para consumo externo (apps, bots, etc.).
// Devuelve solo notas publicadas y no archivadas, con campos normalizados
// y el enlace directo a cada nota. Sin duplicar lógica de acceso a Supabase.
app.get('/api/public/notes', async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    const { data, error } = await supabase
      .from('notes')
      .select('id, title, intro, sport, author, created_at')
      .eq('status', 'publicada')
      .eq('archived', false)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json((data || []).map((note) => mapNoteToPublicApi(note, baseUrl)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Privado: Devuelve todas las notas para la redacción
app.get('/api/notes/all', authenticateWriter, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .order('id', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notes', authenticateWriter, async (req, res) => {
  const { data: clean, error: validationError } = validateNote(req.body, false);
  if (validationError) return res.status(400).json({ error: validationError });

  const { data, error } = await supabase.from('notes').insert([clean]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/notes/:id', authenticateWriter, async (req, res) => {
  const { data: clean, error: validationError } = validateNote(req.body, true);
  if (validationError) return res.status(400).json({ error: validationError });

  const { data, error } = await supabase
    .from('notes')
    .update(clean)
    .eq('id', req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.patch('/api/notes/:id/status', authenticateWriter, async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  if (!['borrador', 'en revisión', 'publicada'].includes(status)) {
    return res.status(400).json({ error: 'Estado editorial no válido.' });
  }

  const { data, error } = await supabase.from('notes').update({ status }).eq('id', id).select();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// DELETE Soft delete: mueve la nota a la papelera (archived = true).
// Desaparece de la web pública y en el panel se muestra como archivada.
// Nunca se borra físicamente.
app.delete('/api/notes/:id', authenticateWriter, async (req, res) => {
  const { data, error } = await supabase
    .from('notes')
    .update({ archived: true })
    .eq('id', req.params.id)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Nota no encontrada.' });
  res.json(data[0]);
});

// Newsletter: alta de suscriptor (público, limitado por rate limiter).
// El envío semanal lo hace la Edge Function; esta ruta solo guarda
// el correo en subscribers con confirmed = true (doble opt-in futuro).
app.post('/api/newsletter/subscribe', async (req, res) => {
  const body = req.body || {};
  const honeypot = String(body.website || '').trim();
  if (honeypot) {
    return res.status(201).json({ ok: true });
  }
  const { email } = body;
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Correo electrónico no válido.' });
  }

  const normalized = email.trim().toLowerCase();
  try {
    const { data: existing } = await supabase
      .from('subscribers')
      .select('id')
      .eq('email', normalized)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Ya estás suscrito a la newsletter.' });
    }

    const { data, error } = await supabase
      .from('subscribers')
      .insert({ email: normalized, confirmed: true })
      .select();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ya estás suscrito a la newsletter.' });
      }
      return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ ok: true, email: data[0].email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Newsletter: baja (se llama desde el enlace del boletín).
app.get('/api/newsletter/unsubscribe', async (req, res) => {
  const email = String(req.query.email || '')
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).type('text/plain').send('Enlace de baja no válido.');
  }

  try {
    const { error } = await supabase
      .from('subscribers')
      .update({ confirmed: false })
      .eq('email', email);

    if (error) return res.status(500).type('text/plain').send('Error interno al procesar la baja.');

    res
      .type('html')
      .send(
        '<!doctype html><html lang="es"><meta charset="utf-8"><title>Baja de la newsletter</title><body style="font-family:Inter,sans-serif;max-width:560px;margin:48px auto;color:#1a1a1a"><p><strong>TRIBUNA</strong></p><h1>Has sido dado de baja correctamente.</h1><p>No volverás a recibir nuestro boletín semanal. Si fue un error, siempre puedes volver a suscribirte desde la web.</p></body></html>'
      );
  } catch {
    res.status(500).type('text/plain').send('Error interno al procesar la baja.');
  }
});

// SEO
app.get('/robots.txt', (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const content = `User-agent: *\nAllow: /\n\nSitemap: ${protocol}://${host}/sitemap.xml`;
  res.type('text/plain');
  res.send(content);
});

app.get('/sitemap.xml', async (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;

  try {
    const { data: notes } = await supabase
      .from('notes')
      .select('id, created_at, status')
      .eq('status', 'publicada')
      .eq('archived', false);

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    xml += `  <url>\n    <loc>${baseUrl}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;

    if (notes && notes.length > 0) {
      notes.forEach((note) => {
        const date = note.created_at
          ? new Date(note.created_at).toISOString()
          : new Date().toISOString();
        xml += `  <url>\n    <loc>${baseUrl}/#note-${note.id}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
      });
    }

    xml += `</urlset>`;

    res.type('application/xml');
    res.send(xml);
  } catch {
    res.status(500).send('Error al generar el sitemap');
  }
});

const LEAGUE_MAP = {
  cl: 'CL',
  bl1: 'BL1',
  ded: 'DED',
  bsa: 'BSA',
  pd: 'PD',
  fl1: 'FL1',
  elc: 'ELC',
  ppl: 'PPL',
  ec: 'EC',
  sa: 'SA',
  pl: 'PL'
};

const cache = {};
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

app.get('/api/standings/:liga', async (req, res) => {
  const ligaKey = req.params.liga.toLowerCase();
  const leagueCode = LEAGUE_MAP[ligaKey];

  if (!leagueCode) return res.status(400).json({ error: 'Liga no válida.' });

  const now = Date.now();
  if (cache[ligaKey] && now - cache[ligaKey].timestamp < CACHE_TTL_MS) {
    return res.json({ stale: false, data: cache[ligaKey].data });
  }

  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Configuración interna del servidor.' });

  try {
    const url = `https://api.football-data.org/v4/competitions/${leagueCode}/standings`;
    const response = await fetch(url, { headers: { 'X-Auth-Token': apiKey } });
    const json = await response.json();

    if (!response.ok || !json.standings || json.standings.length === 0) {
      throw new Error(json.message || `Error HTTP: ${response.status}`);
    }

    const standingObj = json.standings.find((s) => s.type === 'TOTAL') || json.standings[0];
    const rawStandings = standingObj ? standingObj.table : [];

    const transformedData = rawStandings.map((item) => ({
      posicion: item.position,
      equipo: item.team.name,
      escudo: item.team.crest,
      jugados: item.playedGames,
      ganados: item.won,
      empatados: item.draw,
      perdidos: item.lost,
      golesFavor: item.goalsFor,
      golesContra: item.goalsAgainst,
      diferencia: item.goalDifference,
      puntos: item.points
    }));

    cache[ligaKey] = { timestamp: now, data: transformedData };
    return res.json({ stale: false, data: transformedData });
  } catch (error) {
    if (cache[ligaKey]) return res.json({ stale: true, data: cache[ligaKey].data });
    return res.status(503).json({ error: error.message });
  }
});

// Estáticos explícitos de PWA (solo esta carpeta; no exponer fuentes)
app.use(
  '/public',
  express.static(path.join(__dirname, 'public'), { maxAge: '7d', immutable: true })
);

// 404 JSON para cualquier /api/* no registrada (evita que caiga al catch-all HTML)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta de API no encontrada.' });
});

// Middleware SPA para soportar rutas dinámicas en el navegador
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Manejador de errores centralizado de Express (4 argumentos, va siempre al final).
// Atrapa cualquier error que llegue a next(err): INCLUDING body JSON inválido
// (express.json) y rechazos no capturados de rutas async. Devuelve JSON, nunca HTML.
// eslint-disable-next-line no-unused-vars -- los 4 parámetros son la firma requerida por Express
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api') || req.originalUrl?.startsWith('/api')) {
    const status = err.status || err.statusCode || 500;
    const message =
      err.type === 'entity.parse.failed'
        ? 'JSON inválido en el cuerpo de la petición.'
        : 'Error interno del servidor.';
    if (status >= 500)
      console.error(`[API ${status}]`, req.method, req.originalUrl, err.message || err);
    return res.status(status).json({ error: message });
  }
  if (err.status === 404) return res.status(404).send('Recurso no encontrado');
  if (err.status >= 500) console.error('[Error]', req.method, req.originalUrl, err.message || err);
  res.status(500).send('Error interno del servidor');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
}

module.exports = app;
module.exports.toPublicNote = mapNoteToPublicApi;
