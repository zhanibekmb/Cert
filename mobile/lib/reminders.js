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

// Re-apply the schedule (e.g. after a language change) only if reminders are on.
export async function refreshReminderLanguage() {
  const { enabled, time } = await getReminderPref();
  if (enabled) await enableReminder(time);
}
