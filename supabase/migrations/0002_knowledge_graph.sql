-- GoHook knowledge graph
-- Shared content is stored once (nodes, edges). Anything belonging to a person
-- lives in user_nodes / user_edges and is fenced off by row level security.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Shared layer: the parts of Reddit everyone can point at.
-- ---------------------------------------------------------------------------

create table if not exists public.nodes (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('thread', 'comment', 'subreddit', 'author')),
  source_id   text not null,              -- Reddit's own id. Never key on the URL.
  title       text,
  body        text,                       -- short version; full text only for saved threads
  permalink   text,
  meta        jsonb not null default '{}'::jsonb,
  embedding   vector(1536),               -- text-embedding-3-small
  captured_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (type, source_id)
);

create index if not exists nodes_type_idx on public.nodes (type);
create index if not exists nodes_source_idx on public.nodes (source_id);

create table if not exists public.edges (
  id         uuid primary key default gen_random_uuid(),
  from_node  uuid not null references public.nodes (id) on delete cascade,
  to_node    uuid not null references public.nodes (id) on delete cascade,
  type       text not null check (type in ('belongs_to', 'replies_to', 'posted_in', 'written_by')),
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (from_node, to_node, type)
);

create index if not exists edges_from_idx on public.edges (from_node, type);
create index if not exists edges_to_idx on public.edges (to_node, type);

-- ---------------------------------------------------------------------------
-- Per-user layer: topics, similarity and everything the user did themselves.
-- ---------------------------------------------------------------------------

create table if not exists public.user_nodes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- 'self' is the single node standing for the user themselves, so edges like
  -- saved / cited / authored have a real starting point.
  type       text not null check (type in ('self', 'topic', 'question')),
  label      text not null,
  meta       jsonb not null default '{}'::jsonb,
  embedding  vector(1536),
  created_at timestamptz not null default now(),
  unique (user_id, type, label)
);

create index if not exists user_nodes_user_idx on public.user_nodes (user_id, type);

-- Edges here can point at either layer, so each end names its table.
create table if not exists public.user_edges (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  from_table     text not null check (from_table in ('nodes', 'user_nodes')),
  from_id        uuid not null,
  to_table       text not null check (to_table in ('nodes', 'user_nodes')),
  to_id          uuid not null,
  type           text not null check (type in ('mentions', 'co_occurs_with', 'similar_to', 'saved', 'cited', 'authored')),
  weight         real not null default 1,
  meta           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (user_id, from_table, from_id, to_table, to_id, type)
);

create index if not exists user_edges_user_from_idx on public.user_edges (user_id, from_table, from_id, type);
create index if not exists user_edges_user_to_idx on public.user_edges (user_id, to_table, to_id, type);

-- ---------------------------------------------------------------------------
-- Row level security
-- Shared tables: any signed-in user can read. Only the backend (service role)
-- writes, and the service role bypasses these policies entirely.
-- User tables: a user sees and changes only their own rows.
-- ---------------------------------------------------------------------------

alter table public.nodes enable row level security;
alter table public.edges enable row level security;
alter table public.user_nodes enable row level security;
alter table public.user_edges enable row level security;

drop policy if exists "nodes readable by signed in users" on public.nodes;
create policy "nodes readable by signed in users"
  on public.nodes for select
  to authenticated
  using (true);

drop policy if exists "edges readable by signed in users" on public.edges;
create policy "edges readable by signed in users"
  on public.edges for select
  to authenticated
  using (true);

drop policy if exists "own user_nodes" on public.user_nodes;
create policy "own user_nodes"
  on public.user_nodes for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own user_edges" on public.user_edges;
create policy "own user_edges"
  on public.user_edges for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
