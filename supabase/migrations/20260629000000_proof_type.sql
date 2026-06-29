-- Per-goal proof type. 'photo' = a single quick photo (default, existing behavior).
-- 'timelapse' = several frames captured over the session; the AI judges the
-- sequence for genuine, sustained activity (much harder to fake than one photo).
alter table public.goals add column if not exists proof_type text default 'photo'; -- 'photo' | 'timelapse'
