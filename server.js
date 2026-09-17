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
  'cl': 'CL',
  'bl1': 'BL1',
  'ded': 'DED',
  'bsa': 'BSA',
  'pd': 'PD',
  'fl1': 'FL1',
  'elc': 'ELC',
  'ppl': 'PPL',
  'ec': 'EC',
  'sa': 'SA',
  'pl': 'PL'
};

const cache = {};
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

app.get('/api/standings/:liga', async (req, res) => {
  const ligaKey = req.params.liga.toLowerCase();
  const leagueCode = LEAGUE_MAP[ligaKey];

  if (!leagueCode) {
    return res.status(400).json({ error: 'Liga no válida.' });
  }

  const now = Date.now();
  if (cache[ligaKey] && (now - cache[ligaKey].timestamp < CACHE_TTL_MS)) {
    return res.json({ stale: false, data: cache[ligaKey].data });
  }

  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Configuración interna del servidor.' });
  }

  try {
    const url = `https://api.football-data.org/v4/competitions/${leagueCode}/standings`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Auth-Token': apiKey
      }
    });

    const json = await response.json();

    if (!response.ok || !json.standings || json.standings.length === 0) {
      throw new Error(json.message || `Error HTTP: ${response.status}`);
    }

    const standingObj = json.standings.find(s => s.type === 'TOTAL') || json.standings[0];
    const rawStandings = standingObj ? standingObj.table : [];

    const transformedData = rawStandings.map(item => ({
      posicion: item.position,
      equipo: item.team.name,
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
    console.error(`[API ERROR] ${ligaKey}:`, error.message);
    if (cache[ligaKey]) {
      return res.json({ stale: true, data: cache[ligaKey].data });
    }
    return res.status(503).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));