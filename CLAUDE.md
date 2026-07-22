# Cert — project context

> ⚠️ This repo is on GitHub. **Never commit secrets** (Supabase `sbp_`/service-role keys, RevenueCat `sk_`, webhook secret, demo passwords). They live in the Supabase project + local env only. Public keys (`appl_`/`goog_`, anon key) are safe and already in `mobile/config.js`.

## What it is
Cert — a mobile habit-streak app. You set one goal, submit a daily photo, and an **AI judge** decides if it counts ("the streak you can't fake"). Freemium: free + **Cert Pro** subscription. Solo streaks + peer/group challenges. Fully RU + EN.

## Repo layout
- `mobile/` — Expo SDK 54 / RN 0.81 app (New Arch **off**). Main file `App.js` (~2500 lines).
  - `config.js` (Supabase + RevenueCat public keys, product IDs), `purchases.js` (RevenueCat wrapper), `lib/i18n.js` (`t()` dict EN→RU), `lib/reminders.js`, `lib/push.js`, `app.json`, `eas.json`.
- `supabase/functions/` — Deno Edge Functions: `judge`, `challenge`, `appeal`, `daily-sweep`, `risk-push`, `revenuecat-webhook`, `delete-account`.
- `supabase/migrations/` — SQL migrations.
- Repo root `*.html` — landing site (`index`, `pricing`, `privacy`, `terms`, `delete-account`), deployed to **www.certapp.pro** via Vercel.
- `server/` — legacy Express MVP, **not used** by the mobile app.

## Stack / services
- **Supabase** — Postgres + RLS, Auth, Storage bucket `proofs`, Edge Functions. Project ref `hiydsiiuzpneykbjddsr` (URL in `mobile/config.js`).
- **RevenueCat** — IAP via `react-native-purchases` 8. iOS `appl_…`, Android `goog_…` keys in `config.js` (public).
- **Gemini** — the AI judge (in `judge` function).
- **EAS Build/Submit** — cloud builds from Windows.
- **Domain** `certapp.pro` — registrar Spaceship, DNS delegated to **Vercel**; site served at **www.certapp.pro** (non-www 308→www, `.html` kept).
- **Resend** — SMTP for auth emails (sender `noreply@certapp.pro`).

## Key architecture / decisions
- **Auth**: email+password, Google, Sign in with Apple. Password reset by **6-digit CODE** (Supabase recovery OTP + Resend SMTP). Login screen has RU/EN toggle + Sign in / Sign up tabs.
- **Streak honesty**: a break resets `streak` to 0 but `verified_days_total`/`best_streak` **never** reset. One count per local calendar day. Freezes are purchasable by everyone (incl. free users).
- **Purchases**: app fetches products via `getProducts` (direct StoreKit/Play, not Offerings) and **normalizes Android base-plan IDs** (`cert_pro_monthly:monthly` → `cert_pro_monthly`) in `purchases.js`. `revenuecat-webhook` is the ONLY thing that credits `plan`/`freezes` (auth via `REVENUECAT_WEBHOOK_SECRET` header; product_id normalized).
- **UGC moderation (Apple 1.2)**: Report + Block in peer challenges (`SwipeReview`), backed by `user_blocks` + `content_reports` tables and `block`/`report` actions in the `challenge` function; the review queue hides blocked users. Terms have a zero-tolerance clause.
- **Account deletion (Apple 5.1.1(v))**: `delete-account` function (purges storage + `auth.admin.deleteUser` → cascade) + Settings button.
- **Freemium gating**: Free = **1 active personal goal** + **photo** proof (completed goals & joined challenges don't count against the limit). Pro unlocks **timelapse video proof**, **geo check-in**, **unlimited goals**, **analytics** (heatmap/trophies). Freezes are purchasable by everyone. Goal proof types: `photo` (free) / `timelapse` (Pro, video upload judged by Gemini) / `geo` (Pro, GPS check-in vs a map-pinned point). Creation kept lean: goals = **sentence builder** (one plain sentence with inline bronze pills — proof / cadence / deadline / length — each opening a bottom-sheet picker; One-time/Repeating toggle on top), challenges = **3 steps**. Duration/target works for all recurring cadences (daily → days, weekly → weeks; judge completes personal goals at the streak target).
- **Onboarding**: first-run "How Cert works" once (flag `cert_intro`). No auto-paywall.
- **Theme/i18n**: light/dark via module-level `let C` — **LIGHT is the default** (brand v2: indigo accents `#4f46e5`/`#4338ca` on white, cool neutral grays; `err` slot is the only red, reserved for errors/rejections/destructive; no bronze/red brand colors anymore); strings via `t()` in `lib/i18n.js`.

## Product IDs (must match config.js ↔ RevenueCat ↔ stores ↔ webhook)
- Subscriptions: `cert_pro_monthly`, `cert_pro_yearly` (Android base plans `monthly`/`yearly`).
- Consumables: `freeze_pack_3`, `freeze_pack_10` (Android purchase option `standard`).

## URLs
- Landing: https://www.certapp.pro
- Privacy: https://www.certapp.pro/privacy.html
- Terms / EULA: https://www.certapp.pro/terms.html
- Account deletion: https://www.certapp.pro/delete-account.html
- Support email: janibek190906@gmail.com

## Launch status (2026-07)
- **iOS / App Store**: launch crash fixed (was `expo-font` version conflict → pinned `@expo/vector-icons` `~15.0.3` + `overrides: {expo-font: 14.0.12}`). Now clearing metadata review. Outstanding: Terms-of-Use link in the App **Description**, IAP (subscriptions) submitted with the version, ATT labels set to "not tracking". New opaque app icon `mobile/assets/app-icon.png`.
- **Android / Google Play**: in **closed testing**. Personal account needs **12 testers × 14 days** before Production access. `goog_` key + service account connected.
- **Demo review account**: `appreview@cert.app` (password kept in private notes, not in repo).

## Commands
- iOS build: `cd mobile && eas build --profile production --platform ios`
- Android AAB: `cd mobile && eas build --profile production --platform android`
- Submit iOS: `cd mobile && eas submit --profile production --platform ios`
- Deploy Edge Function: `SUPABASE_ACCESS_TOKEN=<sbp> npx supabase functions deploy <name> --project-ref hiydsiiuzpneykbjddsr [--no-verify-jwt]`
- DB query / migration: `POST https://api.supabase.com/v1/projects/hiydsiiuzpneykbjddsr/database/query` with `{query}` + `Authorization: Bearer <sbp>`.
- Landing deploy: `git push` → Vercel auto-deploys www.certapp.pro.
- Parse-check RN before building: `node -e "require('@babel/core').transformFileSync('App.js',{presets:['babel-preset-expo'],filename:'App.js'})"`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Recent work (2026-07-21) — onboarding + UX pass
Branch work (mobile `App.js`, `lib/i18n.js`, Edge Functions). All new user-facing copy is RU+EN via `t()`.
- **Onboarding rebuilt (hands-on)**: `Onboarding` is now ONE what/why screen (was 5 slides). The real goal wizard auto-opens **post-auth in `Main`** as the tutorial — armed by `cert_first_goal_pending` (set on first `SIGNED_IN` next to `cert_funnel_done`), consumed once after `load()` if the account has 0 goals. During first-run (`NewGoal` prop `firstRun`) the proof is pre-set to `photo` and Pro chips are hidden (avoids paywall mid-tutorial). New funnel events: `first_goal_created`, `first_proof_submitted` (col `funnel_events.event` is free text).
- **Progress = grid journal** (`Reel`): the old auto-player is a tap-to-open grid + lightbox. Lightbox supports **horizontal swipe** (PanResponder on the outer container) and **selective export** (tap the circle to pick tiles → "Export N selected" / "Export all"). Hidden for `geo` goals (no photo).
- **Goal creation**: geo goals now show a description field; idea starters are photo-**provable** only (gym / run / pushups / cooked meal) as icon cards — no "read 20 pages".
- **Home GoalCard compacted**: streak on one line + inline `MilestoneMini` bar; merged goal/schedule lines; smaller `StreakCalendar` (`compact`); rejected-today shows a red plate + quiet "Appeal or retry" (no prominent submit CTA).
- **Stats split**: overview tab (streak, counters, week strip) + separate `AnalyticsScreen` (heatmap + trophy shelf, Pro) via `screen === "analytics"`. Week is **Monday-aligned** (`mondayWeek()`) with weekday labels, not a rolling 7-day window.
- **Challenges**: hero banner on `ChallengeDetail` (indigo, flame watermark, stat pills, tap-code-to-share); list + history cards redesigned; **board load optimized** — one parallel `Promise.all` batch (goals/avatars/subs/tz) + derive today/week/pending from the fetched subs instead of ~9 sequential queries; final-rank persist parallelized.
- **Paywall redesigned**: indigo hero + benefit icon-rows (replaced the Free/Pro table). No emoji/stickers anywhere (product rule: **do not use emoji/sticker glyphs in UI**, use Ionicons).
- **AI judge**: `judge` + `appeal` now send `thinkingConfig.thinkingBudget: 0` + `maxOutputTokens: 256` (latency). **Appeal denials email** `zhanibek@certapp.pro` (via Resend) — needs `RESEND_API_KEY` set on the `appeal` function; missing key just skips silently. Video proof `TL_MAX_SECONDS` = **20** (lighter clips reduce Gemini video-processing failures).
- **Fixes**: paywall fine-print links wrap; referral code cached module-level (`_refCache`, no reload flash); post-approval judge `reason` text removed on the approval overlay (kept on reject/appeal).
- **DEPLOY REQUIRED** for the Edge Function changes: `judge`, `appeal`, `challenge` (see Commands). Client changes ride the next EAS build.

## Gotchas
- **Expo Go ≠ build**: RevenueCat is no-op in Expo Go (Preview Mode) and push/New-Arch behave differently. Test payments/push in a real build, not Expo Go.
- **`newArchEnabled: false`** in `app.json` is intentional (3rd-party lib compatibility); Expo Go warns — ignore, it's not a store blocker.
- **Recovery email template** resets to a link if edited in the Supabase **dashboard** — set the `{{ .Token }}` template only via the Management API.
- **EAS free tier** queues builds and is limited per month — batch changes, don't rebuild per tweak.
- iOS subscriptions must be submitted **with an app version** the first time; App Store IAP "Missing Metadata" usually = missing review screenshot or subscription-group localization.
