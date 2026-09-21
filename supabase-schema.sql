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

insert into public.notes (sport, title, intro, author, email, tags, body, status)
select 'Atletismo', 'La victoria tiene más de una medida', 'Repensar el deporte desde el cuidado, la comunidad y la perseverancia.', 'Sofía Campos', 'sofia@tribuna.test', 'opinión, atletismo', 'No todos los triunfos caben en una medalla. En cada proceso deportivo hay constancia, dudas y una red de personas que sostienen a quienes compiten.', 'publicada'
where not exists (select 1 from public.notes where title = 'La victoria tiene más de una medida');

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
