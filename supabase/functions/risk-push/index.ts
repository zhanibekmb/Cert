// =====================================================================
// CERT — risk-push Edge Function. Sends a "streak at risk" push to users who
// still haven't proven a goal that's scheduled today, around 20:00 in THEIR
// local time. Runs hourly (pg_cron), so each timezone gets hit once. At most
// one push per user per day (profiles.last_risk_push_day). Localized by
// profiles.lang. Auth: shared SWEEP_SECRET, deployed --no-verify-jwt.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SWEEP_SECRET = Deno.env.get("SWEEP_SECRET") || "";
const TARGET_HOUR = 20; // local hour to nudge (evening, before most deadlines)

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function todayFor(tz: string): string {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: tz || "UTC" }); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function localHour(tz: string): number {
  try { return parseInt(new Date().toLocaleString("en-GB", { timeZone: tz || "UTC", hour: "2-digit", hour12: false }).slice(0, 2), 10); }
  catch { return new Date().getUTCHours(); }
}
function dowMon0(dayStr: string): number {
  return (new Date(dayStr + "T00:00:00Z").getUTCDay() + 6) % 7;
}
function scheduledOn(goal: any, day: string): boolean {
  if (goal.type !== "recurring") return false;
  const fmt = goal.format;
  if (fmt === "weekdays") return dowMon0(day) <= 4;
  if (fmt === "custom") return (Array.isArray(goal.custom_days) ? goal.custom_days : []).includes(dowMon0(day));
  if (fmt === "3x" || fmt === "5x") return true; // weekly cadence: still worth a nudge
  return true; // daily
}

const COPY = {
  ru: { title: "Серия под угрозой", body: "Ты ещё не доказал сегодняшнюю цель. Не теряй серию." },
  en: { title: "Streak at risk", body: "You haven't proven today's goal yet. Don't lose your streak." },
};

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") || "";
  if (!SWEEP_SECRET || auth !== "Bearer " + SWEEP_SECRET) return json({ error: "unauthorized" }, 401);

  const svc = createClient(SUPABASE_URL, SERVICE);
  const { data: profiles, error } = await svc
    .from("profiles")
    .select("id,timezone,lang,expo_push_token,last_risk_push_day")
    .not("expo_push_token", "is", null);
  if (error) return json({ error: error.message }, 500);

  const messages: any[] = [];
  const pushedUserIds: string[] = [];

  for (const p of profiles || []) {
    const tz = p.timezone || "UTC";
    if (localHour(tz) !== TARGET_HOUR) continue;          // only at ~20:00 local
    const today = todayFor(tz);
    if (p.last_risk_push_day === today) continue;          // already handled today

    // any active recurring goal scheduled today and NOT yet done?
    const { data: goals } = await svc.from("goals")
      .select("id,type,format,custom_days,status")
      .eq("user_id", p.id).eq("status", "active").eq("type", "recurring");
    let atRisk = false;
    for (const g of goals || []) {
      if (!scheduledOn(g, today)) continue;
      const { data: subs } = await svc.from("submissions").select("status").eq("goal_id", g.id).eq("day", today);
      const done = (subs || []).some((x: any) => x.status === "approved" || x.status === "frozen");
      if (!done) { atRisk = true; break; }
    }

    // mark as handled today regardless, so we don't re-evaluate on a double-run
    await svc.from("profiles").update({ last_risk_push_day: today }).eq("id", p.id);
    if (!atRisk) continue;

    const c = p.lang === "ru" ? COPY.ru : COPY.en;
    messages.push({ to: p.expo_push_token, title: c.title, body: c.body, sound: "default", channelId: "reminders", priority: "high" });
    pushedUserIds.push(p.id);
  }

  // Expo push API accepts batches of up to 100.
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const r = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });
      if (r.ok) sent += batch.length;
    } catch (_) { /* keep going */ }
  }

  return json({ ok: true, candidates: (profiles || []).length, pushed: sent });
});
