const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_ROLE_KEY);

app.get('/api/notes', async (req, res) => {
  const { data, error } = await supabase.from('notes').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/notes', async (req, res) => {
  delete req.body.id;
  const { data, error } = await supabase.from('notes').insert([req.body]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/notes/:id', async (req, res) => {
  const id = req.params.id;
  const { data, error } = await supabase.from('notes').update(req.body).eq('id', id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

const LEAGUE_MAP = {
  'costa-rica': '162',
  'honduras': '163',
  'guatemala': '164',
  'el-salvador': '165',
  'panama': '166'
};

const cache = {};
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

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
    return res.status(500).json({ error: 'Configuración interna del servidor.' });
  }

  try {
    const seasonYear = '2026';
    const url = `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${seasonYear}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-apisports-key': apiKey
      }
    });

    const json = await response.json();

    if (!response.ok || !json.response || json.response.length === 0) {
      throw new Error(json.message || `Error HTTP: ${response.status} - Sin datos para la temporada ${seasonYear}`);
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
    console.error(`[API ERROR] ${ligaKey}:`, error.message);
    if (cache[ligaKey]) {
      return res.json({ stale: true, data: cache[ligaKey].data });
    }
    return res.status(503).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));