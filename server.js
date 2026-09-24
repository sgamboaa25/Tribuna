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
          'https://pagead2.googlesyndication.com',
          "'unsafe-inline'"
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: [
          "'self'",
          'https://jmsjbbubhyszrbgqrfio.supabase.co',
          'https://*.supabase.co',
          'https://pagead2.googlesyndication.com',
          'https://googleads.g.doubleclick.net',
          'https://*.googlesyndication.com',
          'https://*.googleadservices.com'
        ],
        frameSrc: [
          'https://googleads.g.doubleclick.net',
          'https://*.googleadservices.com',
          'https://*.googlesyndication.com',
          'https://*.google.com'
        ],
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

const readerPhotosLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas fotos enviadas. Espera unos minutos.' }
});

app.use(express.json({ limit: '10mb' }));

app.use('/api/', globalLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/notes', writeLimiter);
app.use('/api/standings', standingsLimiter);
app.use('/api/fixtures', standingsLimiter);
app.use('/api/newsletter', newsletterLimiter);
app.use('/api/reader-photos', readerPhotosLimiter);

// Health check ligero (no toca la DB). Lo usa el banner de conectividad del
// cliente para confirmar conexión real antes de mostrarse.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Faltan variables de entorno de Supabase. Copia .env.example a .env y completa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (service-role: Supabase > Settings > API keys).'
  );
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const activeSessions = new Map();

// Purga periódica de sesiones expiradas para que el mapa no crezca sin límite
// en procesos de larga vida (Render). El timer no mantiene vivo el proceso.
setInterval(() => {
  const cutoff = Date.now();
  for (const [token, session] of activeSessions) {
    if (session.expiresAt < cutoff) activeSessions.delete(token);
  }
}, 15 * 60 * 1000).unref?.();

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

// ============ Autopublicación en X ============
// Firma OAuth 1.0a (User Context) sin dependencias externas:
// HMAC-SHA1 sobre el "signature base string" del estándar (RFC 5849).
const X_API_URL = 'https://api.x.com/2/tweets';
const X_TCO_URL_LENGTH = 23;

function xPercentEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// `params` admite objeto o array de pares [clave, valor] (RFC 5849 permite
// nombres repetidos, p. ej. los parámetros de consulta y cuerpo combinados).
function oauth1SignatureBase(method, url, params) {
  const pairs = (Array.isArray(params) ? params : Object.entries(params || {}))
    .map(([k, v]) => `${xPercentEncode(k)}=${xPercentEncode(v)}`);
  pairs.sort();
  return [method.toUpperCase(), xPercentEncode(url), xPercentEncode(pairs.join('&'))].join('&');
}

function oauth1Signature(method, url, params, consumerSecret, tokenSecret) {
  const baseString = oauth1SignatureBase(method, url, params);
  const signingKey = `${xPercentEncode(consumerSecret || '')}&${xPercentEncode(tokenSecret || '')}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function oauth1Authorization({
  method,
  url,
  params,
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  nonce,
  timestamp
}) {
  const oauthParams = [
    ['oauth_consumer_key', consumerKey],
    ['oauth_nonce', nonce || crypto.randomBytes(16).toString('hex')],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', timestamp || String(Math.floor(Date.now() / 1000))],
    ['oauth_token', token],
    ['oauth_version', '1.0']
  ];

  const extraParams = Array.isArray(params) ? params : Object.entries(params || {});
  const signature = oauth1Signature(method, url, [...oauthParams, ...extraParams], consumerSecret, tokenSecret);

  const headerParams = [...oauthParams, ['oauth_signature', signature]];
  return `OAuth ${headerParams.map(([k, v]) => `${xPercentEncode(k)}="${xPercentEncode(v)}"`).join(', ')}`;
}

const xAutopostEnabled =
  process.env.X_AUTOPOST_ENABLED === 'true' &&
  Boolean(process.env.X_CONSUMER_KEY && process.env.X_CONSUMER_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET);

function truncateToBytes(str, max) {
  let out = '';
  for (const ch of str) {
    if (Buffer.byteLength(out + ch, 'utf8') > max) break;
    out += ch;
  }
  return out;
}

async function publishToX({ title, id }, baseUrl) {
  const link = `${baseUrl}/#note-${id}`;
  // X cuenta un enlace como 23 caracteres (t.co) y el límite son 280.
  const maxTitle = 280 - 1 - X_TCO_URL_LENGTH;
  const text = `${truncateToBytes(title, maxTitle)}\n${link}`;

  const authorization = oauth1Authorization({
    method: 'POST',
    url: X_API_URL,
    consumerKey: process.env.X_CONSUMER_KEY,
    consumerSecret: process.env.X_CONSUMER_SECRET,
    token: process.env.X_ACCESS_TOKEN,
    tokenSecret: process.env.X_ACCESS_SECRET
  });

  const response = await fetch(X_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`X API ${response.status}: ${detail.slice(0, 200)}`);
  }

  const body = await response.json();
  return body && body.data ? { id: body.data.id, text: body.data.text } : { id: null };
}

// Publica en X solo cuando la nota es publicada + urgente y aún no se envió.
// Falla silencioso: nunca rompe el guardado de la nota original.
async function maybeAutopostNote(note, baseUrl) {
  if (!xAutopostEnabled) return;
  if (!note || !note.id) return;
  if (note.status !== 'publicada' || note.urgent !== true) return;
  if (note.x_post_id || note.x_posted_at) return;

  try {
    const posted = await publishToX({ title: note.title, id: note.id }, baseUrl);
    await supabase
      .from('notes')
      .update({ x_post_id: posted.id, x_posted_at: new Date().toISOString() })
      .eq('id', note.id);
    console.log(`[x-autopost] nota ${note.id} publicada en X (post ${posted.id})`);
  } catch (error) {
    console.error('[x-autopost] no se pudo publicar en X:', error.message);
  }
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

// ============ Equipos de la Liga Promérica (Costa Rica) ============
// Catálogo en teams_ca (se puebla una vez). Se cachea 1h; los escudos son
// URLs públicas y no cambian seguido. resolveTeamSlugs() convierte las
// etiquetas de una nota en slugs de equipo para los hubs /equipo/:slug.
const TEAMS_CACHE_TTL_MS = 60 * 60 * 1000;
let teamsCache = [];
let teamsCacheAt = 0;

function normalizeTeamText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTeamSlugs(tags, teams) {
  if (!Array.isArray(teams)) return [];
  const rawTags = String(tags || '')
    .split(/[,;]+/)
    .map(normalizeTeamText)
    .filter(Boolean);
  const words = new Set();
  for (const tag of rawTags) for (const word of tag.split(' ')) if (word) words.add(word);

  const found = [];
  for (const team of teams) {
    const keywords = [team.slug, team.nombre, ...(Array.isArray(team.aliases) ? team.aliases : [])]
      .map(normalizeTeamText)
      .filter(Boolean);
    const hit = keywords.some(
      (keyword) => rawTags.includes(keyword) || (keyword.indexOf(' ') === -1 && words.has(keyword))
    );
    if (hit) found.push(team.slug);
  }
  return found;
}

async function loadTeams() {
  const now = Date.now();
  if (teamsCacheAt && now - teamsCacheAt < TEAMS_CACHE_TTL_MS) return teamsCache;
  const { data, error } = await supabase
    .from('teams_ca')
    .select('nombre, escudo, slug, aliases')
    .order('nombre');
  if (error) throw error;
  teamsCache = data || [];
  teamsCacheAt = now;
  return teamsCache;
}

async function loadTeamsGraceful() {
  try {
    return await loadTeams();
  } catch {
    return [];
  }
}

// Añade a una nota los equipos resolubles desde sus etiquetas, combinando
// los ya vinculados al guardar (columna teams) con un cálculo a la lectura
// (para notas anteriores a la migración). Nunca modifica la BD.
function decorateNoteTeams(note, teams) {
  if (!note) return note;
  const stored = Array.isArray(note.teams) ? note.teams : [];
  return { ...note, teams: [...new Set([...stored, ...resolveTeamSlugs(note.tags, teams)])] };
}

// GET Público: catálogo de equipos (nombre, escudo, slug) para los hubs.
app.get('/api/teams', async (req, res) => {
  try {
    res.json(await loadTeams());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Jugadores de la Liga Promérica (Costa Rica) ============
// Catálogo en players_ca, curado por la redacción (mismo modelo que teams_ca).
// Se cachea 1h. El join con teams_ca aporta nombre y escudo del club a cada
// jugador para las páginas /jugador/:slug sin otra petición del cliente.
const PLAYERS_CACHE_TTL_MS = 60 * 60 * 1000;
let playersCache = [];
let playersCacheAt = 0;

async function loadPlayers() {
  const now = Date.now();
  if (playersCacheAt && now - playersCacheAt < PLAYERS_CACHE_TTL_MS) return playersCache;
  const { data, error } = await supabase
    .from('players_ca')
    .select('*')
    .order('nombre');
  if (error) throw error;
  playersCache = data || [];
  playersCacheAt = now;
  return playersCache;
}

function decoratePlayersWithTeams(players, teams) {
  const teamBySlug = new Map((teams || []).map((t) => [t.slug, t]));
  return (players || []).map((p) => ({
    nombre: p.nombre || '',
    slug: p.slug || '',
    posicion: p.posicion || '',
    dorsal: p.dorsal ?? null,
    foto: p.foto || '',
    fecha_nacimiento: p.fecha_nacimiento || null,
    nacionalidad: p.nacionalidad || '',
    aliases: Array.isArray(p.aliases) ? p.aliases : [],
    equipo_slug: p.equipo_slug || '',
    equipo: teamBySlug.get(p.equipo_slug) || null
  }));
}

async function loadPlayersDecorated() {
  const [players, teams] = await Promise.all([loadPlayers(), loadTeams()]);
  return decoratePlayersWithTeams(players, teams);
}

// GET Público: catálogo de jugadores (con nombre y escudo del equipo) para
// las páginas /jugador/:slug y la plantilla de cada /equipo/:slug.
app.get('/api/players', async (req, res) => {
  try {
    res.json(await loadPlayersDecorated());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Rastreador de fichajes (rumores de la Liga Promérica) ============
// Entidad curada por la redacción en transfer_rumors. El público lee solo los
// rumores `activo` (caché corta); el panel gestiona todos vía authenticateWriter.
// La decoración une clubes con teams_ca (escudo, /equipo/:slug) y resuelve el
// slug de jugador por nombre contra players_ca (/jugador/:slug).
const RUMOR_FIELDS = [
  'jugador',
  'jugador_slug',
  'posicion',
  'club_origen',
  'club_origen_slug',
  'club_destino',
  'club_destino_slug',
  'estado',
  'veracidad',
  'fuente',
  'detalle',
  'activo'
];
const RUMOR_STATES = ['rumor', 'avanzado', 'confirmado', 'descartado'];
const RUMOR_CACHE_TTL_MS = 10 * 60 * 1000;
const RUMOR_TEXT_LIMITS = {
  jugador: 120,
  posicion: 60,
  club_origen: 120,
  club_destino: 120,
  fuente: 120,
  detalle: 500
};
let rumorsCache = [];
let rumorsCacheAt = 0;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateRumor(body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Cuerpo de petición inválido.' };
  }
  if (!partial && String(body.jugador || '').trim() === '') {
    return { error: 'Campo requerido: jugador.' };
  }
  const clean = {};
  for (const key of Object.keys(body)) {
    if (RUMOR_FIELDS.includes(key)) clean[key] = body[key];
  }
  for (const [field, limit] of Object.entries(RUMOR_TEXT_LIMITS)) {
    if (clean[field] === undefined) continue;
    if (typeof clean[field] !== 'string') return { error: `El campo ${field} debe ser texto.` };
    clean[field] = sanitizeText(clean[field]);
    if (clean[field].length > limit) {
      return { error: `El campo ${field} supera la longitud máxima permitida (${limit} caracteres).` };
    }
  }
  if (clean.jugador !== undefined && clean.jugador === '') {
    return { error: 'Campo requerido: jugador.' };
  }
  for (const field of ['club_origen_slug', 'club_destino_slug', 'jugador_slug']) {
    if (clean[field] === '') delete clean[field];
  }
  if (clean.estado !== undefined && !RUMOR_STATES.includes(clean.estado)) {
    return { error: 'Estado de rumor no válido.' };
  }
  if (clean.estado === undefined && !partial) clean.estado = 'rumor';
  if (clean.veracidad !== undefined) {
    clean.veracidad = Number(clean.veracidad);
    if (!Number.isFinite(clean.veracidad) || clean.veracidad < 0 || clean.veracidad > 100) {
      return { error: 'La veracidad debe ser un número entre 0 y 100.' };
    }
  } else if (!partial) {
    clean.veracidad = 50;
  }
  if (clean.activo !== undefined) clean.activo = Boolean(clean.activo);
  if (Object.keys(clean).length === 0) {
    return { error: 'No se enviaron campos válidos para guardar.' };
  }
  return { data: clean };
}

function resolvePlayerSlugByName(jugador, players) {
  const key = normalizeTeamText(jugador);
  if (!key) return null;
  const hit = (players || []).find((p) =>
    [p.nombre, ...(Array.isArray(p.aliases) ? p.aliases : [])].map(normalizeTeamText).includes(key)
  );
  return hit ? hit.slug : null;
}

// api: decoración de rumores con datos de club (nombre, escudo, slug del hub)
// y slug de jugador resuelto para /jugador/:slug.
function decorateRumors(rumors, teams, players) {
  const teamBySlug = new Map((teams || []).map((t) => [t.slug, t]));
  const toClub = (slug, name) => {
    const t = slug && teamBySlug.get(slug);
    return {
      slug: t ? t.slug : slug || '',
      nombre: t ? t.nombre : name || '',
      escudo: t ? t.escudo : ''
    };
  };
  return (rumors || []).map((r) => ({
    id: r.id,
    jugador: r.jugador || '',
    jugador_slug: r.jugador_slug || resolvePlayerSlugByName(r.jugador, players) || null,
    posicion: r.posicion || '',
    origen: toClub(r.club_origen_slug, r.club_origen),
    destino: toClub(r.club_destino_slug, r.club_destino),
    estado: r.estado || 'rumor',
    veracidad: typeof r.veracidad === 'number' ? r.veracidad : Number(r.veracidad) || 0,
    fuente: r.fuente || '',
    detalle: r.detalle || '',
    activo: r.activo !== false,
    updated_at: r.updated_at || r.created_at || null
  }));
}

async function loadRumorsPublic() {
  const now = Date.now();
  if (rumorsCacheAt && now - rumorsCacheAt < RUMOR_CACHE_TTL_MS) return rumorsCache;
  const { data, error } = await supabase
    .from('transfer_rumors')
    .select('*')
    .eq('activo', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  rumorsCache = data || [];
  rumorsCacheAt = now;
  return rumorsCache;
}

async function loadTeamsAndPlayers() {
  const [teams, players] = await Promise.all([loadTeams(), loadPlayers()]);
  return { teams, players };
}

async function runRumorsQuery(supabaseQuery) {
  const { data, error } = await supabaseQuery;
  if (error) throw error;
  const { teams, players } = await loadTeamsAndPlayers();
  return decorateRumors(data || [], teams, players);
}

// GET Público: rumores activos para la sección "Mercado".
app.get('/api/rumors', async (req, res) => {
  try {
    const { teams, players } = await loadTeamsAndPlayers();
    res.json(decorateRumors(await loadRumorsPublic(), teams, players));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET del panel: todos los rumores (activos e inactivos).
app.get('/api/rumors/manager', authenticateWriter, async (req, res) => {
  try {
    res.json(await runRumorsQuery(supabase.from('transfer_rumors').select('*').order('created_at', { ascending: false })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: crear un rumor (solo redacción).
app.post('/api/rumors', authenticateWriter, async (req, res) => {
  const { data: clean, error: verr } = validateRumor(req.body, false);
  if (verr) return res.status(400).json({ error: verr });
  try {
    clean.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('transfer_rumors').insert([clean]).select();
    if (error) throw error;
    rumorsCacheAt = 0;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT: actualizar un rumor (solo redacción).
app.put('/api/rumors/:id', authenticateWriter, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID no válido.' });
  const { data: clean, error: verr } = validateRumor(req.body, true);
  if (verr) return res.status(400).json({ error: verr });
  try {
    clean.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('transfer_rumors')
      .update(clean)
      .eq('id', req.params.id)
      .select();
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'Rumor no encontrado.' });
    rumorsCacheAt = 0;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE: eliminar un rumor (solo redacción).
app.delete('/api/rumors/:id', authenticateWriter, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID no válido.' });
  try {
    const { error } = await supabase.from('transfer_rumors').delete().eq('id', req.params.id);
    if (error) throw error;
    rumorsCacheAt = 0;
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Fotos de lectores (moderadas) ============
// Los lectores suben la foto a Storage (bucket compartido notes-images, carpeta
// lectores/) desde el navegador y registran aquí el metadata. Todo pasa por el
// backend (service_role): validación de la URL de origen, honeypot y limiter.
// El cliente público solo lee las publicadas vía RLS; el panel las modera.
const READER_PHOTO_STATES = ['en_revision', 'publicada', 'rechazada'];

function readerPhotoUrlPrefix() {
  return `${String(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/storage/v1/object/public/notes-images/lectores/`;
}

function validateReaderPhoto(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Cuerpo de petición inválido.' };
  const autor = sanitizeText(body.autor).slice(0, 80);
  if (!autor) return { error: 'Campo requerido: autor.' };
  const titulo = sanitizeText(body.titulo).slice(0, 140);
  const foto = String(body.foto || '').trim();
  if (foto.length > 500) return { error: 'URL de imagen no válida.' };
  if (!foto.startsWith(readerPhotoUrlPrefix())) return { error: 'La imagen debe subirse desde el sitio.' };
  return { data: { autor, titulo, foto, estado: 'en_revision' } };
}

// POST Público: un lector envía su foto para moderación.
app.post('/api/reader-photos', async (req, res) => {
  const honeypot = String((req.body || {}).website || '').trim();
  if (honeypot) return res.status(201).json({ ok: true });
  const { data, error } = validateReaderPhoto(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { data: rows, error: insertError } = await supabase
      .from('reader_photos')
      .insert({ ...data, creada_ip: req.ip || (req.socket && req.socket.remoteAddress) || null })
      .select('id');
    if (insertError) throw insertError;
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Privado (panel): todas las fotos, más recientes primero.
app.get('/api/reader-photos/manager', authenticateWriter, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reader_photos')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT Privado (panel): aprobar / rechazar una foto enviada.
app.put('/api/reader-photos/:id', authenticateWriter, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID no válido.' });
  const estado = sanitizeText((req.body || {}).estado);
  if (!READER_PHOTO_STATES.includes(estado)) return res.status(400).json({ error: 'Estado de foto no válido.' });
  const nota = sanitizeText((req.body || {}).nota).slice(0, 200);
  const patch = { estado, nota: nota || null };
  if (estado === 'publicada' || estado === 'rechazada') {
    patch.moderada_at = new Date().toISOString();
    patch.moderada_por = req.writer || null;
  }
  try {
    const { error: updateError } = await supabase.from('reader_photos').update(patch).eq('id', req.params.id);
    if (updateError) throw updateError;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE Privado (panel): elimina la foto (fila + objeto en Storage).
app.delete('/api/reader-photos/:id', authenticateWriter, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'ID no válido.' });
  try {
    const { data: rows, error: selectError } = await supabase
      .from('reader_photos')
      .select('foto')
      .eq('id', req.params.id);
    if (selectError) throw selectError;
    const foto = rows && rows[0] ? rows[0].foto : null;
    if (foto && foto.startsWith(readerPhotoUrlPrefix())) {
      const objectPath = foto.slice(readerPhotoUrlPrefix().length);
      await supabase.storage.from('notes-images').remove([objectPath]).catch(() => null);
    }
    const { error } = await supabase.from('reader_photos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Configuración de la redacción (clave/valor) ============
// Campo ligero para datos editoriales que el panel actualiza sin tocar código.
// Hoy expone la "próxima ventana de fichajes" que el frontend usa en el estado
// "sin rumores" del Mercado. Escritura solo vía PUT autenticado; lectura pública
// cacheada (seed site_settings.next_transfer_window = '' significa "no definida").
const SETTINGS_CACHE_TTL_MS = 10 * 60 * 1000;
let settingsCache = null;
let settingsCacheAt = 0;

async function loadSettingsPublic() {
  const now = Date.now();
  if (settingsCacheAt && now - settingsCacheAt < SETTINGS_CACHE_TTL_MS) return settingsCache;
  const { data, error } = await supabase
    .from('site_settings')
    .select('key, value')
    .eq('key', 'next_transfer_window')
    .maybeSingle();
  if (error) throw error;
  settingsCache = { next_transfer_window: (data && data.value) || '' };
  settingsCacheAt = now;
  return settingsCache;
}

function validateTransferWindow(value) {
  const v = sanitizeText(value == null ? '' : value);
  if (v.length > 60) return { error: 'La fecha de la ventana resultó demasiado larga.' };
  return { data: v };
}

// GET Público: configuración visible (la fecha de la próxima ventana).
app.get('/api/settings/public', async (req, res) => {
  try {
    res.json(await loadSettingsPublic());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT Privado (panel): actualiza la próxima ventana de fichajes.
app.put('/api/settings', authenticateWriter, async (req, res) => {
  const { data, error } = validateTransferWindow((req.body || {}).next_transfer_window);
  if (error) return res.status(400).json({ error });
  try {
    const { error: upsertError } = await supabase
      .from('site_settings')
      .upsert(
        { key: 'next_transfer_window', value: data, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (upsertError) throw upsertError;
    settingsCacheAt = 0;
    res.json({ ok: true, next_transfer_window: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const teams = await loadTeamsGraceful();
    res.json((data || []).map((note) => decorateNoteTeams(note, teams)));
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

    const teams = await loadTeamsGraceful();
    res.json(filtered.map((note) => decorateNoteTeams(note, teams)));
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

    const teams = await loadTeamsGraceful();
    res.json(filtered.map((note) => decorateNoteTeams(note, teams)));
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

    const teams = await loadTeamsGraceful();
    res.json(filtered.map((note) => decorateNoteTeams(note, teams)));
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
      query = query.ilike('sport', `%${sport}%`);
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

    const teams = await loadTeamsGraceful();
    res.json(results.map((note) => decorateNoteTeams(note, teams)));
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

// GET Privado: Estadísticas para el panel de redacción.
// Calcula sobre datos ya existentes en Supabase (notes + subscribers).
// Solo lectura, protegida con el mismo JWT de redacción.
app.get('/api/stats', authenticateWriter, async (req, res) => {
  try {
    const publishedQuery = () =>
      supabase.from('notes').select('id', { count: 'exact', head: true })
        .eq('status', 'publicada').eq('archived', false);
    const reactionsQuery = () =>
      supabase.from('notes').select('id, title, reactions')
        .eq('status', 'publicada').eq('archived', false);
    const subsQuery = () =>
      supabase.from('subscribers').select('id', { count: 'exact', head: true }).eq('confirmed', true);

    const [total, notes, subs] = await Promise.all([publishedQuery(), reactionsQuery(), subsQuery()]);
    for (const item of [total, notes, subs]) if (item.error) throw item.error;

    const top = (notes.data || [])
      .map((n) => {
        const r = n.reactions || {};
        const clap = Math.max(0, Number(r.clap) || 0);
        const wow = Math.max(0, Number(r.wow) || 0);
        const angry = Math.max(0, Number(r.angry) || 0);
        return { id: n.id, titulo: n.title, clap, wow, angry, total: clap + wow + angry };
      })
      .sort((a, b) => b.total - a.total || a.titulo.localeCompare(b.titulo))
      .slice(0, 5);

    res.json({
      notas_publicadas: total.count || 0,
      suscriptores: subs.count || 0,
      reacciones_totales: top.reduce((acc, n) => acc + n.total, 0),
      top_reacciones: top
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notes', authenticateWriter, async (req, res) => {
  const { data: clean, error: validationError } = validateNote(req.body, false);
  if (validationError) return res.status(400).json({ error: validationError });

  // Vincula automáticamente los equipos mencionados en las etiquetas.
  // Si el catálogo no está disponible, se guarda igual (teams queda vacío).
  if (typeof clean.tags === 'string') {
    try {
      clean.teams = resolveTeamSlugs(clean.tags, await loadTeams());
    } catch {
      /* catálogo no disponible */
    }
  }

  const { data, error } = await supabase.from('notes').insert([clean]).select();
  if (error) return res.status(500).json({ error: error.message });
  await maybeAutopostNote(data[0], `${req.protocol}://${req.get('host')}`);
  res.json(data[0]);
});

app.put('/api/notes/:id', authenticateWriter, async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'ID de nota no válido.' });
  }
  const { data: clean, error: validationError } = validateNote(req.body, true);
  if (validationError) return res.status(400).json({ error: validationError });

  // Recalcula los equipos vinculados cuando cambian las etiquetas.
  if (typeof clean.tags === 'string') {
    try {
      clean.teams = resolveTeamSlugs(clean.tags, await loadTeams());
    } catch {
      /* catálogo no disponible */
    }
  }

  const { data, error } = await supabase
    .from('notes')
    .update(clean)
    .eq('id', id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Nota no encontrada.' });
  await maybeAutopostNote(data[0], `${req.protocol}://${req.get('host')}`);
  res.json(data[0]);
});

app.patch('/api/notes/:id/status', authenticateWriter, async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'ID de nota no válido.' });
  }
  const { status } = req.body;

  if (!['borrador', 'en revisión', 'publicada'].includes(status)) {
    return res.status(400).json({ error: 'Estado editorial no válido.' });
  }

  const { data, error } = await supabase.from('notes').update({ status }).eq('id', id).select();

  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Nota no encontrada.' });
  await maybeAutopostNote(data[0], `${req.protocol}://${req.get('host')}`);
  res.json(data[0]);
});

// DELETE Soft delete: mueve la nota a la papelera (archived = true).
// Desaparece de la web pública y en el panel se muestra como archivada.
// Nunca se borra físicamente.
app.delete('/api/notes/:id', authenticateWriter, async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'ID de nota no válido.' });
  }
  const { data, error } = await supabase
    .from('notes')
    .update({ archived: true })
    .eq('id', id)
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

    const teams = await loadTeamsGraceful();
    teams.forEach((team) => {
      xml += `  <url>\n    <loc>${baseUrl}/equipo/${team.slug}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
    });

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

app.get('/api/standings/:liga', async (req, res, next) => {
  const ligaKey = req.params.liga.toLowerCase();
  if (ligaKey === 'promerica') return next();
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

// ============ Posiciones Liga Promérica (actualización manual) ============
// Ninguna API conectada cubre UNAFUT de forma confiable, así que la redacción
// actualiza estas estadísticas a mano desde el panel (login existente) en la
// tabla standings_promerica. Todos los campos (incluidos Pts y DIF) se guardan
// tal cual se ingresan en el panel; el nombre/escudo salen del catálogo
// teams_ca. RLS anon solo lectura; escrituras solo backend (authenticateWriter).
const PRO_PROMERICAS_CACHE_MS = 60 * 1000;
let promericaStandingsCache = null;
let promericaStandingsCacheAt = 0;

// Ordena y computa la vista pública (Pts, DIF). Exportado para tests.
function decoratePromericaStandings(rows, teams) {
  const teamBySlug = new Map((teams || []).map((t) => [t.slug, t]));
  const withStats = (rows || []).map((r) => {
    const team = teamBySlug.get(r.equipo_slug) || {};
    const pj = Number(r.pj) || 0;
    const g = Number(r.g) || 0;
    const e = Number(r.e) || 0;
    const p = Number(r.p) || 0;
    const gf = Number(r.gf) || 0;
    const gc = Number(r.gc) || 0;
    const dif = (r.dif !== undefined && r.dif !== null) ? Number(r.dif) : gf - gc;
    const pts = (r.pts !== undefined && r.pts !== null) ? Number(r.pts) : g * 3 + e;
    return {
      slug: r.equipo_slug,
      equipo: team.nombre || r.equipo_slug,
      escudo: team.escudo || '',
      pj, g, e, p, gf, gc,
      dif,
      pts
    };
  });
  return withStats.sort((a, b) =>
    b.pts - a.pts || b.dif - a.dif || b.gf - a.gf || String(a.equipo).localeCompare(String(b.equipo), 'es')
  );
}

function standingsRowMap(rows) {
  const map = new Map();
  for (const r of rows || []) map.set(r.equipo_slug, r);
  return map;
}

// Devuelve SIEMPRE la plantilla completa de clubes (roster de teams_ca) con sus
// estadísticas guardadas o ceros si aún no se cargaron. Así la tabla pública se
// ve desde el primer día (estado "sin actualizar") en vez de parecer un error.
// Pasa DIF y Pts tal cual se guardaron (para que la redacción pueda escribir
// valores que no dependen de GF-GC ni de G*3+E). Si no se guardaron aún, se
// dejan sin definir y decoratePromericaStandings aplica su cálculo por defecto.
function mergeStandingsRoster(teams, rows) {
  const stats = standingsRowMap(rows);
  return (teams || []).map((t) => {
    const s = stats.get(t.slug) || {};
    const dif = (s.dif !== undefined && s.dif !== null) ? Number(s.dif) : undefined;
    const pts = (s.pts !== undefined && s.pts !== null) ? Number(s.pts) : undefined;
    return {
      equipo_slug: t.slug,
      pj: Number(s.pj) || 0,
      g: Number(s.g) || 0,
      e: Number(s.e) || 0,
      p: Number(s.p) || 0,
      gf: Number(s.gf) || 0,
      gc: Number(s.gc) || 0,
      dif,
      pts,
      updated_at: s.updated_at || null
    };
  });
}

// Valida el payload del panel: lista acotada, clubes conocidos, enteros >= 0
// y pj = g + e + p (integridad del conteo). Exportado para tests.
function validateStandingsRows(payload, allowedSlugs) {
  const rows = Array.isArray(payload && payload.rows) ? payload.rows : null;
  if (!rows || rows.length < 1 || rows.length > 12) {
    return { error: 'Se esperaba la lista de equipos en "rows".' };
  }
  const slugSet = new Set(allowedSlugs || []);
  const limits = { pj: [0, 999], g: [0, 999], e: [0, 999], p: [0, 999], gf: [0, 999], gc: [0, 999], dif: [-999, 999], pts: [0, 999] };
  for (const row of rows) {
    if (!row || typeof row !== 'object') return { error: 'Fila inválida en la tabla.' };
    const slug = sanitizeText(row.slug || '');
    if (!slugSet.has(slug)) return { error: `Equipo no válido: "${slug}".` };
    for (const key of Object.keys(limits)) {
      const v = row[key];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      const [min, max] = limits[key];
      if (!Number.isInteger(n) || n < min || n > max) {
        return { error: `Valor inválido en "${slug}" (${key}).` };
      }
    }
    const pj = Number(row.pj) || 0;
    const g = Number(row.g) || 0;
    const e = Number(row.e) || 0;
    const p = Number(row.p) || 0;
    if (pj !== g + e + p) {
      return { error: `En "${slug}" el PJ (${pj}) no cuadra con G+E+P (${g}+${e}+${p}).` };
    }
  }
  return { data: rows };
}

async function loadTeamsSlugs() {
  const { data, error } = await supabase.from('teams_ca').select('slug');
  if (error) throw error;
  return (data || []).map((t) => t.slug);
}

function lastManualUpdate(rows) {
  let lastRow = null;
  for (const r of rows || []) {
    if (r.updated_at && (!lastRow || new Date(r.updated_at) > new Date(lastRow.updated_at))) lastRow = r;
  }
  return lastRow;
}

// GET Público: posiciones manuales de la Liga Promérica (cache 1 min).
app.get('/api/standings/promerica', async (req, res) => {
  try {
    const now = Date.now();
    if (promericaStandingsCacheAt && now - promericaStandingsCacheAt < PRO_PROMERICAS_CACHE_MS) {
      return res.json(promericaStandingsCache);
    }
    const [teams, db] = await Promise.all([
      loadTeams(),
      supabase.from('standings_promerica').select('*')
    ]);
    if (db.error) throw db.error;
    const last = lastManualUpdate(db.data);
    const body = {
      updatedAt: last ? last.updated_at : null,
      updatedBy: last ? last.updated_by : null,
      standings: decoratePromericaStandings(mergeStandingsRoster(teams, db.data), teams)
    };
    promericaStandingsCache = body;
    promericaStandingsCacheAt = now;
    res.json(body);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET del panel: los 10 clubes con sus números (ceros si nunca se guardaron).
app.get('/api/standings/promerica/admin', authenticateWriter, async (req, res) => {
  try {
    const [teams, db] = await Promise.all([
      loadTeams(),
      supabase.from('standings_promerica').select('*')
    ]);
    if (db.error) throw db.error;
    const map = standingsRowMap(db.data);
    const rows = (teams || []).map((t) => {
      const s = map.get(t.slug) || {};
      const g = Number(s.g) || 0;
      const e = Number(s.e) || 0;
      const gf = Number(s.gf) || 0;
      const gc = Number(s.gc) || 0;
      return {
        slug: t.slug,
        equipo: t.nombre,
        escudo: t.escudo,
        pj: Number(s.pj) || 0,
        g,
        e,
        p: Number(s.p) || 0,
        gf,
        gc,
        dif: (s.dif !== undefined && s.dif !== null) ? Number(s.dif) : gf - gc,
        pts: (s.pts !== undefined && s.pts !== null) ? Number(s.pts) : g * 3 + e
      };
    });
    const last = lastManualUpdate(db.data);
    res.json({ standings: rows, updatedAt: last ? last.updated_at : null, updatedBy: last ? last.updated_by : null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT Privado (panel): guarda las estadísticas de los 10 clubes de una vez.
app.put('/api/standings/promerica', authenticateWriter, async (req, res) => {
  try {
    const allowed = await loadTeamsSlugs();
    const { data, error } = validateStandingsRows(req.body, allowed);
    if (error) return res.status(400).json({ error });
    const updatedAt = new Date().toISOString();
    const rowsToSave = data.map((row) => ({
      equipo_slug: sanitizeText(row.slug),
      pj: Number(row.pj) || 0,
      g: Number(row.g) || 0,
      e: Number(row.e) || 0,
      p: Number(row.p) || 0,
      gf: Number(row.gf) || 0,
      gc: Number(row.gc) || 0,
      dif: Number(row.dif) || 0,
      pts: Number(row.pts) || 0,
      updated_by: req.writer || null,
      updated_at: updatedAt
    }));
    const { error: upsertError } = await supabase
      .from('standings_promerica')
      .upsert(rowsToSave, { onConflict: 'equipo_slug' });
    if (upsertError) throw upsertError;
    promericaStandingsCacheAt = 0;
    res.json({ ok: true, updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Próximos partidos (fixtures) ============
// Mismo patrón de caché que standings (TTL 2h + stale-while-revalidate).
// Ligas europeas → football-data.org (endpoint de matches); Liga Promérica
// (Costa Rica) → API-Football (api-sports), que sí cubre UNAFUT. La clave de
// API-Football es secreta y debe vivir en el servidor (API_FOOTBALL_KEY).
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const COSTA_RICA_LEAGUE_ID = 162;
const FIXTURES_WINDOW_DAYS = 3;

function fixturesCacheKey(ligaKey) {
  return `fixtures:${ligaKey}`;
}

function isoDateDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// La temporada de API-Football se identifica por el año de inicio (p. ej. la
// 2026-27 es "2026"). En Costa Rica la Apertura arranca en el segundo semestre.
function apiFootballSeasonFor(date) {
  const d = date || new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

function footballDataMatchToFixture(match) {
  return {
    fecha: String(match.utcDate || '').slice(0, 10),
    fechaISO: match.utcDate || null,
    jornada: match.matchday ? `Jornada ${match.matchday}` : match.stage || '',
    liga: (match.competition && match.competition.name) || '',
    estado: match.status || '',
    local: {
      equipo: (match.homeTeam && match.homeTeam.name) || '',
      escudo: (match.homeTeam && match.homeTeam.crest) || ''
    },
    visitante: {
      equipo: (match.awayTeam && match.awayTeam.name) || '',
      escudo: (match.awayTeam && match.awayTeam.crest) || ''
    }
  };
}

function apiFootballFixtureToFixture(item) {
  const fixture = (item && item.fixture) || {};
  const home = (item && item.teams && item.teams.home) || {};
  const away = (item && item.teams && item.teams.away) || {};
  const league = (item && item.league) || {};
  return {
    fecha: String(fixture.date || '').slice(0, 10),
    fechaISO: fixture.date || null,
    jornada: league.round || '',
    liga: league.name || 'Liga Promérica',
    estado: (fixture.status && fixture.status.short) || 'NS',
    local: { equipo: home.name || '', escudo: home.logo || '' },
    visitante: { equipo: away.name || '', escudo: away.logo || '' }
  };
}

async function fetchFootballDataFixtures(leagueCode) {
  const url =
    `https://api.football-data.org/v4/competitions/${leagueCode}/matches` +
    `?status=SCHEDULED&dateFrom=${isoDateDaysFromNow(0)}&dateTo=${isoDateDaysFromNow(FIXTURES_WINDOW_DAYS - 1)}`;
  const response = await fetch(url, { headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY } });
  const json = await response.json();
  if (!response.ok || !Array.isArray(json.matches)) {
    throw new Error(json.message || `Error HTTP: ${response.status}`);
  }
  return json.matches
    .map(footballDataMatchToFixture)
    .filter((f) => f.fechaISO)
    .sort((a, b) => String(a.fechaISO).localeCompare(String(b.fechaISO)))
    .slice(0, 20);
}

async function fetchApiFootballFixtures() {
  const url =
    `${API_FOOTBALL_BASE}/fixtures?league=${COSTA_RICA_LEAGUE_ID}` +
    `&season=${apiFootballSeasonFor()}&status=NS&timezone=America/Costa_Rica`;
  const response = await fetch(url, { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY } });
  const json = await response.json();
  const apiError =
    json && json.errors && Object.keys(json.errors).length
      ? Object.values(json.errors).join(' ')
      : '';
  if (!response.ok || apiError) {
    throw new Error(apiError || `Error HTTP: ${response.status}`);
  }
  const now = Date.now();
  return (Array.isArray(json.response) ? json.response : [])
    .map(apiFootballFixtureToFixture)
    .filter((f) => f.fechaISO && new Date(f.fechaISO).getTime() >= now - 60 * 60 * 1000)
    .sort((a, b) => String(a.fechaISO).localeCompare(String(b.fechaISO)))
    .slice(0, 20);
}

// GET Público: próximos partidos de una liga. Cachea 2h como standings.
app.get('/api/fixtures/:liga', async (req, res) => {
  const ligaKey = req.params.liga.toLowerCase();
  const leagueCode = LEAGUE_MAP[ligaKey];
  const isPromerica = ligaKey === 'promerica';

  if (!leagueCode && !isPromerica) return res.status(400).json({ error: 'Liga no válida.' });

  const requiredKey = isPromerica ? process.env.API_FOOTBALL_KEY : process.env.FOOTBALL_DATA_API_KEY;
  if (!requiredKey) return res.status(500).json({ error: 'Configuración interna del servidor.' });

  const now = Date.now();
  const cacheKey = fixturesCacheKey(ligaKey);
  if (cache[cacheKey] && now - cache[cacheKey].timestamp < CACHE_TTL_MS) {
    return res.json({ stale: false, data: cache[cacheKey].data });
  }

  try {
    const transformed = isPromerica
      ? await fetchApiFootballFixtures()
      : await fetchFootballDataFixtures(leagueCode);
    cache[cacheKey] = { timestamp: now, data: transformed };
    return res.json({ stale: false, data: transformed });
  } catch (error) {
    if (cache[cacheKey]) return res.json({ stale: true, data: cache[cacheKey].data });
    return res.status(503).json({ error: error.message });
  }
});

// GET Público: máximos goleadores de una liga. Mismo patrón de cache que
// fixtures/standings (2h) y mismo manejo de stale si el proveedor cae.
// Promérica NO pasa por aquí: se sirve manual desde la BD (rutas de abajo).
function scoresCacheKey(ligaKey) {
  return `scorers:${ligaKey}`;
}

function footballDataScorerToRow(s) {
  const player = (s && s.player) || {};
  const team = (s && s.team) || {};
  return {
    jugador: player.name || '',
    equipo: team.name || '',
    escudo: team.crest || '',
    goles: Number(s.goals) || 0,
    asistencias: Number(s.assists) || 0,
    posicion: player.position || ''
  };
}

async function fetchFootballDataScorers(leagueCode) {
  const url = `https://api.football-data.org/v4/competitions/${leagueCode}/scorers?limit=10`;
  const response = await fetch(url, { headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY } });
  const json = await response.json();
  if (!response.ok || !Array.isArray(json.scorers)) {
    throw new Error(json.message || `Error HTTP: ${response.status}`);
  }
  return json.scorers
    .filter((s) => s && s.player && s.player.name)
    .map(footballDataScorerToRow)
    .slice(0, 10);
}

app.get('/api/top-scorers/:liga', async (req, res, next) => {
  const ligaKey = req.params.liga.toLowerCase();
  if (ligaKey === 'promerica') return next();
  const leagueCode = LEAGUE_MAP[ligaKey];

  if (!leagueCode) return res.status(400).json({ error: 'Liga no válida.' });

  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Configuración interna del servidor.' });

  const now = Date.now();
  const cacheKey = scoresCacheKey(ligaKey);
  if (cache[cacheKey] && now - cache[cacheKey].timestamp < CACHE_TTL_MS) {
    return res.json({ stale: false, data: cache[cacheKey].data });
  }

  try {
    const transformed = await fetchFootballDataScorers(leagueCode);
    cache[cacheKey] = { timestamp: now, data: transformed };
    return res.json({ stale: false, data: transformed });
  } catch (error) {
    if (cache[cacheKey]) return res.json({ stale: true, data: cache[cacheKey].data });
    return res.status(503).json({ error: error.message });
  }
});

// ============ Goleadores Liga Promérica (actualización manual) ============
// Misma filosofía que las posiciones: sin fuente externa confiable para
// UNAFUT, la redacción los carga a mano desde el panel (login existente) en
// la tabla goleadores_promerica. El nombre/escudo del equipo salen del
// catálogo teams_ca. RLS anon solo lectura; escrituras solo backend.
const PRO_PROMERICAS_SCORERS_CACHE_MS = 60 * 1000;
let promericaScorersCache = null;
let promericaScorersCacheAt = 0;

// Ordena y decora la vista pública (jugador + equipo + escudo). Exportado.
function decoratePromericaScorers(rows, teams) {
  const teamBySlug = new Map((teams || []).map((t) => [t.slug, t]));
  return (rows || [])
    .map((r) => {
      const team = teamBySlug.get(r.equipo_slug) || {};
      return {
        jugador: r.jugador || '',
        equipo: team.nombre || r.equipo_slug,
        escudo: team.escudo || '',
        goles: Number(r.goles) || 0,
        asistencias: Number(r.asistencias) || 0
      };
    })
    .sort((a, b) =>
      b.goles - a.goles || b.asistencias - a.asistencias || String(a.jugador).localeCompare(String(b.jugador), 'es')
    )
    .slice(0, 30);
}

// Valida el payload del panel: lista acotada, jugador con nombre y club del
// catálogo, goles/asistencias enteros >= 0. Exportado para tests.
function validateTopScorersRows(payload, allowedSlugs) {
  const rows = Array.isArray(payload && payload.rows) ? payload.rows : null;
  if (!rows || rows.length < 1 || rows.length > 30) {
    return { error: 'Se esperaba la lista de goleadores en "rows".' };
  }
  const slugSet = new Set(allowedSlugs || []);
  for (const row of rows) {
    if (!row || typeof row !== 'object') return { error: 'Fila inválida en la lista.' };
    const jugador = sanitizeText(row.jugador || '').slice(0, 80);
    if (!jugador) return { error: 'Falta el nombre del jugador.' };
    const slug = sanitizeText(row.equipo_slug || '');
    if (!slugSet.has(slug)) return { error: `Equipo no válido: "${slug}".` };
    for (const key of ['goles', 'asistencias']) {
      const v = row[key];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 999) {
        return { error: `Valor inválido en "${jugador}" (${key}).` };
      }
    }
  }
  return { data: rows };
}

// GET Público: goleadores manuales de la Liga Promérica (cache 1 min).
app.get('/api/top-scorers/promerica', async (req, res) => {
  try {
    const now = Date.now();
    if (promericaScorersCacheAt && now - promericaScorersCacheAt < PRO_PROMERICAS_SCORERS_CACHE_MS) {
      return res.json(promericaScorersCache);
    }
    const [teams, db] = await Promise.all([
      loadTeams(),
      supabase.from('goleadores_promerica').select('*')
    ]);
    if (db.error) throw db.error;
    const last = lastManualUpdate(db.data);
    const body = {
      updatedAt: last ? last.updated_at : null,
      updatedBy: last ? last.updated_by : null,
      data: decoratePromericaScorers(db.data, teams)
    };
    promericaScorersCache = body;
    promericaScorersCacheAt = now;
    res.json(body);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET del panel: la lista guardada (o vacía) + el catálogo de clubes para el editor.
app.get('/api/top-scorers/promerica/admin', authenticateWriter, async (req, res) => {
  try {
    const [teams, db] = await Promise.all([
      loadTeams(),
      supabase.from('goleadores_promerica').select('*')
    ]);
    if (db.error) throw db.error;
    const teamBySlug = new Map((teams || []).map((t) => [t.slug, t]));
    const rows = (db.data || [])
      .map((r) => ({
        id: r.id,
        jugador: r.jugador || '',
        equipo_slug: r.equipo_slug || '',
        escudo: (teamBySlug.get(r.equipo_slug) || {}).escudo || '',
        goles: Number(r.goles) || 0,
        asistencias: Number(r.asistencias) || 0
      }))
      .sort((a, b) => b.goles - a.goles || b.asistencias - a.asistencias || String(a.jugador).localeCompare(String(b.jugador), 'es'));
    const last = lastManualUpdate(db.data);
    res.json({
      rows,
      teams: (teams || []).map((t) => ({ slug: t.slug, nombre: t.nombre, escudo: t.escudo })),
      updatedAt: last ? last.updated_at : null,
      updatedBy: last ? last.updated_by : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT Privado (panel): reemplaza la lista completa de goleadores de una vez.
app.put('/api/top-scorers/promerica', authenticateWriter, async (req, res) => {
  try {
    const allowed = await loadTeamsSlugs();
    const { data, error } = validateTopScorersRows(req.body, allowed);
    if (error) return res.status(400).json({ error });
    const updatedAt = new Date().toISOString();
    const rowsToSave = (data || [])
      .map((r) => ({
        jugador: sanitizeText(r.jugador).slice(0, 80),
        equipo_slug: sanitizeText(r.equipo_slug),
        goles: Number(r.goles) || 0,
        asistencias: Number(r.asistencias) || 0,
        updated_by: req.writer || null,
        updated_at: updatedAt
      }));
    const { error: deleteError } = await supabase
      .from('goleadores_promerica')
      .delete()
      .gte('id', '00000000-0000-0000-0000-000000000000');
    if (deleteError) throw deleteError;
    if (rowsToSave.length) {
      const { error: insertError } = await supabase.from('goleadores_promerica').insert(rowsToSave);
      if (insertError) throw insertError;
    }
    promericaScorersCacheAt = 0;
    res.json({ ok: true, updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Widget embebible de posiciones (iframe). A diferencia del resto del sitio,
// esta página permite que OTROS sitios la incrusten (frame-ancestors * y sin
// X-Frame-Options). El resto de respuestas conserva la CSP cerrada de helmet.
const WIDGET_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  "connect-src 'self'"
].join('; ');

app.get('/widget/posiciones', (req, res) => {
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Security-Policy', `${WIDGET_CSP}; frame-ancestors *`);
  res.sendFile(path.join(__dirname, 'widgets', 'posiciones.html'));
});

// Estáticos explícitos de PWA (solo esta carpeta; no exponer fuentes)
app.use(
  '/public',
  express.static(path.join(__dirname, 'public'), { maxAge: '7d', immutable: true })
);

// Service Worker en la raíz del dominio (scope "/" para controlar toda la SPA)
app.get('/sw.js', (req, res) => {
  res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ads.txt en la raíz del dominio para Google AdSense (fuera de la SPA)
app.get('/ads.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'ads.txt'));
});

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
module.exports.oauth1SignatureBase = oauth1SignatureBase;
module.exports.oauth1Signature = oauth1Signature;
module.exports.oauth1Authorization = oauth1Authorization;
module.exports.maybeAutopostNote = maybeAutopostNote;
module.exports.resolveTeamSlugs = resolveTeamSlugs;
module.exports.decoratePlayersWithTeams = decoratePlayersWithTeams;
module.exports.decorateRumors = decorateRumors;
module.exports.validateRumor = validateRumor;
module.exports.validateReaderPhoto = validateReaderPhoto;
module.exports.validateTransferWindow = validateTransferWindow;
module.exports.loadSettingsPublic = loadSettingsPublic;
module.exports.decoratePromericaStandings = decoratePromericaStandings;
module.exports.validateStandingsRows = validateStandingsRows;
module.exports.footballDataScorerToRow = footballDataScorerToRow;
module.exports.decoratePromericaScorers = decoratePromericaScorers;
module.exports.validateTopScorersRows = validateTopScorersRows;
module.exports.mergeStandingsRoster = mergeStandingsRoster;
