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
  reactions jsonb not null default '{"clap":0,"wow":0,"angry":0}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Migración para bases ya existentes (idempotente).
alter table public.notes add column if not exists archived boolean not null default false;

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
