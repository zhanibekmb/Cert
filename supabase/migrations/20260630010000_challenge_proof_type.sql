-- Group challenges can require timelapse proof (AI-judged challenges only).
-- Each member's goal inherits this, so the existing Submit → judge timelapse
-- flow is reused unchanged.
alter table public.challenges add column if not exists proof_type text default 'photo'; -- 'photo' | 'timelapse'
