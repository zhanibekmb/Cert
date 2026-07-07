-- Let users delete their own Certs (the achievement is theirs to remove).
drop policy if exists "certs_delete_own" on public.certs;
create policy "certs_delete_own" on public.certs for delete using (auth.uid() = user_id);
