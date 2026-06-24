# Cert API

API-first backend for Cert. One core, many clients (web now, native later).
Zero native dependencies — built-in `node:sqlite`, built-in `fetch`, Express.

## Run

```bash
cd server
npm install
npm start          # http://localhost:8787
npm test           # end-to-end smoke test
```

Runs out of the box with **no config**: the AI judge falls back to a mock and
the database is a local SQLite file (`cert.db`). To enable the real judge, set
`GEMINI_API_KEY` (copy `.env.example` → `.env`). Get a key at
https://aistudio.google.com/apikey.

> Env vars are read from the process; this project has no dotenv dependency.
> On Windows PowerShell: `$env:GEMINI_API_KEY="..."; npm start`

## Stack

- **Express** — HTTP + routing
- **node:sqlite** — storage (swap for Postgres when you outgrow it)
- **Gemini Vision** — the AI judge (`gemini-2.5-flash` by default; mock fallback when no key)
- Opaque bearer tokens in a `sessions` table (revocable, JWT-free)

## Endpoints

| Method | Path | Auth | What |
|---|---|---|---|
| GET  | `/api/health` | — | status + which judge is active |
| POST | `/api/auth/signup` | — | `{email,name,password?,timezone,ref?}` → `{token,user}` |
| POST | `/api/auth/login` | — | `{email,password?}` → `{token,user}` |
| POST | `/api/auth/logout` | ✓ | revoke token |
| GET  | `/api/me` | ✓ | `{user, goals}` |
| DELETE | `/api/me` | ✓ | delete account (App Store / GDPR) |
| POST | `/api/subscribe` | ✓ | `{plan}` — demo; wire Stripe/StoreKit here |
| GET  | `/api/goals` | ✓ | list goals |
| POST | `/api/goals` | ✓ | `{text,category,format,customDays,groupId}` |
| DELETE | `/api/goals/:id` | ✓ | remove goal |
| **POST** | **`/api/goals/:id/submit`** | ✓ | **`{photo,takenAt?}` → AI verdict + updated goal** |
| POST | `/api/goals/:id/freeze` | ✓ | spend a freeze to protect today |
| POST | `/api/goals/:id/reactivate` | ✓ | unblock (streak stays lost) |
| POST | `/api/freezes/buy` | ✓ | `{count}` |
| GET  | `/api/groups` | ✓ | catalog + leaderboards + hall of shame |
| POST | `/api/groups/:id/join` | ✓ | join a public group |
| GET  | `/api/referral` | ✓ | your referral link |

## Core loop (server is the source of truth)

`submit` → AI judge → **approve** (streak +1) or **reject** (strike +1).
3 strikes → goal `blocked`, streak burns to 0. `reactivate` clears strikes but
the streak stays at 0 — the burned streak is the punishment. Strikes are
**local per goal**.

## Demo / test hooks

`submit` accepts `forceApprove:true` / `forceReject:true` to bypass the model —
used by `test.js` and by the web app's "simulate a wrong photo" demo button.

## Wiring the web frontend

The static frontend currently uses a localStorage demo store. To point it at
this API, replace the bodies of `scripts/store.js` / `scripts/ai.js` with fetch
calls to these endpoints (keep `CertStore` / `CertAI` interfaces identical).

## Next

- Stripe Checkout (web) + webhook on `/api/subscribe`, StoreKit for iOS
- Photo storage → S3/R2 instead of local disk
- Postgres + connection pool for scale
