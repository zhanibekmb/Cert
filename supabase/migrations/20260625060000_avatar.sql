-- Profile photo, stored as a small data-URI string (avatar is fetched only on
-- the profile screen, so an inline image keeps it simple — no storage bucket).
alter table public.profiles add column if not exists avatar_url text;
