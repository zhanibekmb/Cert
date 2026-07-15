-- Referral freezes: every profile gets a short invite code; a new user redeems
-- a friend's code ONCE and both sides are granted freezes (see referral fn).
alter table public.profiles add column if not exists ref_code text;
update public.profiles set ref_code = upper(substr(md5(id::text), 1, 6)) where ref_code is null;
create unique index if not exists profiles_ref_code_idx on public.profiles (ref_code);

-- keep new signups covered (profiles are created by the auth trigger)
create or replace function public.ensure_ref_code()
returns trigger language plpgsql as $$
begin
  if new.ref_code is null then new.ref_code := upper(substr(md5(new.id::text), 1, 6)); end if;
  return new;
end $$;
drop trigger if exists trg_ref_code on public.profiles;
create trigger trg_ref_code before insert on public.profiles
  for each row execute function public.ensure_ref_code();

-- one redemption per user, ever
create table if not exists public.referrals (
  referred_id uuid primary key references public.profiles(id) on delete cascade,
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.referrals enable row level security;
-- no client policies: only the referral edge function (service role) touches it
