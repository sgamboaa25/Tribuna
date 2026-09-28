# Tribuna

Periodismo deportivo independiente. Sitio de noticias en español, con SPA vanilla
y backend en Supabase.

## Stack

- **Frontend:** HTML/CSS/JS vanilla en `index.html` (sin framework, sin build).
  `@supabase/supabase-js` y DOMPurify por CDN.
- **Backend:** Node.js + Express en `server.js`. Sirve la SPA, el feed RSS, el
  sitemap y toda la API `/api/*`.
- **Datos:** Supabase Postgres. Esquema idempotente en `supabase-schema.sql`.
- **Service worker:** `public/sw.js` (offline + shell cache).

## Puesta en marcha

```bash
npm install
cp .env.example .env   # y rellena SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y WRITER_PASSWORD
npm start              # aplica la migración (si hay DATABASE_URL) y arranca en :3000
```

Si no defines `DATABASE_URL`, `npm start` arranca igual pero **no** aplica la
migración: ejecuta `supabase-schema.sql` a mano en el SQL Editor de Supabase.

## Variables de entorno

Todas están documentadas en `.env.example`. Las que importan:

| Variable | Secreto | Para qué |
| --- | --- | --- |
| `SUPABASE_URL` | no | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | **sí** | Lectura/escritura desde el backend |
| `DATABASE_URL` | **sí** | Solo para `npm run db:migrate` |
| `WRITER_PASSWORD` | **sí** | Acceso de redacción (`POST /api/auth`) |
| `API_FOOTBALL_KEY` | **sí** | Fixtures de la Liga Promérica |
| `FOOTBALL_DATA_API_KEY` | **sí** | Tablas de posiciones |
| `X_*` | **sí** | Autopublicación en X (apagada por defecto) |

**Nunca** pongas una clave secreta en `index.html` ni en nada que se sirva al
navegador. Lo único que puede vivir en el cliente es la `anon`/`publishable` key
de Supabase y la URL pública del proyecto.

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm start` | Migra (si puede) y arranca el servidor |
| `npm run db:migrate` | Aplica `supabase-schema.sql` |
| `npm run lint` | ESLint sobre `server.js` |
| `npm run lint:client` | Parsea el JS inline de `index.html` |
| `npm test` | Unitarios + regresión HTTP |
| `npm run test:unit` | Tests de lógica, sin red |
| `npm run test:regression` | Levanta el servidor y pega con HTTP de verdad |

## Rutas

SPA (todas devuelven `index.html`): `/`, `/categoria/:deporte`, `/curiosidades`,
`/videos`, `/mercado`, `/etiquetas`, `/tag/:slug`, `/autor/:slug`, `/equipo/:slug`,
`/jugador/:slug`, `/quienes-somos`.

Servidor: `/rss.xml` (y `/feed`, que redirige), `/sitemap.xml`, `/robots.txt`,
`/ads.txt`, `/sw.js`, `/widget/posiciones` y `/api/*`.

## Notas de mantenimiento

- El contador de lecturas (`notes.views`) lo incrementa **solo** el backend, en
  `POST /api/notes/:id/view`, con dedupe por IP + nota. No se otorga permiso de
  escritura al rol `anon` sobre esa columna a propósito: si lo tuviera, bastaría
  llamar al endpoint en bucle para inflar "Las notas más leídas".
- `index.html` no lo cubre ESLint ni ningún bundler. Si tocas su JS, pásalo por
  `npm run lint:client` antes de dar nada por terminado.
- `AGENTS.md` tiene las convenciones de diseño y la regla de seguridad al detalle.

## Deploy

`render.yaml` declara el web service y las variables de entorno. La migración de
la base de datos no se automatiza en el arranque: aplícala desde el SQL Editor
antes de desplegar cambios de esquema.
