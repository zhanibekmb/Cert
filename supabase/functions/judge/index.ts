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
const PAID_DAILY_ATTEMPTS = 2;   // 2 tries a day for everyone — keeps the streak honest
const MILESTONES = [7, 30, 100]; // streak thresholds that mint a shareable badge
// Geo anti-cheat: a submission far from the goal's anchor (its first approved
// location) is flagged, never auto-rejected — GPS drifts indoors and people
// travel. Generous on purpose: within-city moves must never trip it.
const GEO_MISMATCH_KM = 50;
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
function buildJudgePrompt(goalText: string, proofSpec?: string, dailyReq?: string, reasonLang = "English"): string {
  const lines = [
    "You are a FRIENDLY, GENEROUS AI judge for a habit app called Cert. Your job is to ENCOURAGE people who showed up, not to fail them on technicalities. Default to APPROVE — when in doubt, approve.",
    `User goal: "${goalText}"`,
    proofSpec ? `What the user was asked to show (treat as a loose hint, not a strict checklist): "${proofSpec}"` : `Guideline: a photo that plausibly relates to the goal.`,
    "APPROVE if the photo plausibly relates to the goal. The user shoots solo, one-handed, with no timer, and often has NO special equipment, mat, gym gear, or ideal location — never require any of those. A setup, a scene, a result, an aftermath, or simply the user near anything relevant all count as proof. Be very forgiving about angle, lighting, framing, distance and image quality.",
    "ONLY reject when it is OBVIOUS the photo is one of: a completely unrelated/different activity, blank or black, a screenshot, a meme, a stock/internet image, or clearly faked. A borderline, messy, or imperfect but genuine attempt MUST be approved.",
  ];
  if (dailyReq) lines.push(`Freshness check (anti-cheat): the photo should also show "${dailyReq}". If the required fingers are present in ANY clear form, accept. Only reject for this if the fingers are plainly absent — and then explain kindly what to add.`);
  lines.push(`Respond with ONLY a JSON object: {"approved": true|false, "reason": "<short, kind, written in ${reasonLang}>", "confidence": <0..1>}.`);
  return lines.join("\n");
}
function buildTimelapsePrompt(goalText: string, proofSpec?: string, reasonLang = "English"): string {
  return [
    "You are a FRIENDLY, GENEROUS AI judge for a habit app called Cert. You are shown SEVERAL FRAMES captured a few seconds apart as a TIMELAPSE of the user's session. Judge whether they show the user genuinely DOING the goal over time. Default to APPROVE — when in doubt, approve.",
    `User goal: "${goalText}"`,
    proofSpec ? `Loose hint of what doing it looks like (not a strict checklist): "${proofSpec}"` : "",
    "APPROVE if the frames plausibly show the activity happening across time: progress, movement, change, or sustained presence at the activity. The user shoots solo with no special equipment or ideal location — never require any of those. Be forgiving about angle, lighting, framing, distance and quality.",
    "ONLY reject if it is OBVIOUS the timelapse is faked or invalid: every frame is identical/static (a propped single photo, not a real session), a completely unrelated activity, blank/black frames, a screen recording, a stock/internet clip, or clearly staged. A messy but genuine real attempt MUST be approved.",
    `Respond with ONLY a JSON object: {"approved": true|false, "reason": "<short, kind, written in ${reasonLang}>", "confidence": <0..1>}.`,
  ].filter(Boolean).join("\n");
}
async function judgeTimelapse(opts: { frames: string[]; goalText: string; proofSpec?: string; reasonLang?: string }) {
  const parts: any[] = [{ text: `Judge this timelapse of ${opts.frames.length} frames (in order). Reply with ONLY the JSON object.` }];
  for (const f of opts.frames) { const img = parseImage(f); parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } }); }
  const data = await geminiCall({
    system_instruction: { parts: [{ text: buildTimelapsePrompt(opts.goalText, opts.proofSpec, opts.reasonLang) }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024, temperature: 0.3 },
  });
  const p = parseJsonLoose(extractText(data));
  if (!p) throw new Error("no parseable verdict");
  return { approved: !!p.approved, reason: String(p.reason || (p.approved ? "Session confirmed." : "Not proven.")).slice(0, 200), confidence: typeof p.confidence === "number" ? p.confidence : (p.approved ? 0.8 : 0.3) };
}
function buildVideoPrompt(goalText: string, proofSpec?: string, reasonLang = "English"): string {
  return [
    "You are a FRIENDLY, GENEROUS AI judge for a habit app called Cert. You are shown a SHORT VIDEO CLIP the user just recorded as proof of their goal. Watch the whole clip and judge whether it genuinely shows them DOING the goal. Default to APPROVE — when in doubt, approve.",
    `User goal: "${goalText}"`,
    proofSpec ? `Loose hint of what doing it looks like (not a strict checklist): "${proofSpec}"` : "",
    "APPROVE if the clip plausibly shows the activity actually happening: real motion, a real scene, the person present and doing something related to the goal. The user shoots solo, handheld, with no special equipment or ideal location — never require any of those. Be forgiving about angle, lighting, framing, shakiness and quality.",
    "ONLY reject if it is OBVIOUS the video is faked or invalid: it plays another video/screen (a recording of a phone or monitor), is a completely unrelated activity, is blank/black, is a still photo panned across with no real motion, or is clearly staged to fake the goal. A messy but genuine real attempt MUST be approved.",
    `Respond with ONLY a JSON object: {"approved": true|false, "reason": "<short, kind, written in ${reasonLang}>", "confidence": <0..1>}.`,
  ].filter(Boolean).join("\n");
}
async function judgeVideo(opts: { video: string; goalText: string; proofSpec?: string; reasonLang?: string }) {
  const v = parseImage(opts.video); // same data:<mime>;base64,<data> shape as a photo
  const data = await geminiCall({
    system_instruction: { parts: [{ text: buildVideoPrompt(opts.goalText, opts.proofSpec, opts.reasonLang) }] },
    contents: [{ role: "user", parts: [{ text: "Judge this video clip. Reply with ONLY the JSON object." }, { inline_data: { mime_type: v.mimeType, data: v.data } }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024, temperature: 0.3 },
  });
  const p = parseJsonLoose(extractText(data));
  if (!p) throw new Error("no parseable verdict");
  return { approved: !!p.approved, reason: String(p.reason || (p.approved ? "Session confirmed." : "Not proven.")).slice(0, 200), confidence: typeof p.confidence === "number" ? p.confidence : (p.approved ? 0.8 : 0.3) };
}
async function judgePhoto(opts: { photo: string; goalText: string; proofSpec?: string; dailyReq?: string; reasonLang?: string }) {
  const img = parseImage(opts.photo);
  const data = await geminiCall({
    system_instruction: { parts: [{ text: buildJudgePrompt(opts.goalText, opts.proofSpec, opts.dailyReq, opts.reasonLang) }] },
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
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
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
  const { goalId, photo, frames, video, geo, forceReject, peek, lang } = body || {};
  const reasonLang = lang === "ru" ? "Russian" : "English"; // verdict reason language
  const isVideo = typeof video === "string" && video.length > 0;   // real recorded clip
  const isTimelapse = Array.isArray(frames) && frames.length > 0;   // legacy frame-based
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

  // Geo check-in goals: the proof is BEING at the goal's pinned place (within
  // its radius) — no photo, no Gemini. The place locks on the first check-in
  // if it wasn't pinned at creation.
  const isGeo = goal.proof_type === "geo";

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
  // optional window start ("be there FROM 19:00") — mainly for geo check-ins
  const windowStart = goal.daily_start ? String(goal.daily_start) : null;
  const beforeStart = !!windowStart && localHHMM(tz) < windowStart;

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
    // geo rejects can't be appealed (the appeal reviewer re-judges a photo,
    // and a check-in has none) — hide the appeal path for geo goals.
    if (isGeo && lastReject) lastReject = { ...lastReject, submissionId: null as any };
    return json({ dailyReq: daily, day, attemptsLeft, done, lastReject, deadline, pastDeadline, windowStart, beforeStart, scheduledToday, isGeo, geoAnchorSet: isGeo ? (goal.geo_lat != null && goal.geo_lng != null) : undefined, geoPlace: goal.geo_place || null, weekly: isWeekly ? { quota, thisWeek: weekApprovedBefore, weekDone: weekDoneBefore } : null });
  }

  if (goal.status !== "active") return json({ error: "goal_not_active" }, 409);
  if (!isGeo && !photo && !isTimelapse && !isVideo) return json({ error: "missing_photo" }, 400);
  if (!scheduledToday) return json({ error: "not_scheduled_today" }, 409);
  if (done) return json({ error: "already_done_today" }, 409);
  if (weekDoneBefore) return json({ error: "week_done", quota }, 409);
  if (beforeStart) return json({ error: "before_start", windowStart }, 409);
  if (pastDeadline) return json({ error: "past_deadline", deadline }, 409);
  if ((todays?.length || 0) >= limit) return json({ error: "no_checks_left", limit }, 429);

  const fmtDist = (km: number) => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  let verdict;
  if (forceReject) {
    verdict = { approved: false, reason: "Demo: forced reject.", confidence: 0.3 };
  } else if (isGeo) {
    if (geoLat === null || geoLng === null) return json({ error: "no_location" }, 400);
    const ru = lang === "ru";
    if (geo && geo.mocked === true) {
      // Android reports mock-location providers — a faked GPS never counts.
      verdict = { approved: false, reason: ru ? "Похоже на подменённые координаты (fake GPS). Выключи подмену и попробуй снова." : "This looks like mocked GPS. Turn off fake location and try again.", confidence: 0.2 };
    } else if (goal.geo_lat == null || goal.geo_lng == null) {
      // first check-in pins the goal's place
      await svc.from("goals").update({ geo_lat: geoLat, geo_lng: geoLng, geo_place: geoPlace }).eq("id", goalId);
      verdict = { approved: true, reason: ru ? `Место зафиксировано${geoPlace ? ": " + geoPlace : ""}. Теперь отмечайся отсюда.` : `Place pinned${geoPlace ? ": " + geoPlace : ""}. Check in from here from now on.`, confidence: 0.95 };
    } else {
      const km = haversineKm(goal.geo_lat, goal.geo_lng, geoLat, geoLng);
      const radiusKm = (goal.geo_radius_m || 200) / 1000;
      verdict = km <= radiusKm
        ? { approved: true, reason: ru ? `Ты на месте${goal.geo_place ? " — " + goal.geo_place : ""}. Засчитано.` : `You're at the spot${goal.geo_place ? " — " + goal.geo_place : ""}. Counted.`, confidence: 0.95 }
        : { approved: false, reason: ru ? `Ты в ${fmtDist(km)} от места цели. Приди туда и отметься снова.` : `You're ${fmtDist(km)} away from the goal's place. Get there and check in again.`, confidence: 0.9 };
    }
  } else if (isVideo) {
    try { verdict = await judgeVideo({ video, goalText: goal.text, proofSpec: (lang === "ru" ? goal.proof_spec_ru : goal.proof_spec_en) || goal.proof_spec_en, reasonLang }); }
    catch (_e) { return json({ error: true, busy: true, reason: "The judge is busy right now — please try again in a moment." }); }
  } else if (isTimelapse) {
    try { verdict = await judgeTimelapse({ frames, goalText: goal.text, proofSpec: (lang === "ru" ? goal.proof_spec_ru : goal.proof_spec_en) || goal.proof_spec_en, reasonLang }); }
    catch (_e) { return json({ error: true, busy: true, reason: "The judge is busy right now — please try again in a moment." }); }
  } else {
    try { verdict = await judgePhoto({ photo, goalText: goal.text, proofSpec: (lang === "ru" ? goal.proof_spec_ru : goal.proof_spec_en) || goal.proof_spec_en, dailyReq: daily.en, reasonLang }); }
    catch (_e) { return json({ error: true, busy: true, reason: "The judge is busy right now — please try again in a moment." }); }
  }

  // Store the proof. A video is one clip; a legacy timelapse is many frames
  // under one folder; a photo is one image. photo_path points at the first file.
  let photoPath: string | null = null;
  try {
    const imgs: string[] = isVideo ? [video] : isTimelapse ? frames : (photo ? [photo] : []);
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

  // Geo anti-cheat signal — additive to the AI verdict, never a substitute.
  // Compare against the anchor (the goal's first approved submission with geo);
  // a big mismatch lowers stored confidence + flags the row for review/appeal
  // tooling, but NEVER flips an approval.
  let geoSuspect = false;
  if (!isGeo && geoLat !== null && geoLng !== null) {
    const { data: anchor } = await svc.from("submissions").select("lat,lng")
      .eq("goal_id", goalId).in("status", ["approved", "frozen"]).not("lat", "is", null)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (anchor && typeof anchor.lat === "number" && typeof anchor.lng === "number") {
      const km = haversineKm(anchor.lat, anchor.lng, geoLat, geoLng);
      if (km > GEO_MISMATCH_KM) {
        geoSuspect = true;
        verdict.confidence = Math.min(typeof verdict.confidence === "number" ? verdict.confidence : 0.8, 0.5);
      }
    }
  }

  const streakBefore = goal.streak || 0;
  let newStreak = streakBefore, newBest = goal.best_streak || 0, newStatus = goal.status, completedAt: string | null = null;
  // Eternal counter — verified days NEVER reset (cushions the streak reset).
  const newVerified = (goal.verified_days_total || 0) + (verdict.approved ? 1 : 0);
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
    // Personal weekly goals complete when the week-streak reaches the target
    // (duration_days holds weeks for weekly goals). Challenge goals end by date.
    if (!goal.challenge_id && goal.duration_days && newStreak >= goal.duration_days) {
      newStatus = "completed"; completedAt = new Date().toISOString();
    }
  } else if (verdict.approved) {
    newStreak = streakBefore + 1;
    if (newStreak > newBest) newBest = newStreak;
    if (goal.type === "one_time") { newStatus = "completed"; completedAt = new Date().toISOString(); }
    else if (goal.duration_days && newStreak >= goal.duration_days) { newStatus = "completed"; completedAt = new Date().toISOString(); }
  } else {
    // A reject does NOT break the streak while attempts remain — the user can
    // retry today. A day truly ends unsatisfied only at the nightly sweep,
    // which resets the streak (or spends a freeze) for the whole ended day.
    newStreak = streakBefore;
  }

  const { data: sub } = await svc.from("submissions").insert({
    goal_id: goalId, user_id: user.id, day, status: verdict.approved ? "approved" : "rejected",
    reason: verdict.reason, confidence: verdict.confidence, photo_path: photoPath, streak_before: streakBefore,
    lat: geoLat, lng: geoLng, place: geoPlace, geo_suspect: geoSuspect,
  }).select("id").single();
  await svc.from("goals").update({ streak: newStreak, best_streak: newBest, status: newStatus, completed_at: completedAt, verified_days_total: newVerified }).eq("id", goalId);
  if (newStatus === "completed") await svc.from("certs").insert({ user_id: user.id, goal_id: goalId, title: goal.text, days: newBest });

  const { data: updatedGoal } = await svc.from("goals").select("*").eq("id", goalId).single();
  // attempts left TODAY after this one (both free and paid plans are capped).
  const attemptsLeftAfter = Math.max(0, limit - ((todays?.length || 0) + 1));
  // milestone crossed? (daily streaks only — weekly streaks count weeks, not days)
  const milestone = !isWeekly && verdict.approved && MILESTONES.includes(newStreak) ? newStreak : null;
  const thisWeekAfter = weekApprovedBefore + (verdict.approved ? 1 : 0);
  const weekly = isWeekly ? { quota, thisWeek: thisWeekAfter, weekDone: thisWeekAfter >= quota } : null;
  // geo rejects aren't appealable (no photo for the appeal reviewer to re-judge)
  const submissionId = isGeo && !verdict.approved ? null : sub?.id;
  return json({ verdict, goal: updatedGoal, completed: newStatus === "completed", dailyReq: daily, submissionId, attemptsLeft: attemptsLeftAfter, milestone, weekly, geoSuspect });
});
