/* =====================================================================
   CERT — API end-to-end smoke test (no test framework, just fetch)
   Boots the server on a temp DB, drives the full core loop, asserts.
   Run:  npm test
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = 8799;
const TEST_DB = path.join(__dirname, 'test.db');
['', '-shm', '-wal'].forEach((s) => { try { fs.unlinkSync(TEST_DB + s); } catch (e) {} });

process.env.PORT = PORT;
process.env.CERT_DB = TEST_DB;
delete process.env.GEMINI_API_KEY; // force mock
delete process.env.OPENAI_API_KEY; // (legacy) force mock

const app = require('./index.js');
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } }

async function call(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

const tinyPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

(async function run() {
  await new Promise((r) => setTimeout(r, 300)); // let server bind

  // health
  let res = await call('GET', '/api/health');
  ok(res.status === 200 && res.data.ok, 'health ok');
  ok(res.data.ai === 'mock', 'AI judge in mock mode (no key)');

  // signup
  res = await call('POST', '/api/auth/signup', { email: 'fighter@cert.app', name: 'Zhan', timezone: 'Asia/Almaty' });
  ok(res.status === 200 && res.data.token, 'signup returns token');
  const token = res.data.token;
  ok(res.data.user.subscribed === false, 'new user not subscribed');
  ok(!!res.data.user.referralCode, 'referral code issued');

  // duplicate email
  res = await call('POST', '/api/auth/signup', { email: 'fighter@cert.app' });
  ok(res.status === 409, 'duplicate email rejected');

  // me (authed)
  res = await call('GET', '/api/me', null, token);
  ok(res.status === 200 && res.data.user.email === 'fighter@cert.app', 'me returns user');

  // me (unauthed)
  res = await call('GET', '/api/me');
  ok(res.status === 401, 'me without token = 401');

  // subscribe
  res = await call('POST', '/api/subscribe', { plan: 'yearly' }, token);
  ok(res.status === 200 && res.data.user.subscribed === true, 'subscribe works');
  ok(res.data.user.freezes >= 1, 'welcome freeze granted');

  // create goal
  res = await call('POST', '/api/goals', { text: 'Gym 45 min daily', category: 'gym', format: 'daily', groupId: 'gym' }, token);
  ok(res.status === 200 && res.data.goal.id, 'goal created');
  const goalId = res.data.goal.id;

  // goal too short
  res = await call('POST', '/api/goals', { text: 'x' }, token);
  ok(res.status === 400, 'short goal rejected');

  // submit -> approve (forceApprove hook)
  res = await call('POST', `/api/goals/${goalId}/submit`, { photo: tinyPhoto, forceApprove: true }, token);
  ok(res.status === 200 && res.data.verdict.approved === true, 'submit approved (forced)');
  ok(res.data.goal.streak === 1, 'streak incremented to 1');

  // submit -> reject x3 -> block
  for (let i = 0; i < 3; i++) {
    res = await call('POST', `/api/goals/${goalId}/submit`, { photo: tinyPhoto, forceReject: true }, token);
  }
  ok(res.data.goal.strikes >= 3, 'three rejects = 3 strikes');
  ok(res.data.goal.blocked === true, 'blocked after 3 strikes');
  ok(res.data.goal.streak === 0, 'streak burned on block');

  // submit to a blocked goal -> 409
  res = await call('POST', `/api/goals/${goalId}/submit`, { photo: tinyPhoto, forceApprove: true }, token);
  ok(res.status === 409, 'cannot submit to blocked goal');

  // reactivate
  res = await call('POST', `/api/goals/${goalId}/reactivate`, {}, token);
  ok(res.status === 200 && res.data.goal.blocked === false, 'reactivate unblocks');
  ok(res.data.goal.strikes === 0 && res.data.goal.streak === 0, 'reactivate resets strikes, keeps streak 0');

  // anti-fraud: old photo
  res = await call('POST', `/api/goals/${goalId}/submit`, { photo: tinyPhoto, takenAt: '2020-01-01T00:00:00Z', forceApprove: true }, token);
  ok(res.status === 422, 'photo older than 24h rejected before AI');

  // freezes
  res = await call('POST', '/api/freezes/buy', { count: 3 }, token);
  ok(res.status === 200 && res.data.user.freezes >= 4, 'buy freezes adds to balance');

  res = await call('POST', `/api/goals/${goalId}/freeze`, {}, token);
  ok(res.status === 200, 'use freeze on goal');

  // groups
  res = await call('GET', '/api/groups', null, token);
  ok(res.status === 200 && res.data.groups.length === 7, 'groups catalog returns 7');
  ok(res.data.groups.find((g) => g.id === 'gym').joined === true, 'gym shows as joined');

  res = await call('POST', '/api/groups/read/join', { text: 'One chapter a day' }, token);
  ok(res.status === 200 && res.data.goal.groupId === 'read', 'join group creates goal');

  // referral
  res = await call('GET', '/api/referral', null, token);
  ok(res.status === 200 && res.data.code, 'referral link returned');

  // logout
  res = await call('POST', '/api/auth/logout', {}, token);
  ok(res.status === 200, 'logout ok');
  res = await call('GET', '/api/me', null, token);
  ok(res.status === 401, 'token invalid after logout');

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  ['', '-shm', '-wal'].forEach((s) => { try { fs.unlinkSync(TEST_DB + s); } catch (e) {} });
  process.exit(fail ? 1 : 0);
})();
