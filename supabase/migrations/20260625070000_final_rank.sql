-- Final standings for ended challenges (lazily written by the board when a
-- challenge is over) so the history list can show each member's placement.
alter table public.challenge_members add column if not exists final_rank int;
