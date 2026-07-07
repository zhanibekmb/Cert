// =====================================================================
// CERT — waitlist-announce (one-shot launch email to the waitlist).
// Reads every waitlist row (service role) and sends a localized launch
// email via Resend. Guarded by a shared secret header so nobody else can
// trigger a blast. Set secrets: RESEND_API_KEY, ANNOUNCE_SECRET.
// Deploy with --no-verify-jwt; invoke with header x-announce-secret.
// Supports {"dryRun": true} to preview counts without sending.
// =====================================================================
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-announce-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const ANNOUNCE_SECRET = Deno.env.get("ANNOUNCE_SECRET") || "";
const FROM = "Cert <noreply@certapp.pro>";
const APP_URL = "https://apps.apple.com/app/id6786159294";

function wrap(inner: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#070608;padding:28px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#120f14;border:1px solid #241f29;border-radius:16px;padding:28px;color:#f4efe8;">
    ${inner}
    <a href="${APP_URL}" style="display:inline-block;margin-top:22px;background:#e23b2e;color:#120606;font-weight:800;letter-spacing:.04em;text-decoration:none;padding:14px 24px;border-radius:10px;">Download on the App Store →</a>
    <p style="color:#6f6a63;font-size:12px;margin-top:26px;line-height:1.6;">${APP_URL}<br/>Cert · certapp.pro</p>
  </div></body></html>`;
}
const COPY: Record<string, { subject: string; html: string }> = {
  en: {
    subject: "Cert is live — download it on the App Store",
    html: wrap(`<p style="color:#e23b2e;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px;">[ the streak you can't fake ]</p>
      <h1 style="font-size:26px;margin:0 0 14px;">Cert is live.</h1>
      <p style="color:#b8b2ab;font-size:15px;line-height:1.7;margin:0;">You joined the waitlist — thanks for waiting. Cert is now on the App Store for iPhone: one goal, a daily photo, an AI judge that can't be fooled. Build a streak you can't fake, solo or against friends.</p>`),
  },
  ru: {
    subject: "Cert запустился — скачивай в App Store",
    html: wrap(`<p style="color:#e23b2e;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px;">[ серия, которую не подделать ]</p>
      <h1 style="font-size:26px;margin:0 0 14px;">Cert запустился.</h1>
      <p style="color:#b8b2ab;font-size:15px;line-height:1.7;margin:0;">Ты оставил(а) почту в вайтлисте — спасибо, что дождался(ась). Cert уже в App Store для iPhone: одна цель, фото каждый день, ИИ-судья, которого не обмануть. Собери серию, которую не подделать — соло или против друзей.</p>`),
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!ANNOUNCE_SECRET || (req.headers.get("x-announce-secret") || "") !== ANNOUNCE_SECRET) return json({ error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const dryRun = body?.dryRun === true;

  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const svc = createClient(SUPABASE_URL, SERVICE);
  const { data: rows, error } = await svc.from("waitlist").select("email,lang");
  if (error) return json({ error: "read_failed", detail: error.message }, 500);
  const recipients = (rows || []).filter((r: any) => r.email && /.+@.+\..+/.test(r.email));

  if (dryRun) return json({ dryRun: true, total: recipients.length, ru: recipients.filter((r: any) => r.lang === "ru").length });
  if (!RESEND_API_KEY) return json({ error: "no_resend_key" }, 500);

  let sent = 0, failed = 0;
  const errors: string[] = [];
  for (const r of recipients) {
    const c = r.lang === "ru" ? COPY.ru : COPY.en;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: r.email, subject: c.subject, html: c.html }),
      });
      if (res.ok) sent++; else { failed++; if (errors.length < 5) errors.push(`${res.status}: ${(await res.text()).slice(0, 120)}`); }
    } catch (e) { failed++; if (errors.length < 5) errors.push(String((e as Error).message).slice(0, 120)); }
    await new Promise((r) => setTimeout(r, 600)); // stay under Resend's rate limit
  }
  return json({ ok: true, total: recipients.length, sent, failed, errors });
});
