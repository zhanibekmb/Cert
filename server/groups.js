/* =====================================================================
   CERT — public group catalog (Cert-run groups) + demo social proof.
   Single source of truth shared by the judge (rules) and the API.
   ===================================================================== */
'use strict';

const GROUPS = [
  { id: 'gym',      emoji: '🏋️', name: 'Gym Warriors',  name_ru: 'Воины зала',     format: 'daily',    members: 248,
    rule: 'A photo proving a real workout: gym equipment, gym interior, sweat, or active training form.' },
  { id: 'run',      emoji: '🏃', name: 'Road Runners',  name_ru: 'Бегуны',          format: 'daily',    members: 176,
    rule: 'A photo taken during or right after a run: route, outdoor setting, or a fitness tracker showing the run.' },
  { id: 'read',     emoji: '📚', name: 'Daily Readers', name_ru: 'Читатели',        format: 'daily',    members: 91,
    rule: 'A photo of a specific, legible book page the user read today.' },
  { id: 'diet',     emoji: '🥗', name: 'Clean Plate',   name_ru: 'Чистая тарелка',  format: 'daily',    members: 134,
    rule: 'A photo of a genuinely healthy meal on a plate.' },
  { id: 'code',     emoji: '💻', name: 'Ship Daily',    name_ru: 'Код каждый день', format: 'weekdays', members: 203,
    rule: 'A screenshot of an IDE, a code commit, or notes proving real coding/study work.' },
  { id: 'meditate', emoji: '🧘', name: 'Stillness',     name_ru: 'Медитация',       format: 'daily',    members: 67,
    rule: 'A photo of a meditation or yoga setup / pose.' },
  { id: 'create',   emoji: '🎨', name: 'Makers',        name_ru: 'Творцы',          format: '3x',       members: 58,
    rule: 'A photo of creative work in progress: canvas, sketch, instrument, or tool in hand.' }
];

const PEOPLE = {
  gym:  [{ name: 'Arman K.', emoji: '👑', streak: 47, pct: 98 }, { name: 'Daniyal', emoji: '💪', streak: 31, pct: 95 }, { name: 'Sasha M.', emoji: '🔥', streak: 28, pct: 92 }, { name: 'Marat', emoji: '🏃', streak: 18, pct: 88 }],
  run:  [{ name: 'Nurlan', emoji: '⚡', streak: 39, pct: 96 }, { name: 'Aigerim', emoji: '🌅', streak: 22, pct: 91 }, { name: 'Tom', emoji: '🥇', streak: 15, pct: 84 }],
  read: [{ name: 'Dana', emoji: '📖', streak: 54, pct: 99 }, { name: 'Yerlan', emoji: '🦉', streak: 33, pct: 93 }]
};

const SHAME = [
  { name: 'Bekzod', group: 'gym', day: 12 },
  { name: 'Anonymous', group: 'run', day: 4 },
  { name: 'Timur', group: 'gym', day: 7 }
];

function ruleFor(category) {
  const g = GROUPS.find((x) => x.id === category);
  return g ? g.rule : 'A photo that clearly proves the stated goal was completed today.';
}

module.exports = { GROUPS, PEOPLE, SHAME, ruleFor };
