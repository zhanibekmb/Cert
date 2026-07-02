-- Push notifications: store each device's Expo push token + bookkeeping so the
-- risk-push function sends at most one "streak at risk" push per user per day.
alter table public.profiles add column if not exists expo_push_token   text;
alter table public.profiles add column if not exists last_risk_push_day date;
