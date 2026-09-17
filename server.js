const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_ROLE_KEY);

const activeSessions = new Map();

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

app.post('/api/auth', (req, res) => {
  const { email, password } = req.body;
  const serverPassword = process.env.WRITER_PASSWORD;

  if (!serverPassword) {
    return res.status(500).json({ error: 'Configuración interna del servidor incompleta.' });
  }

  if (!email || password !== serverPassword) {
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;

  activeSessions.set(token, { email, expiresAt });

  return res.json({ token, expiresAt });
});

// GET Público: Obtiene directamente todas las notas de Supabase
app.get('/api/notes', async (req, res) => {
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
  delete req.body.id;
  if (!req.body.status) req.body.status = 'borrador';
  
  const { data, error } = await supabase.from('notes').insert([req.body]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/notes/:id', authenticateWriter, async (req, res) => {
  const id = req.params.id;
  const { data, error } = await supabase.from('notes').update(req.body).eq('id', id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.patch('/api/notes/:id/status', authenticateWriter, async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  
  if (!['borrador', 'en revisión', 'publicada'].includes(status)) {
    return res.status(400).json({ error: 'Estado editorial no válido.' });
  }

  const { data, error } = await supabase
    .from('notes')
    .update({ status })
    .eq('id', id)
    .select();
    
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// FASE 5: SEO - Servir robots.txt
app.get('/robots.txt', (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const content = `User-agent: *\nAllow: /\n\nSitemap: ${protocol}://${host}/sitemap.xml`;
  res.type('text/plain');
  res.send(content);
});

// FASE 5: SEO - Generar sitemap.xml dinámico desde Supabase
app.get('/sitemap.xml', async (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;

  try {
    const { data: notes } = await supabase
      .from('notes')
      .select('id, created_at, status');

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    
    xml += `  <url>\n    <loc>${baseUrl}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;

    if (notes && notes.length > 0) {
      notes.forEach(note => {
        const date = note.created_at ? new Date(note.created_at).toISOString() : new Date().toISOString();
        xml += `  <url>\n    <loc>${baseUrl}/#note-${note.id}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
      });
    }

    xml += `</urlset>`;

    res.type('application/xml');
    res.send(xml);
  } catch (error) {
    res.status(500).send('Error al generar el sitemap');
  }
});

const LEAGUE_MAP = {
  'cl': 'CL', 'bl1': 'BL1', 'ded': 'DED', 'bsa': 'BSA',
  'pd': 'PD', 'fl1': 'FL1', 'elc': 'ELC', 'ppl': 'PPL',
  'ec': 'EC', 'sa': 'SA', 'pl': 'PL'
};

const cache = {};
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

app.get('/api/standings/:liga', async (req, res) => {
  const ligaKey = req.params.liga.toLowerCase();
  const leagueCode = LEAGUE_MAP[ligaKey];

  if (!leagueCode) return res.status(400).json({ error: 'Liga no válida.' });

  const now = Date.now();
  if (cache[ligaKey] && (now - cache[ligaKey].timestamp < CACHE_TTL_MS)) {
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

    const standingObj = json.standings.find(s => s.type === 'TOTAL') || json.standings[0];
    const rawStandings = standingObj ? standingObj.table : [];

    const transformedData = rawStandings.map(item => ({
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));