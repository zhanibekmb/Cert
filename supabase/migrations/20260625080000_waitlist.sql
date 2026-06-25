-- Landing-page waitlist: visitors leave an email to reserve 7 days of Pro at
-- launch. Anonymous inserts allowed from the site; emails are NOT readable by
-- the public (no select policy) — only the service role / dashboard can read.
create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  challenge   text,
  lang        text,
  country     text,
  currency    text,
  trial_days  int default 7,
  created_at  timestamptz default now(),
  unique (email)
);
alter table public.waitlist enable row level security;

-- anyone (anon) may add themselves; nobody may read back (privacy)
drop policy if exists "waitlist_insert_anon" on public.waitlist;
create policy "waitlist_insert_anon" on public.waitlist for insert with check (true);
