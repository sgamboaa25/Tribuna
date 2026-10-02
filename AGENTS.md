# AGENTS.md — Tribuna

Guía de contexto para agentes que trabajan en este repositorio. Léela antes de tocar código.

## Proyecto

"Tribuna" es un sitio de noticias deportivas. SPA en `index.html` (HTML/CSS/JS vanilla) que se sirve con Node/Express (`server.js`), con Supabase como backend (Postgres, Auth, Storage y Edge Functions).

## Stack

- **Frontend:** HTML/CSS/JS vanilla en `index.html` (sin framework, sin build). `@supabase/supabase-js` vía CDN.
- **Backend:** Node.js + Express en `server.js` (también expone `/rss.xml` y el sitemap). El cliente del backend usa `@supabase/supabase-js` con credenciales de entorno.
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
- Feed RSS: `/rss.xml` (lo sirve `server.js`; `/feed` redirige ahí). Existe además una
  Edge Function antigua en `/functions/v1/feed-rss`: si alguna vez difieren, la que
  manda es `/rss.xml` porque es la que declara el `<link rel="alternate">`.
- Tablas principales: `notes` (noticias, campo `status` con valores como `publicada`/borrador, `views` como contador de lecturas).
- `social_posts` (sección "En redes"): solo guarda `url` + `red` deducida del dominio por `server.js`; el texto y la imagen los pone la red al montar su embed oficial. No lleva claves de API.

## Sección "En redes" (X e Instagram)

- Única sección que se pinta desde `paintSocialSection()`, y solo en la portada
  (`socialSectionAllowed()`): si no, reaparecía al navegar a `/categoria/*`.
- Los scripts de `platform.twitter.com/widgets.js` y `www.instagram.com/embed.js`
  NO van en el `<head>`: se inyectan con `IntersectionObserver`
  (`SOCIAL_EMBED_MARGIN`). Un embed que no aparece en
  `SOCIAL_EMBED_TIMEOUT_MS` cae a una tarjeta con el enlace ("Ver en X" /
  "Ver en Instagram") — nunca a un hueco vacío.
- `red` se deduce en el servidor, nunca se acepta desde el cliente: es lo que
  decide qué embed se monta. La CSP de helmet ya permite los dominios de X e
  Instagram en `scriptSrc`, `connectSrc` y `frameSrc`; si se toca, revisa esas
  tres listas.
- **Caducidad:** una publicación sale sola de la portada a las
  `SOCIAL_POSTS_TTL_HOURS` (12 por defecto; `0` = nunca). El filtro va en la
  consulta de `GET /api/social-posts`, nunca en el cliente: ese endpoint es la
  única puerta pública de la sección. `GET /api/social-posts/manager` sí devuelve
  las caducadas (con `caduca`) para que la redacción pueda borrarlas; filtrar
  también el panel dejaría las viejas acumulándose sin forma de quitarlas.
- El embed de X se reconoce por la presencia de **cualquier** `iframe` en el
  hueco, no por la clase `twitter-tweet`: esa es del `blockquote`, y el iframe
  real sale como hermano con `twitter-widget twitter-widget-rendered`. Las
  clases de `widgets.js` son internas de X y cambian sin aviso.

## Regla de consentimiento NO NEGOCIABLE

**Nada de terceros que plante cookies o mida al visitante puede cargarse antes
de que acepte.** Igual que las claves, es una regla de servidores, no de
preferencias.

Concreto en el código:

- Ningún `<script>` de terceros en el `<head>`. Ni AdSense, ni gtag.js, ni los
  visores de redes. Cada uno se inyecta desde su cargador (`loadAdsenseIfAllowed()`,
  `loadAnalyticsIfAllowed()`, `hydrateSocialCard()`), que sale con
  `adsenseEnabled` / `analyticsEnabled` / `embedsEnabled` en `false`.
- Si añades una fuente nueva, self-hosteala en `public/fonts/` y declárala con
  `@font-face` en el CSS de `index.html` y de `widgets/posiciones.html`. No
  vuelvas a meter un `<link>` a `fonts.googleapis.com`: eso manda la IP del
  visitante a Google en el primer render, antes de que acepte nada. Declararlo
  en la política de cookies no lo hace legal. `test/fonts-local.test.js` falla
  si reaparece el CDN.
- `consumo/embeds` sin permiso no es "no cargar" el embed: es tampoco cargar el
  script de la red. Sin permiso se pinta `socialConsentMarkup()` con el enlace
  directo a la red.
- Cada finalidad va por su casilla (`CONSENT_OPTIONS`: publicidad, medición,
  visores). Nada de un único "Aceptar todas" como única vía: el art. 4.11 del
  RGPD pide consentimiento específico, y el botón "Ver la publicación" de las
  tarjetas de "En redes" llama a `grantConsentFor('embeds')` justamente para no
  arrastrar publicidad al ver un post. Si añades una finalidad, nueva casilla y
  `grantConsentFor()` tiene que seguir sin tocar las demás.
- `grantConsentFor()` copia el consentimiento antes de modificarlo
  (`Object.assign({}, …)`). Mutar `CONSENT_NONE` en el sitio contaminaría el
  "Rechazar todas" del resto de la sesión. `test/consent-granular.test.js`
  cubre las tres casillas, el aislamiento por finalidad y esa regresión.
- `COOKIE_CONSENT_VERSION` sube a 3 cada vez que se añade una categoría nueva al
  `CONSENT_ALL`: así quien ya había contestado vuelve a ver el aviso y queda
  constancia de que aceptó también lo nuevo.
- Retirar el consentimiento tiene que **cortar**, no solo dejar de pedir: por eso
  `applyConsent()` vacía los anuncios, manda `gtag('consent','update',…)` con
  todo en `denied` y avisa con el evento `tribuna:consent-change` para que las
  tarjetas de "En redes" que esperaban permiso se reintenten.
- Al tocar la CSP de `server.js`: permitir un dominio en `scriptSrc`/`connectSrc`
  **no** lo carga, solo deja que se cargue. Ampliarlo sin el gate de arriba
  convierte la excepción en la infracción.

`LEGAL_CONTACT` (`index.html`) es el canal legal real: correo obligatorio,
domicilio y teléfono recomendados. Si los cambias, actualiza también el pie de
página y `LEGAL_UPDATED` (la fecha que las cuatro políticas citan como versión
vigente).

## Variables de entorno del backend (ver `.env.example`)

- `SUPABASE_URL` — URL pública de Supabase (no secreta).
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (SECRETA; la usa el backend para escribir).
- `DATABASE_URL` — connection string de Postgres de Supabase (SECRETA); la usa `npm run db:migrate` para aplicar `supabase-schema.sql` automáticamente antes de `npm start`. Si falta, la migración se omite (no rompe el arranque).
- `FOOTBALL_DATA_API_KEY` — API key externa de standings (SECRETA).
- `API_FOOTBALL_KEY` — API key de API-Football (SECRETA) para los fixtures de la Liga Promérica; sin ella, `/api/fixtures/promerica` responde 500.
- `WRITER_PASSWORD` — contraseña compartida de la redacción (SECRETA).
- `PORT` — puerto de Express (opcional).
- `X_AUTOPOST_ENABLED` — activa la autopublicación en X de notas urgentes (`true`/`false`, por defecto desactivada).
- `X_CONSUMER_KEY` / `X_CONSUMER_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` — credenciales de la X API (OAuth 1.0a, SECRETAS; solo viven en el backend).
- `X_TIMELINE_ENABLED` / `X_TIMELINE_HANDLE` — timeline embebido de la cuenta de X en la sección "En redes" (`true`/`false` + `@usuario` sin arroba); desactivado por defecto. Ninguna de las dos es secreta: el handle va en el markup del embed.
- `SOCIAL_POSTS_TTL_HOURS` — horas que una publicación de "En redes" sigue en la portada (12 por defecto; `0` = nunca). Ninguna es secreta.

## Rutas del sitio (SPA, todas devuelven `index.html`)

`/`, `/categoria/:deporte`, `/curiosidades`, `/videos`, `/mercado`, `/etiquetas`,
`/tag/:slug`, `/autor/:slug`, `/equipo/:slug`, `/jugador/:slug`, `/quienes-somos`,
`/privacidad`.
Rutas de servidor aparte: `/rss.xml`, `/feed`, `/sitemap.xml`, `/robots.txt`, `/sw.js`,
`/ads.txt`, `/widget/posiciones` y todo `/api/*`.

## Verificación antes de dar algo por terminado

- `npm run lint` (ESLint sobre `server.js`) y `node --check public/sw.js`.
- `npm run test:unit` (puro, sin red) y `npm run test:regression` (levanta el servidor
  en un puerto libre y pega con HTTP de verdad).
- `index.html` no lo cubre ESLint: si tocas JS del cliente, el parseo se comprueba
  con `npm run lint:client` (extrae el script inline a `.tribuna-inline.js` y le
  pasa `node --check`), o indirectamente con los tests de `test/mercado-tags.test.js`, que lo aíslan en un `vm`.