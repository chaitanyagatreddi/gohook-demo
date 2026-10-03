-- One Google Search Console connection per user. The refresh token is stored
-- encrypted (Fernet, key in the backend env), never in plain text.
-- RLS is on with no policies: only the backend's service role can read or
-- write this table, so a browser can never fetch the encrypted token.

create table if not exists public.gsc_connections (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  refresh_token_enc text not null,
  scope             text,
  consented_at      timestamptz not null default now(),
  status            text not null default 'ok' check (status in ('ok', 'needs_reconnect'))
);

alter table public.gsc_connections enable row level security;
