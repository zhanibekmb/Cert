/* =====================================================================
   CERT — database layer (built-in node:sqlite, zero native deps)
   Swap the file path / driver for Postgres when you outgrow SQLite;
   the rest of the server only calls the helpers exported here.
   ===================================================================== */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.CERT_DB || path.join(__dirname, 'cert.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT,
    password_hash TEXT,
    timezone      TEXT DEFAULT 'UTC',
    lang          TEXT DEFAULT 'en',
    subscribed    INTEGER DEFAULT 0,
    plan          TEXT,
    freezes       INTEGER DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by   TEXT,
    created_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT,
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS goals (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    text        TEXT NOT NULL,
    category    TEXT,
    format      TEXT,
    custom_days TEXT,
    duration    TEXT DEFAULT 'ongoing',
    group_id    TEXT,
    streak      INTEGER DEFAULT 0,
    best_streak INTEGER DEFAULT 0,
    strikes     INTEGER DEFAULT 0,
    blocked     INTEGER DEFAULT 0,
    last_submit TEXT,
    created_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id         TEXT PRIMARY KEY,
    goal_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    date       TEXT,
    status     TEXT,
    reason     TEXT,
    confidence REAL,
    photo_path TEXT,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
  CREATE INDEX IF NOT EXISTS idx_sub_goal ON submissions(goal_id);
`);

// lightweight migration for DBs created before `duration` existed
try { db.exec("ALTER TABLE goals ADD COLUMN duration TEXT DEFAULT 'ongoing'"); } catch (e) { /* column already exists */ }

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/* ---- password hashing (scrypt) ---- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex')); }
  catch (e) { return false; }
}

/* ---- date helper: "today" in a user's timezone ---- */
function todayFor(tz) {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: tz || 'UTC' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}

/* ---- serialization (DB row -> API shape) ---- */
function pubUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, timezone: u.timezone, lang: u.lang,
    subscribed: !!u.subscribed, plan: u.plan, freezes: u.freezes,
    referralCode: u.referral_code, createdAt: u.created_at
  };
}
function pubGoal(g) {
  if (!g) return null;
  return {
    id: g.id, text: g.text, category: g.category, format: g.format,
    customDays: g.custom_days ? JSON.parse(g.custom_days) : [],
    duration: g.duration || 'ongoing',
    groupId: g.group_id, streak: g.streak, bestStreak: g.best_streak,
    strikes: g.strikes, blocked: !!g.blocked, lastSubmit: g.last_submit, createdAt: g.created_at
  };
}

/* ---- prepared statements ---- */
const Q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByRef: db.prepare('SELECT * FROM users WHERE referral_code = ?'),
  insertUser: db.prepare(`INSERT INTO users (id,email,name,password_hash,timezone,lang,subscribed,plan,freezes,referral_code,referred_by,created_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  setSub: db.prepare('UPDATE users SET subscribed=?, plan=? WHERE id=?'),
  setFreezes: db.prepare('UPDATE users SET freezes=? WHERE id=?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id=?'),

  insertSession: db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),

  goalsByUser: db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at ASC'),
  goalById: db.prepare('SELECT * FROM goals WHERE id = ?'),
  insertGoal: db.prepare(`INSERT INTO goals (id,user_id,text,category,format,custom_days,duration,group_id,streak,best_streak,strikes,blocked,last_submit,created_at)
                          VALUES (?,?,?,?,?,?,?,?,0,0,0,0,NULL,?)`),
  updateGoalStats: db.prepare('UPDATE goals SET streak=?, best_streak=?, strikes=?, blocked=?, last_submit=? WHERE id=?'),
  deleteGoal: db.prepare('DELETE FROM goals WHERE id=?'),

  insertSubmission: db.prepare(`INSERT INTO submissions (id,goal_id,user_id,date,status,reason,confidence,photo_path,created_at)
                                VALUES (?,?,?,?,?,?,?,?,?)`),
  subsByGoal: db.prepare('SELECT * FROM submissions WHERE goal_id = ? ORDER BY created_at DESC LIMIT 30')
};

module.exports = { db, Q, now, uuid, hashPassword, verifyPassword, todayFor, pubUser, pubGoal };
