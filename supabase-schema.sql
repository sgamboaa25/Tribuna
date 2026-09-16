create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  title text not null,
  intro text not null,
  author text not null,
  email text not null,
  tags text default '',
  body text not null,
  created_at timestamptz default now()
);

insert into public.notes (sport, title, intro, author, email, tags, body)
select 'Fútbol', 'Cuando el juego pide una mirada más profunda', 'Resultados, contexto y las historias que explican por qué el deporte importa mucho más allá del marcador.', 'Marta Villalobos', 'marta@tribuna.test', 'análisis, fútbol', 'Detrás de cada resultado hay una historia que merece ser contada. Mirar el juego con atención también significa comprender a quienes lo hacen posible: los equipos, las aficiones y las comunidades que encuentran en el deporte un lenguaje común.'
where not exists (select 1 from public.notes where title = 'Cuando el juego pide una mirada más profunda');

insert into public.notes (sport, title, intro, author, email, tags, body)
select 'Fútbol', 'La grada también juega el partido', 'Una noche de fútbol vista desde el pulso de quienes nunca abandonan su lugar.', 'Marta Villalobos', 'marta@tribuna.test', 'crónica, afición', 'Desde mucho antes del pitazo inicial, la grada construye su propio partido. Cada cántico y cada silencio forman parte de una experiencia colectiva que acompaña al equipo hasta el último minuto.'
where not exists (select 1 from public.notes where title = 'La grada también juega el partido');

insert into public.notes (sport, title, intro, author, email, tags, body)
select 'Baloncesto', 'El talento joven ya no espera turno', 'Las nuevas figuras transforman la conversación y elevan el ritmo de la liga.', 'Diego Morales', 'diego@tribuna.test', 'baloncesto, liga', 'La nueva generación juega sin pedir permiso. Su energía modifica los partidos y abre una conversación necesaria sobre oportunidades, formación y futuro dentro de la cancha.'
where not exists (select 1 from public.notes where title = 'El talento joven ya no espera turno');

insert into public.notes (sport, title, intro, author, email, tags, body)
select 'Atletismo', 'La victoria tiene más de una medida', 'Repensar el deporte desde el cuidado, la comunidad y la perseverancia.', 'Sofía Campos', 'sofia@tribuna.test', 'opinión, atletismo', 'No todos los triunfos caben en una medalla. En cada proceso deportivo hay constancia, dudas y una red de personas que sostienen a quienes compiten.'
where not exists (select 1 from public.notes where title = 'La victoria tiene más de una medida');
