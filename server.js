const express = require('express');
const app = express();

app.use(express.json());

// ==========================================
// 1. ENDPOINTS DE AUTENTICACIÓN Y NOTAS
// ==========================================
let notes = [
  {id: 0, sport: 'Fútbol', title: 'Cuando el juego pide una mirada más profunda', intro: 'Resultados, contexto y las historias que explican por qué el deporte importa mucho más allá del marcador.', author: 'Marta Villalobos', email: 'marta@tribuna.test', tags: 'análisis, fútbol', body: 'Detrás de cada resultado hay una historia...', image: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1200&q=80'}
];

app.post('/api/auth', (req, res) => {
  const { email, password } = req.body;
  if (email && password) {
    res.json({ token: 'mock-token-seguro' });
  } else {
    res.status(401).json({ error: 'Credenciales inválidas' });
  }
});

app.get('/api/notes', (req, res) => {
  res.json(notes);
});

app.post('/api/notes', (req, res) => {
  const newNote = { id: notes.length, ...req.body };
  notes.push(newNote);
  res.json(newNote);
});

app.put('/api/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (notes[id]) {
    notes[id] = { id, ...req.body };
    res.json(notes[id]);
  } else {
    res.status(404).json({ error: 'Nota no encontrada' });
  }
});

// ==========================================
// 2. CONFIGURACIÓN DE LIGAS (API-FOOTBALL)
// ==========================================
const LEAGUE_MAP = {
  'costa-rica': '162',
  'honduras': '163',
  'guatemala': '164',
  'el-salvador': '165',
  'panama': '166'
};

const cache = {};
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

app.get('/api/standings/:liga', async (req, res) => {
  const ligaKey = req.params.liga;
  const leagueId = LEAGUE_MAP[ligaKey];

  if (!leagueId) {
    return res.status(400).json({ error: 'Liga no válida.' });
  }

  const now = Date.now();

  if (cache[ligaKey] && (now - cache[ligaKey].timestamp < CACHE_TTL_MS)) {
    return res.json({ stale: false, data: cache[ligaKey].data });
  }

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    console.error('[API ERROR] Falta la variable de entorno API_FOOTBALL_KEY');
    return res.status(500).json({ error: 'Configuración interna del servidor.' });
  }

  try {
    const currentYear = new Date().getFullYear();
    const url = `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${currentYear}`;
    
    // Usando fetch nativo de Node.js (sin dependencias externas)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-apisports-key': apiKey,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    if (!response.ok) {
      throw new Error(`API-Football respondió con código HTTP ${response.status}`);
    }

    const json = await response.json();
    
    if (!json.response || json.response.length === 0) {
      throw new Error('No se encontraron datos para esta temporada o liga.');
    }

    const rawStandings = json.response[0].league.standings[0];
    
    const transformedData = rawStandings.map(item => ({
      posicion: item.rank,
      equipo: item.team.name,
      jugados: item.all.played,
      ganados: item.all.win,
      empatados: item.all.draw,
      perdidos: item.all.lose,
      golesFavor: item.all.goals.for,
      golesContra: item.all.goals.against,
      diferencia: item.goalsDiff,
      puntos: item.points
    }));

    cache[ligaKey] = { timestamp: now, data: transformedData };

    return res.json({ stale: false, data: transformedData });

  } catch (error) {
    console.error(`[API ERROR] Fallo al obtener tabla para ${ligaKey}:`, error.message);

    if (cache[ligaKey]) {
      return res.json({ stale: true, data: cache[ligaKey].data });
    }

    return res.status(503).json({ error: 'No se pudieron recuperar los datos.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de Tribuna en ejecución en puerto ${PORT}`));