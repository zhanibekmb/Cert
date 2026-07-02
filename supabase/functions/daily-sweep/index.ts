// =====================================================================
// CERT — daily-sweep Edge Function (the missing honesty fix).
// Without this, a streak NEVER drops if you simply stop submitting — so
// "the streak you can't fake" could be faked by doing nothing. This sweep
// runs hourly (pg_cron → pg_net, see migration 20260630000000) and, for
// each ended local day a recurring goal was SCHEDULED but had no approved
// proof, either spends a freeze (keeps the streak, records a 'frozen' day)
// or resets the streak to 0 and records a 'missed' day.
//
// Service-role only. Invoke with the SUPABASE_SERVICE_ROLE_KEY as Bearer.
// Idempotent: goals.last_swept_day guarantees each day is processed once.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Dedicated shared secret for cron→function auth. Decoupled from the service
// role key so rotating the service key never breaks the sweep, and robust to
// Supabase's new vs legacy API-key formats. Set with: supabase secrets set SWEEP_SECRET=…
const SWEEP_SECRET = Deno.env.get("SWEEP_SECRET") || "";
const MAX_BACKFILL_DAYS = 60; // bound the loop if cron was down for a while

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function todayFor(tz: string): string {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: tz || "UTC" }); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function localHHMM(tz: string): string {
  try { return new Date().toLocaleTimeString("en-GB", { timeZone: tz || "UTC", hour12: false, hour: "2-digit", minute: "2-digit" }); }
  catch { return new Date().toISOString().slice(11, 16); }
}
function shiftDay(dayStr: string, n: number): string {
  const d = new Date(dayStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dowMon0(dayStr: string): number {
  // Mon=0 … Sun=6, matching custom_days / weekdays elsewhere in the codebase
  return (new Date(dayStr + "T00:00:00Z").getUTCDay() + 6) % 7;
}
// Is this DAILY-cadence goal scheduled on `day`? Weekly cadences (3x/5x) are
// NOT swept here — their streak is recomputed as consecutive weeks by the
// judge, so a single missed day is not a break.
function scheduledOn(goal: any, day: string): boolean {
  const fmt = goal.format;
  if (fmt === "weekdays") return dowMon0(day) <= 4;            // Mon–Fri
  if (fmt === "custom") {
    const cd: number[] = Array.isArray(goal.custom_days) ? goal.custom_days : [];
    return cd.includes(dowMon0(day));
  }
  // "daily" (and any unknown daily-ish format) → every day
  return true;
}
function isWeeklyCadence(goal: any): boolean {
  return goal.type === "recurring" && (goal.format === "3x" || goal.format === "5x");
}

Deno.serve(async (req) => {
  // Guard: only a caller holding the shared SWEEP_SECRET (the cron) may run it.
  const auth = req.headers.get("Authorization") || "";
  if (!SWEEP_SECRET || auth !== "Bearer " + SWEEP_SECRET) return json({ error: "unauthorized" }, 401);

  const svc = createClient(SUPABASE_URL, SERVICE);

  // Active recurring goals only. one_time goals don't have a daily streak to lose.
  const { data: goals, error } = await svc
    .from("goals")
    .select("id,user_id,type,format,custom_days,daily_deadline,streak,best_streak,verified_days_total,last_swept_day,created_at,status")
    .eq("status", "active")
    .eq("type", "recurring");
  if (error) return json({ error: error.message }, 500);

  // Cache per-user timezone + spendable freeze balance (read once, persist deltas).
  const profileCache = new Map<string, { tz: string; freezes: number }>();
  async function getProfile(uid: string) {
    if (profileCache.has(uid)) return profileCache.get(uid)!;
    const { data } = await svc.from("profiles").select("timezone,freezes").eq("id", uid).single();
    const p = { tz: data?.timezone || "UTC", freezes: data?.freezes ?? 0 };
    profileCache.set(uid, p);
    return p;
  }

  let reset = 0, frozen = 0, swept = 0, skipped = 0;

  for (const goal of goals || []) {
    if (isWeeklyCadence(goal)) { skipped++; continue; }

    const prof = await getProfile(goal.user_id);
    const today = todayFor(prof.tz);
    const yesterday = shiftDay(today, -1);

    // Don't penalize today before its deadline has passed; "ended day" = yesterday.
    // If a deadline exists and today is already past it, today also counts as ended
    // for a goal that wasn't done — but we keep the sweep to fully-ended days only
    // (yesterday and earlier) to avoid racing in-progress days.
    let cursor: string;
    if (!goal.last_swept_day) {
      // First sweep ever for this goal: grant grace — set the marker to yesterday
      // WITHOUT penalizing history (avoids nuking pre-existing streaks on rollout).
      await svc.from("goals").update({ last_swept_day: yesterday }).eq("id", goal.id);
      swept++;
      continue;
    }
    cursor = shiftDay(goal.last_swept_day, 1);

    // Walk each ended day from the last swept day up to (and including) yesterday.
    let curStreak = goal.streak || 0;
    let bestStreak = goal.best_streak || 0;
    const createdDay = String(goal.created_at || "").slice(0, 10);
    let guard = 0;
    let lastProcessed = goal.last_swept_day;

    while (cursor <= yesterday && guard < MAX_BACKFILL_DAYS) {
      guard++;
      lastProcessed = cursor;

      // Skip days before the goal existed or days it wasn't scheduled.
      if ((createdDay && cursor < createdDay) || !scheduledOn(goal, cursor)) {
        cursor = shiftDay(cursor, 1);
        continue;
      }

      // Was the day satisfied? (approved proof OR an already-recorded freeze)
      const { data: subs } = await svc
        .from("submissions").select("status")
        .eq("goal_id", goal.id).eq("day", cursor);
      const satisfied = (subs || []).some((s: any) => s.status === "approved" || s.status === "frozen");

      if (!satisfied) {
        if (prof.freezes > 0) {
          // Spend a freeze: the day is protected, the streak survives.
          const ok = await svc.from("profiles")
            .update({ freezes: prof.freezes - 1 }).eq("id", goal.user_id).gt("freezes", 0);
          if (!ok.error) {
            prof.freezes -= 1;
            await svc.from("submissions").insert({
              goal_id: goal.id, user_id: goal.user_id, day: cursor,
              status: "frozen", reason: "Streak freeze used — day protected.", confidence: 1,
              streak_before: curStreak,
            });
            frozen++;
          } else {
            // freeze raced to 0 between read and write → treat as a real miss
            curStreak = 0;
            await svc.from("submissions").insert({
              goal_id: goal.id, user_id: goal.user_id, day: cursor,
              status: "missed", reason: "No proof submitted — streak reset.", confidence: 0,
              streak_before: curStreak,
            });
            reset++;
          }
        } else {
          // No freeze: the streak burns. Record the miss for the heatmap.
          if (curStreak > 0) reset++;
          curStreak = 0;
          await svc.from("submissions").insert({
            goal_id: goal.id, user_id: goal.user_id, day: cursor,
            status: "missed", reason: "No proof submitted — streak reset.", confidence: 0,
            streak_before: goal.streak || 0,
          });
        }
      }
      cursor = shiftDay(cursor, 1);
    }

    // best_streak never decreases; verified_days_total is untouched here
    // (only the judge increments it on an approval).
    await svc.from("goals").update({
      streak: curStreak,
      best_streak: Math.max(bestStreak, curStreak),
      last_swept_day: lastProcessed,
    }).eq("id", goal.id);
    swept++;
  }

  return json({ ok: true, swept, reset, frozen, skipped_weekly: skipped });
});
