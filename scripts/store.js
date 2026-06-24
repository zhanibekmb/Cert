/* =====================================================================
   CERT — client state (localStorage demo backend)
   Concept (CONCEPT.md): solo, unfakeable streak, freemium.
   FREE  = 1 active goal, 2 photo attempts/day, full streak.
   PAID  = multiple goals, streak freezes, stats (+ friends, phase 2).
   Mechanic: a rejected day resets the streak to 0. No strikes/blocked.
   Swap these functions for real API calls later — the rest of the app
   only talks to CertStore, never to localStorage directly.
   ===================================================================== */
(function (global) {
  'use strict';

  var KEY = 'cert_state_v2';            // bumped: data model changed

  /* ---- freemium limits ---- */
  var FREE_GOAL_LIMIT = 1;              // free: one active goal
  var FREE_DAILY_ATTEMPTS = 2;         // free: photo verdicts/day/goal (Gemini cost guard)
  var APPEAL_LIMIT_FREE = 1;           // free: appeals per calendar month
  var APPEAL_LIMIT_PAID = 5;           // pro:  appeals per calendar month

  /* ---- PHASE 2 (parked): public group catalog + demo social proof ----
     Kept so the friends/groups phase can switch back on without a rebuild.
     Not surfaced anywhere in the solo flow. */
  var GROUPS = [
    { id: 'gym',     emoji: '🏋️', name: 'Gym Warriors',  name_ru: 'Воины зала',     rule: 'A photo proving a real workout: equipment, gym interior, sweat or form.', members: 248, format: 'daily' },
    { id: 'run',     emoji: '🏃', name: 'Road Runners',  name_ru: 'Бегуны',          rule: 'A photo during or right after a run: route, tracker, outdoor setting.',    members: 176, format: 'daily' },
    { id: 'read',    emoji: '📚', name: 'Daily Readers', name_ru: 'Читатели',        rule: 'A photo of a specific book page you read today.',                          members: 91,  format: 'daily' },
    { id: 'diet',    emoji: '🥗', name: 'Clean Plate',   name_ru: 'Чистая тарелка',  rule: 'A photo of a healthy meal on a plate.',                                    members: 134, format: 'daily' },
    { id: 'code',    emoji: '💻', name: 'Ship Daily',    name_ru: 'Код каждый день', rule: 'A screenshot of an IDE, commit, or notebook proving coding work.',          members: 203, format: 'weekdays' },
    { id: 'meditate',emoji: '🧘', name: 'Stillness',     name_ru: 'Медитация',       rule: 'A photo of your meditation or yoga setup / pose.',                         members: 67,  format: 'daily' },
    { id: 'create',  emoji: '🎨', name: 'Makers',        name_ru: 'Творцы',          rule: 'A photo of creative work in progress: canvas, sketch, tool in hand.',      members: 58,  format: '3x' }
  ];

  /* category palette reused for the solo goal picker */
  var CATS = GROUPS.map(function (g) { return { id: g.id, emoji: g.emoji, name: g.name, name_ru: g.name_ru }; });
  // "Other" — for goals outside the preset categories; judged purely by the goal text.
  CATS.push({ id: 'other', emoji: '✨', name: 'Other', name_ru: 'Другое' });

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function blank() {
    return {
      user: null,            // { email, name, timezone, plan, freezes, referralCode, createdAt }
      goals: [],             // solo goals
      appeals: [],           // { id, goalId, date, note, status, streakBefore, reason, createdAt }
      lang: localStorage.getItem('cert_lang') || 'en'
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var s = JSON.parse(raw);
      if (!s.lang) s.lang = localStorage.getItem('cert_lang') || 'en';
      if (!Array.isArray(s.appeals)) s.appeals = [];
      return s;
    } catch (e) { return blank(); }
  }

  function save(s) {
    localStorage.setItem(KEY, JSON.stringify(s));
    if (s.lang) localStorage.setItem('cert_lang', s.lang);
  }

  var state = load();

  function genRef() { return 'cert-' + Math.random().toString(36).slice(2, 8); }

  function isPaidPlan(plan) { return plan === 'monthly' || plan === 'yearly'; }

  var Store = {
    GROUPS: GROUPS,       // parked (phase 2)
    CATS: CATS,
    FREE_GOAL_LIMIT: FREE_GOAL_LIMIT,
    FREE_DAILY_ATTEMPTS: FREE_DAILY_ATTEMPTS,

    get: function () { return state; },
    reload: function () { state = load(); return state; },

    isAuthed: function () { return !!state.user; },
    isPaid: function () { return !!(state.user && isPaidPlan(state.user.plan)); },

    /* ---- auth (demo) ---- */
    signup: function (email, name, timezone) {
      state.user = {
        email: email,
        name: name || email.split('@')[0],
        timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        plan: 'free',
        freezes: 0,
        referralCode: genRef(),
        createdAt: new Date().toISOString()
      };
      save(state);
      return state.user;
    },
    logout: function () {
      state = blank();
      localStorage.removeItem(KEY);
      save(state);
    },
    deleteAccount: function () {
      localStorage.removeItem(KEY);
      state = blank();
    },

    /* ---- upgrade to paid (unlocks multiple goals + freezes) ---- */
    upgrade: function (plan) {
      if (!state.user) return;
      state.user.plan = isPaidPlan(plan) ? plan : 'monthly';
      if (state.user.freezes < 1) state.user.freezes = 1; // welcome freeze
      save(state);
    },

    /* ---- goals ---- */
    activeGoals: function () { return state.goals; },
    canAddGoal: function () {
      if (this.isPaid()) return true;
      return state.goals.length < FREE_GOAL_LIMIT;
    },
    addGoal: function (g) {
      var goal = {
        id: 'g' + Date.now() + Math.floor(Math.random() * 99),
        text: g.text,
        category: g.category || 'gym',
        format: g.format || 'daily',
        customDays: g.customDays || [],
        groupId: g.groupId || null,        // null in solo; used by phase 2
        proofSpec: g.proofSpec || '',      // AI-generated "what photo to send"
        streak: 0,
        bestStreak: 0,
        history: [],                       // { date, status: 'approved'|'rejected'|'frozen', reason }
        lastSubmit: null,
        attempts: { date: null, count: 0 },// daily attempt counter (free tier guard)
        createdAt: new Date().toISOString()
      };
      state.goals.push(goal);
      save(state);
      return goal;
    },
    getGoal: function (id) {
      for (var i = 0; i < state.goals.length; i++) if (state.goals[i].id === id) return state.goals[i];
      return null;
    },
    removeGoal: function (id) {
      state.goals = state.goals.filter(function (g) { return g.id !== id; });
      save(state);
    },
    setProofSpec: function (id, spec) {
      var g = this.getGoal(id);
      if (g) { g.proofSpec = spec || ''; save(state); }
    },

    /* ---- daily state ---- */
    submittedToday: function (goal) { return goal.lastSubmit === todayStr(); },
    // "done" for today = approved or frozen (a rejected day still allows a retry if attempts remain)
    doneToday: function (goal) {
      return this.submittedToday(goal) && goal.history[0] &&
             (goal.history[0].status === 'approved' || goal.history[0].status === 'frozen');
    },
    attemptsLeftToday: function (goal) {
      if (this.isPaid()) return Infinity;
      var used = (goal.attempts && goal.attempts.date === todayStr()) ? goal.attempts.count : 0;
      return Math.max(0, FREE_DAILY_ATTEMPTS - used);
    },
    canSubmit: function (goal) {
      if (this.doneToday(goal)) return false;
      return this.attemptsLeftToday(goal) > 0;
    },
    recordAttempt: function (goalId) {
      var g = this.getGoal(goalId);
      if (!g) return;
      var t = todayStr();
      if (!g.attempts || g.attempts.date !== t) g.attempts = { date: t, count: 0 };
      g.attempts.count += 1;
      save(state);
    },

    /* record an AI verdict against a goal */
    recordVerdict: function (goalId, approved, reason) {
      var g = this.getGoal(goalId);
      if (!g) return;
      var today = todayStr();
      g.lastSubmit = today;
      if (approved) {
        g.streak += 1;
        if (g.streak > g.bestStreak) g.bestStreak = g.streak;
        g.history.unshift({ date: today, status: 'approved', reason: reason });
      } else {
        // the punishment: the unfakeable streak resets to zero.
        // remember what it was, so a successful appeal can restore it.
        var before = g.streak;
        g.streak = 0;
        g.history.unshift({ date: today, status: 'rejected', reason: reason, streakBefore: before });
      }
      save(state);
      return g;
    },

    /* ---- freezes (paid perk) ---- */
    useFreeze: function (goalId) {
      if (!state.user || state.user.freezes < 1) return false;
      var g = this.getGoal(goalId);
      if (!g) return false;
      state.user.freezes -= 1;
      g.lastSubmit = todayStr();
      g.history.unshift({ date: todayStr(), status: 'frozen', reason: 'Day protected by a freeze — streak preserved' });
      save(state);
      return true;
    },
    buyFreezes: function (count) {
      if (!state.user) return;
      state.user.freezes += count;
      save(state);
    },

    /* ---- appeals (human review during validation; AI re-judge at scale later) ---- */
    appealLimit: function () { return this.isPaid() ? APPEAL_LIMIT_PAID : APPEAL_LIMIT_FREE; },
    appealsUsedThisMonth: function () {
      var m = new Date().toISOString().slice(0, 7);
      return state.appeals.filter(function (a) { return (a.createdAt || '').slice(0, 7) === m; }).length;
    },
    appealsLeft: function () { return Math.max(0, this.appealLimit() - this.appealsUsedThisMonth()); },
    appealFor: function (goalId, date) {
      for (var i = 0; i < state.appeals.length; i++) if (state.appeals[i].goalId === goalId && state.appeals[i].date === date) return state.appeals[i];
      return null;
    },
    appealForToday: function (goal) { return this.appealFor(goal.id, todayStr()); },
    canAppeal: function (goal) {
      var h = goal.history[0];
      if (!h || h.status !== 'rejected') return false;     // only a rejected verdict can be appealed
      if (this.appealFor(goal.id, h.date)) return false;   // already appealed that day
      return this.appealsLeft() > 0;
    },
    createAppeal: function (goalId, date, note) {
      var g = this.getGoal(goalId);
      if (!g) return null;
      var entry = null;
      for (var i = 0; i < g.history.length; i++) if (g.history[i].date === date) { entry = g.history[i]; break; }
      var a = {
        id: 'a' + Date.now() + Math.floor(Math.random() * 99),
        goalId: goalId, date: date, note: note || '', status: 'pending',
        streakBefore: entry ? (entry.streakBefore || 0) : 0,
        reason: entry ? entry.reason : '',
        goalText: g.text,
        createdAt: new Date().toISOString()
      };
      state.appeals.unshift(a);
      save(state);
      return a;
    },
    pendingAppeals: function () { return state.appeals.filter(function (a) { return a.status === 'pending'; }); },
    resolveAppeal: function (id, approved) {
      var a = null;
      for (var i = 0; i < state.appeals.length; i++) if (state.appeals[i].id === id) { a = state.appeals[i]; break; }
      if (!a || a.status !== 'pending') return null;
      a.status = approved ? 'approved' : 'rejected';
      a.resolvedAt = new Date().toISOString();
      if (approved) {
        var g = this.getGoal(a.goalId);
        if (g) {
          for (var j = 0; j < g.history.length; j++) {
            if (g.history[j].date === a.date) { g.history[j].status = 'approved'; g.history[j].reason = 'Approved on appeal. ' + (g.history[j].reason || ''); break; }
          }
          g.streak = (a.streakBefore || 0) + 1;
          if (g.streak > g.bestStreak) g.bestStreak = g.streak;
        }
      }
      save(state);
      return a;
    },

    /* aggregate reputation: best streak across goals = your Cert-rep */
    rep: function () {
      return state.goals.reduce(function (a, g) { return Math.max(a, g.bestStreak); }, 0);
    },
    // % of judged submissions that passed (approved ÷ approved+rejected; freezes excluded)
    successRate: function () {
      var ap = 0, rej = 0;
      state.goals.forEach(function (g) {
        (g.history || []).forEach(function (h) {
          if (h.status === 'approved') ap++;
          else if (h.status === 'rejected') rej++;
        });
      });
      var tot = ap + rej;
      return tot ? Math.round((ap / tot) * 100) : 0;
    },

    // distinct days actually proven (dedup by goal+date so retries/appeals don't double-count)
    totalApproved: function () {
      var seen = {};
      state.goals.forEach(function (g) {
        (g.history || []).forEach(function (h) {
          if (h.status === 'approved') seen[g.id + '|' + h.date] = 1;
        });
      });
      return Object.keys(seen).length;
    },

    setLang: function (l) { state.lang = l; save(state); },
    todayStr: todayStr,

    /* ---- demo helper ---- */
    seedDemo: function () {
      if (!state.user) return;
      if (state.goals.length) return;
      var g = this.addGoal({ text: 'Зал 45 минут каждый день, фото с оборудованием', category: 'gym', format: 'daily' });
      g.streak = 23; g.bestStreak = 30;
      g.history = [
        { date: '2026-06-23', status: 'approved', reason: 'Gym equipment and active training clearly visible.' },
        { date: '2026-06-22', status: 'approved', reason: 'Workout confirmed.' }
      ];
      save(state);
    }
  };

  global.CertStore = Store;
})(window);
