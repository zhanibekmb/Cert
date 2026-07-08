-- Hardening batch: enforce the free-tier goal limit server-side, and add a
-- readable funnel summary for the dashboard.

-- 1) Free plan = 1 active personal goal, enforced at the DB (the app already
--    gates in the UI; this closes the direct-API loophole). Challenge goals
--    (created by the challenge function) and Pro users are exempt.
create or replace function public.enforce_free_goal_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int; p text;
begin
  if new.challenge_id is not null then return new; end if;
  select plan into p from public.profiles where id = new.user_id;
  if p in ('monthly', 'yearly') then return new; end if;
  select count(*) into n from public.goals
    where user_id = new.user_id and challenge_id is null and status = 'active';
  if n >= 1 then raise exception 'free_goal_limit'; end if;
  return new;
end $$;
drop trigger if exists trg_free_goal_limit on public.goals;
create trigger trg_free_goal_limit before insert on public.goals
  for each row execute function public.enforce_free_goal_limit();

-- 2) Funnel summary view (dashboard-only: not readable via the public API).
create or replace view public.funnel_summary as
  select event,
         count(*)                as total,
         count(distinct device_id) as devices,
         min(created_at)         as first_seen,
         max(created_at)         as last_seen
  from public.funnel_events
  group by event;
revoke all on public.funnel_summary from anon, authenticated;
