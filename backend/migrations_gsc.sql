-- Search Console import, rows and saved patterns. One user's data is only
-- ever readable by that user; the backend writes with the service role key.

create table if not exists gsc_imports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  source      text not null default 'csv',      -- csv | api
  site_url    text,
  key_kind    text not null default 'query',    -- query | page
  row_count   integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists gsc_rows (
  id          bigserial primary key,
  import_id   uuid not null references gsc_imports(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,
  clicks      double precision,
  impressions double precision,
  ctr         double precision,
  position    double precision
);

create table if not exists gsc_patterns (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  pattern      text not null,
  intent_class text not null default 'question',
  created_at   timestamptz not null default now()
);

create index if not exists gsc_rows_import_idx    on gsc_rows (import_id);
create index if not exists gsc_imports_user_idx   on gsc_imports (user_id, created_at desc);
create index if not exists gsc_patterns_user_idx  on gsc_patterns (user_id);

alter table gsc_imports  enable row level security;
alter table gsc_rows     enable row level security;
alter table gsc_patterns enable row level security;

drop policy if exists gsc_imports_own  on gsc_imports;
drop policy if exists gsc_rows_own     on gsc_rows;
drop policy if exists gsc_patterns_own on gsc_patterns;

create policy gsc_imports_own  on gsc_imports  for all using (auth.uid() = user_id);
create policy gsc_rows_own     on gsc_rows     for all using (auth.uid() = user_id);
create policy gsc_patterns_own on gsc_patterns for all using (auth.uid() = user_id);
