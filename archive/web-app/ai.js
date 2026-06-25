/* =====================================================================
   CERT — AI judge (client)
   If window.CERT_AI_ENDPOINT is set (see app.html), photos are sent to the
   backend, which runs the real Gemini Vision judge. If the endpoint is
   unreachable, we fall back to a lenient local mock so the demo never blocks.
   The rest of the app only calls CertAI.judge() — provider stays hidden.
   ===================================================================== */
(function (global) {
  'use strict';

  var APPROVE_REASONS = {
    gym:      ['Gym equipment and active training are visible.', 'Workout confirmed — looks like real effort.'],
    run:      ['Outdoor run confirmed: route and effort are clear.', 'Post-run proof accepted — nice work.'],
    read:     ['A book page is shown — reading confirmed.', 'Reading counts today, good job.'],
    diet:     ['A healthy meal is visible. Counts toward your goal.', 'Clean plate confirmed.'],
    code:     ['Coding work is visible — accepted.', 'IDE / commit shown, counts today.'],
    meditate: ['Meditation setup is clear — counts.', 'Calm session accepted.'],
    create:   ['Creative work in progress is visible. Accepted.', 'Making confirmed — keep going.'],
    _default: ['Looks like a genuine attempt — approved for today.', 'Proof accepted — goal confirmed for today.']
  };

  var REJECT_REASONS = {
    gym:      'This photo does not look related to training — try a shot at the gym or with equipment.',
    run:      'Hard to see any run here — a photo during or right after running works best.',
    read:     'Cannot see a book or page — try a photo of what you are reading.',
    diet:     'No meal visible — try a photo of your plate.',
    code:     'No coding work visible — a screenshot of your editor or commit works.',
    meditate: 'Meditation setup is not visible — try a photo of your spot.',
    create:   'No creative work visible — try a photo of what you are making.',
    _default: 'This photo does not seem related to your goal — try one that shows it more clearly.'
  };

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function normalize(v) {
    var approved = !!(v && v.approved);
    return {
      error: !!(v && v.error),
      approved: approved,
      reason: (v && v.reason) ? String(v.reason) : (approved ? 'Approved for today.' : 'Not approved — try a clearer photo.'),
      confidence: (v && typeof v.confidence === 'number') ? v.confidence : (approved ? 0.85 : 0.35)
    };
  }

  /* lenient local mock — used only as a fallback when no/failed endpoint */
  function demoJudge(opts) {
    var category = opts.category || '_default';
    var delay = 1200 + Math.random() * 1200;
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (opts.forceReject) { resolve(normalize({ approved: false, reason: REJECT_REASONS[category] || REJECT_REASONS._default, confidence: 0.3 })); return; }
        if (!opts.photo) { resolve(normalize({ approved: false, reason: 'No photo submitted.', confidence: 0 })); return; }
        // any real photo passes; small reject chance keeps the demo honest
        var approved = Math.random() > 0.06;
        resolve(normalize(approved
          ? { approved: true, reason: pick(APPROVE_REASONS[category] || APPROVE_REASONS._default), confidence: 0.9 }
          : { approved: false, reason: REJECT_REASONS[category] || REJECT_REASONS._default, confidence: 0.4 }));
      }, delay);
    });
  }

  /* localized proof-spec fallback (used when no/failed endpoint) */
  var SPEC_MOCK = {
    gym:      ['Send a photo at the gym showing equipment or you mid-workout. A plain mirror selfie will not count.', 'Пришли фото из зала: видно оборудование или тебя на тренировке. Селфи в зеркале не засчитается.'],
    run:      ['Send a photo during or right after your run — route, tracker, or you outdoors.', 'Пришли фото во время или сразу после пробежки — маршрут, трекер или ты на улице.'],
    read:     ['Send a photo of the actual page or book you read today. A cover-only shot will not count.', 'Пришли фото страницы или книги, которую читаешь сегодня. Только обложка не засчитается.'],
    diet:     ['Send a photo of your healthy meal on the plate. Packaging will not count.', 'Пришли фото здоровой еды на тарелке. Упаковка не засчитается.'],
    code:     ['Send a screenshot of your editor, a commit, or running code.', 'Пришли скрин редактора, коммита или работающего кода.'],
    meditate: ['Send a photo of your meditation or yoga spot or pose.', 'Пришли фото места или позы для медитации/йоги.'],
    create:   ['Send a photo of your work in progress — canvas, sketch, or tool in hand.', 'Пришли фото работы в процессе — холст, скетч или инструмент в руке.'],
    _default: ['Send a clear photo that visibly proves you did this today.', 'Пришли чёткое фото, которое наглядно доказывает, что ты сделал это сегодня.']
  };
  function mockSpec(category) {
    var pair = SPEC_MOCK[category] || SPEC_MOCK._default;
    return { en: pair[0], ru: pair[1] };
  }
  function specEndpoint() {
    return global.CERT_AI_ENDPOINT ? global.CERT_AI_ENDPOINT.replace(/\/api\/judge$/, '/api/proof-spec') : null;
  }

  var AI = {
    /* judge(opts) -> Promise<{ approved, reason, confidence }>
       opts: { photo (dataURL|null), goalText, category, proofSpec, forceReject } */
    judge: function (opts) {
      opts = opts || {};
      var category = opts.category || '_default';

      // real backend path (Gemini on the server)
      if (global.CERT_AI_ENDPOINT) {
        return fetch(global.CERT_AI_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo: opts.photo, goal: opts.goalText, category: category, proofSpec: opts.proofSpec || '', dailyReq: opts.dailyReq || '', forceReject: !!opts.forceReject })
        })
          .then(function (r) { if (!r.ok) throw new Error('judge http ' + r.status); return r.json(); })
          .then(function (v) { return normalize(v); })
          .catch(function (e) {
            console.warn('[CertAI] endpoint failed, using local mock:', e.message);
            return demoJudge(opts);
          });
      }

      // no endpoint configured — local mock
      return demoJudge(opts);
    },

    /* proofSpec(goalText, category) -> Promise<{ en, ru }>
       Asks the AI what photo proves this goal, in both languages. Falls back to templates. */
    proofSpec: function (goalText, category) {
      var ep = specEndpoint();
      var cat = category || '_default';
      if (ep && goalText) {
        return fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: goalText, category: cat })
        })
          .then(function (r) { if (!r.ok) throw new Error('spec http ' + r.status); return r.json(); })
          .then(function (v) {
            var m = mockSpec(cat);
            return { en: (v && v.en) ? String(v.en) : m.en, ru: (v && v.ru) ? String(v.ru) : m.ru };
          })
          .catch(function (e) {
            console.warn('[CertAI] proof-spec endpoint failed, using local mock:', e.message);
            return mockSpec(cat);
          });
      }
      return Promise.resolve(mockSpec(cat));
    }
  };

  global.CertAI = AI;
})(window);
