// =====================================================================
// CERT — appeal Edge Function (self-contained, paste-deploy ready).
// A rejected submission gets ONE appeal: a second, more generous look by
// the same AI judge, this time WITH the user's written explanation. On
// approval the streak is restored (the day counts). Server-authoritative.
// Needs GEMINI_API_KEY. SUPABASE_* are injected automatically.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Where DENIED appeals are emailed for a manual second look, and the verified
// Resend sender. Best-effort: a missing key or a send failure never blocks the
// user's appeal response.
const APPEAL_NOTIFY_TO = Deno.env.get("APPEAL_NOTIFY_TO") || "zhanibek@certapp.pro";
const RESEND_FROM = Deno.env.get("RESEND_FROM") || "Cert <noreply@certapp.pro>";
const RESEND_API_KEY = () => Deno.env.get("RESEND_API_KEY") || "";

function esc(s: string): string {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}
async function emailDeniedAppeal(opts: {
  userId: string; goalText: string; note: string; firstReason: string; appealReason: string;
  submissionId: string; photoUrl: string | null;
}): Promise<void> {
  const apiKey = RESEND_API_KEY();
  if (!apiKey) return; // not configured — skip silently
  const html = [
    `<h2>Appeal denied — manual review</h2>`,
    `<p><b>User:</b> ${esc(opts.userId)}</p>`,
    `<p><b>Goal:</b> ${esc(opts.goalText)}</p>`,
    `<p><b>User's explanation:</b> ${esc(opts.note) || "<i>(none)</i>"}</p>`,
    `<p><b>First-pass rejection:</b> ${esc(opts.firstReason) || "<i>(none)</i>"}</p>`,
    `<p><b>Appeal verdict:</b> ${esc(opts.appealReason) || "<i>(none)</i>"}</p>`,
    `<p><b>Submission:</b> ${esc(opts.submissionId)}</p>`,
    opts.photoUrl ? `<p><a href="${esc(opts.photoUrl)}">View the proof photo</a> (link valid ~7 days)</p>` : `<p><i>No stored photo.</i></p>`,
  ].join("\n");
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [APPEAL_NOTIFY_TO], subject: "Cert — appeal denied (manual review)", html }),
    });
  } catch (_) { /* best-effort; never block the user */ }
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
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// Daily anti-replay token — kept in sync with the judge function.
function dailyRequirement(day: string, goalId: string): string {
  let h = 0; const s = day + "|" + goalId;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  h = Math.abs(h);
  const n = (h % 4) + 2;
  return `With your free hand, hold up ${n} fingers somewhere in the frame.`;
}

function buildAppealPrompt(goalText: string, note: string, dailyReq: string, prevReason: string): string {
  return [
    "You are the APPEAL reviewer for a habit app called Cert. A first pass rejected this photo; the user is appealing. Your job is to give the benefit of the doubt and be MORE generous than the first pass.",
    `User goal: "${goalText}"`,
    `First-pass rejection reason: "${prevReason}"`,
    `The user's explanation for the appeal: "${note || "(no note provided)"}"`,
    "Re-examine the photo fairly and generously. The user shoots solo, one-handed, with no timer and often no special equipment — never hold those against them. Take their explanation into account.",
    `Freshness check: the photo should include "${dailyReq}". If the fingers are present in any clear form, that part is satisfied.`,
    "APPROVE unless the photo is CLEARLY unrelated to the goal, blank/black, a screenshot, a meme, a stock/internet image, or obviously faked. A genuine attempt MUST be approved on appeal.",
    'Respond with ONLY a JSON object: {"approved": true|false, "reason": "<short, kind, in the user goal\'s language>", "confidence": <0..1>}.',
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_body" }, 400); }
  const { submissionId, note } = body || {};
  if (!submissionId) return json({ error: "missing_submission" }, 400);

  const svc = createClient(SUPABASE_URL, SERVICE);
  const { data: sub } = await svc.from("submissions").select("*").eq("id", submissionId).single();
  if (!sub || sub.user_id !== user.id) return json({ error: "not_found" }, 404);
  if (sub.status !== "rejected") return json({ error: "not_appealable" }, 409);

  // one appeal per submission
  const { data: existing } = await svc.from("appeals").select("id").eq("submission_id", submissionId).maybeSingle();
  if (existing) return json({ error: "already_appealed" }, 409);

  const { data: goal } = await svc.from("goals").select("*").eq("id", sub.goal_id).single();
  if (!goal) return json({ error: "goal_not_found" }, 404);

  // Re-judge the stored photo with the user's note (benefit of the doubt if the
  // photo couldn't be stored at submit time).
  const daily = dailyRequirement(sub.day, sub.goal_id);
  let verdict: { approved: boolean; reason: string; confidence: number };
  let photoBytes: Uint8Array | null = null;
  if (sub.photo_path) {
    try {
      const { data: blob } = await svc.storage.from("proofs").download(sub.photo_path);
      if (blob) photoBytes = new Uint8Array(await blob.arrayBuffer());
    } catch (_) { photoBytes = null; }
  }

  if (!photoBytes) {
    // No photo on file — give the benefit of the doubt on this one-time appeal.
    verdict = { approved: true, reason: "Appeal accepted — thanks for the context.", confidence: 0.5 };
  } else {
    const mime = sub.photo_path?.endsWith(".png") ? "image/png" : "image/jpeg";
    try {
      const data = await geminiCall({
        system_instruction: { parts: [{ text: buildAppealPrompt(goal.text, String(note || ""), daily, String(sub.reason || "")) }] },
        contents: [{ role: "user", parts: [{ text: "Review this appeal. Reply with ONLY the JSON object." }, { inline_data: { mime_type: mime, data: toBase64(photoBytes) } }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 256, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
      });
      const p = parseJsonLoose(extractText(data));
      if (!p) throw new Error("no parseable verdict");
      verdict = { approved: !!p.approved, reason: String(p.reason || (p.approved ? "Appeal accepted." : "Appeal denied.")).slice(0, 200), confidence: typeof p.confidence === "number" ? p.confidence : (p.approved ? 0.8 : 0.3) };
    } catch (_e) {
      return json({ error: true, busy: true, reason: "The reviewer is busy right now — please try again in a moment." });
    }
  }

  // Record the appeal
  await svc.from("appeals").insert({
    submission_id: submissionId, goal_id: sub.goal_id, user_id: user.id, note: String(note || "").slice(0, 500),
    status: verdict.approved ? "approved" : "rejected", streak_before: sub.streak_before || 0,
    resolved_at: new Date().toISOString(),
  });

  if (!verdict.approved) {
    // Denied appeals go to a human for a manual second look (best-effort email).
    let photoUrl: string | null = null;
    if (sub.photo_path) {
      try {
        const { data: signed } = await svc.storage.from("proofs").createSignedUrl(sub.photo_path, 60 * 60 * 24 * 7);
        photoUrl = signed?.signedUrl || null;
      } catch (_) { photoUrl = null; }
    }
    await emailDeniedAppeal({
      userId: user.id, goalText: String(goal.text || ""), note: String(note || ""),
      firstReason: String(sub.reason || ""), appealReason: String(verdict.reason || ""),
      submissionId: String(submissionId), photoUrl,
    });
    return json({ verdict, restored: false, goal });
  }

  // Restore the streak: the appealed day now counts.
  const restored = (sub.streak_before || 0) + 1;
  let newBest = goal.best_streak || 0;
  if (restored > newBest) newBest = restored;
  let newStatus = goal.status, completedAt: string | null = goal.completed_at;
  if (goal.status === "active") {
    if (goal.type === "one_time") { newStatus = "completed"; completedAt = new Date().toISOString(); }
    else if (goal.duration_days && restored >= goal.duration_days) { newStatus = "completed"; completedAt = new Date().toISOString(); }
  }

  await svc.from("submissions").update({ status: "approved", reason: verdict.reason }).eq("id", submissionId);
  await svc.from("goals").update({ streak: restored, best_streak: newBest, status: newStatus, completed_at: completedAt }).eq("id", sub.goal_id);
  if (newStatus === "completed" && goal.status !== "completed") {
    await svc.from("certs").insert({ user_id: user.id, goal_id: sub.goal_id, title: goal.text, days: newBest });
  }

  const { data: updatedGoal } = await svc.from("goals").select("*").eq("id", sub.goal_id).single();
  return json({ verdict, restored: true, streak: restored, completed: newStatus === "completed", goal: updatedGoal });
});
