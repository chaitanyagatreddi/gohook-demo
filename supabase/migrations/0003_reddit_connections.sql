-- Remembers which GoHook account has connected which Reddit account.
-- No Reddit tokens are kept here. Composio holds those; this only points at them.

create table if not exists public.reddit_connections (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  connected_account_id text not null,        -- Composio's id for this connection
  reddit_username      text,
  status               text not null default 'active'
                         check (status in ('pending', 'active', 'expired', 'revoked')),
  meta                 jsonb not null default '{}'::jsonb,   -- karma, account age
  last_synced_at       timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists reddit_connections_account_idx
  on public.reddit_connections (connected_account_id);

alter table public.reddit_connections enable row level security;

-- A person can see their own connection. Only the backend writes, and the
-- service role bypasses these rules.
drop policy if exists "own reddit connection" on public.reddit_connections;
create policy "own reddit connection"
  on public.reddit_connections for select
  to authenticated
  using (auth.uid() = user_id);
