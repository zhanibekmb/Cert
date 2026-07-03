// =====================================================================
// CERT — challenge Edge Function (friend challenges). Auth required.
// Actions: create | join | board | spin. Writes use the service role so
// members can compete on a shared goal and read a cross-user leaderboard
// without loosening RLS. Joining creates a normal goal tagged challenge_id,
// reusing the existing photo → judge → streak engine. Server picks the
// wheel-of-fortune dare for last place (no reroll).
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Wheel-of-fortune dares for last place. Light, fun, group-friendly.
const DARES = [
  "Do 20 push-ups, film it, send to the group. 💪",
  "Post a goofy selfie to your story for 1 hour. 🤡",
  "Send the group a voice message singing a song chorus. 🎤",
  "Do 30 squats right now, on camera. 🏋️",
  "Set a silly profile picture for 24 hours. 🖼️",
  "Hold a 2-minute plank and film the timer. ⏱️",
  "Text someone 'I lost a bet and now I owe you a coffee'. ☕",
  "Read your last message out loud in an opera voice (voice memo). 🎭",
  "Do 15 burpees and send proof to the group. 🔥",
  "Wear your clothes inside out for an hour and send a pic. 👕",
  "Do 10 jumping jacks counting in another language. 🌍",
  "Send the group your goofiest camera-roll photo. 📸",
];

function weekKeyUTC(dayStr: string): string {
  const d = new Date(dayStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function shiftDay(dayStr: string, n: number): string {
  const d = new Date(dayStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

function genCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/L
  let c = "";
  for (let i = 0; i < 6; i++) c += alphabet[Math.floor(Math.random() * alphabet.length)];
  return c;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_body" }, 400); }
  const action = body?.action;
  const svc = createClient(SUPABASE_URL, SERVICE);

  // create a goal row for a member, mirroring the challenge's shared goal
  async function makeMemberGoal(ch: any): Promise<string | null> {
    const recurring = (ch.goal_type || "recurring") === "recurring";
    const { data: g } = await svc.from("goals").insert({
      user_id: user.id, text: ch.goal_text, category: "other",
      type: recurring ? "recurring" : "one_time",
      format: recurring ? (ch.goal_format || "daily") : null,
      duration_days: recurring ? ch.duration_days : null,
      deadline: recurring ? null : (ch.ends_at ? String(ch.ends_at).slice(0, 10) : null), // one_time: deadline date
      proof_spec_en: ch.proof_spec_en, proof_spec_ru: ch.proof_spec_ru,
      proof_type: ch.proof_type || "photo", // members inherit the challenge's proof type
      challenge_id: ch.id,
    }).select("id").single();
    return g?.id ?? null;
  }

  // ---- CREATE ----
  if (action === "create") {
    const title = String(body.title || "").trim() || "Challenge";
    const goalText = String(body.goalText || "").trim();
    const name = String(body.name || "").trim() || "Host";
    const durationDays = Math.min(60, Math.max(1, parseInt(body.durationDays) || 7));
    const goalType = body.goalType === "one_time" ? "one_time" : "recurring";
    const goalFormat = ["daily", "3x", "5x"].includes(body.goalFormat) ? body.goalFormat : "daily";
    const judgeMode = body.judgeMode === "peer" ? "peer" : "ai";
    // Timelapse proof only makes sense for AI-judged challenges (peer voting on a
    // frame reel isn't built); force photo otherwise.
    const proofType = (body.proofType === "timelapse" && judgeMode === "ai") ? "timelapse" : "photo";
    if (goalText.length < 3) return json({ error: "goal_too_short" }, 400);

    let code = genCode();
    for (let i = 0; i < 5; i++) {
      const { data: clash } = await svc.from("challenges").select("id").eq("code", code).maybeSingle();
      if (!clash) break;
      code = genCode();
    }
    // one_time challenges end at an explicit date+time; recurring ones run for N days
    let endsAt = new Date(Date.now() + durationDays * 86400000).toISOString();
    if (goalType === "one_time" && body.endsAt) {
      const dt = new Date(body.endsAt);
      if (!isNaN(dt.getTime())) endsAt = dt.toISOString();
    }
    const { data: ch, error: e1 } = await svc.from("challenges").insert({
      code, title, goal_text: goalText, duration_days: durationDays, host_user_id: user.id, ends_at: endsAt,
      goal_type: goalType, goal_format: goalFormat, judge_mode: judgeMode, proof_type: proofType,
    }).select("*").single();
    if (e1 || !ch) return json({ error: "create_failed", detail: e1?.message }, 500);

    const goalId = await makeMemberGoal(ch);
    await svc.from("challenge_members").insert({ challenge_id: ch.id, user_id: user.id, name, goal_id: goalId });
    return json({ challenge: ch });
  }

  // ---- JOIN ----
  if (action === "join") {
    const code = String(body.code || "").trim().toUpperCase();
    const name = String(body.name || "").trim() || "Player";
    if (!code) return json({ error: "missing_code" }, 400);
    const { data: ch } = await svc.from("challenges").select("*").eq("code", code).maybeSingle();
    if (!ch) return json({ error: "not_found" }, 404);

    const { data: existing } = await svc.from("challenge_members").select("id").eq("challenge_id", ch.id).eq("user_id", user.id).maybeSingle();
    if (existing) return json({ challenge: ch, already: true });
    if (ch.status !== "active") return json({ error: "challenge_ended" }, 409);

    const goalId = await makeMemberGoal(ch);
    await svc.from("challenge_members").insert({ challenge_id: ch.id, user_id: user.id, name, goal_id: goalId });
    return json({ challenge: ch });
  }

  // ---- BOARD ----
  if (action === "board") {
    const challengeId = body.challengeId;
    if (!challengeId) return json({ error: "missing_challenge" }, 400);
    const { data: ch } = await svc.from("challenges").select("*").eq("id", challengeId).maybeSingle();
    if (!ch) return json({ error: "not_found" }, 404);

    const { data: members } = await svc.from("challenge_members").select("user_id,name,goal_id,joined_at").eq("challenge_id", challengeId).order("joined_at", { ascending: true });
    const mine = (members || []).find((m: any) => m.user_id === user.id);
    if (!mine) return json({ error: "not_a_member" }, 403);

    const goalIds = (members || []).map((m: any) => m.goal_id).filter(Boolean);
    const goalsById: Record<string, any> = {};
    if (goalIds.length) {
      const { data: gs } = await svc.from("goals").select("*").in("id", goalIds);
      for (const g of gs || []) goalsById[g.id] = g;
    }
    // verified days per goal = approved submissions
    const verifiedByGoal: Record<string, number> = {};
    if (goalIds.length) {
      const { data: subs } = await svc.from("submissions").select("goal_id,status").in("goal_id", goalIds);
      for (const s of subs || []) if (s.status === "approved" || s.status === "frozen") verifiedByGoal[s.goal_id] = (verifiedByGoal[s.goal_id] || 0) + 1;
    }

    let rows = (members || []).map((m: any) => {
      const g = m.goal_id ? goalsById[m.goal_id] : null;
      return {
        userId: m.user_id, name: m.name, isMe: m.user_id === user.id,
        verifiedDays: m.goal_id ? (verifiedByGoal[m.goal_id] || 0) : 0,
        streak: g?.streak || 0, bestStreak: g?.best_streak || 0, joinedAt: m.joined_at,
      };
    });
    // rank: most verified days, then current streak, then earliest joiner
    rows.sort((a, b) => b.verifiedDays - a.verifiedDays || b.streak - a.streak || (a.joinedAt < b.joinedAt ? -1 : 1));
    rows = rows.map((r, i) => ({ ...r, rank: i + 1 }));

    const ended = ch.status === "ended" || Date.now() >= new Date(ch.ends_at).getTime();
    // lazily persist final standings so the history list can show placements
    if (ended) {
      for (const r of rows) await svc.from("challenge_members").update({ final_rank: r.rank }).eq("challenge_id", challengeId).eq("user_id", r.userId);
    }
    const last = rows.length ? rows[rows.length - 1] : null;
    const loser = ended && last ? { name: last.name, userId: last.userId, isMe: last.isMe } : null;
    const canSpin = !!(ended && loser && loser.isMe && !ch.dare && rows.length > 1);

    const myGoal = mine.goal_id ? goalsById[mine.goal_id] : null;
    // Has the requester already satisfied today / this week? (so the UI adapts)
    let doneToday = false;
    let awaitingVotes = false;
    let rejectedToday = false; // peer: a friends-declined proof today closes the day (no resubmit)
    let weekly: { quota: number; thisWeek: number; weekDone: boolean } | null = null;
    if (myGoal) {
      const { data: prof } = await svc.from("profiles").select("timezone").eq("id", user.id).maybeSingle();
      const tz = prof?.timezone || "UTC";
      const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
      if (myGoal.status === "completed") {
        doneToday = true;
      } else {
        const { data: t } = await svc.from("submissions").select("status").eq("goal_id", myGoal.id).eq("day", today);
        const approved = (t || []).some((x: any) => x.status === "approved" || x.status === "frozen");
        const pending = (t || []).some((x: any) => x.status === "pending");
        doneToday = approved || pending;
        awaitingVotes = pending;
        // In peer mode there is ONE attempt per day: a decline ends the day.
        // (AI mode keeps its own retry/attempts logic via the judge, so don't lock it here.)
        rejectedToday = ch.judge_mode === "peer" && !approved && !pending && (t || []).some((x: any) => x.status === "rejected");
      }
      if (myGoal.type === "recurring" && (myGoal.format === "3x" || myGoal.format === "5x")) {
        const quota = myGoal.format === "5x" ? 5 : 3;
        const wk = weekKeyUTC(today);
        const { data: w } = await svc.from("submissions").select("status").eq("goal_id", myGoal.id).gte("day", wk).lt("day", shiftDay(wk, 7));
        const thisWeek = (w || []).filter((x: any) => x.status === "approved" || x.status === "frozen").length;
        weekly = { quota, thisWeek, weekDone: thisWeek >= quota };
      }
    }
    // peer review: how many of others' proofs are waiting for my vote
    let pendingForMe = 0;
    if (ch.judge_mode === "peer") {
      const otherGoalIds = (members || []).filter((m: any) => m.user_id !== user.id).map((m: any) => m.goal_id).filter(Boolean);
      if (otherGoalIds.length) {
        const { data: pend } = await svc.from("submissions").select("id").in("goal_id", otherGoalIds).eq("status", "pending");
        const pendIds = (pend || []).map((p: any) => p.id);
        if (pendIds.length) {
          const { data: v } = await svc.from("challenge_votes").select("submission_id").eq("voter_id", user.id).in("submission_id", pendIds);
          const voted = new Set((v || []).map((x: any) => x.submission_id));
          pendingForMe = pendIds.filter((id: string) => !voted.has(id)).length;
        }
      }
    }
    return json({ challenge: ch, ended, members: rows, loser, dare: ch.dare || null, canSpin, myGoal, doneToday, awaitingVotes, rejectedToday, weekly, isHost: ch.host_user_id === user.id, judgeMode: ch.judge_mode, pendingForMe });
  }

  // ---- SPIN (last place only, no reroll) ----
  if (action === "spin") {
    const challengeId = body.challengeId;
    if (!challengeId) return json({ error: "missing_challenge" }, 400);
    const { data: ch } = await svc.from("challenges").select("*").eq("id", challengeId).maybeSingle();
    if (!ch) return json({ error: "not_found" }, 404);
    if (ch.dare) return json({ dare: ch.dare, already: true });

    const ended = ch.status === "ended" || Date.now() >= new Date(ch.ends_at).getTime();
    if (!ended) return json({ error: "not_ended" }, 409);

    // recompute the leaderboard to confirm the caller is genuinely last
    const { data: members } = await svc.from("challenge_members").select("user_id,name,goal_id,joined_at").eq("challenge_id", challengeId).order("joined_at", { ascending: true });
    if (!members || members.length < 2) return json({ error: "need_more_players" }, 409);
    const goalIds = members.map((m: any) => m.goal_id).filter(Boolean);
    const goalsById: Record<string, any> = {};
    if (goalIds.length) { const { data: gs } = await svc.from("goals").select("id,streak").in("id", goalIds); for (const g of gs || []) goalsById[g.id] = g; }
    const verifiedByGoal: Record<string, number> = {};
    if (goalIds.length) { const { data: subs } = await svc.from("submissions").select("goal_id,status").in("goal_id", goalIds); for (const s of subs || []) if (s.status === "approved" || s.status === "frozen") verifiedByGoal[s.goal_id] = (verifiedByGoal[s.goal_id] || 0) + 1; }
    const rows = members.map((m: any) => ({ userId: m.user_id, v: m.goal_id ? (verifiedByGoal[m.goal_id] || 0) : 0, s: m.goal_id ? (goalsById[m.goal_id]?.streak || 0) : 0, joinedAt: m.joined_at }));
    rows.sort((a, b) => b.v - a.v || b.s - a.s || (a.joinedAt < b.joinedAt ? -1 : 1));
    const last = rows[rows.length - 1];
    if (last.userId !== user.id) return json({ error: "not_last_place" }, 403);

    const dare = DARES[Math.floor(Math.random() * DARES.length)];
    await svc.from("challenges").update({ dare, loser_user_id: user.id, status: "ended" }).eq("id", challengeId).is("dare", null);
    const { data: after } = await svc.from("challenges").select("dare").eq("id", challengeId).single();
    return json({ dare: after?.dare || dare });
  }

  // ---- SUBMIT (peer challenge: upload a proof for friends to vote on) ----
  if (action === "submit") {
    const challengeId = body.challengeId; const photo = body.photo;
    if (!challengeId || !photo) return json({ error: "missing" }, 400);
    const { data: ch } = await svc.from("challenges").select("*").eq("id", challengeId).maybeSingle();
    if (!ch) return json({ error: "not_found" }, 404);
    if (ch.judge_mode !== "peer") return json({ error: "not_peer" }, 400);
    const { data: mem } = await svc.from("challenge_members").select("goal_id").eq("challenge_id", challengeId).eq("user_id", user.id).maybeSingle();
    if (!mem?.goal_id) return json({ error: "not_a_member" }, 403);
    const { data: prof } = await svc.from("profiles").select("timezone").eq("id", user.id).maybeSingle();
    const tz = prof?.timezone || "UTC";
    const day = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const { data: t } = await svc.from("submissions").select("status").eq("goal_id", mem.goal_id).eq("day", day);
    // One attempt per day in peer mode: a resolved (approved/rejected) OR pending
    // proof today closes the day. A decline does NOT let you re-submit until friends pass it.
    if ((t || []).some((x: any) => ["approved", "frozen", "pending", "rejected"].includes(x.status))) {
      const wasRejected = (t || []).some((x: any) => x.status === "rejected");
      return json({ error: wasRejected ? "rejected_today" : "already_today" }, 409);
    }
    let photoPath: string | null = null;
    try {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(String(photo));
      if (m) { const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); const ext = (m[1].split("/")[1] || "jpg").replace("jpeg", "jpg"); photoPath = `${user.id}/${mem.goal_id}/${crypto.randomUUID()}.${ext}`; await svc.storage.from("proofs").upload(photoPath, bytes, { contentType: m[1], upsert: false }); }
    } catch (_) { photoPath = null; }
    await svc.from("submissions").insert({ goal_id: mem.goal_id, user_id: user.id, day, status: "pending", photo_path: photoPath, reason: "Awaiting friends' votes" });
    return json({ ok: true });
  }

  // ---- REVIEW QUEUE (others' pending proofs across my peer challenges) ----
  if (action === "reviewQueue") {
    const { data: mems } = await svc.from("challenge_members").select("challenge_id").eq("user_id", user.id);
    const chIds = (mems || []).map((m: any) => m.challenge_id);
    if (!chIds.length) return json({ queue: [] });
    const { data: chs } = await svc.from("challenges").select("id,goal_text").in("id", chIds).eq("judge_mode", "peer");
    const peerChIds = (chs || []).map((c: any) => c.id);
    const chById: Record<string, any> = {}; for (const c of chs || []) chById[c.id] = c;
    if (!peerChIds.length) return json({ queue: [] });
    const { data: allMems } = await svc.from("challenge_members").select("challenge_id,user_id,name,goal_id").in("challenge_id", peerChIds);
    const goalInfo: Record<string, any> = {};
    for (const m of allMems || []) if (m.goal_id) goalInfo[m.goal_id] = { challengeId: m.challenge_id, name: m.name, userId: m.user_id };
    const goalIds = Object.keys(goalInfo);
    if (!goalIds.length) return json({ queue: [] });
    const { data: subs } = await svc.from("submissions").select("id,goal_id,day,photo_path,user_id").in("goal_id", goalIds).eq("status", "pending").order("created_at", { ascending: true });
    const subIds = (subs || []).map((s: any) => s.id);
    const voted = new Set<string>();
    if (subIds.length) { const { data: v } = await svc.from("challenge_votes").select("submission_id").eq("voter_id", user.id).in("submission_id", subIds); for (const x of v || []) voted.add(x.submission_id); }
    // filter out proofs from users this reviewer has blocked (UGC moderation)
    const { data: blk } = await svc.from("user_blocks").select("blocked_id").eq("blocker_id", user.id);
    const blocked = new Set((blk || []).map((b: any) => b.blocked_id));
    const queue = [];
    for (const sub of subs || []) {
      if (sub.user_id === user.id || voted.has(sub.id) || blocked.has(sub.user_id)) continue;
      const info = goalInfo[sub.goal_id]; if (!info) continue;
      let photoUrl: string | null = null;
      if (sub.photo_path) { const { data: signed } = await svc.storage.from("proofs").createSignedUrl(sub.photo_path, 3600); photoUrl = signed?.signedUrl || null; }
      queue.push({ submissionId: sub.id, userId: sub.user_id, name: info.name, goalText: chById[info.challengeId]?.goal_text || "", day: sub.day, photoUrl });
    }
    return json({ queue });
  }

  // ---- VOTE (approve/decline a friend's proof) ----
  if (action === "vote") {
    const submissionId = body.submissionId; const vote = body.vote === "approve" ? "approve" : "decline";
    if (!submissionId) return json({ error: "missing" }, 400);
    const { data: sub } = await svc.from("submissions").select("*").eq("id", submissionId).maybeSingle();
    if (!sub) return json({ error: "not_found" }, 404);
    if (sub.user_id === user.id) return json({ error: "own_submission" }, 403);
    if (sub.status !== "pending") return json({ ok: true, already: true, status: sub.status });
    const { data: goal } = await svc.from("goals").select("*").eq("id", sub.goal_id).single();
    const challengeId = goal.challenge_id;
    const { data: vm } = await svc.from("challenge_members").select("id").eq("challenge_id", challengeId).eq("user_id", user.id).maybeSingle();
    if (!vm) return json({ error: "not_a_member" }, 403);
    await svc.from("challenge_votes").upsert({ submission_id: submissionId, challenge_id: challengeId, voter_id: user.id, vote }, { onConflict: "submission_id,voter_id" });
    const { data: votes } = await svc.from("challenge_votes").select("vote").eq("submission_id", submissionId);
    const approves = (votes || []).filter((v: any) => v.vote === "approve").length;
    const declines = (votes || []).filter((v: any) => v.vote === "decline").length;
    const { count: memCount } = await svc.from("challenge_members").select("id", { count: "exact", head: true }).eq("challenge_id", challengeId);
    const others = Math.max(1, (memCount || 1) - 1);
    let status = "pending";
    if (approves >= 1) status = "approved";
    else if (declines >= others) status = "rejected";
    if (status === "approved") {
      const { data: appr } = await svc.from("submissions").select("id").eq("goal_id", sub.goal_id).eq("status", "approved");
      const verified = (appr?.length || 0) + 1;
      await svc.from("submissions").update({ status: "approved", reason: "Approved by friends" }).eq("id", submissionId);
      await svc.from("goals").update({ streak: verified, best_streak: Math.max(verified, goal.best_streak || 0) }).eq("id", sub.goal_id);
    } else if (status === "rejected") {
      await svc.from("submissions").update({ status: "rejected", reason: "Declined by friends" }).eq("id", submissionId);
    }
    return json({ ok: true, status });
  }

  // ---- END (host ends the challenge early) ----
  if (action === "end") {
    const challengeId = body.challengeId;
    if (!challengeId) return json({ error: "missing_challenge" }, 400);
    const { data: ch } = await svc.from("challenges").select("host_user_id,status").eq("id", challengeId).maybeSingle();
    if (!ch) return json({ error: "not_found" }, 404);
    if (ch.host_user_id !== user.id) return json({ error: "not_host" }, 403);
    if (ch.status === "ended") return json({ ok: true, already: true });
    await svc.from("challenges").update({ status: "ended", ends_at: new Date().toISOString() }).eq("id", challengeId);
    return json({ ok: true });
  }

  // ---- BLOCK (hide an abusive user's proofs from my review queue) ----
  if (action === "block") {
    const blockedId = body.blockedUserId;
    if (!blockedId || blockedId === user.id) return json({ error: "bad_target" }, 400);
    await svc.from("user_blocks").upsert({ blocker_id: user.id, blocked_id: blockedId }, { onConflict: "blocker_id,blocked_id" });
    return json({ ok: true });
  }

  // ---- REPORT (flag objectionable proof content for manual review) ----
  if (action === "report") {
    await svc.from("content_reports").insert({
      reporter_id: user.id,
      reported_user_id: body.reportedUserId || null,
      submission_id: body.submissionId || null,
      challenge_id: body.challengeId || null,
      reason: String(body.reason || "").slice(0, 500),
    });
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
