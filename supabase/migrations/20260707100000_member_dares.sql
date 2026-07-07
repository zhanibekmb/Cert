-- Custom wheel-of-fortune dares written by challenge members. Each member may
-- write one (optional) at create/join time; the wheel spins over the written
-- ones (padded with defaults), falling back to the default list when nobody
-- wrote any. Written by the challenge Edge Function (service role) only.
alter table public.challenge_members add column if not exists dare_text text;
