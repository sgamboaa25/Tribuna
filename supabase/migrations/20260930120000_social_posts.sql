-- Sección "En redes": publicaciones ya salidas en X o Instagram que la
-- redacción pega desde el panel. Solo se guarda la URL; el texto, la imagen y
-- el formato los pone la red al montar su embed oficial, así que la tabla no
-- duplica contenido ni depende de ninguna API de pago.
-- `red` NO lo manda el cliente: server.js lo deduce del dominio al validar.
-- Mismo bloque que el final de supabase-schema.sql (idempotente).
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  red text not null check (red in ('x', 'instagram')),
  destacada boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists social_posts_created_at_idx
  on public.social_posts (created_at desc);

alter table public.social_posts enable row level security;

drop policy if exists "Lectura pública de publicaciones sociales" on public.social_posts;
create policy "Lectura pública de publicaciones sociales"
  on public.social_posts for select
  to anon
  using (true);

revoke all on table public.social_posts from anon;
grant select on table public.social_posts to anon;