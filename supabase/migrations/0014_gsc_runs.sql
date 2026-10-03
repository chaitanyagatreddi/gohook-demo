-- A saved Search Console run, and its rows (top 100 query+page rows by clicks).
-- Rows are stored and never re-pulled, so the weekly 25-row gate can be served
-- from here without a Google call. RLS is on with no policies: only the backend
-- (service role) can read or write, so locked rows can never reach a browser.

create table if not exists public.gsc_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  site_url    text not null,
  start_date  date not null,
  end_date    date not null,
  row_count   integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.gsc_run_rows (
  id          bigserial primary key,
  run_id      uuid not null references public.gsc_runs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  rank        integer not null,
  query       text not null,
  page        text,
  clicks      double precision,
  impressions double precision,
  ctr         double precision,
  position    double precision,
  unique (run_id, rank)
);

create index if not exists gsc_runs_user_idx     on public.gsc_runs (user_id, created_at desc);
create index if not exists gsc_run_rows_run_idx  on public.gsc_run_rows (run_id);

alter table public.gsc_runs     enable row level security;
alter table public.gsc_run_rows enable row level security;
