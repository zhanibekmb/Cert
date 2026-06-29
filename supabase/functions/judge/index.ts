// =====================================================================
// CERT — judge Edge Function (self-contained, paste-deploy ready).
// Server-authoritative: verifies the user, judges the photo with Gemini,
// then records the submission + updates the streak + mints a Cert on
// completion. Clients can't fake a verdict. Auth required (verify_jwt).
// Needs the GEMINI_API_KEY secret. SUPABASE_* are injected automatically.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const KEY = () => Deno.env.get("GEMINI_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FREE_DAILY_ATTEMPTS = 2;
const PAID_DAILY_ATTEMPTS = 5;   // subscribers get more tries, but not unlimited
const MILESTONES = [7, 30, 100]; // streak thresholds that mint a shareable badge
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function todayFor(tz: string): string {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: tz || "UTC" }); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function extractText(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts) return "";
  for (const p of parts) if (p && typeof p.text === "string" && p.text.trim()) return p.text;
  return "";
}
function parseJsonLoose(text: string): any {
  if (!text) return null;
  let t = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (_) { /* */ }
  const obj = /\{[\s\S]*\}/.exec(t);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) { /* */ } }
  return null;
}
async function geminiCall(body: unknown): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY() }, body: JSON.stringify(body) });
    } catch (e) { lastErr = e; await sleep(600 * (attempt + 1)); continue; }
    if (r.ok) return await r.json();
    if (r.status === 503 || r.status === 429 || r.status === 500) { lastErr = new Error(`Gemini ${r.status}`); await sleep(700 * (attempt + 1)); continue; }
    throw new Error(`Gemini ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  }
  throw lastErr || new Error("Gemini call failed");
}
function parseImage(photo: string): { mimeType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(photo));
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: "image/jpeg", data: String(photo).replace(/^data:[^,]*,/, "") };
}
// Anti-replay token built from things you ALWAYS have on you — works anywhere
// (street, gym, home), one-handed, no props, no timer. Freshness comes from the
// finger count, which rotates daily, so an old photo can't satisfy today's token.
function dailyRequirement(day: string, goalId: string): { en: string; ru: string } {
  let h = 0; const s = day + "|" + goalId;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  h = Math.abs(h);
  const n = (h % 4) + 2;                       // 2..5 fingers, changes every day
  const fw = n < 5 ? "пальца" : "пальцев";
  return { en: `With your free hand, hold up ${n} fingers somewhere in the frame.`, ru: `Свободной рукой покажи ${n} ${fw} где-нибудь в кадре.` };
}
function buildJudgePrompt(goalText: string, proofSpec?: string, dailyReq?: string): string {
  const lines = [
    "You are a FRIENDLY, GENEROUS AI judge for a habit app called Cert. Your job is to ENCOURAGE people who showed up, not to fail them on technicalities. Default to APPROVE — when in doubt, approve.",
    `User goal: "${goalText}"`,
    proofSpec ? `What the user was asked to show (treat as a loose hint, not a strict checklist): "${proofSpec}"` : `Guideline: a photo that plausibly relates to the goal.`,
    "APPROVE if the photo plausibly relates to the goal. The user shoots solo, one-handed, with no timer, and often has NO special equipment, mat, gym gear, or ideal location — never require any of those. A setup, a scene, a result, an aftermath, or simply the user near anything relevant all count as proof. Be very forgiving about angle, lighting, framing, distance and image quality.",
    "ONLY reject when it is OBVIOUS the photo is one of: a completely unrelated/different activity, blank or black, a screenshot, a meme, a stock/internet image, or clearly faked. A borderline, messy, or imperfect but genuine attempt MUST be approved.",
  ];
  if (dailyReq) lines.push(`Freshness check (anti-cheat): the photo should also show "${dailyReq}". If the required fingers are present in ANY clear form, accept. Only reject for this if the fingers are plainly absent — and then explain kindly what to add.`);
  lines.push('Respond with ONLY a JSON object: {"approved": true|false, "reason": "<short, kind, in the user goal\'s language>", "confidence": <0..1>}.');
  return lines.join("\n");
}
function buildTimelapsePrompt(goalText: string, proofSpec?: string): string {
  return [
    "You are a FRIENDLY, GENEROUS AI judge for a habit app called Cert. You are shown SEVERAL FRAMES captured a few seconds apart as a TIMELAPSE of the user's session. Judge whether they show the user genuinely DOING the goal over time. Default to APPROVE — when in doubt, approve.",
    `User goal: "${goalText}"`,
    proofSpec ? `Loose hint of what doing it looks like (not a strict checklist): "${proofSpec}"` : "",
    "APPROVE if the frames plausibly show the activity happening across time: progress, movement, change, or sustained presence at the activity. The user shoots solo with no special equipment or ideal location — never require any of those. Be forgiving about angle, lighting, framing, distance and quality.",
    "ONLY reject if it is OBVIOUS the timelapse is faked or invalid: every frame is identical/static (a propped single photo, not a real session), a completely unrelated activity, blank/black frames, a screen recording, a stock/internet clip, or clearly staged. A messy but genuine real attempt MUST be approved.",
    'Respond with ONLY a JSON object: {"approved": true|false, "reason": "<short, kind, in the user goal\'s language>", "confidence": <0..1>}.',
  ].filter(Boolean).join("\n");
}
async function judgeTimelapse(opts: { frames: string[]; goalText: string; proofSpec?: string }) {
  const parts: any[] = [{ text: `Judge this timelapse of ${opts.frames.length} frames (in order). Reply with ONLY the JSON object.` }];
  for (const f of opts.frames) { const img = parseImage(f); parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } }); }
  const data = await geminiCall({
    system_instruction: { parts: [{ text: buildTimelapsePrompt(opts.goalText, opts.proofSpec) }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024, temperature: 0.3 },
  });
  const p = parseJsonLoose(extractText(data));
  if (!p) throw new Error("no parseable verdict");
  return { approved: !!p.approved, reason: String(p.reason || (p.approved ? "Session confirmed." : "Not proven.")).slice(0, 200), confidence: typeof p.confidence === "number" ? p.confidence : (p.approved ? 0.8 : 0.3) };
}
async function judgePhoto(opts: { photo: string; goalText: string; proofSpec?: string; dailyReq?: string }) {
  const img = parseImage(opts.photo);
  const data = await geminiCall({
    system_instruction: { parts: [{ text: buildJudgePrompt(opts.goalText, opts.proofSpec, opts.dailyReq) }] },
    contents: [{ role: "user", parts: [{ text: "Judge this photo. Reply with ONLY the JSON object." }, { inline_data: { mime_type: img.mimeType, data: img.data } }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024, temperature: 0.3 },
  });
  const p = parseJsonLoose(extractText(data));
  if (!p) throw new Error("no parseable verdict");
  return { approved: !!p.approved, reason: String(p.reason || (p.approved ? "Goal confirmed." : "Goal not proven.")).slice(0, 200), confidence: typeof p.confidence === "number" ? p.confidence : (p.approved ? 0.8 : 0.3) };
}

// ---- weekly-cadence helpers (3×/5× per week) ----
function weekKeyUTC(dayStr: string): string {
  const d = new Date(dayStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;           // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);           // the week's Monday
}
function shiftDay(dayStr: string, n: number): string {
  const d = new Date(dayStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function weeklyQuota(format: string | null): number { return format === "5x" ? 5 : 3; }
function localHHMM(tz: string): string {
  try { return new Date().toLocaleTimeString("en-GB", { timeZone: tz || "UTC", hour12: false, hour: "2-digit", minute: "2-digit" }); }
  catch { return new Date().toISOString().slice(11, 16); }
}
// consecutive weeks that met quota, ending at the current (or last completed) week
function consecutiveWeeks(approvedDays: string[], quota: number, currentWeek: string): number {
  const counts: Record<string, number> = {};
  for (const day of approvedDays) { const k = weekKeyUTC(day); counts[k] = (counts[k] || 0) + 1; }
  let cursor = currentWeek;
  if ((counts[cursor] || 0) < quota) cursor = shiftDay(currentWeek, -7); // this week still in progress
  let streak = 0;
  while ((counts[cursor] || 0) >= quota) { streak++; cursor = shiftDay(cursor, -7); }
  return streak;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_body" }, 400); }
  const { goalId, photo, frames, geo, forceReject, peek } = body || {};
  const isTimelapse = Array.isArray(frames) && frames.length > 0;
  const geoLat = geo && typeof geo.lat === "number" ? geo.lat : null;
  const geoLng = geo && typeof geo.lng === "number" ? geo.lng : null;
  const geoPlace = geo && geo.place ? String(geo.place).slice(0, 120) : null;
  if (!goalId) return json({ error: "missing_goal" }, 400);

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const svc = createClient(SUPABASE_URL, SERVICE);
  const { data: goal } = await svc.from("goals").select("*").eq("id", goalId).single();
  if (!goal || goal.user_id !== user.id) return json({ error: "not_found" }, 404);

  const { data: profile } = await svc.from("profiles").select("plan,timezone").eq("id", user.id).single();
  const tz = profile?.timezone || "UTC";
  const paid = profile?.plan === "monthly" || profile?.plan === "yearly";
  const limit = paid ? PAID_DAILY_ATTEMPTS : FREE_DAILY_ATTEMPTS;
  const day = todayFor(tz);
  const daily = dailyRequirement(day, goalId);

  const { data: todays } = await svc.from("submissions").select("id,status,reason,created_at").eq("goal_id", goalId).eq("day", day).order("created_at", { ascending: true });
  const done = (todays || []).some((s: any) => s.status === "approved" || s.status === "frozen");
  const attemptsLeft = Math.max(0, limit - (todays?.length || 0));

  // weekly cadence (3×/5× per week, or custom weekdays): track this week's count
  const isCustom = goal.type === "recurring" && goal.format === "custom";
  const customDays: number[] = Array.isArray(goal.custom_days) ? goal.custom_days : [];
  const isWeekly = goal.type === "recurring" && (goal.format === "3x" || goal.format === "5x" || isCustom);
  const quota = isCustom ? (customDays.length || 1) : weeklyQuota(goal.format);
  const wkKey = weekKeyUTC(day);
  const todayDow = (new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const scheduledToday = !isCustom || customDays.includes(todayDow);
  let weekApprovedBefore = 0;
  if (isWeekly) {
    const { data: wk } = await svc.from("submissions").select("status").eq("goal_id", goalId).gte("day", wkKey).lt("day", shiftDay(wkKey, 7));
    weekApprovedBefore = (wk || []).filter((x: any) => x.status === "approved" || x.status === "frozen").length;
  }
  const weekDoneBefore = isWeekly && weekApprovedBefore >= quota;

  // optional time-of-day deadline (e.g. "07:00" = must submit before 7am local)
  const deadline = goal.type === "recurring" && goal.daily_deadline ? String(goal.daily_deadline) : null;
  const pastDeadline = !!deadline && localHHMM(tz) > deadline;

  // PEEK: the Submit screen asks, before shooting, for today's anti-cheat check,
  // how many attempts remain, and the last un-appealed rejection (so it can open
  // the appeal screen straight away when attempts are used up).
  if (peek) {
    let lastReject: { submissionId: string; reason: string } | null = null;
    if (!done) {
      const rejects = (todays || []).filter((s: any) => s.status === "rejected");
      const last = rejects[rejects.length - 1];
      if (last) {
        const { data: ap } = await svc.from("appeals").select("id").eq("submission_id", last.id).maybeSingle();
        if (!ap) lastReject = { submissionId: last.id, reason: last.reason || "Not approved." };
      }
    }
    return json({ dailyReq: daily, day, attemptsLeft, done, lastReject, deadline, pastDeadline, scheduledToday, weekly: isWeekly ? { quota, thisWeek: weekApprovedBefore, weekDone: weekDoneBefore } : null });
  }

  if (goal.status !== "active") return json({ error: "goal_not_active" }, 409);
  if (!photo && !isTimelapse) return json({ error: "missing_photo" }, 400);
  if (!scheduledToday) return json({ error: "not_scheduled_today" }, 409);
  if (done) return json({ error: "already_done_today" }, 409);
  if (weekDoneBefore) return json({ error: "week_done", quota }, 409);
  if (pastDeadline) return json({ error: "past_deadline", deadline }, 409);
  if ((todays?.length || 0) >= limit) return json({ error: "no_checks_left", limit }, 429);

  let verdict;
  if (forceReject) {
    verdict = { approved: false, reason: "Demo: forced reject.", confidence: 0.3 };
  } else if (isTimelapse) {
    try { verdict = await judgeTimelapse({ frames, goalText: goal.text, proofSpec: goal.proof_spec_en }); }
    catch (_e) { return json({ error: true, busy: true, reason: "The judge is busy right now — please try again in a moment." }); }
  } else {
    try { verdict = await judgePhoto({ photo, goalText: goal.text, proofSpec: goal.proof_spec_en, dailyReq: daily.en }); }
    catch (_e) { return json({ error: true, busy: true, reason: "The judge is busy right now — please try again in a moment." }); }
  }

  // Store the proof. For a timelapse we keep every frame under one folder and
  // point photo_path at the first frame (the cover); a single photo is just one.
  let photoPath: string | null = null;
  try {
    const imgs: string[] = isTimelapse ? frames : (photo ? [photo] : []);
    const folder = crypto.randomUUID();
    for (let i = 0; i < imgs.length; i++) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(String(imgs[i]));
      if (!m) continue;
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      const ext = (m[1].split("/")[1] || "jpg").replace("jpeg", "jpg");
      const path = `${user.id}/${goalId}/${folder}/${i}.${ext}`;
      await svc.storage.from("proofs").upload(path, bytes, { contentType: m[1], upsert: false });
      if (i === 0) photoPath = path;
    }
  } catch (_) { /* keep whatever uploaded */ }

  const streakBefore = goal.streak || 0;
  let newStreak = streakBefore, newBest = goal.best_streak || 0, newStatus = goal.status, completedAt: string | null = null;
  if (isWeekly) {
    // weekly streak = consecutive weeks meeting quota; a single reject doesn't break it
    if (verdict.approved) {
      const { data: all } = await svc.from("submissions").select("day,status").eq("goal_id", goalId);
      const approvedDays = (all || []).filter((x: any) => x.status === "approved" || x.status === "frozen").map((x: any) => x.day);
      approvedDays.push(day);
      newStreak = consecutiveWeeks(approvedDays, quota, wkKey);
    } else {
      newStreak = streakBefore;
    }
    if (newStreak > newBest) newBest = newStreak;
    // weekly challenge goals end by date, not by a streak target — no auto-complete
  } else if (verdict.approved) {
    newStreak = streakBefore + 1;
    if (newStreak > newBest) newBest = newStreak;
    if (goal.type === "one_time") { newStatus = "completed"; completedAt = new Date().toISOString(); }
    else if (goal.duration_days && newStreak >= goal.duration_days) { newStatus = "completed"; completedAt = new Date().toISOString(); }
  } else { newStreak = 0; }

  const { data: sub } = await svc.from("submissions").insert({
    goal_id: goalId, user_id: user.id, day, status: verdict.approved ? "approved" : "rejected",
    reason: verdict.reason, confidence: verdict.confidence, photo_path: photoPath, streak_before: streakBefore,
    lat: geoLat, lng: geoLng, place: geoPlace,
  }).select("id").single();
  await svc.from("goals").update({ streak: newStreak, best_streak: newBest, status: newStatus, completed_at: completedAt }).eq("id", goalId);
  if (newStatus === "completed") await svc.from("certs").insert({ user_id: user.id, goal_id: goalId, title: goal.text, days: newBest });

  const { data: updatedGoal } = await svc.from("goals").select("*").eq("id", goalId).single();
  // attempts left TODAY after this one (both free and paid plans are capped).
  const attemptsLeftAfter = Math.max(0, limit - ((todays?.length || 0) + 1));
  // milestone crossed? (daily streaks only — weekly streaks count weeks, not days)
  const milestone = !isWeekly && verdict.approved && MILESTONES.includes(newStreak) ? newStreak : null;
  const thisWeekAfter = weekApprovedBefore + (verdict.approved ? 1 : 0);
  const weekly = isWeekly ? { quota, thisWeek: thisWeekAfter, weekDone: thisWeekAfter >= quota } : null;
  return json({ verdict, goal: updatedGoal, completed: newStatus === "completed", dailyReq: daily, submissionId: sub?.id, attemptsLeft: attemptsLeftAfter, milestone, weekly });
});
