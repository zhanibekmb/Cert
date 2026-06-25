-- Optional time-of-day deadline for recurring goals (e.g. "07:00" = must submit
-- before 7am local). Enforced server-side by the judge using the user's timezone.
alter table public.goals add column if not exists daily_deadline text; -- "HH:MM" or null
