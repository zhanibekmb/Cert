/* =====================================================================
   CERT — web app (hash router + screens)
   Concept (CONCEPT.md): solo, unfakeable streak, freemium.
   Flow: auth → pick 1 goal → photo → AI verdict → streak.
   No paywall gate. Paywall is now an upsell (#/upgrade).
   Free = 1 goal + 2 photo attempts/day. Paid = many goals + freezes.
   Groups / blocked screens are PARKED below (phase 2) — kept but unlinked.
   Talks only to CertStore / CertAI. Demo backend = localStorage.
   ===================================================================== */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var S = window.CertStore;

  /* transient flow state (not persisted) */
  var ob = { step: 0, text: '', category: 'gym', format: 'daily', customDays: [], tz: '', proofSpec: {}, specLoading: false, specKey: '' };
  var sub = { state: 'capture', photo: null, forceReject: false, verdict: null, goalId: null };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  window.go = go;

  function parseHash() {
    var h = location.hash || '#/home';
    var q = {};
    var qi = h.indexOf('?');
    if (qi >= 0) { h.slice(qi + 1).split('&').forEach(function (p) { var kv = p.split('='); q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); }); h = h.slice(0, qi); }
    return { path: h, q: q };
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 400); }, 2200);
  }

  window.appSetLang = function (l) { CertI18n.set(l); route(); };

  function syncChrome() {
    document.querySelectorAll('.lang-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-l') === CertI18n.lang); });
    var st = S.get();
    var initial = st.user ? (st.user.name || 'Z').slice(0, 1).toUpperCase() : 'Z';
    document.querySelectorAll('.app-avatar').forEach(function (av) {
      av.textContent = initial;
      av.style.display = st.user ? 'flex' : 'none';
    });
  }

  function catEmoji(id) { for (var i = 0; i < S.CATS.length; i++) if (S.CATS[i].id === id) return S.CATS[i].emoji; return '🎯'; }
  function catName(id) { for (var i = 0; i < S.CATS.length; i++) if (S.CATS[i].id === id) return T(S.CATS[i].name, S.CATS[i].name_ru); return id; }
  function fmtLabel(f) { return ({ daily: T('Daily', 'Ежедневно'), weekdays: T('Weekdays', 'Будни'), '3x': T('3×/week', '3×/нед'), '5x': T('5×/week', '5×/нед'), custom: T('Custom', 'Свои дни') })[f] || f; }
  /* proof-spec is { en, ru } (older goals may be a plain string). Pick by language. */
  function pickSpec(ps, lang) {
    if (!ps) return '';
    if (typeof ps === 'string') return ps;
    lang = lang || CertI18n.lang;
    return ps[lang] || ps.en || ps.ru || '';
  }

  /* Daily anti-replay check: a small extra requirement that changes every day,
     deterministic per (date, goal). The judge verifies it too, so yesterday's
     photo can't be reused. Returns { en, ru, text(current lang) }. */
  function hashStr(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return Math.abs(h); }
  function dailyCheck(goalId) {
    var date = S.todayStr();
    var h = hashStr(date + '|' + goalId);
    var pool = [
      function () { var n = (h % 4) + 2; var ruw = n < 5 ? 'пальца' : 'пальцев'; return { en: 'Hold up ' + n + ' fingers somewhere in the frame.', ru: 'Покажи ' + n + ' ' + ruw + ' где-нибудь в кадре.' }; },
      function () { return { en: "Write today's date (" + date + ') on paper and include it in the photo.', ru: 'Напиши сегодняшнюю дату (' + date + ') на бумаге и покажи в кадре.' }; },
      function () { var o = [['a spoon', 'ложку'], ['your keys', 'ключи'], ['a cup', 'кружку'], ['a pen', 'ручку']][h % 4]; return { en: 'Also include ' + o[0] + ' somewhere in the shot.', ru: 'Добавь в кадр ' + o[1] + '.' }; },
      function () { return { en: 'Show a clear thumbs-up in the photo.', ru: 'Покажи большой палец вверх в кадре.' }; }
    ];
    var p = pool[h % pool.length]();
    return { en: p.en, ru: p.ru, text: CertI18n.lang === 'ru' ? p.ru : p.en };
  }

  /* ---------- nav (Home + Profile; Groups returns in phase 2) ---------- */
  function renderNav(active) {
    var bottom = document.getElementById('bottom-nav');
    var side = document.getElementById('side-nav');
    if (!active) {
      if (bottom) bottom.innerHTML = '';
      if (side) side.innerHTML = '';
      return;
    }
    var items = [
      { ic: '🔥', lb: T('Streak', 'Стрик'), h: '#/home' },
      { ic: '👤', lb: T('Profile', 'Профиль'), h: '#/profile' }
    ];
    if (bottom) bottom.innerHTML = items.map(function (it) {
      var on = location.hash.indexOf(it.h) === 0;
      return '<button class="nav-item ' + (on ? 'active' : '') + '" onclick="go(\'' + it.h + '\')"><span class="ic">' + it.ic + '</span><span class="lb">' + it.lb + '</span></button>';
    }).join('');
    if (side) side.innerHTML = items.map(function (it) {
      var on = location.hash.indexOf(it.h) === 0;
      return '<button class="side-link ' + (on ? 'active' : '') + '" onclick="go(\'' + it.h + '\')"><span class="ic">' + it.ic + '</span><span>' + it.lb + '</span></button>';
    }).join('');
  }

  /* =====================================================================
     SCREENS
     ===================================================================== */

  /* ---- AUTH ---- */
  function screenAuth() {
    renderNav(false);
    view.innerHTML =
      '<div style="padding:40px 4px;">' +
      '<div class="center" style="margin-bottom:30px;">' +
        '<div class="pixel" style="font-size:10px;color:var(--red);letter-spacing:.08em;margin-bottom:18px;">[ ' + T('the streak you can\'t fake', 'стрик, который не подделать') + ' ]</div>' +
        '<h1 class="display" style="font-size:40px;margin:0;line-height:1;">' + T('Start your', 'Начни свой') + '<br>' + T('streak', 'стрик') + '</h1>' +
        '<p class="lede" style="color:var(--ink-mute);font-size:15px;margin-top:16px;">' + T('One goal. A daily photo. An honest AI judge. Free to start.', 'Одна цель. Фото в день. Честный ИИ-судья. Бесплатно для старта.') + '</p>' +
      '</div>' +
      '<div class="card">' +
        '<label class="field-label">' + T('Your name', 'Имя') + '</label>' +
        '<input id="au-name" class="field-input" placeholder="' + T('Zhanibek', 'Жанибек') + '">' +
        '<label class="field-label" style="margin-top:16px;">Email</label>' +
        '<input id="au-email" class="field-input" type="email" placeholder="you@email.com">' +
        '<div id="au-err" class="field-err hidden"></div>' +
        '<button class="btn btn-red btn-block" style="margin-top:18px;" onclick="auSubmit()">' + T('Start free →', 'Начать бесплатно →') + '</button>' +
        '<div class="center mono" style="font-size:11px;color:var(--ink-faint);margin-top:14px;">' + T('Demo — no password, stored locally on this device.', 'Демо — без пароля, хранится локально.') + '</div>' +
      '</div>' +
      '</div>';
  }
  window.auSubmit = function () {
    var name = document.getElementById('au-name').value.trim();
    var email = document.getElementById('au-email').value.trim();
    var err = document.getElementById('au-err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = T('That email looks off.', 'Похоже на неправильную почту.'); err.classList.remove('hidden'); return; }
    S.signup(email, name, Intl.DateTimeFormat().resolvedOptions().timeZone);
    syncChrome();
    go('#/onboarding');
  };

  /* ---- ONBOARDING (2 steps: goal → frequency, then lock) ---- */
  function screenOnboarding() {
    renderNav(false);
    if (!ob.tz) ob.tz = (S.get().user && S.get().user.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    var steps = 2;
    var pct = Math.round(((ob.step + 1) / steps) * 100);
    var head =
      '<div class="row between" style="margin-bottom:6px;"><div class="kicker">' + T('Step', 'Шаг') + ' ' + (ob.step + 1) + ' / ' + steps + '</div><div class="kicker kicker-red">' + pct + '%</div></div>' +
      '<div style="height:3px;background:var(--bg-3);margin-bottom:26px;"><div style="height:3px;width:' + pct + '%;background:var(--red);transition:width .3s;"></div></div>';

    var body = '';
    if (ob.step === 0) {
      body =
        '<h2 class="display" style="font-size:26px;margin:0 0 6px;">' + T('What will you prove?', 'Что будешь доказывать?') + '</h2>' +
        '<p class="lede" style="color:var(--ink-mute);font-size:14px;line-height:1.6;margin:0 0 18px;">' + T('Write your goal in your own words. The AI judge reads this every day.', 'Опиши цель своими словами. ИИ-судья читает именно это каждый день.') + '</p>' +
        '<textarea id="ob-text" class="field-textarea" rows="3" placeholder="' + T('e.g. Gym 45 min daily, photo with equipment', 'напр. Зал 45 мин ежедневно, фото с оборудованием') + '">' + esc(ob.text) + '</textarea>' +
        '<label class="field-label" style="margin-top:20px;">' + T('Category', 'Категория') + '</label>' +
        '<div class="choice-grid" style="grid-template-columns:1fr 1fr;">' +
          S.CATS.map(function (g) {
            return '<div class="choice ' + (ob.category === g.id ? 'sel' : '') + '" onclick="obCat(\'' + g.id + '\')"><span class="emoji">' + g.emoji + '</span><span>' + esc(T(g.name, g.name_ru)) + '</span></div>';
          }).join('') +
        '</div>' +
        '<button class="btn btn-red btn-block" style="margin-top:24px;" onclick="obNext()">' + T('Next →', 'Дальше →') + '</button>';
    } else {
      var fmts = [
        { id: 'daily', l: T('Every day', 'Каждый день') },
        { id: 'weekdays', l: T('Weekdays (Mon–Fri)', 'Будни (пн–пт)') },
        { id: '3x', l: T('3× per week', '3 раза в неделю') },
        { id: '5x', l: T('5× per week', '5 раз в неделю') },
        { id: 'custom', l: T('Custom days', 'Свои дни') }
      ];
      body =
        '<h2 class="display" style="font-size:26px;margin:0 0 6px;">' + T('How often?', 'Как часто?') + '</h2>' +
        '<p class="lede" style="color:var(--ink-mute);font-size:14px;line-height:1.6;margin:0 0 18px;">' + T('Miss a required day and your streak resets to zero. No money on the line — just the streak.', 'Пропустил обязательный день — стрик обнуляется. Денег на кону нет — только стрик.') + '</p>' +
        '<div class="choice-grid">' +
          fmts.map(function (f) { return '<div class="choice ' + (ob.format === f.id ? 'sel' : '') + '" onclick="obFmt(\'' + f.id + '\')"><span>' + f.l + '</span></div>'; }).join('') +
        '</div>' +
        (ob.format === 'custom' ?
          '<div style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;">' +
          ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d, i) {
            var on = ob.customDays.indexOf(i) >= 0;
            return '<button class="btn btn-sm ' + (on ? 'btn-red' : 'btn-ghost') + '" onclick="obDay(' + i + ')">' + d + '</button>';
          }).join('') + '</div>' : '') +
        '<div class="card" style="margin-top:18px;background:var(--surface-2);border-color:var(--bronze-dim);">' +
          '<div class="kicker text-bronze" style="margin-bottom:8px;">' + T('Your goal', 'Твоя цель') + '</div>' +
          '<div class="mono" style="font-size:14px;color:var(--ink);line-height:1.5;">' + esc(ob.text || T('(no goal text)', '(нет текста цели)')) + '</div>' +
          '<div class="kicker" style="margin-top:10px;">' + fmtLabel(ob.format) + ' · ' + esc(catName(ob.category)) + '</div>' +
        '</div>' +
        '<div class="card" style="margin-top:14px;background:linear-gradient(135deg,#1a1210,#120e0c);border-color:var(--bronze-dim);">' +
          '<div class="kicker text-bronze" style="margin-bottom:8px;">📸 ' + T('AI: what photo to send', 'ИИ: какое фото слать') + '</div>' +
          (ob.specLoading
            ? '<div class="mono" style="font-size:13px;color:var(--ink-mute);">⏳ ' + T('AI is figuring out your proof…', 'ИИ подбирает, какое фото слать…') + '</div>'
            : '<div class="mono" style="font-size:13px;color:var(--ink);line-height:1.55;">' + esc(pickSpec(ob.proofSpec) || T('(no spec yet)', '(спека ещё не готова)')) + '</div>' +
              '<button class="btn btn-ghost btn-sm" style="margin-top:10px;" onclick="obRegenSpec()">↻ ' + T('Regenerate', 'Перегенерить') + '</button>') +
        '</div>' +
        '<button class="btn btn-red btn-block" style="margin-top:20px;" onclick="obFinish()">' + T('Start the streak →', 'Запустить стрик →') + '</button>';
    }
    view.innerHTML = '<div style="padding:8px 4px;">' + head + body + '</div>';
  }
  window.obCat = function (c) { var el = document.getElementById('ob-text'); if (el) ob.text = el.value; ob.category = c; screenOnboarding(); };
  window.obFmt = function (f) { ob.format = f; screenOnboarding(); };
  window.obDay = function (i) { var p = ob.customDays.indexOf(i); if (p >= 0) ob.customDays.splice(p, 1); else ob.customDays.push(i); screenOnboarding(); };
  window.obNext = function () {
    if (ob.step === 0) { ob.text = document.getElementById('ob-text').value.trim(); if (ob.text.length < 3) { toast(T('Name your goal first.', 'Сначала опиши цель.')); return; } }
    ob.step = Math.min(1, ob.step + 1); screenOnboarding();
    maybeGenSpec();
  };
  function maybeGenSpec() {
    if (ob.step !== 1) return;
    var key = ob.text + '|' + ob.category;
    if (ob.specKey === key && ob.proofSpec) return; // already have a spec for this goal
    ob.specLoading = true; ob.proofSpec = ''; screenOnboarding();
    var t = ob.text, c = ob.category;
    CertAI.proofSpec(t, c).then(function (r) {
      if (ob.text !== t || ob.category !== c) return; // user changed it; a later call wins
      ob.proofSpec = r || {}; ob.specKey = t + '|' + c; ob.specLoading = false;
      if (ob.step === 1) screenOnboarding();
    });
  }
  window.obRegenSpec = function () { ob.specKey = ''; ob.proofSpec = ''; maybeGenSpec(); };
  window.obFinish = function () {
    S.addGoal({ text: ob.text, category: ob.category, format: ob.format, customDays: ob.customDays, proofSpec: ob.proofSpec });
    ob = { step: 0, text: '', category: 'gym', format: 'daily', customDays: [], tz: '', proofSpec: {}, specLoading: false, specKey: '' };
    toast(T('Day 1. Submit your first proof.', 'День 1. Отправь первый пруф.'));
    go('#/home');
  };

  /* ---- UPGRADE (upsell — was the hard paywall) ---- */
  function screenUpgrade() {
    renderNav(false);
    var paid = S.isPaid();
    view.innerHTML =
      '<div style="padding:14px 4px;">' +
      '<div class="row gap-12" style="margin-bottom:18px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="go(\'#/home\')">←</button>' +
        '<div class="display" style="font-size:18px;">' + T('Cert Pro', 'Cert Pro') + '</div></div>' +
      '<div class="center" style="margin-bottom:22px;">' +
        '<div class="kicker kicker-red" style="margin-bottom:12px;">' + T('Your streak stays free', 'Стрик навсегда бесплатный') + '</div>' +
        '<h1 class="display" style="font-size:30px;margin:0;line-height:1.05;">' + T('Go further', 'Иди дальше') + '<br>' + T('with Pro', 'с Pro') + '</h1>' +
        '<p class="lede" style="color:var(--ink-mute);font-size:14px;line-height:1.6;margin-top:12px;max-width:340px;margin-left:auto;margin-right:auto;">' + T('The free plan is one goal, forever. Pro unlocks more goals, streak freezes, and stats.', 'Бесплатно — одна цель навсегда. Pro открывает больше целей, заморозки стрика и статистику.') + '</p>' +
      '</div>' +

      '<div class="card" style="margin-bottom:16px;">' +
        '<div class="kicker" style="margin-bottom:10px;">' + T('Free vs Pro', 'Free и Pro') + '</div>' +
        proRow(T('1 active goal', '1 активная цель'), T('Multiple goals', 'Несколько целей')) +
        proRow(T('2 photo checks / day', '2 проверки фото / день'), T('Unlimited checks', 'Безлимит проверок')) +
        proRow(T('Unfakeable streak', 'Неподдельный стрик'), T('+ streak freezes', '+ заморозки стрика')) +
        proRow('—', T('Stats & history', 'Статистика и история')) +
        proRow('—', T('Friends challenges (soon)', 'Челленджи с друзьями (скоро)')) +
      '</div>' +

      (paid
        ? '<div class="card card-bronze center"><div class="kicker text-bronze">✓ ' + T('You are on Pro', 'У тебя Pro') + ' — ' + (S.get().user.plan === 'yearly' ? T('Yearly', 'Год') : T('Monthly', 'Месяц')) + '</div></div>'
        : '<div class="price-card featured" style="margin-bottom:14px;">' +
            '<div class="price-badge">' + T('Best value', 'Выгодно') + '</div>' +
            '<div class="price-name">' + T('Yearly', 'Год') + '</div>' +
            '<div class="price-amt">$59.99 <span class="per">' + T('/year', '/год') + '</span></div>' +
            '<div class="price-note">' + T('≈ $5/mo — saves ~50%', '≈ $5/мес — экономия ~50%') + '</div>' +
            '<button class="btn btn-red btn-block" style="margin-top:18px;" onclick="payPro(\'yearly\')">' + T('Go yearly', 'Взять год') + '</button>' +
          '</div>' +
          '<div class="price-card">' +
            '<div class="price-name">' + T('Monthly', 'Месяц') + '</div>' +
            '<div class="price-amt">$9.99 <span class="per">' + T('/month', '/мес') + '</span></div>' +
            '<div class="price-note">' + T('Cancel anytime.', 'Отмена в любой момент.') + '</div>' +
            '<button class="btn btn-ghost btn-block" style="margin-top:18px;" onclick="payPro(\'monthly\')">' + T('Go monthly', 'Взять месяц') + '</button>' +
          '</div>' +
          '<div class="center mono" style="font-size:11px;color:var(--ink-faint);margin-top:16px;">' + T('Demo checkout — no real charge.', 'Демо-оплата — без реального списания.') + '</div>') +
      '</div>';
  }
  function proRow(free, pro) {
    return '<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--bg-3);">' +
      '<div class="mono" style="font-size:12px;color:var(--ink-mute);flex:1;">' + esc(free) + '</div>' +
      '<div class="mono" style="font-size:12px;color:var(--bronze);flex:1;text-align:right;">' + esc(pro) + '</div></div>';
  }
  window.payPro = function (plan) { S.upgrade(plan); toast(T('Welcome to Pro. +1 freeze.', 'Добро в Pro. +1 заморозка.')); go('#/home'); };

  /* ---- HOME (streak-first) ---- */
  function screenHome() {
    renderNav(true);
    var st = S.get();
    var goal = st.goals[0];
    if (!goal) { go('#/onboarding'); return; }

    var done = S.doneToday(goal);
    var lastStatus = (done && goal.history[0]) ? goal.history[0].status : null;
    var attemptsLeft = S.attemptsLeftToday(goal);
    var paid = S.isPaid();

    var appeal = S.appealForToday(goal);
    var appealPending = appeal && appeal.status === 'pending';
    var firstRun = (goal.streak === 0 && (!goal.history || goal.history.length === 0));
    var specHint = pickSpec(goal.proofSpec);
    var multi = st.goals.length > 1;

    var banner;
    if (appealPending) banner = '<div class="kicker text-bronze" style="margin-top:12px;">⏳ ' + T('Appeal under review', 'Аппеляция на рассмотрении') + '</div>';
    else if (done) banner = '<div class="kicker text-green" style="margin-top:12px;">✓ ' + (lastStatus === 'frozen' ? T('Frozen — streak safe today', 'Заморожено — стрик в безопасности') : T('Locked in for today', 'Зачтено на сегодня')) + '</div>';
    else if (firstRun) banner = '<div class="kicker text-bronze" style="margin-top:12px;">★ ' + T('Day one — submit to start your streak', 'День первый — отправь и начни стрик') + '</div>';
    else banner = '<div class="kicker text-red" style="margin-top:12px;">⚠ ' + T('Streak at risk — submit before 23:59', 'Стрик под угрозой — отправь до 23:59') + '</div>';

    /* primary action — exactly one clear CTA */
    var action;
    if (done) {
      action = '<div class="btn btn-ghost btn-block" style="margin-top:16px;cursor:default;opacity:.7;">' + T('Come back tomorrow', 'Возвращайся завтра') + '</div>';
    } else if (S.canSubmit(goal)) {
      action = '<button class="btn btn-red btn-block cta-pulse" style="margin-top:16px;" onclick="go(\'#/submit?goal=' + goal.id + '\')">📷 ' + (firstRun ? T('Submit your first proof', 'Отправить первый пруф') : T('Submit proof', 'Отправить доказательство')) + '</button>';
    } else {
      action = '<div class="card card-hot" style="margin-top:16px;text-align:center;"><div class="mono" style="font-size:13px;color:var(--ink-soft);line-height:1.6;">' + T('No photo checks left today.', 'Проверки фото на сегодня кончились.') + '</div>' +
        '<button class="btn btn-bronze btn-sm btn-block" style="margin-top:10px;" onclick="go(\'#/upgrade\')">' + T('Get unlimited with Pro', 'Безлимит в Pro') + '</button></div>';
    }

    var freezeBtn = (!done && paid && st.user.freezes > 0)
      ? '<button class="btn btn-ghost btn-block btn-sm" style="margin-top:10px;" onclick="freezeToday(\'' + goal.id + '\')">🧊 ' + T('Freeze today', 'Заморозить сегодня') + ' (' + st.user.freezes + ')</button>'
      : '';

    view.innerHTML =
      '<div class="home-grid"><div>' +
      '<div class="streak-block">' +
        '<div class="kicker" style="margin-bottom:2px;">' + T('Current streak', 'Текущий стрик') + '</div>' +
        '<div class="streak-num">' + goal.streak + '</div>' +
        '<div class="kicker" style="margin-top:2px;">' + T('days · verified by the judge', 'дней · заверено судьёй') + '</div>' +
        banner +
      '</div>' +

      '<div class="card" style="margin-top:16px;">' +
        '<div class="row between" style="margin-bottom:8px;"><div class="kicker">' + T("Today's goal", 'Цель на сегодня') + '</div>' +
          '<div class="kicker" style="font-size:10px;">' + catEmoji(goal.category) + ' ' + esc(catName(goal.category)) + '</div></div>' +
        '<div class="mono" style="font-size:14px;color:var(--ink);line-height:1.5;">' + esc(goal.text) + '</div>' +
        (specHint && !done ? '<div class="kicker" style="font-size:10px;margin-top:8px;line-height:1.5;color:var(--bronze);">📸 ' + esc(specHint) + '</div>' : '') +
        '<div class="row between mt-12">' +
          (done
            ? '<div class="kicker ' + (lastStatus === 'approved' ? 'text-green' : 'text-bronze') + '">' + (lastStatus === 'approved' ? '✓ ' + T('Approved today', 'Зачтено сегодня') : '🧊 ' + T('Frozen today', 'Заморожено')) + '</div>'
            : '<div class="kicker text-mute">⏳ ' + T('Not submitted yet', 'Ещё не отправлено') + '</div>') +
          (!paid && !done ? '<div class="kicker" style="font-size:10px;">' + attemptsLeft + ' ' + T('checks left', 'проверок осталось') + '</div>' : '<div class="kicker" style="font-size:10px;">' + T('deadline 23:59', 'дедлайн 23:59') + '</div>') +
        '</div>' +
      '</div>' +

      action + freezeBtn +

      '</div><div>' +
      '<div class="row between" style="margin:0 0 10px;"><div class="kicker">📊 ' + T('Your record', 'Твой рекорд') + '</div>' +
        '<button onclick="go(\'#/stats\')" class="kicker" style="background:none;border:none;color:var(--bronze);cursor:pointer;font-size:10px;letter-spacing:.1em;">' + T('Stats →', 'Статистика →') + '</button></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        statTile(S.rep(), T('Best streak', 'Лучший стрик'), 'var(--bronze)') +
        statTile(S.totalApproved(), T('Days proven', 'Дней доказано'), 'var(--green)') +
      '</div>' +
      '<div class="card" style="margin-top:12px;padding:14px;">' +
        '<div class="kicker text-bronze" style="margin-bottom:6px;">🔒 ' + T('Why it counts', 'Почему это ценно') + '</div>' +
        '<div class="mono" style="font-size:12px;color:var(--ink-mute);line-height:1.6;">' + T('Every day in this streak was checked by an impartial judge. It cannot be faked.', 'Каждый день этого стрика проверил беспристрастный судья. Его нельзя подделать.') + '</div>' +
      '</div>' +
      '</div></div>' +

      // single-goal users: the card above IS their goal — skip the redundant list
      (multi
        ? '<div class="kicker" style="margin:30px 0 10px;">🎯 ' + T('Your goals', 'Твои цели') + ' · ' + st.goals.length + '</div>' + st.goals.map(challengeRow).join('')
        : '') +
      (S.canAddGoal()
        ? '<button class="btn btn-ghost btn-block" style="margin-top:' + (multi ? '6px' : '22px') + ';" onclick="addGoalTap()">+ ' + T('Add a goal', 'Добавить цель') + '</button>'
        : '<button class="btn btn-bronze btn-block" style="margin-top:22px;" onclick="go(\'#/upgrade\')">🔓 ' + T('Add more goals with Pro', 'Больше целей с Pro') + '</button>');
  }

  window.addGoalTap = function () { if (S.canAddGoal()) go('#/onboarding'); else go('#/upgrade'); };
  window.freezeToday = function (goalId) {
    if (S.useFreeze(goalId)) { toast(T('Day frozen — streak preserved.', 'День заморожен — стрик сохранён.')); screenHome(); }
    else { toast(T('No freezes left.', 'Заморозок не осталось.')); }
  };

  /* one goal row with its own submit action (Home + Profile) */
  function challengeRow(g) {
    var done = S.doneToday(g);
    var last = (done && g.history[0]) ? g.history[0].status : null;
    var ap = S.appealForToday(g);
    var status;
    if (ap && ap.status === 'pending') {
      status = '<span class="kicker text-bronze" style="font-size:10px;">⏳ ' + T('appeal', 'аппеляция') + '</span>';
    } else if (done) {
      var badge = last === 'approved' ? '✓ ' + T('today', 'сегодня') : '🧊';
      var col = last === 'approved' ? 'text-green' : 'text-bronze';
      status = '<span class="kicker ' + col + '" style="font-size:10px;">' + badge + '</span>';
    } else if (S.canSubmit(g)) {
      status = '<button class="btn btn-red btn-sm" onclick="go(\'#/submit?goal=' + g.id + '\')">📷 ' + T('Submit', 'Пруф') + '</button>';
    } else {
      status = '<span class="kicker text-mute" style="font-size:10px;">' + T('no checks left', 'нет проверок') + '</span>';
    }
    return '<div class="card" style="padding:14px;margin-bottom:10px;">' +
      '<div class="row between gap-12">' +
        '<div class="row gap-12" style="min-width:0;flex:1;"><span style="font-size:20px;">' + catEmoji(g.category) + '</span>' +
        '<div style="min-width:0;"><div class="mono" style="font-size:13px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(g.text) + '</div>' +
        '<div class="kicker" style="font-size:9px;margin-top:3px;">' + fmtLabel(g.format) + ' · ' + T('best', 'лучший') + ' ' + g.bestStreak + '</div></div></div>' +
        '<div class="row gap-12" style="flex:none;"><span class="lb-streak" style="font-size:16px;">' + g.streak + '<small>' + T('days', 'дней') + '</small></span>' + status + '</div>' +
      '</div></div>';
  }

  /* ---- SUBMIT ---- */
  function screenSubmit(goalId) {
    renderNav(false);
    var goal = S.getGoal(goalId);
    if (!goal) { go('#/home'); return; }
    sub.goalId = goalId;

    if (sub.state === 'analyzing') { renderAnalyzing(goal); return; }
    if (sub.state === 'verdict') { renderVerdict(goal); return; }

    // already done today
    if (S.doneToday(goal)) { go('#/home'); return; }

    var attemptsLeft = S.attemptsLeftToday(goal);
    // out of attempts
    if (attemptsLeft <= 0) {
      view.innerHTML =
        '<div class="row gap-12" style="margin-bottom:18px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="go(\'#/home\')">←</button>' +
          '<div class="display" style="font-size:18px;">' + T('Submit proof', 'Доказательство') + '</div></div>' +
        '<div class="card card-hot center"><div class="display text-red" style="font-size:20px;">' + T('No checks left today', 'Проверки кончились') + '</div>' +
          '<div class="kicker" style="font-size:10px;margin:10px 0 14px;">' + T('Free plan: ' + S.FREE_DAILY_ATTEMPTS + ' photo checks per day. Come back tomorrow.', 'Бесплатно: ' + S.FREE_DAILY_ATTEMPTS + ' проверки фото в день. Возвращайся завтра.') + '</div>' +
          '<button class="btn btn-bronze btn-sm btn-block" onclick="go(\'#/upgrade\')">' + T('Get unlimited with Pro', 'Безлимит в Pro') + '</button></div>';
      return;
    }

    var paid = S.isPaid();
    var dc = dailyCheck(goal.id);
    view.innerHTML =
      '<div class="row gap-12" style="margin-bottom:18px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="go(\'#/home\')">←</button>' +
        '<div class="display" style="font-size:18px;">' + T('Submit proof', 'Доказательство') + '</div></div>' +

      (sub.photo
        ? '<div class="verdict-photo" style="background-image:url(' + sub.photo + ');"></div>'
        : '<div class="scanner" style="display:flex;align-items:center;justify-content:center;flex-direction:column;animation:none;">' +
            '<div style="font-size:54px;opacity:.4;">📷</div>' +
            '<div class="mono" style="font-size:12px;color:var(--ink-faint);margin-top:10px;text-align:center;padding:0 24px;line-height:1.6;">' + T('Take or upload a photo that proves your goal today', 'Сфотографируй или загрузи фото-доказательство') + '</div>' +
          '</div>') +

      '<div class="card" style="margin-top:14px;background:var(--surface-2);border-color:var(--bronze-dim);">' +
        '<div class="kicker text-bronze" style="margin-bottom:6px;">📸 ' + T('Send a photo like this', 'Пришли такое фото') + '</div>' +
        '<div class="mono" style="font-size:13px;color:var(--ink);line-height:1.5;">' + esc(pickSpec(goal.proofSpec) || goal.text) + '</div>' +
        (pickSpec(goal.proofSpec) ? '<div class="kicker" style="font-size:9px;margin-top:8px;">🎯 ' + esc(goal.text) + '</div>' : '') +
      '</div>' +

      '<div class="card" style="margin-top:12px;border-color:var(--red-dim);background:linear-gradient(135deg,#150a0b,#0d0c0b);">' +
        '<div class="kicker text-red" style="margin-bottom:6px;">🔄 ' + T("Today's anti-cheat check", 'Проверка против повтора') + '</div>' +
        '<div class="mono" style="font-size:13px;color:var(--ink);line-height:1.5;">' + esc(dc.text) + '</div>' +
        '<div class="kicker" style="font-size:9px;margin-top:6px;">' + T("Changes daily — an old photo won't pass.", 'Меняется каждый день — старое фото не подойдёт.') + '</div>' +
      '</div>' +

      '<div class="kicker" style="margin-top:12px;font-size:10px;line-height:1.7;">⚡ ' + T('AI judges in ~5s · a reject resets your streak — you can appeal once', 'ИИ судит за ~5с · отказ обнуляет стрик — можно оспорить 1 раз') +
        (paid ? '' : ' · <span class="text-bronze">' + attemptsLeft + ' ' + T('checks left today', 'проверок сегодня') + '</span>') + '</div>' +

      '<input id="photo-input" type="file" accept="image/*" capture="environment" style="display:none" onchange="onPhoto(event)">' +
      '<div class="row gap-12" style="margin-top:18px;">' +
        '<button class="btn btn-ghost" style="flex:1;" onclick="pickPhoto()">📁 ' + (sub.photo ? T('Retake', 'Заново') : T('Choose', 'Выбрать')) + '</button>' +
        (sub.photo
          ? '<button class="btn btn-red" style="flex:2;" onclick="sendToJudge()">⚖️ ' + T('Send to judge', 'Судить') + '</button>'
          : '<button class="btn btn-red" style="flex:2;" onclick="pickPhoto()">📷 ' + T('Add photo', 'Добавить фото') + '</button>') +
      '</div>' +
      '<div class="center" style="margin-top:14px;"><button onclick="toggleForceReject()" class="mono" style="background:none;border:none;color:var(--ink-faint);font-size:11px;text-decoration:underline;cursor:pointer;">' +
        (sub.forceReject ? '⚠ ' + T('Demo: will force a REJECT', 'Демо: будет ОТКАЗ') : T('Demo: simulate a wrong photo', 'Демо: симулировать плохое фото')) + '</button></div>';
  }
  window.pickPhoto = function () { document.getElementById('photo-input').click(); };
  window.onPhoto = function (e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () { sub.photo = r.result; screenSubmit(sub.goalId); };
    r.readAsDataURL(f);
  };
  window.toggleForceReject = function () { sub.forceReject = !sub.forceReject; screenSubmit(sub.goalId); };
  window.sendToJudge = function () {
    if (!sub.photo) { toast(T('Add a photo first.', 'Сначала добавь фото.')); return; }
    var goal = S.getGoal(sub.goalId);
    if (!S.canSubmit(goal)) { go('#/home'); return; }
    sub.state = 'analyzing'; screenSubmit(sub.goalId);
    CertAI.judge({ photo: sub.photo, goalText: goal.text, category: goal.category, proofSpec: pickSpec(goal.proofSpec, 'en'), dailyReq: dailyCheck(goal.id).en, forceReject: sub.forceReject })
      .then(function (res) {
        sub.verdict = res;
        if (!res.error) {                      // a real verdict — spend an attempt, record it
          S.recordAttempt(sub.goalId);
          S.recordVerdict(sub.goalId, res.approved, res.reason);
        }
        sub.state = 'verdict'; screenSubmit(sub.goalId);
      });
  };
  function renderAnalyzing(goal) {
    view.innerHTML =
      '<div class="row gap-12" style="margin-bottom:18px;"><div class="display" style="font-size:18px;">' + T('Judging…', 'Судим…') + '</div></div>' +
      '<div class="scanner"><div class="scan-line"></div>' +
        (sub.photo ? '<img src="' + sub.photo + '" style="width:100%;height:100%;object-fit:cover;opacity:.5;">' : '') +
      '</div>' +
      '<div class="center mono" style="margin-top:20px;color:var(--ink-mute);font-size:13px;">' + T('The AI judge is analyzing your photo against your goal…', 'ИИ-судья анализирует фото по твоей цели…') + '</div>' +
      '<div class="center kicker kicker-red" style="margin-top:10px;">' + T('honest verdict', 'честный вердикт') + '</div>';
  }
  function renderVerdict(goal) {
    renderNav(false);
    var v = sub.verdict;
    if (v.error) {                              // judge unreachable — no streak change, ask to retry
      view.innerHTML =
        '<div style="padding:8px 4px;">' +
        '<div class="card card-hot center" style="margin-top:24px;">' +
          '<div style="font-size:46px;">⏳</div>' +
          '<div class="display" style="font-size:20px;margin-top:8px;">' + T('Judge is busy', 'Судья занят') + '</div>' +
          '<div class="mono" style="font-size:13px;color:var(--ink-soft);line-height:1.6;margin-top:10px;">' + esc(v.reason || T('Could not reach the judge. Your streak is untouched — try again.', 'Не удалось связаться с судьёй. Стрик не тронут — попробуй снова.')) + '</div>' +
        '</div>' +
        '<button class="btn btn-red btn-block" style="margin-top:14px;" onclick="retrySubmit()">' + T('Try again', 'Попробовать снова') + '</button>' +
        '<button class="btn btn-ghost btn-block" style="margin-top:10px;" onclick="afterVerdict()">' + T('Back to home', 'На главную') + '</button>' +
        '</div>';
      return;
    }
    var ok = v.approved;
    var color = ok ? 'var(--green)' : 'var(--red)';
    var attemptsLeft = S.attemptsLeftToday(goal);

    view.innerHTML =
      '<div style="padding:8px 4px;">' +
      '<div class="verdict-photo" style="background-image:url(' + (sub.photo || '') + ');border-color:' + color + ';box-shadow:inset 0 0 60px ' + (ok ? 'rgba(52,199,89,.15)' : 'rgba(226,59,46,.15)') + ';"></div>' +
      '<div class="verdict-badge" style="color:' + color + ';margin-top:24px;text-shadow:0 0 40px ' + (ok ? 'rgba(52,199,89,.4)' : 'rgba(226,59,46,.4)') + ';">' + (ok ? T('APPROVED', 'ЗАЧТЕНО') : T('REJECTED', 'ОТКАЗ')) + '</div>' +
      '<p class="center mono" style="color:var(--ink-soft);font-size:13px;line-height:1.6;margin:8px auto 22px;max-width:340px;">' + esc(v.reason) + '</p>' +

      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        statTile(goal.streak, T('Day streak', 'Стрик'), ok ? 'var(--bronze)' : 'var(--red)') +
        statTile(goal.bestStreak, T('Best streak', 'Лучший'), 'var(--bronze)') +
      '</div>' +

      (ok
        ? '<button class="btn btn-bronze btn-block" style="margin-top:18px;" onclick="afterVerdict()">' + T('Back to home →', 'На главную →') + '</button>'
        : '<div class="card card-hot center" style="margin-top:18px;"><div class="mono" style="font-size:13px;color:var(--ink-soft);line-height:1.6;">🔻 ' + T('Your streak reset to zero. A new one can start today.', 'Стрик обнулился. Новый можно начать сегодня же.') + '</div></div>' +
          (S.canAppeal(goal)
            ? '<button class="btn btn-bronze btn-block" style="margin-top:14px;" onclick="go(\'#/appeal?goal=' + goal.id + '\')">⚖️ ' + T('Think the judge is wrong? Appeal', 'Судья ошибся? Оспорить') + '</button>'
            : '') +
          (S.canSubmit(goal)
            ? '<button class="btn btn-red btn-block" style="margin-top:10px;" onclick="retrySubmit()">' + T('Try again', 'Ещё раз') + (S.isPaid() ? '' : ' (' + attemptsLeft + ')') + '</button>'
            : '') +
          '<button class="btn btn-ghost btn-block" style="margin-top:10px;" onclick="afterVerdict()">' + T('Back to home', 'На главную') + '</button>') +
      '</div>';
  }
  function statTile(val, label, color) {
    return '<div class="card center" style="padding:16px;"><div class="display" style="font-size:28px;color:' + color + ';">' + val + '</div><div class="kicker" style="font-size:9px;margin-top:4px;">' + label + '</div></div>';
  }
  window.afterVerdict = function () { sub = { state: 'capture', photo: null, forceReject: false, verdict: null, goalId: null }; go('#/home'); };
  window.retrySubmit = function () { var id = sub.goalId; sub = { state: 'capture', photo: null, forceReject: false, verdict: null, goalId: id }; screenSubmit(id); };

  /* ---- PROFILE ---- */
  function screenProfile() {
    renderNav(true);
    var st = S.get();
    var u = st.user;
    var paid = S.isPaid();

    var goalsList = st.goals.length
      ? st.goals.map(challengeRow).join('')
      : '<div class="kicker center" style="padding:20px;">' + T('No goals yet.', 'Целей пока нет.') + '</div>';

    view.innerHTML =
      '<div class="center" style="margin-bottom:20px;">' +
        '<div class="app-avatar" style="width:64px;height:64px;font-size:28px;margin:0 auto 12px;">' + esc((u.name || 'Z').slice(0, 1).toUpperCase()) + '</div>' +
        '<div class="display" style="font-size:22px;">' + esc(u.name) + '</div>' +
        '<div class="kicker" style="margin-top:4px;">' + esc(u.email) + '</div>' +
        '<div class="kicker text-bronze" style="margin-top:6px;">' + (paid ? (u.plan === 'yearly' ? T('Cert Pro · Yearly', 'Cert Pro · Год') : T('Cert Pro · Monthly', 'Cert Pro · Месяц')) : T('Free plan', 'Бесплатный план')) + '</div>' +
      '</div>' +

      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">' +
        statTile(S.rep(), T('Best streak', 'Лучший'), 'var(--bronze)') +
        statTile(S.totalApproved(), T('Days proven', 'Доказано'), 'var(--green)') +
        statTile(paid ? u.freezes : '—', T('Freezes', 'Заморозки'), paid ? 'var(--green)' : 'var(--ink-faint)') +
      '</div>' +
      '<button class="btn btn-ghost btn-block" style="margin-top:12px;" onclick="go(\'#/stats\')">📊 ' + T('View statistics', 'Подробная статистика') + '</button>' +

      (paid
        ? '<div class="kicker" style="margin:24px 0 8px;">🧊 ' + T('Buy freezes', 'Купить заморозки') + '</div>' +
          '<div class="row gap-12">' + freezeBuyBtn(1, '$2') + freezeBuyBtn(3, '$5') + freezeBuyBtn(5, '$7') + '</div>'
        : '<div class="card card-bronze" style="margin-top:24px;text-align:center;">' +
            '<div class="kicker text-bronze" style="margin-bottom:6px;">🔓 ' + T('Cert Pro', 'Cert Pro') + '</div>' +
            '<div class="mono" style="font-size:12px;color:var(--ink-mute);line-height:1.6;margin-bottom:12px;">' + T('More goals, unlimited checks, streak freezes, stats.', 'Больше целей, безлимит проверок, заморозки, статистика.') + '</div>' +
            '<button class="btn btn-red btn-sm btn-block" onclick="go(\'#/upgrade\')">' + T('See Pro', 'Смотреть Pro') + '</button></div>') +

      '<div class="kicker" style="margin:24px 0 8px;">🎯 ' + T('Your goals', 'Твои цели') + '</div>' + goalsList +

      '<button class="btn btn-ghost btn-block" style="margin-top:12px;" onclick="go(\'#/admin\')">🛡 ' + T('Appeals review (admin)', 'Разбор аппеляций (админ)') + (S.pendingAppeals().length ? ' · ' + S.pendingAppeals().length : '') + '</button>' +

      '<div class="row gap-12" style="margin-top:14px;">' +
        '<button class="btn btn-ghost" style="flex:1;" onclick="go(\'#/settings\')">⚙ ' + T('Settings', 'Настройки') + '</button>' +
        '<button class="btn btn-ghost" style="flex:1;" onclick="doLogout()">' + T('Log out', 'Выйти') + '</button>' +
      '</div>';
  }
  function freezeBuyBtn(n, price) {
    return '<button class="btn btn-ghost" style="flex:1;flex-direction:column;gap:2px;padding:14px 4px;" onclick="buyFreeze(' + n + ')">' +
      '<span class="display text-bronze" style="font-size:18px;">' + n + '</span>' +
      '<span class="mono" style="font-size:11px;color:var(--ink-mute);">' + price + '</span></button>';
  }
  window.buyFreeze = function (n) { S.buyFreezes(n); toast(T('+' + n + ' freeze(s) added', '+' + n + ' заморозок')); screenProfile(); };
  window.doLogout = function () { S.logout(); syncChrome(); go('#/auth'); };

  /* ---- SETTINGS ---- */
  function screenSettings() {
    renderNav(false);
    var u = S.get().user;
    view.innerHTML =
      '<div class="row gap-12" style="margin-bottom:18px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="go(\'#/profile\')">←</button>' +
        '<div class="display" style="font-size:18px;">' + T('Settings', 'Настройки') + '</div></div>' +

      '<div class="card" style="margin-bottom:12px;">' +
        '<div class="kicker" style="margin-bottom:8px;">' + T('Time zone', 'Часовой пояс') + '</div>' +
        '<div class="mono" style="font-size:14px;color:var(--ink);">' + esc(u.timezone) + '</div>' +
      '</div>' +

      '<div class="card" style="margin-bottom:12px;">' +
        '<div class="kicker" style="margin-bottom:8px;">' + T('Language', 'Язык') + '</div>' +
        '<div class="row gap-12">' +
          '<button class="btn btn-sm ' + (CertI18n.lang === 'en' ? 'btn-red' : 'btn-ghost') + '" onclick="appSetLang(\'en\')">English</button>' +
          '<button class="btn btn-sm ' + (CertI18n.lang === 'ru' ? 'btn-red' : 'btn-ghost') + '" onclick="appSetLang(\'ru\')">Русский</button>' +
        '</div>' +
      '</div>' +

      '<div class="card" style="margin-bottom:12px;">' +
        '<div class="kicker" style="margin-bottom:8px;">' + T('Plan', 'Тариф') + '</div>' +
        '<div class="mono" style="font-size:13px;color:var(--ink);">' + (S.isPaid() ? (u.plan === 'yearly' ? T('Pro — $59.99/yr', 'Pro — $59.99/год') : T('Pro — $9.99/mo', 'Pro — $9.99/мес')) : T('Free', 'Бесплатный')) + '</div>' +
        (!S.isPaid() ? '<button class="btn btn-bronze btn-sm btn-block" style="margin-top:10px;" onclick="go(\'#/upgrade\')">' + T('Upgrade to Pro', 'Перейти на Pro') + '</button>' : '') +
      '</div>' +

      '<div class="card card-hot" style="margin-top:24px;">' +
        '<div class="kicker text-red" style="margin-bottom:8px;">' + T('Danger zone', 'Опасная зона') + '</div>' +
        '<div class="mono" style="font-size:12px;color:var(--ink-mute);line-height:1.6;margin-bottom:12px;">' + T('Delete account: plan cancels immediately, data anonymized after 30 days.', 'Удаление: тариф отменяется сразу, данные анонимизируются через 30 дней.') + '</div>' +
        '<button class="btn btn-red btn-sm btn-block" onclick="confirmDelete()">' + T('Delete account', 'Удалить аккаунт') + '</button>' +
      '</div>';
  }
  window.confirmDelete = function () {
    if (confirm(T('Delete your account and all data? This cannot be undone.', 'Удалить аккаунт и все данные? Необратимо.'))) {
      S.deleteAccount(); syncChrome(); go('#/auth');
    }
  };

  /* ---- APPEAL (user files an appeal on a rejected verdict) ---- */
  function screenAppeal(goalId) {
    renderNav(false);
    var goal = S.getGoal(goalId);
    if (!goal) { go('#/home'); return; }
    var h = goal.history[0];
    if (!S.canAppeal(goal)) {
      view.innerHTML =
        '<div class="row gap-12" style="margin-bottom:18px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="go(\'#/home\')">←</button>' +
          '<div class="display" style="font-size:18px;">' + T('Appeal', 'Аппеляция') + '</div></div>' +
        '<div class="card center"><div class="mono" style="font-size:13px;color:var(--ink-mute);line-height:1.6;">' +
          (S.appealForToday(goal) ? T('You already appealed today — it is under review.', 'Ты уже оспорил сегодня — на рассмотрении.')
            : S.appealsLeft() <= 0 ? T('No appeals left this month.', 'Аппеляции на этот месяц закончились.')
            : T('Nothing to appeal here.', 'Тут нечего оспаривать.')) + '</div>' +
          '<button class="btn btn-ghost btn-sm btn-block" style="margin-top:12px;" onclick="go(\'#/home\')">' + T('Back', 'Назад') + '</button></div>';
      return;
    }
    view.innerHTML =
      '<div class="row gap-12" style="margin-bottom:18px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="go(\'#/home\')">←</button>' +
        '<div class="display" style="font-size:18px;">' + T('Appeal the verdict', 'Оспорить вердикт') + '</div></div>' +
      '<div class="card card-hot" style="margin-bottom:14px;"><div class="kicker text-red" style="margin-bottom:6px;">' + T('The judge said', 'Судья сказал') + '</div>' +
        '<div class="mono" style="font-size:13px;color:var(--ink-soft);line-height:1.5;">' + esc(h.reason || '') + '</div></div>' +
      '<label class="field-label">' + T('What does the photo actually show?', 'Что на самом деле на фото?') + '</label>' +
      '<textarea id="appeal-note" class="field-textarea" rows="3" placeholder="' + T('e.g. The book is open on the desk, page visible at bottom-left', 'напр. Книга открыта на столе, страница видна слева внизу') + '"></textarea>' +
      '<div class="kicker" style="font-size:10px;margin-top:10px;line-height:1.7;">' + T('A reviewer checks it. If the judge was wrong, your streak is restored.', 'Заявку проверит человек. Если судья ошибся — стрик восстановят.') + '<br>' + T('Appeals left this month', 'Аппеляций в этом месяце') + ': ' + S.appealsLeft() + '</div>' +
      '<button class="btn btn-red btn-block" style="margin-top:18px;" onclick="submitAppeal(\'' + goal.id + '\')">' + T('Send for review →', 'Отправить на разбор →') + '</button>';
  }
  window.submitAppeal = function (goalId) {
    var goal = S.getGoal(goalId);
    if (!goal || !S.canAppeal(goal)) { go('#/home'); return; }
    var el = document.getElementById('appeal-note');
    S.createAppeal(goalId, goal.history[0].date, el ? el.value.trim() : '');
    toast(T('Sent for review.', 'Отправлено на рассмотрение.'));
    go('#/home');
  };

  /* ---- ADMIN: appeal review (founder tool during validation; becomes a 2nd
     AI pass at scale per CONCEPT.md) ---- */
  function screenAdmin() {
    renderNav(true);
    var pend = S.pendingAppeals();
    var rows = pend.length
      ? pend.map(adminAppealRow).join('')
      : '<div class="card center"><div class="kicker">' + T('No appeals to review.', 'Нет аппеляций на рассмотрении.') + '</div></div>';
    view.innerHTML =
      '<div class="row between" style="margin-bottom:8px;"><div class="display" style="font-size:22px;">🛡 ' + T('Appeals review', 'Разбор аппеляций') + '</div></div>' +
      '<div class="kicker" style="margin-bottom:16px;">' + T('You are the judge of last resort — for now. No photo stored in this demo; judge by the note.', 'Ты судья последней инстанции — пока что. В демо фото не хранится; суди по пояснению.') + '</div>' +
      rows;
  }
  function adminAppealRow(a) {
    return '<div class="card" style="margin-bottom:12px;">' +
      '<div class="kicker text-bronze" style="margin-bottom:6px;">🎯 ' + esc(a.goalText || '') + ' · ' + esc(a.date) + '</div>' +
      '<div class="kicker text-red" style="margin-bottom:4px;">' + T('Judge said', 'Судья') + '</div>' +
      '<div class="mono" style="font-size:12px;color:var(--ink-mute);line-height:1.5;margin-bottom:8px;">' + esc(a.reason || '—') + '</div>' +
      '<div class="kicker" style="margin-bottom:4px;">' + T('User says', 'Юзер') + '</div>' +
      '<div class="mono" style="font-size:12px;color:var(--ink);line-height:1.5;margin-bottom:6px;">' + esc(a.note || T('(no note)', '(без пояснения)')) + '</div>' +
      '<div class="kicker" style="font-size:9px;margin-bottom:12px;">' + T('Approving restores streak to', 'Одобрение восстановит стрик до') + ' ' + ((a.streakBefore || 0) + 1) + '</div>' +
      '<div class="row gap-12">' +
        '<button class="btn btn-ghost" style="flex:1;" onclick="resolveAppealTap(\'' + a.id + '\',false)">✕ ' + T('Reject', 'Отклонить') + '</button>' +
        '<button class="btn btn-bronze" style="flex:1;" onclick="resolveAppealTap(\'' + a.id + '\',true)">✓ ' + T('Restore streak', 'Восстановить') + '</button>' +
      '</div></div>';
  }
  window.resolveAppealTap = function (id, approved) {
    S.resolveAppeal(id, approved);
    toast(approved ? T('Streak restored.', 'Стрик восстановлен.') : T('Appeal rejected.', 'Аппеляция отклонена.'));
    screenAdmin();
  };

  /* ---- STATISTICS (heatmap + headline numbers) ---- */
  function statLegend(c, l) {
    return '<div class="row" style="align-items:center;gap:5px;"><span style="width:11px;height:11px;border-radius:2px;background:' + c + ';display:inline-block;"></span><span class="kicker" style="font-size:9px;">' + l + '</span></div>';
  }
  function screenStats() {
    renderNav(true);
    var st = S.get();
    var goal = st.goals[0];
    if (!goal) { go('#/home'); return; }

    // day -> best status that day (approved > frozen > rejected)
    var prio = { approved: 3, frozen: 2, rejected: 1 };
    var map = {};
    (goal.history || []).forEach(function (h) { var p = prio[h.status] || 0; if (p && p > (map[h.date] || 0)) map[h.date] = p; });
    var colorFor = function (v) { return v === 3 ? 'var(--green)' : v === 2 ? '#3a6ea5' : v === 1 ? 'var(--red)' : 'var(--bg-3)'; };

    var today = new Date();
    var cells = '';
    for (var i = 34; i >= 0; i--) {
      var d = new Date(today); d.setDate(today.getDate() - i);
      var ds = d.toISOString().slice(0, 10);
      var v = map[ds] || 0;
      var isToday = ds === S.todayStr();
      cells += '<div title="' + ds + '" style="width:100%;aspect-ratio:1;border-radius:3px;background:' + colorFor(v) + ';' + (isToday ? 'outline:2px solid var(--bronze);outline-offset:-1px;' : '') + '"></div>';
    }

    view.innerHTML =
      '<div class="row gap-12" style="margin-bottom:18px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="go(\'#/profile\')">←</button>' +
        '<div class="display" style="font-size:20px;">📊 ' + T('Statistics', 'Статистика') + '</div></div>' +

      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        statTile(goal.streak, T('Current streak', 'Текущий стрик'), 'var(--bronze)') +
        statTile(S.rep(), T('Best streak', 'Лучший стрик'), 'var(--bronze)') +
        statTile(S.totalApproved(), T('Days proven', 'Дней доказано'), 'var(--green)') +
        statTile(S.successRate() + '%', T('Success rate', '% успеха'), 'var(--ink)') +
      '</div>' +

      '<div class="kicker" style="margin:24px 0 10px;">🔥 ' + T("Don't break the chain — last 5 weeks", 'Не рви цепь — последние 5 недель') + '</div>' +
      '<div class="card" style="padding:16px;">' +
        '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;">' + cells + '</div>' +
        '<div class="row" style="margin-top:14px;gap:14px;flex-wrap:wrap;">' +
          statLegend('var(--green)', T('done', 'зачтено')) + statLegend('var(--red)', T('rejected', 'отказ')) + statLegend('#3a6ea5', T('frozen', 'заморозка')) + statLegend('var(--bg-3)', T('none', 'нет')) +
        '</div>' +
      '</div>' +
      (st.goals.length > 1 ? '<div class="kicker" style="margin-top:14px;font-size:9px;">' + T('Heatmap shows your main goal.', 'Хитмап по основной цели.') + '</div>' : '');
  }

  /* =====================================================================
     PHASE 2 — PARKED (friends / groups). Kept for the next phase; not
     reachable from the solo flow. Re-link in renderNav + route() to revive.
     ===================================================================== */
  // function screenGroups() { ... }   // group catalog + leaderboards
  // function screenJoin(groupId) { ... } // join a group challenge
  // function screenBlocked(goalId) { ... } // 3-strikes block + reactivation

  /* =====================================================================
     ROUTER + GUARDS
     ===================================================================== */
  function route() {
    syncChrome();
    var r = parseHash();
    var st = S.get();

    // auth guard
    if (!st.user) {
      if (r.path !== '#/auth') { go('#/auth'); return; }
      screenAuth(); return;
    }
    // onboarding guard — need at least one goal (no paywall guard anymore)
    if (st.goals.length === 0 && r.path !== '#/onboarding') { go('#/onboarding'); return; }

    switch (r.path) {
      case '#/auth': go('#/home'); break;
      case '#/onboarding': screenOnboarding(); break;
      case '#/upgrade': screenUpgrade(); break;
      case '#/home': screenHome(); break;
      case '#/submit': screenSubmit(r.q.goal); break;
      case '#/appeal': screenAppeal(r.q.goal); break;
      case '#/admin': screenAdmin(); break;
      case '#/stats': screenStats(); break;
      case '#/profile': screenProfile(); break;
      case '#/settings': screenSettings(); break;
      // parked phase-2 routes → home
      case '#/groups':
      case '#/join':
      case '#/blocked':
      case '#/paywall': go('#/home'); break;
      default: screenHome();
    }
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', function () {
    // reset submit flow when leaving submit
    if (location.hash.indexOf('#/submit') !== 0) sub = { state: 'capture', photo: null, forceReject: false, verdict: null, goalId: null };
    route();
  });

  // boot
  document.documentElement.lang = CertI18n.lang;
  if (!location.hash) location.hash = '#/home';
  route();
})();
