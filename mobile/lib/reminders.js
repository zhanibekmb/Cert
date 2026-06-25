// Daily local reminder to submit proof. On-device scheduling (no server),
// repeats every day at the chosen hour. Preference persisted in AsyncStorage.
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

const KEY_ENABLED = "reminder_enabled";
const KEY_TIME = "reminder_time";

export async function getReminderPref() {
  const [e, t] = await Promise.all([AsyncStorage.getItem(KEY_ENABLED), AsyncStorage.getItem(KEY_TIME)]);
  return { enabled: e === "1", time: t || "20:00" };
}

async function ensureChannel() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("reminders", {
      name: "Daily reminders",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

// Schedule (or reschedule) a daily reminder at "HH:MM". Returns {ok} or {ok:false, reason}.
export async function enableReminder(time) {
  const perm = await Notifications.requestPermissionsAsync();
  if (perm.status !== "granted") return { ok: false, reason: "denied" };
  const [h, m] = String(time || "20:00").split(":").map((x) => parseInt(x, 10));
  const hour = isNaN(h) ? 20 : h, minute = isNaN(m) ? 0 : m;
  await ensureChannel();
  await Notifications.cancelAllScheduledNotificationsAsync();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Don't break the chain ⚔️",
      body: "Submit today's proof — keep your verified streak alive.",
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: "reminders" },
  });
  await AsyncStorage.multiSet([[KEY_ENABLED, "1"], [KEY_TIME, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`]]);
  return { ok: true };
}

export async function disableReminder() {
  await Notifications.cancelAllScheduledNotificationsAsync();
  await AsyncStorage.setItem(KEY_ENABLED, "0");
}
