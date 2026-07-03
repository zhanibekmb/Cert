-- =====================================================================
-- CERT — UGC moderation (App Store Guideline 1.2 / Google UGC policy).
-- Users can report objectionable proof content and block abusive users.
-- Writes go through the `challenge` Edge Function (service role), so these
-- tables have RLS enabled with NO client policies (deny direct access).
-- =====================================================================

-- Who a user has blocked. Their proofs are filtered out of the review queue.
create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);
alter table public.user_blocks enable row level security;

-- Reports of objectionable content, reviewed manually.
create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid references auth.users(id) on delete set null,
  submission_id uuid references public.submissions(id) on delete set null,
  challenge_id uuid references public.challenges(id) on delete set null,
  reason text,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
alter table public.content_reports enable row level security;

create index if not exists content_reports_open_idx on public.content_reports (status, created_at);
