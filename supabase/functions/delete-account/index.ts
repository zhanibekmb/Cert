// =====================================================================
// CERT — delete-account Edge Function (App Store 5.1.1(v) compliance).
// The signed-in user permanently deletes their own account + all data.
// Auth required (verify_jwt). Deleting the auth user cascades profiles,
// goals, submissions, certs, appeals, challenge_members, freeze_grants
// (all reference auth.users ON DELETE CASCADE). We also best-effort remove
// their proof photos from Storage.
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

// Recursively remove every object under the user's folder in the proofs bucket.
async function purgeStorage(svc: any, uid: string) {
  async function walk(prefix: string) {
    const { data, error } = await svc.storage.from("proofs").list(prefix, { limit: 1000 });
    if (error || !data) return;
    const files: string[] = [];
    for (const e of data) {
      const full = `${prefix}/${e.name}`;
      if (e.id === null || e.metadata == null) await walk(full); // folder
      else files.push(full);
    }
    if (files.length) await svc.storage.from("proofs").remove(files);
  }
  try { await walk(uid); } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const svc = createClient(SUPABASE_URL, SERVICE);

  await purgeStorage(svc, user.id);

  // Deletes the auth user; all app tables cascade from auth.users.
  const { error } = await svc.auth.admin.deleteUser(user.id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
});
