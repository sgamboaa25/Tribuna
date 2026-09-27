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

-- Historial de ediciones visible al lector (transparencia editorial).
-- last_edited_at la escribe SOLO el backend (server.js) cuando se guarda una
-- edición sobre una nota que ya estaba publicada y el contenido cambió de verdad.
-- Por eso no se usa updated_at, que se mueve en cada escritura. La referencia
-- para saber si es posterior a la publicación es created_at.
-- edit_note es la nota breve de "qué se corrigió" (opcional, la escribe la
-- redacción). Ambas columnas son públicas a propósito: el detalle de la nota
-- las muestra al lector.
alter table public.notes add column if not exists last_edited_at timestamptz;
alter table public.notes add column if not exists edit_note text;

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

-- ============================================================
-- COLORES DE CLUB (marcadores de la sección "Próximos partidos")
-- ============================================================
-- Ningún proveedor de fixtures expone un color utilizable:
--   - football-data.org v4: el objeto de equipo en el recurso Match no trae
--     color; `clubColors` solo existe en /teams/{id} y es texto libre
--     ("Green / White"), no un hex.
--   - API-Football: el objeto de equipo es {id, name, logo}, sin color.
-- Por eso el color se guarda aquí, con fuente TheSportsDB (strColour1/2/3).
-- Para los clubes donde strColour1 era blanco, gris o negro —invisible como
-- franja sobre la tarjeta, y negro invisible en el tema oscuro— se tomó el
-- color de identidad de strColour2/strColour3.
--
-- Se cruza por NOMBRE normalizado (normalizeTeamText en server.js) contra
-- nombre + aliases, no por id de proveedor: un id mal escrito pintaría el color
-- del club equivocado, mientras que un nombre que no casa simplemente no pinta
-- color. `color` acepta null a propósito: el club queda sin franja.
--
-- Seed con `where not exists`, igual que teams_ca: si alguien corrige un color a
-- mano en el SQL Editor, la próxima migración NO lo pisa. Para rellenar un null:
--   update public.team_colors set color = '#aabbcc' where nombre = 'Nombre Club';
create table if not exists public.team_colors (
  nombre text primary key,
  color text,
  aliases text[] not null default '{}',
  liga text not null default ''
);

-- El color llega a un atributo style del cliente, así que se valida aquí: solo
-- #rrggbb o null. Cualquier otra cosa (url(...), rgb(), punto y coma...) se rechaza.
alter table public.team_colors drop constraint if exists team_colors_formato;
alter table public.team_colors
  add constraint team_colors_formato check (color is null or color ~ '^#[0-9a-fA-F]{6}$');

alter table public.team_colors enable row level security;

drop policy if exists "Lectura pública de colores" on public.team_colors;
create policy "Lectura pública de colores"
  on public.team_colors for select
  to anon
  using (true);

revoke all on table public.team_colors from anon;
grant select on table public.team_colors to anon;

-- ---- Premier League ----
insert into public.team_colors (nombre, color, aliases, liga) select 'Arsenal', '#ef0107', '{"arsenal fc","arsenal football club","gunners"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Arsenal');
insert into public.team_colors (nombre, color, aliases, liga) select 'Aston Villa', '#490125', '{"aston villa fc","villa"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Aston Villa');
insert into public.team_colors (nombre, color, aliases, liga) select 'Bournemouth', '#b50e12', '{"afc bournemouth","bournemouth fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Bournemouth');
insert into public.team_colors (nombre, color, aliases, liga) select 'Brentford', '#e30613', '{"brentford fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Brentford');
insert into public.team_colors (nombre, color, aliases, liga) select 'Brighton and Hove Albion', '#0057b8', '{"brighton","brighton hove albion","brighton & hove albion","brighton and hove albion fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Brighton and Hove Albion');
insert into public.team_colors (nombre, color, aliases, liga) select 'Burnley', '#6c1d45', '{"burnley fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Burnley');
insert into public.team_colors (nombre, color, aliases, liga) select 'Chelsea', '#034694', '{"chelsea fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Chelsea');
insert into public.team_colors (nombre, color, aliases, liga) select 'Crystal Palace', '#1b458f', '{"crystal palace fc","palace"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Crystal Palace');
insert into public.team_colors (nombre, color, aliases, liga) select 'Everton', '#003399', '{"everton fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Everton');
insert into public.team_colors (nombre, color, aliases, liga) select 'Fulham', '#cc0000', '{"fulham fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Fulham');
insert into public.team_colors (nombre, color, aliases, liga) select 'Leeds United', '#1d428a', '{"leeds","leeds united fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Leeds United');
insert into public.team_colors (nombre, color, aliases, liga) select 'Liverpool', '#c8102e', '{"liverpool fc","lfc","reds"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Liverpool');
insert into public.team_colors (nombre, color, aliases, liga) select 'Manchester City', '#6cabdd', '{"manchester city fc","man city","mcfc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Manchester City');
insert into public.team_colors (nombre, color, aliases, liga) select 'Manchester United', '#da291c', '{"manchester united fc","man united","man utd","mufc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Manchester United');
insert into public.team_colors (nombre, color, aliases, liga) select 'Newcastle United', null, '{"newcastle","newcastle united fc","magpies"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Newcastle United');
insert into public.team_colors (nombre, color, aliases, liga) select 'Nottingham Forest', null, '{"forest","nottingham forest fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Nottingham Forest');
insert into public.team_colors (nombre, color, aliases, liga) select 'Sunderland', '#ff0000', '{"sunderland fc","black cats"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Sunderland');
insert into public.team_colors (nombre, color, aliases, liga) select 'Tottenham Hotspur', '#132257', '{"tottenham","spurs","tottenham hotspur fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Tottenham Hotspur');
insert into public.team_colors (nombre, color, aliases, liga) select 'West Ham United', '#7c2c3b', '{"west ham","west ham united fc","the hammers"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'West Ham United');
insert into public.team_colors (nombre, color, aliases, liga) select 'Wolverhampton Wanderers', '#fdb913', '{"wolves","wolverhampton","wolverhampton wanderers fc"}', 'Premier League' where not exists (select 1 from public.team_colors where nombre = 'Wolverhampton Wanderers');

-- ---- La Liga ----
insert into public.team_colors (nombre, color, aliases, liga) select 'Deportivo Alavés', '#0761af', '{"alaves","alavés","deportivo alaves"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Deportivo Alavés');
insert into public.team_colors (nombre, color, aliases, liga) select 'Athletic Bilbao', '#ee2523', '{"athletic club","athletic bilbao","athletic"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Athletic Bilbao');
insert into public.team_colors (nombre, color, aliases, liga) select 'Atlético Madrid', '#cb3524', '{"atletico madrid","atlético madrid","atleti","atletico de madrid"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Atlético Madrid');
insert into public.team_colors (nombre, color, aliases, liga) select 'Barcelona', '#004d98', '{"fc barcelona","barça","barca"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Barcelona');
insert into public.team_colors (nombre, color, aliases, liga) select 'Celta Vigo', '#8ac3ee', '{"celta de vigo","celta"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Celta Vigo');
insert into public.team_colors (nombre, color, aliases, liga) select 'Espanyol', '#007fc8', '{"espanyol de barcelona","rcd espanyol"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Espanyol');
insert into public.team_colors (nombre, color, aliases, liga) select 'Getafe', '#005999', '{"getafe cf"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Getafe');
insert into public.team_colors (nombre, color, aliases, liga) select 'Girona', '#cd2534', '{"girona fc","girona de"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Girona');
insert into public.team_colors (nombre, color, aliases, liga) select 'Levante', '#c60b46', '{"levante ud","levante fc"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Levante');
insert into public.team_colors (nombre, color, aliases, liga) select 'Mallorca', '#e20613', '{"rcd mallorca","mallorca ca"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Mallorca');
insert into public.team_colors (nombre, color, aliases, liga) select 'Osasuna', '#0a346f', '{"osasuna ca","ca osasuna"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Osasuna');
insert into public.team_colors (nombre, color, aliases, liga) select 'Real Oviedo', null, '{"oviedo"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Real Oviedo');
insert into public.team_colors (nombre, color, aliases, liga) select 'Rayo Vallecano', '#e53027', '{"rayo","rayo vallecano de madrid"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Rayo Vallecano');
insert into public.team_colors (nombre, color, aliases, liga) select 'Real Betis', '#0bb363', '{"betis","real betis balompie"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Real Betis');
insert into public.team_colors (nombre, color, aliases, liga) select 'Real Madrid', '#00529f', '{"real madrid cf","madrid","los blancos"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Real Madrid');
insert into public.team_colors (nombre, color, aliases, liga) select 'Real Sociedad', '#0067b1', '{"sociedad","real sociedad de futbol","txuri-urdin"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Real Sociedad');
insert into public.team_colors (nombre, color, aliases, liga) select 'Sevilla', '#f43333', '{"sevilla fc","club atletico sevilla"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Sevilla');
insert into public.team_colors (nombre, color, aliases, liga) select 'Valencia', '#ff671f', '{"valencia cf"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Valencia');
insert into public.team_colors (nombre, color, aliases, liga) select 'Villarreal', '#005187', '{"villarreal cf"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Villarreal');
insert into public.team_colors (nombre, color, aliases, liga) select 'Elche', '#05642c', '{"elche cf"}', 'La Liga' where not exists (select 1 from public.team_colors where nombre = 'Elche');

-- ---- Serie A ----
insert into public.team_colors (nombre, color, aliases, liga) select 'Atalanta', '#1e71b8', '{"atalanta bc"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Atalanta');
insert into public.team_colors (nombre, color, aliases, liga) select 'Bologna', '#a21c26', '{"bologna fc"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Bologna');
insert into public.team_colors (nombre, color, aliases, liga) select 'Cagliari', '#002350', '{"cagliari calcio"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Cagliari');
insert into public.team_colors (nombre, color, aliases, liga) select 'Como', '#114169', '{"como 1907"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Como');
insert into public.team_colors (nombre, color, aliases, liga) select 'Cremonese', '#ed1c24', '{"cremonese calcio"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Cremonese');
insert into public.team_colors (nombre, color, aliases, liga) select 'Fiorentina', '#482e92', '{"acf fiorentina"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Fiorentina');
insert into public.team_colors (nombre, color, aliases, liga) select 'Genoa', '#ad1919', '{"genoa cfc","ac genoa"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Genoa');
insert into public.team_colors (nombre, color, aliases, liga) select 'Hellas Verona', '#ffe74a', '{"verona","hellas verona fc"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Hellas Verona');
insert into public.team_colors (nombre, color, aliases, liga) select 'Inter Milan', '#010e80', '{"inter","internazionale","inter de milan","fc internazionale"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Inter Milan');
insert into public.team_colors (nombre, color, aliases, liga) select 'Juventus', null, '{"juve","juventus fc"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Juventus');
insert into public.team_colors (nombre, color, aliases, liga) select 'Lazio', '#87d8f7', '{"ss lazio","lazio roma"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Lazio');
insert into public.team_colors (nombre, color, aliases, liga) select 'Lecce', '#fff200', '{"us lecce"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Lecce');
insert into public.team_colors (nombre, color, aliases, liga) select 'AC Milan', '#fb090b', '{"milan","ac milan","a.c. milan"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'AC Milan');
insert into public.team_colors (nombre, color, aliases, liga) select 'Napoli', '#12a0d7', '{"ssc napoli","napoli ssc"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Napoli');
insert into public.team_colors (nombre, color, aliases, liga) select 'Parma', '#1b4094', '{"parma calcio"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Parma');
insert into public.team_colors (nombre, color, aliases, liga) select 'Roma', '#8e1f2f', '{"as roma","roma cf"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Roma');
insert into public.team_colors (nombre, color, aliases, liga) select 'Sassuolo', '#00a752', '{"us sassuolo"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Sassuolo');
insert into public.team_colors (nombre, color, aliases, liga) select 'Torino', '#8a1e03', '{"torino fc"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Torino');
insert into public.team_colors (nombre, color, aliases, liga) select 'Udinese', '#8b7d37', '{"udinese calcio"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Udinese');
insert into public.team_colors (nombre, color, aliases, liga) select 'Pisa', null, '{"pisa sc"}', 'Serie A' where not exists (select 1 from public.team_colors where nombre = 'Pisa');

-- ---- Bundesliga ----
insert into public.team_colors (nombre, color, aliases, liga) select 'Augsburg', '#ba3733', '{"fc augsburg"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Augsburg');
insert into public.team_colors (nombre, color, aliases, liga) select 'Bayer Leverkusen', '#e32221', '{"bayer 04 leverkusen","leverkusen"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Bayer Leverkusen');
insert into public.team_colors (nombre, color, aliases, liga) select 'Bayern Munich', '#dc052d', '{"bayern munchen","bayern münchen","fc bayern","bayern"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Bayern Munich');
insert into public.team_colors (nombre, color, aliases, liga) select 'Bochum', '#005ca9', '{"vfl bochum"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Bochum');
insert into public.team_colors (nombre, color, aliases, liga) select 'Borussia Dortmund', '#fde100', '{"bvb","borussia dortmund"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Borussia Dortmund');
insert into public.team_colors (nombre, color, aliases, liga) select 'Borussia Mönchengladbach', null, '{"borussia monchengladbach","gladbach","borussia m gladbach","monchengladbach"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Borussia Mönchengladbach');
insert into public.team_colors (nombre, color, aliases, liga) select 'Eintracht Frankfurt', '#e1000f', '{"frankfurt","eintracht"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Eintracht Frankfurt');
insert into public.team_colors (nombre, color, aliases, liga) select 'Freiburg', '#fd1220', '{"sc freiburg"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Freiburg');
insert into public.team_colors (nombre, color, aliases, liga) select 'Heidenheim', '#e2001a', '{"1 fc heidenheim","heidenheim"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Heidenheim');
insert into public.team_colors (nombre, color, aliases, liga) select 'Hoffenheim', '#1961b5', '{"tsg hoffenheim","1899 hoffenheim"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Hoffenheim');
insert into public.team_colors (nombre, color, aliases, liga) select 'Köln', '#ed1c24', '{"koln","cologne","1 fc koln","1. fc köln"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Köln');
insert into public.team_colors (nombre, color, aliases, liga) select 'Mainz', '#c3141e', '{"mainz 05","1 fsv mainz 05","mainz"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Mainz');
insert into public.team_colors (nombre, color, aliases, liga) select 'RB Leipzig', '#dd013f', '{"leipzig","rb leipzig"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'RB Leipzig');
insert into public.team_colors (nombre, color, aliases, liga) select 'St Pauli', '#624839', '{"st pauli","fc st pauli","pauli"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'St Pauli');
insert into public.team_colors (nombre, color, aliases, liga) select 'Stuttgart', '#e32219', '{"vfb stuttgart","stuttgart"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Stuttgart');
insert into public.team_colors (nombre, color, aliases, liga) select 'Union Berlin', '#eb1923', '{"1 fc union berlin","fc union berlin"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Union Berlin');
insert into public.team_colors (nombre, color, aliases, liga) select 'Werder Bremen', '#1d9053', '{"sv werder bremen","werder"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Werder Bremen');
insert into public.team_colors (nombre, color, aliases, liga) select 'Wolfsburg', '#09633d', '{"vfl wolfsburg","wolfsburg"}', 'Bundesliga' where not exists (select 1 from public.team_colors where nombre = 'Wolfsburg');

-- ---- Ligue 1 ----
insert into public.team_colors (nombre, color, aliases, liga) select 'Angers', null, '{"angers sco","sco angers"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Angers');
insert into public.team_colors (nombre, color, aliases, liga) select 'Auxerre', '#4087bf', '{"aj auxerre"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Auxerre');
insert into public.team_colors (nombre, color, aliases, liga) select 'Brest', '#ed1c24', '{"stade brestois","stade brestois 29"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Brest');
insert into public.team_colors (nombre, color, aliases, liga) select 'Le Havre', '#79bce7', '{"havre ac","le havre ac"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Le Havre');
insert into public.team_colors (nombre, color, aliases, liga) select 'Lens', '#fff200', '{"rc lens"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Lens');
insert into public.team_colors (nombre, color, aliases, liga) select 'Lille', '#e01e13', '{"losc","losc lille","lille osc"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Lille');
insert into public.team_colors (nombre, color, aliases, liga) select 'Lorient', '#f58113', '{"fc lorient"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Lorient');
insert into public.team_colors (nombre, color, aliases, liga) select 'Lyon', '#0f23aa', '{"ol","olympique lyonnais","olympique de lyon"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Lyon');
insert into public.team_colors (nombre, color, aliases, liga) select 'Marseille', '#00a1df', '{"olympique de marseille","om"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Marseille');
insert into public.team_colors (nombre, color, aliases, liga) select 'Monaco', '#e51b22', '{"as monaco","as_monaco"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Monaco');
insert into public.team_colors (nombre, color, aliases, liga) select 'Nantes', '#fcd405', '{"fc nantes"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Nantes');
insert into public.team_colors (nombre, color, aliases, liga) select 'Nice', '#ed1c24', '{"ogc nice"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Nice');
insert into public.team_colors (nombre, color, aliases, liga) select 'Paris Saint-Germain', '#004170', '{"psg","paris saint germain","paris sg"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Paris Saint-Germain');
insert into public.team_colors (nombre, color, aliases, liga) select 'Stade de Reims', '#ee2223', '{"reims"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Stade de Reims');
insert into public.team_colors (nombre, color, aliases, liga) select 'Rennes', '#e13327', '{"stade rennais","stade rennes"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Rennes');
insert into public.team_colors (nombre, color, aliases, liga) select 'Strasbourg', '#009fe3', '{"rc strasbourg"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Strasbourg');
insert into public.team_colors (nombre, color, aliases, liga) select 'Toulouse', '#492359', '{"toulouse fc"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Toulouse');
insert into public.team_colors (nombre, color, aliases, liga) select 'Metz', '#6e0f12', '{"fc metz"}', 'Ligue 1' where not exists (select 1 from public.team_colors where nombre = 'Metz');

-- ---- Liga Promérica (Costa Rica) ----
-- TheSportsDB no tiene color para 9 de los 10: quedan en null a propósito.
insert into public.team_colors (nombre, color, aliases, liga) select 'Alajuelense', null, '{"ld alajuelense","liga deportiva alajuelense","manudos"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Alajuelense');
insert into public.team_colors (nombre, color, aliases, liga) select 'Cartaginés', null, '{"cartagines","club sport cartagines","brumosos"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Cartaginés');
insert into public.team_colors (nombre, color, aliases, liga) select 'Deportivo Saprissa', null, '{"saprissa","deportivo saprissa fc"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Deportivo Saprissa');
insert into public.team_colors (nombre, color, aliases, liga) select 'Escorpiones de Belén', '#f3d718', '{"escorpiones de belen","belen","escorpiones"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Escorpiones de Belén');
insert into public.team_colors (nombre, color, aliases, liga) select 'Herediano', null, '{"club sport herediano","cs herediano","herediano fc"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Herediano');
insert into public.team_colors (nombre, color, aliases, liga) select 'Inter de San Carlos', null, '{"inter san carlos","inter de san carlos fc"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Inter de San Carlos');
insert into public.team_colors (nombre, color, aliases, liga) select 'Pérez Zeledón', null, '{"perez zeledon","municipal perez zeledon"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Pérez Zeledón');
insert into public.team_colors (nombre, color, aliases, liga) select 'Puntarenas', null, '{"municipal puntarenas","puntarenas fc"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Puntarenas');
insert into public.team_colors (nombre, color, aliases, liga) select 'San Carlos', null, '{"club sport san carlos","san carlos fc"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'San Carlos');
insert into public.team_colors (nombre, color, aliases, liga) select 'Sporting San José', null, '{"sporting san jose","sporting de san jose"}', 'Liga Promérica' where not exists (select 1 from public.team_colors where nombre = 'Sporting San José');

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

-- ============================================================
-- PERFILES DE REDACCIÓN (FOTO + BIO)
-- ============================================================
-- Perfil opcional de cada redactor: avatar (foto propia, guardada en el bucket
-- público "notes-images", carpeta authors/) y bio corta. Se vincula a las notas
-- por el campo `email` (obligatorio en notes), así el nombre en las notas puede
-- seguir siendo texto libre sin depender de un FK.
-- Lectura pública para anon; toda escritura pasa por el backend (service_role)
-- vía GET/PUT /api/writers/me.
create table if not exists public.authors (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text not null,
  slug text not null,
  bio text default '',
  avatar_url text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.authors enable row level security;

drop policy if exists "Lectura pública de autores" on public.authors;
create policy "Lectura pública de autores"
  on public.authors for select
  to anon
  using (true);

revoke all on table public.authors from anon;
grant select on table public.authors to anon;

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
