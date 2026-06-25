-- =====================================================================
-- CERT — initial Supabase schema (Postgres + RLS)
-- Tables: profiles, goals, submissions, appeals, certs.
-- Server-authoritative: verdicts/streaks are written by the judge Edge
-- Function (service role). Clients can read their own rows + create goals
-- and appeals, but never write submissions/streaks directly.
-- =====================================================================

-- ---------- profiles (1:1 with auth.users) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  name        text,
  timezone    text default 'UTC',
  lang        text default 'en',
  plan        text default 'free',          -- free | monthly | yearly
  freezes     int  default 0,
  cert_score  int  default 0,               -- gamification XP (verified days etc.)
  created_at  timestamptz default now()
);

-- auto-create a profile when a new auth user signs up (incl. Google)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- goals ----------
create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  text          text not null,
  category      text default 'other',
  proof_spec_en text,
  proof_spec_ru text,
  type          text not null default 'recurring',   -- recurring | one_time
  format        text,                                -- recurring: daily|weekdays|3x|5x|custom
  custom_days   int[] default '{}',                  -- recurring custom: 0=Mon..6=Sun
  duration_days int,                                 -- recurring target; null = ongoing
  deadline      date,                                -- one_time deadline
  streak        int default 0,
  best_streak   int default 0,
  status        text default 'active',               -- active | completed | failed | archived
  completed_at  timestamptz,
  created_at    timestamptz default now()
);
create index if not exists idx_goals_user on public.goals(user_id);

-- ---------- submissions (one per judged photo) ----------
create table if not exists public.submissions (
  id          uuid primary key default gen_random_uuid(),
  goal_id     uuid not null references public.goals(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  status      text not null,                          -- approved | rejected | frozen
  reason      text,
  confidence  real,
  photo_path  text,                                   -- storage object path
  streak_before int default 0,                        -- for appeal restore
  created_at  timestamptz default now()
);
create index if not exists idx_sub_goal on public.submissions(goal_id);
create index if not exists idx_sub_user_day on public.submissions(user_id, day);

-- ---------- appeals (human review during validation) ----------
create table if not exists public.appeals (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid references public.submissions(id) on delete cascade,
  goal_id       uuid not null references public.goals(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  note          text,
  status        text default 'pending',               -- pending | approved | rejected
  streak_before int default 0,
  created_at    timestamptz default now(),
  resolved_at   timestamptz
);
create index if not exists idx_appeals_user on public.appeals(user_id);

-- ---------- certs (gamification: minted when a goal is completed) ----------
create table if not exists public.certs (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  goal_id   uuid references public.goals(id) on delete set null,
  title     text not null,
  days      int  default 0,
  share_id  text unique default encode(gen_random_bytes(8),'hex'),
  issued_at timestamptz default now()
);
create index if not exists idx_certs_user on public.certs(user_id);

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles    enable row level security;
alter table public.goals       enable row level security;
alter table public.submissions enable row level security;
alter table public.appeals     enable row level security;
alter table public.certs       enable row level security;

-- profiles: owner can read/update own
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- goals: owner full control (create/read/update/delete own)
create policy "goals_all_own" on public.goals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- submissions: owner can READ own; writes happen only via the judge Edge
-- Function (service role bypasses RLS), so no client insert/update policy.
create policy "submissions_select_own" on public.submissions for select using (auth.uid() = user_id);

-- appeals: owner can create + read own; resolution is done by service role.
create policy "appeals_select_own" on public.appeals for select using (auth.uid() = user_id);
create policy "appeals_insert_own" on public.appeals for insert with check (auth.uid() = user_id);

-- certs: owner can read own; minting is done by service role.
create policy "certs_select_own" on public.certs for select using (auth.uid() = user_id);

-- =====================================================================
-- Storage: private bucket for proof photos; users scoped to their folder
-- (path = "<user_id>/..."). The judge function (service role) also writes.
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('proofs', 'proofs', false)
on conflict (id) do nothing;

create policy "proofs_read_own" on storage.objects for select
  using (bucket_id = 'proofs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "proofs_write_own" on storage.objects for insert
  with check (bucket_id = 'proofs' and (storage.foldername(name))[1] = auth.uid()::text);
