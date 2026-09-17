-- Track comments the user actually posted on Reddit, alongside saved/cited/authored.
alter table public.user_edges drop constraint if exists user_edges_type_check;
alter table public.user_edges add constraint user_edges_type_check
  check (type in ('mentions', 'co_occurs_with', 'similar_to', 'saved', 'cited', 'authored', 'commented'));
