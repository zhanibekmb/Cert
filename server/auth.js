/* =====================================================================
   CERT — auth: opaque bearer tokens stored in the sessions table.
   (JWT-free on purpose — revocable, simple, swappable later.)
   ===================================================================== */
'use strict';

const crypto = require('crypto');
const { Q, now, uuid } = require('./db');

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const created = now();
  const expires = new Date(Date.now() + THIRTY_DAYS).toISOString();
  Q.insertSession.run(token, userId, created, expires);
  return token;
}

function revokeToken(token) {
  if (token) Q.deleteSession.run(token);
}

function userFromToken(token) {
  if (!token) return null;
  const s = Q.sessionByToken.get(token);
  if (!s) return null;
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
    Q.deleteSession.run(token);
    return null;
  }
  return Q.userById.get(s.user_id) || null;
}

/* express middleware — attaches req.user (full DB row) or 401 */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.token = token;
  next();
}

module.exports = { issueToken, revokeToken, userFromToken, requireAuth };
