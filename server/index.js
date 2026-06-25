/* =====================================================================
   CERT — API server (API-first core; web/Telegram/native are clients)
   Run:  npm install && npm start
   Env:  PORT, GEMINI_API_KEY (optional), CERT_DB, CORS_ORIGIN
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* zero-dependency .env loader (no dotenv dep). Runs before anything reads
   process.env, so server/.env "just works". Real env vars take precedence. */
(function loadDotenv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) return;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
    });
  } catch (e) { /* ignore */ }
})();

const express = require('express');
const cors = require('cors');

const { Q, now, uuid, hashPassword, verifyPassword, todayFor, pubUser, pubGoal } = require('./db');
const { issueToken, revokeToken, requireAuth } = require('./auth');
const { GROUPS, PEOPLE, SHAME, ruleFor } = require('./groups');
const AI = require('./ai');

const app = express();
const PORT = process.env.PORT || 8787;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '12mb' })); // base64 photos
app.use('/uploads', express.static(UPLOAD_DIR));

/* ---------- helpers ---------- */
function genRef() { return 'cert-' + Math.random().toString(36).slice(2, 8); }

function savePhoto(dataUrl, id) {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg').replace(/[^\w]/g, '') || 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  return `/uploads/${file}`;
}

/* mirror of the client streak/strike rules — server is the source of truth */
function applyVerdict(goal, approved, reason, confidence, photoPath, tz) {
  const today = todayFor(tz);
  let { streak, best_streak, strikes, blocked } = goal;
  let status;
  if (approved) {
    streak += 1; if (streak > best_streak) best_streak = streak; status = 'approved';
  } else {
    strikes += 1; status = 'rejected';
    if (strikes >= 3) { blocked = 1; streak = 0; }
  }
  Q.updateGoalStats.run(streak, best_streak, strikes, blocked, today, goal.id);
  Q.insertSubmission.run(uuid(), goal.id, goal.user_id, today, status, reason, confidence, photoPath, now());
  return Q.goalById.get(goal.id);
}

/* ---------- health ---------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ai: AI.usingRealAI() ? 'gemini' : 'mock', time: now() });
});

/* ---------- standalone judge ----------
   Used by the static web app's CertAI (window.CERT_AI_ENDPOINT). No auth, no DB —
   just runs a photo + goal through the judge so the frontend can use real Gemini
   without the full account/goal pipeline. Returns { approved, reason, confidence }. */
app.post('/api/judge', async (req, res) => {
  const { photo, goal, category, proofSpec, dailyReq, forceReject, forceApprove } = req.body || {};
  if (!photo) return res.status(400).json({ approved: false, reason: 'No photo submitted.', confidence: 0 });
  try {
    const verdict = await AI.judge({
      photo, goalText: goal || '', category: category || '_default', proofSpec: proofSpec || '', dailyReq: dailyReq || '',
      forceReject: !!forceReject, forceApprove: !!forceApprove
    });
    res.json(verdict);
  } catch (e) {
    res.status(502).json({ approved: false, reason: 'Judge failed: ' + e.message, confidence: 0 });
  }
});

/* ---------- proof-spec ----------
   The AI tells the user what photo proves their goal (shown at goal creation
   and on the submit screen; the same spec is fed back to the judge). */
app.post('/api/proof-spec', async (req, res) => {
  const { goal, category, lang } = req.body || {};
  if (!goal || String(goal).trim().length < 3) return res.status(400).json({ error: 'goal_too_short' });
  try {
    const out = await AI.spec({ goalText: String(goal).trim(), category: category || '_default', lang: lang === 'ru' ? 'ru' : 'en' });
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: 'spec_failed', message: e.message });
  }
});

/* ---------- auth ---------- */
app.post('/api/auth/signup', (req, res) => {
  const { email, name, password, timezone, ref } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (Q.userByEmail.get(email)) return res.status(409).json({ error: 'email_taken' });

  const referrer = ref ? Q.userByRef.get(ref) : null;
  const id = uuid();
  Q.insertUser.run(
    id, email, name || email.split('@')[0],
    password ? hashPassword(password) : null,
    timezone || 'UTC', 'en', 0, null, 0, genRef(), referrer ? referrer.id : null, now()
  );
  const token = issueToken(id);
  res.json({ token, user: pubUser(Q.userById.get(id)) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = email ? Q.userByEmail.get(email) : null;
  if (!u) return res.status(404).json({ error: 'no_user' });
  // passwordless demo accounts: login by email; if a password is set, it must match
  if (u.password_hash && !verifyPassword(password || '', u.password_hash)) {
    return res.status(401).json({ error: 'bad_password' });
  }
  const token = issueToken(u.id);
  res.json({ token, user: pubUser(u) });
});

/* Sign in with Google: the client sends a Google ID token (credential).
   We verify it with Google's tokeninfo (zero deps), check it was issued for
   OUR client id, then find-or-create the user and issue our own session token. */
app.post('/api/auth/google', async (req, res) => {
  const { credential, timezone } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'no_credential' });
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'google_not_configured' });

  let claims;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!r.ok) throw new Error('tokeninfo ' + r.status);
    claims = await r.json();
  } catch (e) {
    return res.status(401).json({ error: 'verify_failed', message: e.message });
  }

  // security checks: audience must be our app, issuer must be Google, email verified, not expired
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'bad_audience' });
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') return res.status(401).json({ error: 'bad_issuer' });
  if (String(claims.email_verified) !== 'true') return res.status(401).json({ error: 'email_unverified' });
  if (claims.exp && (Date.now() / 1000) > Number(claims.exp)) return res.status(401).json({ error: 'token_expired' });
  const email = String(claims.email || '').toLowerCase();
  if (!email) return res.status(401).json({ error: 'no_email' });

  let u = Q.userByEmail.get(email);
  if (!u) {
    const id = uuid();
    Q.insertUser.run(id, email, claims.name || email.split('@')[0], null, timezone || 'UTC', 'en', 0, null, 0, genRef(), null, now());
    u = Q.userById.get(id);
  }
  const token = issueToken(u.id);
  res.json({ token, user: pubUser(u) });
});

app.post('/api/auth/logout', requireAuth, (req, res) => { revokeToken(req.token); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: pubUser(req.user), goals: Q.goalsByUser.all(req.user.id).map(pubGoal) });
});

app.delete('/api/me', requireAuth, (req, res) => {
  Q.deleteUserSessions.run(req.user.id);
  Q.goalsByUser.all(req.user.id).forEach((g) => Q.deleteGoal.run(g.id));
  Q.deleteUser.run(req.user.id);
  res.json({ ok: true });
});

/* ---------- subscription (demo; wire Stripe/StoreKit here) ---------- */
app.post('/api/subscribe', requireAuth, (req, res) => {
  const plan = (req.body && req.body.plan) === 'yearly' ? 'yearly' : 'monthly';
  Q.setSub.run(1, plan, req.user.id);
  // welcome freeze
  const u = Q.userById.get(req.user.id);
  if (u.freezes < 1) Q.setFreezes.run(1, u.id);
  res.json({ user: pubUser(Q.userById.get(req.user.id)) });
});

/* ---------- goals ---------- */
app.get('/api/goals', requireAuth, (req, res) => {
  res.json({ goals: Q.goalsByUser.all(req.user.id).map(pubGoal) });
});

app.post('/api/goals', requireAuth, (req, res) => {
  const { text, category, format, customDays, duration, groupId } = req.body || {};
  if (!text || String(text).trim().length < 3) return res.status(400).json({ error: 'goal_too_short' });
  const id = uuid();
  Q.insertGoal.run(id, req.user.id, String(text).trim(), category || 'gym', format || 'daily',
    JSON.stringify(Array.isArray(customDays) ? customDays : []), duration || 'ongoing', groupId || null, now());
  res.json({ goal: pubGoal(Q.goalById.get(id)) });
});

app.delete('/api/goals/:id', requireAuth, (req, res) => {
  const g = Q.goalById.get(req.params.id);
  if (!g || g.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  Q.deleteGoal.run(g.id);
  res.json({ ok: true });
});

/* ---------- THE CORE: submit proof -> AI judge -> verdict ---------- */
app.post('/api/goals/:id/submit', requireAuth, async (req, res) => {
  const g = Q.goalById.get(req.params.id);
  if (!g || g.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (g.blocked) return res.status(409).json({ error: 'goal_blocked' });

  const { photo, takenAt, forceReject, forceApprove } = req.body || {};
  if (!photo) return res.status(400).json({ error: 'no_photo' });

  // anti-fraud (MVP): reject photos older than 24h before spending an AI call
  if (takenAt) {
    const age = Date.now() - new Date(takenAt).getTime();
    if (isFinite(age) && age > 24 * 60 * 60 * 1000) {
      return res.status(422).json({ error: 'photo_too_old', message: 'Photo must be from the last 24 hours.' });
    }
  }

  let verdict;
  try {
    verdict = await AI.judge({ photo, goalText: g.text, category: g.category, forceReject: !!forceReject, forceApprove: !!forceApprove });
  } catch (e) {
    return res.status(502).json({ error: 'judge_failed', message: e.message });
  }

  const photoPath = savePhoto(photo, uuid());
  const updated = applyVerdict(g, verdict.approved, verdict.reason, verdict.confidence, photoPath, req.user.timezone);

  res.json({
    verdict: { approved: verdict.approved, reason: verdict.reason, confidence: verdict.confidence },
    goal: pubGoal(updated),
    user: pubUser(Q.userById.get(req.user.id))
  });
});

/* ---------- freezes ---------- */
app.post('/api/freezes/buy', requireAuth, (req, res) => {
  const count = Math.max(1, Math.min(20, parseInt((req.body && req.body.count) || 1, 10)));
  const u = Q.userById.get(req.user.id);
  Q.setFreezes.run(u.freezes + count, u.id);
  res.json({ user: pubUser(Q.userById.get(u.id)) });
});

app.post('/api/goals/:id/freeze', requireAuth, (req, res) => {
  const g = Q.goalById.get(req.params.id);
  if (!g || g.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  const u = Q.userById.get(req.user.id);
  if (u.freezes < 1) return res.status(402).json({ error: 'no_freezes' });
  Q.setFreezes.run(u.freezes - 1, u.id);
  const today = todayFor(req.user.timezone);
  Q.updateGoalStats.run(g.streak, g.best_streak, g.strikes, g.blocked, today, g.id);
  Q.insertSubmission.run(uuid(), g.id, u.id, today, 'frozen', 'Day protected by freeze', null, null, now());
  res.json({ goal: pubGoal(Q.goalById.get(g.id)), user: pubUser(Q.userById.get(u.id)) });
});

/* ---------- reactivation (demo; wire payment here) ---------- */
app.post('/api/goals/:id/reactivate', requireAuth, (req, res) => {
  const g = Q.goalById.get(req.params.id);
  if (!g || g.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  // streak stays at 0 — the burned streak IS the punishment
  Q.updateGoalStats.run(0, g.best_streak, 0, 0, g.last_submit, g.id);
  Q.insertSubmission.run(uuid(), g.id, req.user.id, todayFor(req.user.timezone), 'reactivated', 'Goal reactivated — streak reset', null, null, now());
  res.json({ goal: pubGoal(Q.goalById.get(g.id)) });
});

/* ---------- groups ---------- */
app.get('/api/groups', requireAuth, (req, res) => {
  const mine = Q.goalsByUser.all(req.user.id).map((g) => g.group_id).filter(Boolean);
  const groups = GROUPS.map((g) => ({
    id: g.id, emoji: g.emoji, name: g.name, name_ru: g.name_ru, rule: g.rule,
    format: g.format, members: g.members, joined: mine.indexOf(g.id) >= 0,
    leaderboard: PEOPLE[g.id] || []
  }));
  res.json({ groups, shame: SHAME });
});

app.post('/api/groups/:id/join', requireAuth, (req, res) => {
  const grp = GROUPS.find((x) => x.id === req.params.id);
  if (!grp) return res.status(404).json({ error: 'no_group' });
  const b = req.body || {};
  if (!b.text || String(b.text).trim().length < 3) return res.status(400).json({ error: 'goal_too_short' });
  const id = uuid();
  Q.insertGoal.run(id, req.user.id, String(b.text).trim(), grp.id, b.format || grp.format,
    JSON.stringify(Array.isArray(b.customDays) ? b.customDays : []), b.duration || '30', grp.id, now());
  res.json({ goal: pubGoal(Q.goalById.get(id)) });
});

/* ---------- referral ---------- */
app.get('/api/referral', requireAuth, (req, res) => {
  const u = Q.userById.get(req.user.id);
  res.json({ code: u.referral_code, link: `cert.app/r/${u.referral_code}` });
});

/* ---------- static frontend (single-service deploy) ----------
   Serve the web app from the repo root so ONE deploy serves API + UI.
   Block /server so backend source and .env are never exposed; dotfiles ignored. */
app.use('/server', (req, res) => res.status(404).end());
app.use(express.static(path.join(__dirname, '..'), { dotfiles: 'ignore', extensions: ['html'] }));

/* ---------- boot ---------- */
const server = app.listen(PORT, () => {
  console.log(`\n  CERT API  ·  http://localhost:${PORT}`);
  console.log(`  AI judge  ·  ${AI.usingRealAI() ? 'Gemini ' + (process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite') : 'mock (set GEMINI_API_KEY for real)'}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.\n` +
      `    The Cert API is probably already running in another window.\n` +
      `    Either use it as-is, or start this one on a different port:\n\n` +
      `      Windows PowerShell:  $env:PORT=8788; npm start\n` +
      `      macOS / Linux:       PORT=8788 npm start\n`);
    process.exit(1);
  }
  throw err;
});

module.exports = app;
