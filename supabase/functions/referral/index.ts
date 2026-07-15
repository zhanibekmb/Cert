// =====================================================================
// CERT — referral freezes.
//   action "me"     → { code, redeemed }  (my invite code + whether I already
//                     redeemed someone else's)
//   action "redeem" → { ok, granted } — validates the code, records the
//                     referral (one per user, ever) and grants BOTH sides
//                     REWARD freezes. Service role only touches referrals,
//                     so clients can't self-credit.
// Deploy: npx supabase functions deploy referral --project-ref <ref>
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const REWARD = 2; // freezes granted to EACH side

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const auth = req.headers.get("Authorization") || "";
  const supa = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const svc = createClient(SUPABASE_URL, SERVICE);

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty body */ }
  const action = body.action;

  if (action === "me") {
    const { data: prof } = await svc.from("profiles").select("ref_code").eq("id", user.id).maybeSingle();
    const { data: red } = await svc.from("referrals").select("referred_id").eq("referred_id", user.id).maybeSingle();
    return json({ code: prof?.ref_code || null, redeemed: !!red });
  }

  if (action === "redeem") {
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return json({ error: "missing_code" }, 400);
    const { data: referrer } = await svc.from("profiles").select("id").eq("ref_code", code).maybeSingle();
    if (!referrer) return json({ error: "invalid_code" });
    if (referrer.id === user.id) return json({ error: "own_code" });
    // one redemption per user, ever — the PK enforces it even under races
    const { error: insErr } = await svc.from("referrals").insert({ referred_id: user.id, referrer_id: referrer.id });
    if (insErr) return json({ error: "already_redeemed" });
    // grant both sides
    const bump = async (uid: string) => {
      const { data: p } = await svc.from("profiles").select("freezes").eq("id", uid).maybeSingle();
      await svc.from("profiles").update({ freezes: (p?.freezes || 0) + REWARD }).eq("id", uid);
    };
    await bump(user.id);
    await bump(referrer.id);
    return json({ ok: true, granted: REWARD });
  }

  return json({ error: "unknown_action" }, 400);
});
