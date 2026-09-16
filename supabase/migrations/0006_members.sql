-- The team. Owners can see everything and manage the team;
-- admins can see the usage view but not change who is on it.

create table if not exists public.members (
  email      text primary key,
  role       text not null default 'admin' check (role in ('owner', 'admin')),
  added_by   text,
  created_at timestamptz not null default now()
);

alter table public.members enable row level security;
-- No policies: only the backend's service role reads or writes this.
