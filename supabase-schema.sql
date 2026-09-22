create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  title text not null,
  intro text not null,
  author text not null,
  email text not null,
  tags text default '',
  body text not null,
  image text,
  video_url text,
  status text not null default 'borrador',
  urgent boolean not null default false,
  archived boolean not null default false,
  -- Autopublicación en X: id y fecha del post enviado (anti doble envío).
  -- Los rellena el backend (server.js) tras publicar una nota urgente.
  x_post_id text,
  x_posted_at timestamptz,
  -- reactions: contadores de clap/wow/angry más, opcionalmente, la encuesta
  -- rápida (poll: {question, options:[2..4]} + poll_votes: {indice: votos}).
  -- Los lectores actualizan esta columna vía RLS (grant update (reactions)
  -- to anon), por eso poll y poll_votes viven aquí y NO requieren migración.
  reactions jsonb not null default '{"clap":0,"wow":0,"angry":0}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Migración para bases ya existentes (idempotente).
alter table public.notes add column if not exists archived boolean not null default false;
alter table public.notes add column if not exists x_post_id text;
alter table public.notes add column if not exists x_posted_at timestamptz;

-- Equipos vinculados a una nota (slugs). Los rellena el backend (server.js)
-- al guardar una nota a partir de sus etiquetas; los usa el hub /equipo/:slug.
alter table public.notes add column if not exists teams text[] not null default '{}';

-- Row Level Security:
-- El cliente público (rol anon) solo puede leer notas publicadas y
-- incrementar las reacciones. Todas las escrituras editoriales pasan
-- por el backend (server.js), que usa la service_role key y salta la RLS.
alter table public.notes enable row level security;

drop policy if exists "Lectura pública de notas publicadas" on public.notes;
create policy "Lectura pública de notas publicadas"
  on public.notes for select
  to anon
  using (status = 'publicada' and archived = false);

drop policy if exists "Reacciones públicas sobre notas publicadas" on public.notes;
create policy "Reacciones públicas sobre notas publicadas"
  on public.notes for update
  to anon
  using (status = 'publicada' and archived = false);

revoke all on table public.notes from anon;
grant select on table public.notes to anon;
grant update (reactions) on table public.notes to anon;

insert into public.notes (sport, title, intro, author, email, tags, body, status)
select 'Fútbol', 'Cuando el juego pide una mirada más profunda', 'Resultados, contexto y las historias que explican por qué el deporte importa mucho más allá del marcador.', 'Marta Villalobos', 'marta@tribuna.test', 'análisis, fútbol', 'Detrás de cada resultado hay una historia que merece ser contada. Mirar el juego con atención también significa comprender a quienes lo hacen posible: los equipos, las aficiones y las comunidades que encuentran en el deporte un lenguaje común.', 'publicada'
where not exists (select 1 from public.notes where title = 'Cuando el juego pide una mirada más profunda');

insert into public.notes (sport, title, intro, author, email, tags, body, status)
select 'Fútbol', 'La grada también juega el partido', 'Una noche de fútbol vista desde el pulso de quienes nunca abandonan su lugar.', 'Marta Villalobos', 'marta@tribuna.test', 'crónica, afición', 'Desde mucho antes del pitazo inicial, la grada construye su propio partido. Cada cántico y cada silencio forman parte de una experiencia colectiva que acompaña al equipo hasta el último minuto.', 'publicada'
where not exists (select 1 from public.notes where title = 'La grada también juega el partido');

insert into public.notes (sport, title, intro, author, email, tags, body, status)
select 'Baloncesto', 'El talento joven ya no espera turno', 'Las nuevas figuras transforman la conversación y elevan el ritmo de la liga.', 'Diego Morales', 'diego@tribuna.test', 'baloncesto, liga', 'La nueva generación juega sin pedir permiso. Su energía modifica los partidos y abre una conversación necesaria sobre oportunidades, formación y futuro dentro de la cancha.', 'publicada'
where not exists (select 1 from public.notes where title = 'El talento joven ya no espera turno');

insert into public.notes (sport, title, intro, author, email, tags, body, status, reactions)
select 'Fútbol', 'La victoria tiene más de una medida', 'Repensar el deporte desde el cuidado, la comunidad y la perseverancia.', 'Sofía Campos', 'sofia@tribuna.test', 'opinión, atletismo', 'No todos los triunfos caben en una medalla. En cada proceso deportivo hay constancia, dudas y una red de personas que sostienen a quienes compiten.', 'publicada', '{"clap":0,"wow":0,"angry":0}'::jsonb
where not exists (select 1 from public.notes where title = 'La victoria tiene más de una medida');

-- MVP DE LA JORNADA (MUESTRA): nota-encuesta etiquetada "mvp" que la sección
-- "MVP de la jornada" de la portada destaca automáticamente. La redacción crea
-- una igual desde el panel (marcom "Añadir una encuesta rápida" y etiqueta mvp);
-- o re-publica esta actualizando pregunta/opciones/votos.
insert into public.notes (sport, title, intro, author, email, tags, body, status, reactions)
select 'Fútbol', '¿Quién fue el MVP de la jornada?', 'Elegí al mejor del partido del fin de semana en la Liga Promérica.', 'Redacción Tribuna', 'redaccion@tribuna.test', 'mvp, liga promerica, jornada', 'El voto de los lectores define al jugador destacado de cada jornada. Resultados en tiempo real al votar.', 'publicada', '{"clap":0,"wow":0,"angry":0,"poll":{"question":"¿Quién fue el MVP de la jornada?","options":["Joel Campbell","Alexander López","Alonso Martínez"]},"poll_votes":{"0":24,"1":11,"2":9}}'::jsonb
where not exists (select 1 from public.notes where title = '¿Quién fue el MVP de la jornada?');

-- ============================================================
-- NEWSLETTER SEMANAL
-- ============================================================

-- Suscriptores del boletín. El campo `confirmed` permite activar
-- más adelante un doble opt-in: hoy se inserta ya activo (true).
-- Toda escritura pasa por el backend (server.js) o la Edge Function,
-- que usan service_role y saltan la RLS. Por eso la RLS queda
-- cerrada para el cliente público (anon).
create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  confirmed boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.subscribers enable row level security;

revoke all on table public.subscribers from anon;
revoke all on table public.subscribers from authenticated;

-- Audit log de cada envío del boletín (la escribe la Edge Function).
create table if not exists public.newsletter_sends (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  sent_at timestamptz not null default now(),
  notes_count int not null default 0,
  recipients_count int not null default 0,
  status text not null default 'ok',
  error text
);

alter table public.newsletter_sends enable row level security;

revoke all on table public.newsletter_sends from anon;
revoke all on table public.newsletter_sends from authenticated;

-- ============================================================
-- PROGRAMACIÓN SEMANAL (pg_cron -> Edge Function) — DESPUÉS
-- de desplegar functions/newsletter-send/index.ts y guardar en Vault
-- el secreto CRON_SECRET. Ejecutar una sola vez en el SQL editor.
-- Domingos 08:00 UTC. Si quieres otra hora local, ajusta la zona: p.ej.
-- domingo 10:00 en verano madrileño (CEST) = 08:00 UTC -> '0 8 * * 0'.
-- select cron.schedule(
--   'newsletter-semanal',
--   '0 8 * * 0',
--   $$
--   select net.http_post(
--     url := 'https://jmsjbbubhyszrbgqrfio.supabase.co/functions/v1/newsletter-send',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-tribuna-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
--     ),
--     body := '{}',
--     timeout_milliseconds := 10000
--   );
--   $$
-- );

-- ============================================================
-- EQUIPOS DE LA LIGA PROMÉRICA (Costa Rica) — HUBS /equipo/:slug
-- ============================================================
-- Catálogo de clubes de la Primera División de Costa Rica (Liga Promérica)
-- para las páginas de hub por equipo. Escudos y nombres son datos públicos.
-- Se pobla una única vez (no cambian seguido); si algo cambia, se actualiza
-- esta tabla (p.ej. con el SQL de abajo) sin tocar código.
create table if not exists public.teams_ca (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  escudo text not null,
  slug text not null unique,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.teams_ca enable row level security;

-- El cliente público puede leer el catálogo (nombres + escudos públicos).
drop policy if exists "Lectura pública de equipos" on public.teams_ca;
create policy "Lectura pública de equipos"
  on public.teams_ca for select
  to anon
  using (true);

revoke all on table public.teams_ca from anon;
grant select on table public.teams_ca to anon;

-- Seed idempotente con los 10 clubes de la temporada 2026-27
-- (escudos de TheSportsDB, URLs públicas). Los aliases son variantes de
-- etiqueta que el backend usa para enlazar notas automáticamente.
insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Alajuelense', 'https://r2.thesportsdb.com/images/media/team/badge/zi9ft21707630526.png', 'alajuelense', '{"alajuelense","lda","manudos"}'
where not exists (select 1 from public.teams_ca where slug = 'alajuelense');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Cartaginés', 'https://r2.thesportsdb.com/images/media/team/badge/0mo64x1589122311.png', 'cartagines', '{"cartagines","brumosos"}'
where not exists (select 1 from public.teams_ca where slug = 'cartagines');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Deportivo Saprissa', 'https://r2.thesportsdb.com/images/media/team/badge/tvj33z1707630611.png', 'saprissa', '{"saprissa","deportivo saprissa"}'
where not exists (select 1 from public.teams_ca where slug = 'saprissa');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Escorpiones de Belén', 'https://r2.thesportsdb.com/images/media/team/badge/aeng4x1785697969.png', 'escorpiones-belen', '{"escorpiones de belen","escorpiones","belen"}'
where not exists (select 1 from public.teams_ca where slug = 'escorpiones-belen');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Herediano', 'https://r2.thesportsdb.com/images/media/team/badge/20qq911582143301.png', 'herediano', '{"herediano","fluminense"}'
where not exists (select 1 from public.teams_ca where slug = 'herediano');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Inter de San Carlos', 'https://r2.thesportsdb.com/images/media/team/badge/9doqdz1781200489.png', 'inter-san-carlos', '{"inter de san carlos","inter san carlos"}'
where not exists (select 1 from public.teams_ca where slug = 'inter-san-carlos');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Pérez Zeledón', 'https://r2.thesportsdb.com/images/media/team/badge/rbsepr1589122379.png', 'perez-zeledon', '{"perez zeledon","zeledon"}'
where not exists (select 1 from public.teams_ca where slug = 'perez-zeledon');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Puntarenas', 'https://r2.thesportsdb.com/images/media/team/badge/ljzov51657724106.png', 'puntarenas', '{"puntarenas"}'
where not exists (select 1 from public.teams_ca where slug = 'puntarenas');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'San Carlos', 'https://r2.thesportsdb.com/images/media/team/badge/v7hikt1606772054.png', 'san-carlos', '{"san carlos"}'
where not exists (select 1 from public.teams_ca where slug = 'san-carlos');

insert into public.teams_ca (nombre, escudo, slug, aliases)
select 'Sporting San José', 'https://r2.thesportsdb.com/images/media/team/badge/7wzxlo1606770023.png', 'sporting-san-jose', '{"sporting san jose","sporting"}'
where not exists (select 1 from public.teams_ca where slug = 'sporting-san-jose');

-- Las notas publicadas antes de esta migración no tienen equipos vinculados.
-- Cuando una de ellas mencione un equipo, re-guárdala (PUT /api/notes/:id) y
-- el backend recalculará el campo teams desde sus etiquetas.

-- ============================================================
-- PLANTILLA LIGA PROMÉRICA — PÁGINAS /jugador/:slug
-- ============================================================
-- Catálogo curado de jugadores (la redacción lo edita vía SQL o el panel).
-- Mismo modelo que teams_ca: el cliente solo lee (RLS select anon) y el
-- backend (server.js) lo sirve cacheado y enriquecido con el escudo del club.
create table if not exists public.players_ca (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  slug text not null unique,
  equipo_slug text not null,
  posicion text not null,
  dorsal integer,
  foto text,
  fecha_nacimiento date,
  nacionalidad text,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.players_ca enable row level security;

drop policy if exists "Lectura pública de jugadores" on public.players_ca;
create policy "Lectura pública de jugadores"
  on public.players_ca for select
  to anon
  using (true);

revoke all on table public.players_ca from anon;
grant select on table public.players_ca to anon;

-- Seed idempotente con una muestra representativa (MUESTRA INICIAL: la
-- redacción debe actualizar la plantilla real vía SQL eliminando los INSERT
-- de abajo). Sin foto ni fecha de nacimiento se muestra el fallback en la UI;
-- la columna foto admite cualquier URL pública (p. ej. r2.thesportsdb.com).
insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Christian Bolaños', 'christian-bolanos', 'saprissa', 'Mediocampista', 8, 'Costa Rica', '{}'
where not exists (select 1 from public.players_ca where slug = 'christian-bolanos');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Mariano Torres', 'mariano-torres', 'saprissa', 'Mediocampista', 7, 'Costa Rica', '{"mariano torres martinez"}'
where not exists (select 1 from public.players_ca where slug = 'mariano-torres');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Kendall Waston', 'kendall-waston', 'saprissa', 'Defensa', 4, 'Costa Rica', '{"macho watson"}'
where not exists (select 1 from public.players_ca where slug = 'kendall-waston');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Aarón Suárez', 'aaron-suarez', 'saprissa', 'Mediocampista', 10, 'Costa Rica', '{"aaron suarez"}'
where not exists (select 1 from public.players_ca where slug = 'aaron-suarez');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Bryan Ruiz', 'bryan-ruiz', 'alajuelense', 'Mediocampista', 10, 'Costa Rica', '{"el banda"}'
where not exists (select 1 from public.players_ca where slug = 'bryan-ruiz');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Joel Campbell', 'joel-campbell', 'alajuelense', 'Delantero', 7, 'Costa Rica', '{}'
where not exists (select 1 from public.players_ca where slug = 'joel-campbell');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Alexander López', 'alexander-lopez', 'alajuelense', 'Mediocampista', 6, 'Costa Rica', '{"alexander hernando lopez"}'
where not exists (select 1 from public.players_ca where slug = 'alexander-lopez');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Ian Smith', 'ian-smith', 'alajuelense', 'Defensa', 4, 'Costa Rica', '{"ian wesley smith"}'
where not exists (select 1 from public.players_ca where slug = 'ian-smith');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Alonso Martínez', 'alonso-martinez', 'alajuelense', 'Delantero', 9, 'Costa Rica', '{"alonso martinez jara"}'
where not exists (select 1 from public.players_ca where slug = 'alonso-martinez');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Yeltsin Tejeda', 'yeltsin-tejeda', 'herediano', 'Mediocampista', 6, 'Costa Rica', '{}'
where not exists (select 1 from public.players_ca where slug = 'yeltsin-tejeda');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Gerson Torres', 'gerson-torres', 'herediano', 'Delantero', 11, 'Costa Rica', '{"gerson torres barrantes"}'
where not exists (select 1 from public.players_ca where slug = 'gerson-torres');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Luis Díaz', 'luis-diaz', 'herediano', 'Defensa', 3, 'Costa Rica', '{"luis fernando diaz"}'
where not exists (select 1 from public.players_ca where slug = 'luis-diaz');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Daniel Chacón', 'daniel-chacon', 'cartagines', 'Mediocampista', 14, 'Costa Rica', '{"daniel chacon salas"}'
where not exists (select 1 from public.players_ca where slug = 'daniel-chacon');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Marcel Hernández', 'marcel-hernandez', 'cartagines', 'Delantero', 9, 'Cuba', '{"marcel"}'
where not exists (select 1 from public.players_ca where slug = 'marcel-hernandez');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Javon East', 'javon-east', 'san-carlos', 'Delantero', 9, 'Jamaica', '{}'
where not exists (select 1 from public.players_ca where slug = 'javon-east');

insert into public.players_ca (nombre, slug, equipo_slug, posicion, dorsal, nacionalidad, aliases)
select 'Junior Lara', 'junior-lara', 'puntarenas', 'Delantero', 7, 'Costa Rica', '{}'
where not exists (select 1 from public.players_ca where slug = 'junior-lara');

-- ============================================================
-- RASTREADOR DE FICHAJES — SECCIÓN "MERCADO" / panel redacción
-- ============================================================
-- Rumores curados por la redacción. El cliente público (anon) solo lee los
-- marcados como `activo`; toda escritura pasa por server.js con service_role.
-- Los slugs de club enlazan con /equipo/:slug y el jugador con /jugador/:slug.
create table if not exists public.transfer_rumors (
  id uuid primary key default gen_random_uuid(),
  jugador text not null,
  jugador_slug text,
  posicion text,
  club_origen text,
  club_origen_slug text,
  club_destino text,
  club_destino_slug text,
  estado text not null default 'rumor',
  veracidad integer not null default 50,
  fuente text,
  detalle text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transfer_rumors enable row level security;

drop policy if exists "Lectura pública de rumores activos" on public.transfer_rumors;
create policy "Lectura pública de rumores activos"
  on public.transfer_rumors for select
  to anon
  using (activo = true);

revoke all on table public.transfer_rumors from anon;
grant select on table public.transfer_rumors to anon;

-- Seed idempotente de MUESTRA: borra estos INSERT cuando la redacción cargue
-- sus primeros rumores reales (o úsalo como plantilla).
insert into public.transfer_rumors (jugador, jugador_slug, posicion, club_origen, club_origen_slug, club_destino, club_destino_slug, estado, veracidad, fuente, detalle)
select 'Marcel Hernández', 'marcel-hernandez', 'Delantero', 'Cartaginés', 'cartagines', 'San Carlos', 'san-carlos', 'avanzado', 65, 'La Nación', 'El entorno del jugador estudia la oferta del club del planeta. Se esperaría resolución antes del cierre del mercado.'
where not exists (select 1 from public.transfer_rumors where jugador = 'Marcel Hernández' and club_destino = 'San Carlos');

insert into public.transfer_rumors (jugador, jugador_slug, posicion, club_origen, club_origen_slug, club_destino, club_destino_slug, estado, veracidad, fuente, detalle)
select 'Alonso Martínez', 'alonso-martinez', 'Delantero', 'Alajuelense', 'alajuelense', 'Deportivo Saprissa', 'saprissa', 'rumor', 30, 'Afición Radio', 'El nombre suena en el vestuario rojinegro pero hoy no hay oferta formal sobre la mesa.'
where not exists (select 1 from public.transfer_rumors where jugador = 'Alonso Martínez' and club_destino = 'Deportivo Saprissa');

insert into public.transfer_rumors (jugador, jugador_slug, posicion, club_origen, club_origen_slug, club_destino, club_destino_slug, estado, veracidad, fuente, detalle)
select 'Christian Bolaños', 'christian-bolanos', 'Mediocampista', 'Deportivo Saprissa', 'saprissa', 'Pérez Zeledón', 'perez-zeledon', 'descartado', 10, '—', 'El club sur manifestó interés, pero el capitán continuará en el Monstruo esta temporada.'
where not exists (select 1 from public.transfer_rumors where jugador = 'Christian Bolaños' and club_destino = 'Pérez Zeledón');

-- ============================================================
-- FOTOS DE LECTORES (MODERADAS)
-- ============================================================
-- Los lectores suben su foto a Storage (bucket público compartido
-- "notes-images", carpeta lectores/; quien quiera endurecerlo crea un bucket
-- dedicado "reader-photos") y el navegador registra aquí solo el metadata vía
-- POST /api/reader-photos (server.js valida la URL de origen, honeypot y limite
-- por IP). La columna `estado` empieza como 'en_revision'; el panel de redacción
-- la pasa a 'publicada' o 'rechazada'. El cliente anon solo lee publicadas (RLS).
create table if not exists public.reader_photos (
  id uuid primary key default gen_random_uuid(),
  autor text not null,
  titulo text,
  foto text not null,
  estado text not null default 'en_revision',
  nota text,
  creada_ip text,
  moderada_por text,
  moderada_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.reader_photos enable row level security;

-- Escrituras solo por el backend (service_role). Sin INSERT/UPDATE/DELETE anon.
drop policy if exists "Lectura pública de fotos aprobadas" on public.reader_photos;
create policy "Lectura pública de fotos aprobadas"
  on public.reader_photos for select
  to anon
  using (estado = 'publicada');

revoke all on table public.reader_photos from anon;
grant select on table public.reader_photos to anon;

-- ============ Configuración editorial (clave/valor) ============
-- Datos ligeros que la redacción cambia desde el panel sin tocar código. Clave
-- usada hoy: 'next_transfer_window' (fecha de la próxima ventana de fichajes,
-- se muestra en el estado "sin rumores" de la sección Mercado). Solo el backend
-- (service_role) escribe; el cliente público la lee vía GET /api/settings/public.
create table if not exists public.site_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.site_settings enable row level security;

revoke all on table public.site_settings from anon;
revoke all on table public.site_settings from authenticated;

insert into public.site_settings (key, value)
select 'next_transfer_window', ''
where not exists (select 1 from public.site_settings where key = 'next_transfer_window');

-- ============================================================
-- POSICIONES LIGA PROMÉRICA — ACTUALIZACIÓN MANUAL
-- ============================================================
-- Ninguna API conectada cubre UNAFUT de forma confiable, así que la redacción
-- actualiza estas estadísticas a mano desde el panel (login existente) en la
-- tabla standings_promerica. La redacción escribe Pts y DIF a mano junto con el
-- resto de las estadísticas; se guardan tal cual se ingresan en el panel. Solo el
-- backend escribe (rutas /api/standings/promerica[/admin]); anon solo lee.
create table if not exists public.standings_promerica (
  id uuid primary key default gen_random_uuid(),
  equipo_slug text not null unique references public.teams_ca(slug) on delete cascade,
  pj integer not null default 0 check (pj between 0 and 999),
  g integer not null default 0 check (g between 0 and 999),
  e integer not null default 0 check (e between 0 and 999),
  p integer not null default 0 check (p between 0 and 999),
  gf integer not null default 0 check (gf between 0 and 999),
  gc integer not null default 0 check (gc between 0 and 999),
  dif integer not null default 0 check (dif between -999 and 999),
  pts integer not null default 0 check (pts between 0 and 999),
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.standings_promerica enable row level security;

drop policy if exists "Lectura pública de posiciones manuales" on public.standings_promerica;
create policy "Lectura pública de posiciones manuales"
  on public.standings_promerica for select
  to anon
  using (true);

revoke all on table public.standings_promerica from anon;
grant select on table public.standings_promerica to anon;

-- ============================================================
-- GOLEADORES LIGA PROMÉRICA — ACTUALIZACIÓN MANUAL
-- ============================================================
-- Misma filosofía que standings_promerica: la redacción carga los máximos
-- goleadores a mano desde el panel. El jugador es texto libre; el equipo se
-- referencia al catálogo teams_ca (nombre + escudo se resuelven al servir).
-- La lista es variable y se guarda reemplazándola completa. RLS anon lectura.
create table if not exists public.goleadores_promerica (
  id uuid primary key default gen_random_uuid(),
  jugador text not null check (char_length(jugador) between 1 and 80),
  equipo_slug text not null references public.teams_ca(slug) on delete cascade,
  goles integer not null default 0 check (goles between 0 and 999),
  asistencias integer not null default 0 check (asistencias between 0 and 999),
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.goleadores_promerica enable row level security;

drop policy if exists "Lectura pública de goleadores manuales" on public.goleadores_promerica;
create policy "Lectura pública de goleadores manuales"
  on public.goleadores_promerica for select
  to anon
  using (true);

revoke all on table public.goleadores_promerica from anon;
grant select on table public.goleadores_promerica to anon;
