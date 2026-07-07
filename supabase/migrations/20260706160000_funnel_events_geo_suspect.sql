-- First-run funnel analytics + geo anti-cheat flag (post-launch UX batch).

-- funnel_events: write-only from clients (including pre-auth anon, so the
-- onboarding→auth funnel can be measured before sign-up). No select policy —
-- reads happen via the dashboard / service role only.
create table if not exists public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  device_id text,
  user_id uuid references auth.users(id) on delete set null,
  event text not null,
  created_at timestamptz not null default now()
);
alter table public.funnel_events enable row level security;
drop policy if exists "funnel insert" on public.funnel_events;
create policy "funnel insert" on public.funnel_events
  for insert to anon, authenticated with check (true);

-- Geo anti-cheat: set by the judge when a submission's location is far from
-- the goal's anchor (its first approved submission). Additive signal only —
-- never flips the AI verdict.
alter table public.submissions add column if not exists geo_suspect boolean not null default false;
