-- Geo check-in proof type: the goal pins a place, and the daily proof is
-- BEING there (within geo_radius_m) inside the optional time window
-- [daily_start .. daily_deadline]. proof_type is free text — 'geo' joins
-- 'photo' | 'timelapse' with no constraint change.
alter table public.goals add column if not exists geo_lat double precision;
alter table public.goals add column if not exists geo_lng double precision;
alter table public.goals add column if not exists geo_radius_m integer not null default 200;
alter table public.goals add column if not exists geo_place text;
alter table public.goals add column if not exists daily_start text; -- "HH:MM" local, null = any time
