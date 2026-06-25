-- Challenge goal cadence: one-time, daily, or N-times-per-week. Mirrors the
-- goals model so member goals inherit the right type/format.
alter table public.challenges add column if not exists goal_type   text not null default 'recurring'; -- recurring | one_time
alter table public.challenges add column if not exists goal_format text default 'daily';              -- daily | 3x | 5x (recurring only)
