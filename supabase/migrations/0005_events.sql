-- What people do in GoHook, so we can see where they get stuck.
-- Only the backend writes here, and only owners read it.

create table if not exists public.events (
  id         bigserial primary key,
  user_id    uuid references auth.users (id) on delete set null,
  event      text not null,          -- scan, ideate_angles, reply_draft, board_add, question, voice_saved…
  ok         boolean not null default true,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_created_idx on public.events (created_at desc);
create index if not exists events_user_idx on public.events (user_id, created_at desc);
create index if not exists events_name_idx on public.events (event, created_at desc);

alter table public.events enable row level security;
-- No policies on purpose: only the backend's service role reads or writes this.
