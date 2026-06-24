/* =====================================================================
   CERT — AI judge (server side, the moat)
   - With GEMINI_API_KEY set: real Gemini Vision call.
   - Without a key: a deterministic-ish mock so the API runs out of the box.
   Returns { approved:boolean, reason:string, confidence:number }.
   ===================================================================== */
'use strict';

const { ruleFor } = require('./groups');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

function buildSystemPrompt(goalText, category, proofSpec, dailyReq) {
  const lines = [
    'You are a fair, encouraging AI judge for a habit-accountability app called Cert.',
    `User goal: "${goalText}"`
  ];
  // Align the judge with what the user was actually told to send (proof-spec).
  if (proofSpec) lines.push(`The exact proof requirement the user was shown: "${proofSpec}"`);
  else lines.push(`General guideline for this category: "${ruleFor(category)}"`);
  lines.push(
    'Decide if the photo genuinely shows the user doing THIS goal today.',
    'STEP 1 — RELEVANCE (strict): does the photo show the same activity/subject as the goal? If it clearly shows a DIFFERENT activity (for example: push-ups or a gym when the goal is reading; food when the goal is running), you MUST reject. A wrong-topic photo never passes, no matter how genuine.',
    'STEP 2 — only if the activity matches: be lenient about angle, lighting, quality and framing, and APPROVE a genuine attempt. Do not nitpick.'
  );
  if (dailyReq) lines.push(`STEP 3 — ANTI-REPLAY (mandatory): the photo must ALSO clearly satisfy today's freshness check: "${dailyReq}". If it is not clearly visible, reject — this stops the user reusing an old photo.`);
  lines.push(
    'Always reject blank, black, stock, meme, or unrelated screenshots.',
    'Respond with ONLY a JSON object of the exact shape:',
    '{"approved": true|false, "reason": "<one short sentence under 120 chars, in the same language as the user goal>", "confidence": <number 0..1>}'
  );
  return lines.join('\n');
}

/* ---- mock judge (no API key) ---- */
const APPROVE = {
  gym: 'Gym equipment and active training are visible.',
  run: 'Outdoor run confirmed: route and effort are clear.',
  read: 'A legible book page is shown — reading confirmed.',
  diet: 'A healthy meal on a plate is visible.',
  code: 'IDE / commit visible — coding work confirmed.',
  meditate: 'Meditation / yoga setup is clear.',
  create: 'Creative work in progress is visible.',
  _default: 'The photo proves the goal was completed today.'
};
const REJECT = {
  gym: 'Photo does not show real training or gym equipment.',
  run: 'No run evidence — need a photo during or right after running.',
  read: 'Cannot read a specific book page in this photo.',
  diet: 'No clear healthy meal visible on a plate.',
  code: 'No IDE, commit, or coding work visible.',
  meditate: 'Meditation or yoga setup is not clearly shown.',
  create: 'No creative work in progress is visible.',
  _default: 'Photo does not clearly prove the goal was completed.'
};

function mockJudge({ photo, category, forceReject, forceApprove }) {
  const cat = category || '_default';
  if (forceReject) return { approved: false, reason: REJECT[cat] || REJECT._default, confidence: 0.3 };
  if (forceApprove) return { approved: true, reason: APPROVE[cat] || APPROVE._default, confidence: 0.92 };
  if (!photo) return { approved: false, reason: 'No photo submitted.', confidence: 0 };
  // lenient mock: any real photo is approved, with a tiny reject chance for demo realism
  const approved = Math.random() > 0.05;
  const conf = Math.min(0.97, 0.7 + (String(photo).length / 200000) * 0.3);
  return approved
    ? { approved: true, reason: APPROVE[cat] || APPROVE._default, confidence: conf }
    : { approved: false, reason: REJECT[cat] || REJECT._default, confidence: 0.4 };
}

/* split a data URL ("data:image/jpeg;base64,XXXX") into { mimeType, data } */
function parseImage(photo) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(photo));
  if (m) return { mimeType: m[1], data: m[2] };
  // assume raw base64; default to jpeg
  return { mimeType: 'image/jpeg', data: String(photo).replace(/^data:[^,]*,/, '') };
}

/* ---- Gemini transport: retry transient overload (503/429/500), parse loosely ---- */
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) return '';
  for (const p of parts) if (p && typeof p.text === 'string' && p.text.trim()) return p.text;
  return '';
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const obj = /\{[\s\S]*\}/.exec(t);            // last resort: grab the first {...}
  if (obj) { try { return JSON.parse(obj[0]); } catch (e) {} }
  return null;
}

async function geminiCall(body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {  // Gemini free tier 503s a lot; retry hard
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(body)
      });
    } catch (e) { lastErr = e; await sleep(600 * (attempt + 1)); continue; }
    if (r.ok) return r.json();
    if (r.status === 503 || r.status === 429 || r.status === 500) {  // transient — back off and retry
      lastErr = new Error(`Gemini ${r.status} (overloaded)`);
      await sleep(700 * (attempt + 1));
      continue;
    }
    const txt = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${txt.slice(0, 200)}`);
  }
  throw lastErr || new Error('Gemini call failed');
}

/* ---- real judge (Gemini vision) ---- */
async function geminiJudge({ photo, goalText, category, proofSpec, dailyReq }) {
  const img = parseImage(photo);
  const data = await geminiCall({
    system_instruction: { parts: [{ text: buildSystemPrompt(goalText, category, proofSpec, dailyReq) }] },
    contents: [
      { role: 'user', parts: [
        { text: 'Judge this photo against the goal. Keep "reason" under 120 characters. Reply with ONLY a JSON object: {"approved": true|false, "reason": "<short>", "confidence": <0..1>} and nothing else.' },
        { inline_data: { mime_type: img.mimeType, data: img.data } }
      ] }
    ],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024, temperature: 0.3 }
  });
  const parsed = parseJsonLoose(extractText(data));
  if (!parsed) throw new Error('Gemini returned no parseable verdict');
  return {
    approved: !!parsed.approved,
    reason: String(parsed.reason || (parsed.approved ? 'Goal confirmed.' : 'Goal not proven.')).slice(0, 200),
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : (parsed.approved ? 0.8 : 0.3)
  };
}

/* =====================================================================
   PROOF-SPEC — the AI tells the user what photo to send for their goal.
   Same spec is shown to the user AND fed to the judge (alignment → fewer
   false rejects). Cheap text-only call; mock fallback when no key.
   ===================================================================== */
const SPEC_MOCK_EN = {
  gym: 'Send a photo taken at the gym showing equipment or you mid-workout. A plain mirror selfie with no gym context will not count.',
  run: 'Send a photo from during or right after your run — route, tracker, or you outdoors. A screenshot with no run context will not count.',
  read: 'Send a photo of the actual page or book you are reading today. A cover-only shot will not count.',
  diet: 'Send a photo of your healthy meal on the plate. A photo of packaging or a menu will not count.',
  code: 'Send a screenshot of your editor, a commit, or running code. A blank desktop will not count.',
  meditate: 'Send a photo of your meditation or yoga spot or pose. A random room shot will not count.',
  create: 'Send a photo of your work in progress — canvas, sketch, or tool in hand. A finished stock image will not count.',
  _default: 'Send a clear photo that visibly proves you did this today. An unrelated or blank photo will not count.'
};
const SPEC_MOCK_RU = {
  gym: 'Пришли фото из зала: видно оборудование или тебя на тренировке. Селфи в зеркале без зала не засчитается.',
  run: 'Пришли фото во время или сразу после пробежки — маршрут, трекер или ты на улице. Просто скрин без контекста не засчитается.',
  read: 'Пришли фото самой страницы или книги, которую читаешь сегодня. Только обложка не засчитается.',
  diet: 'Пришли фото здоровой еды на тарелке. Фото упаковки или меню не засчитается.',
  code: 'Пришли скрин редактора, коммита или работающего кода. Пустой рабочий стол не засчитается.',
  meditate: 'Пришли фото места или позы для медитации/йоги. Случайное фото комнаты не засчитается.',
  create: 'Пришли фото работы в процессе — холст, скетч или инструмент в руке. Готовая сток-картинка не засчитается.',
  _default: 'Пришли чёткое фото, которое наглядно доказывает, что ты сделал это сегодня. Не по теме или пустое не засчитается.'
};
function mockSpec(category, lang) {
  const table = lang === 'ru' ? SPEC_MOCK_RU : SPEC_MOCK_EN;
  return table[category] || table._default;
}

async function geminiSpec({ goalText, category }) {
  const prompt = [
    'You help users of a habit app called Cert understand what photo will prove their goal.',
    `User goal: "${goalText}"`,
    `Category guideline: "${ruleFor(category)}"`,
    'Write a short "proof spec": 1 sentence on what the daily photo must show to be approved, plus one quick example that will NOT count.',
    'Be specific to THIS goal, address the user as "you", stay encouraging.',
    'Provide BOTH an English and a Russian version. Keep each UNDER 200 characters.',
    'Output ONLY a JSON object {"spec_en":"<English>","spec_ru":"<Russian>"} and nothing else.'
  ].join('\n');
  const data = await geminiCall({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024, temperature: 0.5 }
  });
  const parsed = parseJsonLoose(extractText(data));
  if (parsed && (parsed.spec_en || parsed.spec_ru)) {
    return {
      en: String(parsed.spec_en || parsed.spec_ru || '').slice(0, 300),
      ru: String(parsed.spec_ru || parsed.spec_en || '').slice(0, 300)
    };
  }
  return { en: mockSpec(category || '_default', 'en'), ru: mockSpec(category || '_default', 'ru') };
}

async function spec(opts) {
  opts = opts || {};
  const category = opts.category || '_default';
  if (process.env.GEMINI_API_KEY && opts.goalText) {
    try { return await geminiSpec(opts); }
    catch (e) { console.warn('[ai] Gemini spec failed, falling back to mock:', e.message); }
  }
  return { en: mockSpec(category, 'en'), ru: mockSpec(category, 'ru') };
}

async function judge(opts) {
  opts = opts || {};
  if (opts.forceReject || opts.forceApprove) return mockJudge(opts); // test/demo hooks bypass the model
  if (process.env.GEMINI_API_KEY && opts.photo) {
    try {
      return await geminiJudge(opts);
    } catch (e) {
      // Do NOT fall back to mock here — a busy judge must never wrongly approve.
      // Return an explicit error so the app asks the user to retry (no streak change).
      console.warn('[ai] Gemini judge failed:', e.message);
      return { error: true, approved: false, reason: 'The judge is busy right now — please try again in a moment.', confidence: 0 };
    }
  }
  return mockJudge(opts); // no key configured (local dev) — keep the demo running
}

module.exports = { judge, spec, usingRealAI: () => !!process.env.GEMINI_API_KEY };
