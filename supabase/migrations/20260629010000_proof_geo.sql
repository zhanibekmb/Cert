-- Optional geolocation attached to a proof (geo-verified proofs). Captured on
-- the device at submit time, best-effort; null when the user declines location.
alter table public.submissions add column if not exists lat   double precision;
alter table public.submissions add column if not exists lng   double precision;
alter table public.submissions add column if not exists place text;
