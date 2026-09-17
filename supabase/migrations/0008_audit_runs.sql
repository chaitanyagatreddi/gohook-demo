-- Every audit run, so a score can be compared with the last one,
-- and a Slack webhook per person for the alerts.

create table if not exists public.audit_runs (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  brand       text not null,
  category    text not null default '',
  competitors text[] not null default '{}',
  score       integer not null,
  report      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_runs_user_idx on public.audit_runs (user_id, brand, created_at desc);

alter table public.audit_runs enable row level security;

drop policy if exists "own audit runs" on public.audit_runs;
create policy "own audit runs"
  on public.audit_runs for select
  to authenticated
  using (auth.uid() = user_id);

create table if not exists public.slack_hooks (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  webhook_url text not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.slack_hooks enable row level security;
-- No policies: the backend holds these, and a webhook URL is a secret.
