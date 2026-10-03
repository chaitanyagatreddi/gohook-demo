-- Day 3: the brand and benchmark for a run, and each row's groups, bucket,
-- estimate (ESTIMATE, null when the target bucket has too little data) and action.
alter table public.gsc_runs
  add column if not exists brand_name  text,
  add column if not exists brand_regex text,
  add column if not exists benchmark   jsonb;

alter table public.gsc_run_rows
  add column if not exists word_count      integer,
  add column if not exists is_brand        boolean not null default false,
  add column if not exists geo_flag        boolean not null default false,
  add column if not exists groups          text[]  not null default '{}',
  add column if not exists bucket          text,
  add column if not exists target_bucket   text,
  add column if not exists est_extra_clicks double precision,
  add column if not exists low_data        boolean not null default false,
  add column if not exists action          text;
