// Daily local reminders to submit proof. On-device scheduling (no server),
// repeats every day. Copy is localized (RU/EN) at schedule time. Preference
// persisted in AsyncStorage. A second "last chance" reminder fires in the
// evening when the main one is set earlier in the day.
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { t } from "./i18n";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

const KEY_ENABLED = "reminder_enabled";
const KEY_TIME = "reminder_time";
const LAST_CHANCE_HOUR = 21; // evening "don't lose the streak" nudge

export async function getReminderPref() {
  const [e, t2] = await Promise.all([AsyncStorage.getItem(KEY_ENABLED), AsyncStorage.getItem(KEY_TIME)]);
  return { enabled: e === "1", time: t2 || "20:00" };
}

async function ensureChannel() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("reminders", {
      name: "Cert reminders",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

// Schedule (or reschedule) the daily reminder(s) at "HH:MM". Localized copy is
// baked in at schedule time — call again after a language change to refresh it.
// Returns {ok} or {ok:false, reason}.
export async function enableReminder(time) {
  const perm = await Notifications.requestPermissionsAsync();
  if (perm.status !== "granted") return { ok: false, reason: "denied" };
  const [h, m] = String(time || "20:00").split(":").map((x) => parseInt(x, 10));
  const hour = isNaN(h) ? 20 : h, minute = isNaN(m) ? 0 : m;
  await ensureChannel();
  await Notifications.cancelAllScheduledNotificationsAsync();

  // main reminder at the chosen time
  await Notifications.scheduleNotificationAsync({
    content: {
      title: t("Keep your streak alive"),
      body: t("Send today's proof — the judge is waiting."),
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: "reminders" },
  });

  // evening "last chance" nudge, only if the main reminder is earlier in the day
  if (hour < LAST_CHANCE_HOUR) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: t("Streak at risk"),
        body: t("You haven't proven today's goal yet. Don't lose your streak."),
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: LAST_CHANCE_HOUR, minute: 0, channelId: "reminders" },
    });
  }

  await AsyncStorage.multiSet([[KEY_ENABLED, "1"], [KEY_TIME, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`]]);
  return { ok: true };
}

export async function disableReminder() {
  await Notifications.cancelAllScheduledNotificationsAsync();
  await AsyncStorage.setItem(KEY_ENABLED, "0");
}

const KEY_DEADLINE_IDS = "deadline_reminder_ids";
const REMIND_BEFORE_MIN = 60; // nudge 1h before a goal's deadline

// Auto-schedule a "deadline soon" reminder for every active goal/challenge with
// a deadline. Cancels only the ones it scheduled before (leaves the user's own
// daily reminder alone). No-op unless notification permission is already
// granted, so it never nags. Call whenever goals reload.
export async function syncDeadlineReminders(goals) {
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "granted") return;
    await ensureChannel();
    const prevRaw = await AsyncStorage.getItem(KEY_DEADLINE_IDS);
    const prev = prevRaw ? JSON.parse(prevRaw) : [];
    for (const id of prev) { try { await Notifications.cancelScheduledNotificationAsync(id); } catch (_) { /* */ } }

    const ids = [];
    for (const g of goals || []) {
      if (!g || g.status !== "active") continue;
      const short = String(g.text || "").slice(0, 40);
      // recurring goal with a time-of-day deadline → daily reminder before it
      if (g.type === "recurring" && g.daily_deadline) {
        const [h, m] = String(g.daily_deadline).split(":").map((x) => parseInt(x, 10));
        if (isNaN(h)) continue;
        let mins = h * 60 + (isNaN(m) ? 0 : m) - REMIND_BEFORE_MIN;
        if (mins < 0) mins += 1440;
        const id = await Notifications.scheduleNotificationAsync({
          content: { title: t("Deadline soon"), body: t("\"{goal}\" is due at {time} — send your proof.", { goal: short, time: g.daily_deadline }) },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: Math.floor(mins / 60), minute: mins % 60, channelId: "reminders" },
        });
        ids.push(id);
      }
      // one-time goal/challenge with a date+time deadline → single reminder before it
      if (g.type === "one_time" && g.deadline) {
        const when = new Date(`${g.deadline}T${g.daily_deadline || "23:59"}:00`);
        when.setMinutes(when.getMinutes() - REMIND_BEFORE_MIN);
        if (when.getTime() > Date.now()) {
          const id = await Notifications.scheduleNotificationAsync({
            content: { title: t("Deadline soon"), body: t("\"{goal}\" is due soon — submit your proof.", { goal: short }) },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: "reminders" },
          });
          ids.push(id);
        }
      }
    }
    await AsyncStorage.setItem(KEY_DEADLINE_IDS, JSON.stringify(ids));
  } catch (_) { /* best-effort — reminders never block the app */ }
}

// Re-apply the schedule (e.g. after a language change) only if reminders are on.
export async function refreshReminderLanguage() {
  const { enabled, time } = await getReminderPref();
  if (enabled) await enableReminder(time);
}
