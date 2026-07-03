// =====================================================================
// CERT — RevenueCat webhook (payments). Single source of truth for what a
// user paid for. The client NEVER credits itself; the store tells us here.
//
// Two product kinds:
//   • Freeze packs   — CONSUMABLE in-app purchase. Available to EVERYONE,
//                      including free users. Credits profiles.freezes.
//   • Pro            — auto-renewing subscription. Sets profiles.plan and
//                      tops up the monthly freeze allowance.
//
// Idempotent: each RevenueCat event id is recorded in freeze_grants.ext_ref
// (unique), so retried/duplicate webhooks never double-credit.
//
// SETUP (once):
//   1. RevenueCat dashboard → create products:
//        - consumable "freeze_pack_3", "freeze_pack_10"  (free users can buy)
//        - subscription "cert_pro_monthly", "cert_pro_yearly"
//   2. On the mobile client, set RevenueCat appUserID = the Supabase user id
//      so event.app_user_id maps straight to profiles.id.
//   3. RevenueCat → Integrations → Webhooks → URL =
//        https://<PROJECT_REF>.supabase.co/functions/v1/revenuecat-webhook
//      Set the Authorization header value, and store the same string as the
//      REVENUECAT_WEBHOOK_SECRET function secret.
//   4. supabase secrets set REVENUECAT_WEBHOOK_SECRET=<value>
//   5. Deploy WITHOUT JWT verification (it's a server-to-server call):
//        supabase functions deploy revenuecat-webhook --no-verify-jwt
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("REVENUECAT_WEBHOOK_SECRET") || "";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

// product_id → what to grant. Edit to match your RevenueCat product ids.
const FREEZE_PACKS: Record<string, number> = {
  freeze_pack_1: 1,
  freeze_pack_3: 3,
  freeze_pack_10: 10,
};
const PRO_PRODUCTS: Record<string, { plan: string; monthlyFreezes: number }> = {
  cert_pro_monthly: { plan: "monthly", monthlyFreezes: 3 },
  cert_pro_yearly:  { plan: "yearly",  monthlyFreezes: 3 },
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // RevenueCat sends the Authorization header you configured on the webhook.
  const auth = req.headers.get("Authorization") || "";
  if (!WEBHOOK_SECRET || auth !== WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_body" }, 400); }
  const ev = body?.event;
  if (!ev) return json({ error: "no_event" }, 400);

  const uid: string = ev.app_user_id;
  // Android may report "productId:basePlanId" — normalize to the flat product id.
  const productId: string = (ev.product_id || "").split(":")[0];
  const eventId: string = ev.id || ev.transaction_id || "";
  const type: string = ev.type || "";
  if (!uid || !eventId) return json({ error: "missing_fields" }, 400);

  const svc = createClient(SUPABASE_URL, SERVICE);

  // Only acquisition events grant. (CANCELLATION/EXPIRATION change entitlement
  // but don't revoke already-granted consumable freezes.)
  const grants = ["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE", "UNCANCELLATION"];

  const freezeQty = FREEZE_PACKS[productId];
  const pro = PRO_PRODUCTS[productId];

  if (grants.includes(type) && (freezeQty || pro)) {
    const qty = freezeQty || (pro ? pro.monthlyFreezes : 0);
    const source = freezeQty ? "purchase" : "pro_" + (pro?.plan || "sub");

    // Idempotency gate: the unique index on ext_ref rejects a replayed event.
    const { error: grantErr } = await svc.from("freeze_grants")
      .insert({ user_id: uid, qty, source, ext_ref: eventId });
    if (grantErr) {
      // 23505 = unique violation → already processed this event. Ack with 200.
      if ((grantErr as any).code === "23505") return json({ ok: true, duplicate: true });
      return json({ error: grantErr.message }, 500);
    }

    // Credit the spendable balance (read-modify-write; webhook volume is low).
    const { data: prof } = await svc.from("profiles").select("freezes").eq("id", uid).single();
    const newFreezes = (prof?.freezes ?? 0) + qty;
    const patch: Record<string, unknown> = { freezes: newFreezes };
    if (pro) patch.plan = pro.plan;
    await svc.from("profiles").update(patch).eq("id", uid);

    return json({ ok: true, granted: qty, source });
  }

  // Subscription lapse → downgrade plan (keep any unused freezes).
  if ((type === "EXPIRATION" || type === "CANCELLATION") && pro) {
    await svc.from("profiles").update({ plan: "free" }).eq("id", uid);
    return json({ ok: true, downgraded: true });
  }

  return json({ ok: true, ignored: type });
});
