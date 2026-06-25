-- =====================================================================
-- CERT — friend challenges (shared goal, leaderboard, wheel-of-fortune).
-- A challenge is a social wrapper around the existing engine: joining one
-- creates a normal goal tagged with challenge_id, so the daily photo →
-- judge → streak loop is reused unchanged. Writes happen via the
-- service-role `challenge` Edge Function; clients only read their own rows.
-- =====================================================================

create table if not exists public.challenges (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,                 -- short join code
  title         text not null,
  goal_text     text not null,                        -- the shared goal everyone does
  proof_spec_en text,
  proof_spec_ru text,
  duration_days int  not null default 7,
  host_user_id  uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'active',       -- active | ended
  ends_at       timestamptz not null,
  loser_user_id uuid references auth.users(id) on delete set null,  -- last place
  dare          text,                                 -- wheel result (server-set)
  created_at    timestamptz default now()
);
create index if not exists idx_challenges_code on public.challenges(code);

create table if not exists public.challenge_members (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  goal_id      uuid references public.goals(id) on delete set null,
  joined_at    timestamptz default now(),
  unique (challenge_id, user_id)
);
create index if not exists idx_cm_challenge on public.challenge_members(challenge_id);
create index if not exists idx_cm_user on public.challenge_members(user_id);

-- link a personal goal to its challenge (null = solo goal, as today)
alter table public.goals add column if not exists challenge_id uuid references public.challenges(id) on delete set null;

alter table public.challenges       enable row level security;
alter table public.challenge_members enable row level security;

-- host or any member can read the challenge; all writes go through the function
drop policy if exists "challenges_select" on public.challenges;
create policy "challenges_select" on public.challenges for select using (
  host_user_id = auth.uid()
  or exists (select 1 from public.challenge_members m where m.challenge_id = challenges.id and m.user_id = auth.uid())
);

-- a user sees only their own membership rows (used to list "my challenges");
-- co-members + leaderboard come from the service-role function to avoid
-- recursive policies and to keep cross-user reads controlled.
drop policy if exists "cm_select_own" on public.challenge_members;
create policy "cm_select_own" on public.challenge_members for select using (user_id = auth.uid());
