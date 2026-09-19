-- Track subreddits the user is subscribed to, alongside saved/cited/authored/commented.
alter table public.user_edges drop constraint if exists user_edges_type_check;
alter table public.user_edges add constraint user_edges_type_check
  check (type in ('mentions', 'co_occurs_with', 'similar_to', 'saved', 'cited', 'authored', 'commented', 'subscribed'));
