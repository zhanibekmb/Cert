# Cert on Supabase — setup runbook

Backend re-platform: **Auth (Google) + Postgres + Storage on Supabase**, AI judge
in **Edge Functions** (Gemini key stays a server secret). Same backend serves the
web app now and the iOS app later.

What's in the repo:
- `supabase/migrations/…_init.sql` — schema + RLS + storage bucket.
- `supabase/functions/judge/` — judges a photo, records the submission, updates
  the streak, mints a Cert on completion (server-authoritative).
- `supabase/functions/proof-spec/` — bilingual "what photo to send".
- `supabase/functions/_shared/` — Gemini helpers + CORS.

---

## 1. Create the project
1. https://supabase.com → **New project**. Pick a name + region + DB password.
2. Project Settings → **API**: copy **Project URL** and the **anon (public) key**.
   (Also note the **service_role** key — secret, never in the frontend.)

## 2. Apply the database schema
Easiest (no CLI): Dashboard → **SQL Editor** → paste the contents of
`supabase/migrations/20260624000000_init.sql` → **Run**.

Or with the CLI:
```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

## 3. Set the Gemini secret (for the functions)
```bash
supabase secrets set GEMINI_API_KEY=YOUR_KEY GEMINI_MODEL=gemini-2.5-flash-lite
```
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected into
functions automatically — don't set them.)

## 4. Deploy the Edge Functions
```bash
supabase functions deploy judge
supabase functions deploy proof-spec
```

## 5. Enable Google sign-in (Supabase-managed)
1. Dashboard → **Authentication → Providers → Google** → enable.
2. Paste your Google **Client ID** and **Client secret** (Google Cloud Console →
   Credentials → OAuth client, type *Web*).
3. Copy the **redirect URL** Supabase shows you and add it to the Google client's
   *Authorized redirect URIs*.
4. Authentication → **URL Configuration** → set Site URL to your Vercel URL and add
   it to Redirect URLs.

> With Supabase Auth we DROP the custom `/api/auth/google` we wrote — Supabase
> handles Google for web and iOS. The old Express backend (`server/`) becomes
> legacy reference.

## 6. Storage
The migration creates a private **`proofs`** bucket with per-user policies. Nothing
else to do — the judge function writes photos there.

## 7. Hand back to me
Send me the **Project URL** and the **anon key**. I'll wire the web frontend
(`app.html` + a new `scripts/supabase.js` data layer) to:
- sign in with Google via Supabase,
- read/write goals & submissions (RLS-scoped),
- call the `judge` / `proof-spec` functions,
- upload proofs to Storage.

(The anon key is safe in the frontend — RLS protects the data. The service_role key
stays only in Supabase.)

---

## Data model (v1)
- **profiles** — user + plan + freezes + cert_score.
- **goals** — `type` = `recurring | one_time`; recurring has `format` + `duration_days`
  (null = ongoing); one_time has `deadline`. `status` = active/completed/failed/archived.
- **submissions** — one per judged photo (approved/rejected/frozen) + photo path.
- **appeals** — human review (limit enforced in app), restores streak on approve.
- **certs** — minted when a goal completes (the shareable "you did N verified days").

Adjust durations / gamification by editing the migration before you run it.
