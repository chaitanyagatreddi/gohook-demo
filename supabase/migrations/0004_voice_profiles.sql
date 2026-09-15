-- Keeps each person's writing style so drafts can sound like them.
-- Only the style summary is stored, never the text they pasted.

create table if not exists public.voice_profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  style        jsonb not null default '{}'::jsonb,   -- sentence length, tone, openers, words to avoid
  sample_count integer not null default 0,           -- words analysed, not the words themselves
  source       text not null default 'paste'
                 check (source in ('paste', 'reddit')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.voice_profiles enable row level security;

-- A person can see their own voice. Only the backend writes, and the
-- service role bypasses these rules.
drop policy if exists "own voice profile" on public.voice_profiles;
create policy "own voice profile"
  on public.voice_profiles for select
  to authenticated
  using (auth.uid() = user_id);
