// Expo push registration. Gets the device's Expo push token and stores it on
// the user's profile so the server (risk-push function) can send "streak at
// risk" notifications. Everything is best-effort and guarded — on a simulator,
// in Expo Go, or without a projectId it just no-ops (no crash).
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { supabase } from "./supabase";

export async function registerForPush(userId) {
  try {
    if (!userId) return null;

    // Android needs a channel before a token is useful.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("reminders", {
        name: "Cert reminders",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;

    // projectId is required for Expo push tokens (set by EAS in app config).
    const projectId =
      Constants?.expoConfig?.extra?.eas?.projectId ||
      Constants?.easConfig?.projectId;
    const tokenResp = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const token = tokenResp?.data;
    if (!token) return null;

    await supabase.from("profiles").update({ expo_push_token: token }).eq("id", userId);
    return token;
  } catch (_) {
    return null; // simulator / Expo Go / missing projectId — silently skip
  }
}
