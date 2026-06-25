// =====================================================================
// CERT — proof-spec Edge Function (self-contained, paste-deploy ready).
// Returns a bilingual "what photo to send" for a goal. Needs the
// GEMINI_API_KEY secret. Auth required (verify_jwt = true in config).
// =====================================================================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const KEY = () => Deno.env.get("GEMINI_API_KEY") || "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function generateSpec(goalText: string): Promise<{ en: string; ru: string }> {
  const fallback = {
    en: "Send a clear photo that visibly proves you did this today. An unrelated or blank photo will not count.",
    ru: "Пришли чёткое фото, которое наглядно доказывает, что ты сделал это сегодня. Не по теме или пустое не засчитается.",
  };
  if (!KEY() || !goalText) return fallback;
  try {
    const prompt = [
      "You help users of a habit app called Cert know what photo proves their goal.",
      `User goal: "${goalText}"`,
      "Write a short proof spec: 1 sentence on what the daily photo must show to be approved, plus one quick example that will NOT count.",
      "Keep it EASY and low-effort. The user shoots SOLO, one-handed, with NO camera timer, and may have NO special equipment, mat, gym gear, or ideal location — never require any of those. Never ask for an action selfie, a held pose, or a person mid-motion. Accept a simple setup, scene, result, or aftermath that can be snapped with one hand. The example that 'won't count' should only be a clearly unrelated or fake photo, not a strict technicality.",
      'Be specific to THIS goal, address the user as "you", stay encouraging.',
      "Provide BOTH an English and a Russian version, each UNDER 200 characters.",
      'Output ONLY a JSON object {"spec_en":"...","spec_ru":"..."} and nothing else.',
    ].join("\n");
    const data = await geminiCall({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024, temperature: 0.5 },
    });
    const p = parseJsonLoose(extractText(data));
    if (p && (p.spec_en || p.spec_ru)) {
      return { en: String(p.spec_en || p.spec_ru || "").slice(0, 300) || fallback.en, ru: String(p.spec_ru || p.spec_en || "").slice(0, 300) || fallback.ru };
    }
  } catch (e) { console.warn("[gemini] spec failed:", (e as Error).message); }
  return fallback;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { goal } = await req.json();
    if (!goal || String(goal).trim().length < 3) return json({ error: "goal_too_short" }, 400);
    return json(await generateSpec(String(goal).trim()));
  } catch (e) {
    return json({ error: "spec_failed", message: (e as Error).message }, 500);
  }
});
