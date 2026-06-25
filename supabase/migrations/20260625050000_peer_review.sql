-- Peer-reviewed challenges: friends approve each other's proofs (Tinder-style
-- swipe). judge_mode = 'ai' (AI judge, default) | 'peer' (friends vote).
alter table public.challenges add column if not exists judge_mode text not null default 'ai';

-- one vote per reviewer per submission
create table if not exists public.challenge_votes (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  challenge_id  uuid not null references public.challenges(id) on delete cascade,
  voter_id      uuid not null references auth.users(id) on delete cascade,
  vote          text not null,                 -- approve | decline
  created_at    timestamptz default now(),
  unique (submission_id, voter_id)
);
create index if not exists idx_votes_sub on public.challenge_votes(submission_id);
create index if not exists idx_votes_challenge on public.challenge_votes(challenge_id);

-- all vote reads/writes go through the service-role `challenge` function
alter table public.challenge_votes enable row level security;
