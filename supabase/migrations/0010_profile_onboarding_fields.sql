-- Onboarding: company/role/goal collected once, on the Profile screen.
alter table public.profiles add column if not exists company text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists goal text;

-- Profiles only had a select policy; the onboarding screen needs to write these.
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
