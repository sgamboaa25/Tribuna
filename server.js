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
    const currentYear = new Date().getFullYear();
    const url = `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${currentYear}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-apisports-key': apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    const json = await response.json();
    if (!json.response || json.response.length === 0) {
      throw new Error('No se encontraron datos en la respuesta');
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
    return res.status(503).json({ error: 'No se pudieron recuperar los datos.' });
  }
});