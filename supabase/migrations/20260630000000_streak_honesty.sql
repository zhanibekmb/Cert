-- =====================================================================
-- CERT — streak honesty + purchasable freezes (office-hours 2026-06-30)
-- See DESIGN-2026-06-30-mechanics.md.
--   1. Eternal counter: verified_days_total never resets (cushions the
--      brutal streak reset → fewer churns).
--   2. last_swept_day: bookkeeping for the nightly missed-day sweep so it
--      processes each ended local day exactly once.
--   3. freeze_grants: audit ledger for freezes credited to a user — works
--      for FREE users too (anyone can buy a freeze pack). profiles.freezes
--      already holds the spendable balance; this records where it came from.
-- =====================================================================

alter table public.goals add column if not exists verified_days_total int  default 0;
alter table public.goals add column if not exists last_swept_day      date;

-- Backfill the eternal counter from history so existing users don't show 0.
update public.goals g
set verified_days_total = sub.cnt
from (
  select goal_id, count(*) cnt
  from public.submissions
  where status in ('approved','frozen')
  group by goal_id
) sub
where sub.goal_id = g.id and g.verified_days_total = 0;

-- ---------- freeze grant ledger ----------
create table if not exists public.freeze_grants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  qty        int  not null,                  -- freezes credited (+) by this grant
  source     text not null,                  -- purchase | pro_monthly | gift | promo
  ext_ref    text,                           -- store transaction / webhook id (idempotency)
  created_at timestamptz default now()
);
create index if not exists idx_freeze_grants_user on public.freeze_grants(user_id);
-- one row per external transaction → safe to replay store webhooks
create unique index if not exists idx_freeze_grants_extref
  on public.freeze_grants(ext_ref) where ext_ref is not null;

alter table public.freeze_grants enable row level security;
-- owner reads own ledger; all writes go through service-role functions only
drop policy if exists "freeze_grants_select_own" on public.freeze_grants;
create policy "freeze_grants_select_own" on public.freeze_grants
  for select using (auth.uid() = user_id);

-- =====================================================================
-- Schedule the nightly sweep. Runs HOURLY because users span timezones —
-- every hour some users cross their local midnight; the function no-ops
-- for goals whose local day hasn't ended yet.
--
-- Requires the pg_cron + pg_net extensions (enable in the Supabase
-- dashboard → Database → Extensions). Fill in your project ref + service
-- role key, then run the cron.schedule block ONCE (kept out of the plain
-- migration so the service key is never committed):
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--
--   select cron.schedule('cert-daily-sweep', '0 * * * *', $$
--     select net.http_post(
--       url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-sweep',
--       headers := jsonb_build_object(
--                    'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
--                    'Content-Type',  'application/json'),
--       body    := '{}'::jsonb
--     );
--   $$);
--
-- To unschedule:  select cron.unschedule('cert-daily-sweep');
-- =====================================================================
