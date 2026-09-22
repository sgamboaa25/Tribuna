# AGENTS.md — Tribuna

Guía de contexto para agentes que trabajan en este repositorio. Léela antes de tocar código.

## Proyecto

"Tribuna" es un sitio de noticias deportivas. SPA en `index.html` (HTML/CSS/JS vanilla) que se sirve con Node/Express (`server.js`), con Supabase como backend (Postgres, Auth, Storage y Edge Functions).

## Stack

- **Frontend:** HTML/CSS/JS vanilla en `index.html` (sin framework, sin build). `@supabase/supabase-js` vía CDN.
- **Backend:** Node.js + Express en `server.js` (también expone el feed RSS). El cliente del backend usa `@supabase/supabase-js` con credenciales de entorno.
- **Base de datos:** Supabase Postgres (schema idempotente en `supabase-schema.sql`, semilla en `seed-notes.json`). Si la variable `DATABASE_URL` está configurada, `npm start` lo aplica automáticamente antes de arrancar (`npm run db:migrate`); si no, hay que ejecutarlo a mano en el SQL Editor. El schema es totalmente re-ejecutable (IF NOT EXISTS / WHERE NOT EXISTS).
- **Serverless (cuando aplique):** Supabase Edge Functions (`functions/*`).

## Convenciones de diseño

- **Tipografía:** `Fraunces` (serif) para títulos, destacados y números editoriales; `Inter` (sans-serif) para cuerpo, UI, botones y formularios. Import vía Google Fonts en `index.html`.
- **Paleta:** blanco/negro + coral `#A8321A`. Se definen como variables CSS en `:root` (`--ink`, `--paper`, `--accent`, `--muted`, `--line`, etc.) con tema claro/oscuro vía `[data-theme="dark"]`. Usa siempre las variables, nunca color en crudo dentro del markup.
- **Idioma/estilo:** contenido del sitio en español. UI responsive, accesible (botones con área táctil de ~44px, `dialog` para modales, temática con `prefers-color-scheme`).

## Regla de seguridad NO NEGOCIABLE

**Nunca incluyas claves secretas, tokens de API ni credenciales directamente en archivos HTML/JS que se sirvan al navegador.** Siempre deben ir como variables de entorno del backend (Node/Express) o como secretos de Supabase Edge Functions (`process.env.*`, `Deno.env.get(...)`, etc.).

Notas de aplicación:

- Claves que NO son secretas (publicables por diseño) y que SÍ pueden vivir en el cliente: la `anon`/`publishable` key de Supabase y la URL pública del proyecto.
- Claves que SON secretas y deben ir SIEMPRE en el servidor: `service_role`/service-role key de Supabase, API keys de proveedores externos (ej. `FOOTBALL_DATA_API_KEY` en `server.js`), tokens OAuth, etc.
- Si una ruta del sitio necesita una clave secreta, móvela a `server.js` o a una Edge Function; nunca al HTML/JS que se descarga en el navegador.

## Datos del proyecto

- URL pública de Supabase: `https://jmsjbbubhyszrbgqrfio.supabase.co`
- Feed RSS: `/functions/v1/feed-rss`
- Tablas principales: `notes` (noticias, campo `status` con valores como `publicada`/borrador).

## Variables de entorno del backend (ver `.env.example`)

- `SUPABASE_URL` — URL pública de Supabase (no secreta).
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (SECRETA; la usa el backend para escribir).
- `DATABASE_URL` — connection string de Postgres de Supabase (SECRETA); la usa `npm run db:migrate` para aplicar `supabase-schema.sql` automáticamente antes de `npm start`. Si falta, la migración se omite (no rompe el arranque).
- `FOOTBALL_DATA_API_KEY` — API key externa de standings (SECRETA).
- `WRITER_PASSWORD` — contraseña compartida de la redacción (SECRETA).
- `PORT` — puerto de Express (opcional).
- `X_AUTOPOST_ENABLED` — activa la autopublicación en X de notas urgentes (`true`/`false`, por defecto desactivada).
- `X_CONSUMER_KEY` / `X_CONSUMER_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` — credenciales de la X API (OAuth 1.0a, SECRETAS; solo viven en el backend).