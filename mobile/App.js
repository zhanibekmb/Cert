// =====================================================================
// CERT — mobile app (Expo / React Native). Talks to Supabase:
//   - auth: email + password (sign up / sign in) or Google OAuth (PKCE)
//   - goals + streak in Postgres (RLS-scoped)
//   - photo proof -> "judge" Edge Function (Gemini) -> verdict
// Single-file app for v1; we'll split into screens as it grows.
// =====================================================================
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  StyleSheet, Alert, RefreshControl, StatusBar, Image, Switch, Share, Modal, Platform,
  Animated, PanResponder, Dimensions, Easing, KeyboardAvoidingView, Appearance,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import MapView, { Marker } from "react-native-maps";
import { CameraView, useCameraPermissions } from "expo-camera";
import { VideoView, useVideoPlayer } from "expo-video";
import * as FileSystem from "expo-file-system/legacy";
import * as Location from "expo-location";
import * as WebBrowser from "expo-web-browser";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import * as Sharing from "expo-sharing";
import * as MediaLibrary from "expo-media-library";
import { captureRef } from "react-native-view-shot";
import { supabase } from "./lib/supabase";
import { getReminderPref, enableReminder, disableReminder, refreshReminderLanguage, syncDeadlineReminders } from "./lib/reminders";
import { registerForPush } from "./lib/push";
import { initPurchases, purchasesEnabled, buyProduct, getProducts, restorePurchases } from "./purchases";
import { FREEZE_PACK_PRODUCTS, PRO_PRODUCTS } from "./config";
import { t, useLang, getLangPref, setLangPref, initLang, activeLang } from "./lib/i18n";

// The AI proof-spec is generated in both languages and stored on the goal;
// show the one matching the current app language (fall back to the other).
function proofSpec(goal) {
  if (!goal) return null;
  return activeLang() === "ru"
    ? (goal.proof_spec_ru || goal.proof_spec_en)
    : (goal.proof_spec_en || goal.proof_spec_ru);
}

WebBrowser.maybeCompleteAuthSession();

/* ---------- theme (Cert brand v2: indigo on white, LIGHT default) ----------
   One hue family (emerald) + cool neutral grays. Slot names kept for history:
   `red` = PRIMARY accent (CTAs), `bronze` = secondary accent (selection /
   verified / stamps) — both indigo shades now. `err` is the only true red
   and is reserved for errors, rejections and destructive actions.
   C and s are module-level `let` bindings read live by every component on each
   render. Reassigning them + forcing the root to re-render repaints the whole
   tree — so a theme switch needs no per-component wiring. */
const DARK = {
  bg: "#0b0d10", card: "#14181e", line: "#262c36",
  ink: "#f2f4f7", mute: "#9aa3ad", faint: "#66707c",
  red: "#6366f1", bronze: "#818cf8", green: "#4ade80", err: "#f87171",
  inputBg: "#10141a", inputLine: "#2a313c", isDark: true,
};
const LIGHT = {
  bg: "#ffffff", card: "#f6f8fa", line: "#e4e8ee",
  ink: "#171b21", mute: "#667080", faint: "#98a1ad",
  red: "#4f46e5", bronze: "#4338ca", green: "#16a34a", err: "#dc2626",
  inputBg: "#f2f5f8", inputLine: "#dfe4eb", isDark: false,
};
let C = LIGHT; // light is the default theme
const F = { display: "System", mono: "System" };

// theme preference: 'system' | 'dark' | 'light' — LIGHT by default
let _themePref = "light";
function _systemIsLight() { try { return Appearance.getColorScheme() === "light"; } catch (_) { return false; } }
function _resolveTheme(pref) { return pref === "light" ? "light" : pref === "dark" ? "dark" : (_systemIsLight() ? "light" : "dark"); }
const _themeListeners = new Set();
function applyThemePref(pref) {
  _themePref = pref;
  C = _resolveTheme(pref) === "light" ? LIGHT : DARK;
  s = makeStyles();                      // rebuild the stylesheet from the new palette
  AsyncStorage.setItem("cert_theme", pref).catch(() => {});
  _themeListeners.forEach((fn) => fn()); // re-render subscribed roots → whole tree repaints
}
function useThemePref() {
  const [, force] = useState(0);
  useEffect(() => { const fn = () => force((x) => x + 1); _themeListeners.add(fn); return () => _themeListeners.delete(fn); }, []);
  return [_themePref, applyThemePref];
}
let s = makeStyles(); // built from the current palette; rebuilt on theme change

/* Optional "hide my streak count" — some people focus better without the number
   staring at them. Module-level so a Settings toggle updates the home live. */
let _hideStreak = false;
const _hideStreakListeners = new Set();
function applyHideStreak(v) {
  _hideStreak = !!v;
  AsyncStorage.setItem("cert_hide_streak", _hideStreak ? "1" : "0").catch(() => {});
  _hideStreakListeners.forEach((fn) => fn());
}
function useHideStreak() {
  const [, force] = useState(0);
  useEffect(() => { const fn = () => force((x) => x + 1); _hideStreakListeners.add(fn); return () => _hideStreakListeners.delete(fn); }, []);
  return [_hideStreak, applyHideStreak];
}

/* Streak milestones that mint a shareable badge. Keep in sync with the judge. */
const MILESTONES = [7, 30, 100];

/* Gladiator brand mark (transparent PNG). */
const LOGO = require("./assets/gladiator-logo.png");

/* Full profile cache — the Profile tab unmounts on every tab switch; rendering
   from this cache makes it open instantly (refresh happens in the background). */
let _profileCache = null; // { uid, data }

/* Display name: set once in the profile, reused on every leaderboard. Cached so
   challenge screens don't re-query (and so a profile edit reflects immediately). */
let _cachedName = null;
async function loadMyName() {
  if (_cachedName) return _cachedName;
  try {
    const { data: u } = await supabase.auth.getUser();
    const uid = u?.user?.id; if (!uid) return null;
    const { data } = await supabase.from("profiles").select("name").eq("id", uid).maybeSingle();
    _cachedName = data?.name?.trim() || null;
    return _cachedName;
  } catch (_) { return null; }
}
async function saveMyName(name) {
  const clean = String(name || "").trim();
  if (!clean) return;
  try {
    const { data: u } = await supabase.auth.getUser();
    const uid = u?.user?.id; if (!uid) return;
    await supabase.from("profiles").update({ name: clean }).eq("id", uid);
    _cachedName = clean;
  } catch (_) { /* ignore */ }
}

/* Best-effort device location for geo-verified proofs. Returns {lat,lng,place}
   or null — never blocks the proof (denied permission / timeout just skips geo). */
async function getGeo() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    let place = null;
    try {
      const g = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      const a = g && g[0];
      if (a) place = [a.name, a.city || a.subregion, a.country].filter(Boolean).slice(0, 2).join(", ");
    } catch (_) { /* reverse-geocode optional */ }
    // Android flags mock-location providers — the judge rejects faked GPS check-ins.
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, place, mocked: pos.mocked === true };
  } catch (_) { return null; }
}
async function getGeoTimed() { return Promise.race([getGeo(), new Promise((r) => setTimeout(() => r(null), 6000))]); }

/* Fire-and-forget funnel analytics (first-run flow). Pre-auth events carry a
   random per-install device id so the funnel can be stitched before sign-up.
   Analytics must never block or break the app — every failure is swallowed. */
let _deviceId = null;
async function track(event) {
  try {
    if (!_deviceId) {
      _deviceId = await AsyncStorage.getItem("cert_device");
      if (!_deviceId) {
        _deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        await AsyncStorage.setItem("cert_device", _deviceId);
      }
    }
    const { data } = await supabase.auth.getSession();
    await supabase.from("funnel_events").insert({ device_id: _deviceId, user_id: data?.session?.user?.id || null, event });
  } catch (_) { /* ignore */ }
}

/* Split a Date into a "YYYY-MM-DD" date and an "HH:MM" time (local). */
function isoDateParts(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/* ===================================================================== */
export default function App() {
  useThemePref(); // re-render the whole tree when theme changes
  const [langPref] = useLang(); // re-render the whole tree when language changes
  // re-localize scheduled reminder copy when the language changes
  useEffect(() => { refreshReminderLanguage().catch(() => {}); }, [langPref]);
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [recovery, setRecovery] = useState(false); // came in via a password-reset link → set a new password
  // First-run (pre-auth): onboarding carousel → Pro info (skippable) → auth.
  // Reuses the cert_intro flag so existing installs never see it again.
  const [firstRun, setFirstRun] = useState(null); // null=loading | "onboarding" | "prointro" | "done"

  // restore saved theme + language preferences once at startup
  useEffect(() => {
    AsyncStorage.getItem("cert_theme").then((p) => { if (p) applyThemePref(p); }).catch(() => {});
    AsyncStorage.getItem("cert_hide_streak").then((v) => { if (v === "1") applyHideStreak(true); }).catch(() => {});
    initLang();
    AsyncStorage.getItem("cert_intro").then((v) => setFirstRun(v ? "done" : "onboarding")).catch(() => setFirstRun("done"));
  }, []);
  const finishFirstRun = () => { AsyncStorage.setItem("cert_intro", "1").catch(() => {}); setFirstRun("done"); };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setBooting(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") { _profileCache = null; _cachedName = null; }
      // funnel: first successful sign-in on this device completes the first-run flow
      if (event === "SIGNED_IN") {
        AsyncStorage.getItem("cert_funnel_done").then((v) => {
          if (!v) { AsyncStorage.setItem("cert_funnel_done", "1").catch(() => {}); track("signup_complete"); }
        }).catch(() => {});
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Auth deep links: email-confirmation and password-reset links open the app
  // as cert://?code=<pkce_code>. Exchange it for a session. Challenge invites
  // (cert://join?code=...) are handled in Main and skipped here.
  useEffect(() => {
    const handleAuthUrl = async (url) => {
      if (!url) return;
      try {
        const parsed = Linking.parse(url);
        const isJoin = /(^|\/)join/.test(parsed?.path || "") || parsed?.hostname === "join";
        const code = parsed?.queryParams?.code;
        if (code && !isJoin) {
          const { error } = await supabase.auth.exchangeCodeForSession(String(code));
          if (error) { console.warn("Cert auth deep-link exchange failed:", error.message); return; }
          // a reset link we initiated → prompt for a new password (set by forgotPassword)
          const pending = await AsyncStorage.getItem("cert_recovery");
          if (pending) { await AsyncStorage.removeItem("cert_recovery"); setRecovery(true); }
          // otherwise onAuthStateChange flips to Main on success
        }
      } catch (_) { /* ignore malformed urls */ }
    };
    Linking.getInitialURL().then(handleAuthUrl);
    const sub = Linking.addEventListener("url", (e) => handleAuthUrl(e.url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe} edges={["top"]}>
        <StatusBar barStyle={C.isDark ? "light-content" : "dark-content"} />
        {booting || (!session && firstRun === null) ? <Center><ActivityIndicator color={C.bronze} /></Center>
          : (session && recovery) ? <SetNewPassword onDone={() => setRecovery(false)} />
          : session ? <Main session={session} />
          : firstRun === "onboarding" ? <Onboarding onDone={() => setFirstRun("prointro")} />
          : firstRun === "prointro" ? <ProIntro onDone={finishFirstRun} />
          : <Auth />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ---------- AUTH: email + password, or Google ---------- */
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function Auth() {
  const [mode, setMode] = useState("signin"); // signin | signup | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState(""); // password-reset code from email
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null); // success/info banner (e.g. "confirm your email")
  const [langPref, setLang] = useLang();
  const [appleReady, setAppleReady] = useState(false);
  useEffect(() => { track("auth_view"); }, []); // funnel
  // Only render the native Apple button once the module confirms availability —
  // guards against a launch crash if the native module / capability isn't present.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    (async () => {
      try { setAppleReady(await AppleAuthentication.isAvailableAsync()); }
      catch (_) { setAppleReady(false); }
    })();
  }, []);

  // Demo entry: real (anonymous) session, no email/password needed.
  // Requires Supabase → Authentication → Providers → Anonymous = enabled.
  async function enterDemo() {
    try {
      setBusy(true); setInfo(null);
      const { error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      // onAuthStateChange flips to Main
    } catch (e) {
      Alert.alert("Cert", e.message || "Anonymous sign-in failed. Enable it in Supabase → Authentication → Providers → Anonymous.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithApple() {
    try {
      setBusy(true); setInfo(null);
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!cred.identityToken) throw new Error(t("No identity token from Apple."));
      const { error } = await supabase.auth.signInWithIdToken({ provider: "apple", token: cred.identityToken });
      if (error) throw error;
      // If Apple returned a name (only on first sign-in), save it to the profile.
      const full = [cred.fullName?.givenName, cred.fullName?.familyName].filter(Boolean).join(" ").trim();
      if (full) saveMyName(full);
      // onAuthStateChange flips to Main
    } catch (e) {
      if (e.code === "ERR_REQUEST_CANCELED") return; // user cancelled the sheet
      Alert.alert("Cert", e.message || t("Apple sign-in failed."));
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    try {
      setBusy(true); setInfo(null);
      const redirectTo = Linking.createURL("/");
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error) throw error;
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type === "cancel" || result.type === "dismiss") return; // user closed the sheet
      if (result.type !== "success") throw new Error("Google sign-in didn't complete. Please try again.");
      const params = Linking.parse(result.url)?.queryParams || {};
      if (params.error) throw new Error(String(params.error_description || params.error));
      if (!params.code) throw new Error("No auth code returned from Google.");
      const { error: e2 } = await supabase.auth.exchangeCodeForSession(String(params.code));
      if (e2) throw e2;
      // onAuthStateChange flips to Main
    } catch (e) {
      Alert.alert("Cert", e.message || "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitEmail() {
    const mail = email.trim();
    if (!emailOk(mail)) return Alert.alert("Cert", "Enter a valid email address.");
    if (password.length < 6) return Alert.alert("Cert", "Password must be at least 6 characters.");
    try {
      setBusy(true); setInfo(null);
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: mail, password,
          options: { emailRedirectTo: Linking.createURL("/") },
        });
        if (error) throw error;
        // If "Confirm email" is on in Supabase, there's no session yet.
        if (!data.session) {
          setInfo("Account created. Check your email to confirm, then sign in.");
          setMode("signin"); setPassword("");
        }
        // else onAuthStateChange flips to Main
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: mail, password });
        if (error) throw error;
        // onAuthStateChange flips to Main
      }
    } catch (e) {
      Alert.alert("Cert", e.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  // Password reset by CODE: we email a 6-digit code (SMTP + {{ .Token }} template),
  // the user types it + a new password, and we verify + update in-app.
  async function sendResetCode() {
    const mail = email.trim();
    if (!emailOk(mail)) return Alert.alert("Cert", t("Type your email above first."));
    try {
      setBusy(true); setInfo(null);
      const { error } = await supabase.auth.resetPasswordForEmail(mail);
      if (error) throw error;
      setCode(""); setPassword(""); setMode("reset");
      setInfo(t("We emailed a reset code to {email}.", { email: mail }));
    } catch (e) {
      Alert.alert("Cert", e.message || t("Could not send the reset code."));
    } finally { setBusy(false); }
  }

  async function resetWithCode() {
    const mail = email.trim();
    if (code.trim().length < 6) return Alert.alert("Cert", t("Enter the 6-digit code from the email."));
    if (password.length < 6) return Alert.alert("Cert", t("Password must be at least 6 characters."));
    try {
      setBusy(true); setInfo(null);
      const { error: vErr } = await supabase.auth.verifyOtp({ email: mail, token: code.trim(), type: "recovery" });
      if (vErr) throw vErr;
      const { error: uErr } = await supabase.auth.updateUser({ password });
      if (uErr) throw uErr;
      // now signed in with the new password → onAuthStateChange flips to Main
    } catch (e) {
      Alert.alert("Cert", e.message || t("Could not reset the password. Check the code and try again."));
    } finally { setBusy(false); }
  }

  const isSignup = mode === "signup";
  const isReset = mode === "reset";
  const title = isReset ? t("Reset password") : isSignup ? t("Create your\naccount") : t("Welcome\nback");
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={s.authWrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive">
      {/* language switcher — usable before login */}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginBottom: 4 }}>
        {[["ru", "RU"], ["en", "EN"]].map(([v, lbl]) => (
          <TouchableOpacity key={v} onPress={() => setLang(v)} style={[s.langChip, activeLang() === v && s.langChipOn]}>
            <Text style={[s.langChipT, activeLang() === v && { color: C.bg }]}>{lbl}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Image source={LOGO} style={s.authLogo} resizeMode="contain" />
      <Text style={s.kickerRed}>{t("[ the streak you can't fake ]")}</Text>
      <Text style={s.h1} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>{title}</Text>
      <Text style={s.lede}>{isReset ? t("Enter the code we emailed you and set a new password.") : t("One goal. A daily photo. An honest AI judge.")}</Text>

      {info ? <Text style={s.infoBanner}>{info}</Text> : null}

      {isReset ? (
        <>
          <View style={s.card}>
            <Text style={s.label}>{t("Email")}</Text>
            <TextInput style={s.input} placeholder="you@email.com" placeholderTextColor={C.faint}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
              value={email} onChangeText={setEmail} />
            <Text style={[s.label, { marginTop: 14 }]}>{t("Reset code")}</Text>
            <TextInput style={s.input} placeholder="123456" placeholderTextColor={C.faint}
              keyboardType="number-pad" autoCapitalize="none" value={code} onChangeText={setCode} />
            <Text style={[s.label, { marginTop: 14 }]}>{t("New password")}</Text>
            <TextInput style={s.input} placeholder="••••••••" placeholderTextColor={C.faint}
              secureTextEntry autoCapitalize="none" autoCorrect={false} value={password} onChangeText={setPassword} />
            <Btn label={busy ? "…" : t("Reset password")} onPress={resetWithCode} disabled={busy} />
            <TouchableOpacity onPress={sendResetCode} disabled={busy}><Text style={s.note}>{t("Resend code")}</Text></TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => { setMode("signin"); setInfo(null); }} disabled={busy}>
            <Text style={s.switchAuth}>{t("Back to sign in")}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          {appleReady ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={C.isDark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={10}
              style={{ height: 48, marginBottom: 8 }}
              onPress={signInWithApple}
            />
          ) : null}

          <TouchableOpacity style={s.googleBtn} onPress={signInWithGoogle} disabled={busy}>
            <Ionicons name="logo-google" size={18} color="#1f1f1f" style={{ marginRight: 9 }} />
            <Text style={s.googleText}>{busy ? "…" : t("Continue with Google")}</Text>
          </TouchableOpacity>

          <Text style={s.orText}>{t("— or with email —")}</Text>

          {/* clear Sign in / Sign up switch */}
          <View style={s.rowGap}>
            <Pill label={t("Sign in")} active={!isSignup} onPress={() => { setMode("signin"); setInfo(null); }} />
            <Pill label={t("Sign up")} active={isSignup} onPress={() => { setMode("signup"); setInfo(null); }} />
          </View>

          <View style={s.card}>
            <Text style={s.label}>{t("Email")}</Text>
            <TextInput style={s.input} placeholder="you@email.com" placeholderTextColor={C.faint}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
              value={email} onChangeText={setEmail} />
            <Text style={[s.label, { marginTop: 14 }]}>{t("Password")}</Text>
            <TextInput style={s.input} placeholder="••••••••" placeholderTextColor={C.faint}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              value={password} onChangeText={setPassword} />
            <Btn label={busy ? "…" : isSignup ? t("Create account") + " →" : t("Sign in") + " →"} onPress={submitEmail} disabled={busy} />
            {isSignup
              ? <Text style={s.note}>{t("At least 6 characters.")}</Text>
              : <TouchableOpacity onPress={sendResetCode} disabled={busy}><Text style={s.note}>{t("Forgot password?")}</Text></TouchableOpacity>}
          </View>

          {__DEV__ ? (
            <TouchableOpacity style={s.skipBtn} onPress={enterDemo} disabled={busy}>
              <Text style={s.skipText}>{busy ? "…" : "Enter demo (no login) →"}</Text>
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* ---------- SET NEW PASSWORD (after a reset link) ---------- */
function SetNewPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (password.length < 6) return Alert.alert("Cert", "Password must be at least 6 characters.");
    try {
      setBusy(true);
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      Alert.alert("Cert", "Password updated.", [{ text: "OK", onPress: onDone }]);
    } catch (e) { Alert.alert("Cert", e.message || "Could not update password."); }
    finally { setBusy(false); }
  }
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.authWrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Image source={LOGO} style={s.authLogo} resizeMode="contain" />
        <Text style={s.h1}>Set a new{"\n"}password</Text>
        <Text style={s.lede}>Choose a new password for your account.</Text>
        <View style={s.card}>
          <Text style={s.label}>New password</Text>
          <TextInput style={s.input} placeholder="••••••••" placeholderTextColor={C.faint}
            secureTextEntry autoCapitalize="none" autoCorrect={false} value={password} onChangeText={setPassword} />
          <Btn label={busy ? "…" : "Save password →"} onPress={save} disabled={busy} />
        </View>
        <TouchableOpacity onPress={onDone}><Text style={s.switchAuth}>Skip for now</Text></TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* ---------- MAIN (tab shell + overlay screens) ---------- */
/* ---------- ONBOARDING (first-run: pain → magic → flex → start) ----------
   Four swipe screens, each a phone-frame mockup of the real product. The
   emotional arc sells the hook: your old streaks were fake → Cert's judge
   makes them real → real streaks are worth bragging about → set one goal. */
function ObFrame({ children }) {
  return (
    <View style={{ width: "82%", alignSelf: "center", borderRadius: 30, borderWidth: 6, borderColor: C.isDark ? "#232a34" : "#e5e8ee", backgroundColor: C.bg, padding: 14, minHeight: 270, justifyContent: "center", overflow: "hidden" }}>
      {children}
    </View>
  );
}
function ObMockRow({ label, dead }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 13, marginTop: 8, opacity: dead ? 0.55 : 1 }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: dead ? C.faint : C.green, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name="checkmark" size={15} color={C.bg} />
      </View>
      <Text style={[s.goalText, { marginTop: 0, flex: 1 }]}>{label}</Text>
    </View>
  );
}
function ObStamp({ active, size = 26 }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (active) {
      v.setValue(0);
      Animated.spring(v, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }).start();
    }
  }, [active]);
  return (
    <Animated.View style={{ position: "absolute", alignSelf: "center", top: "34%", transform: [{ rotate: "-12deg" }, { scale: v.interpolate({ inputRange: [0, 1], outputRange: [2.4, 1] }) }], opacity: v, borderWidth: 3, borderColor: C.bronze, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: "rgba(10,13,18,0.35)" }}>
      <Text style={{ color: C.bronze, fontSize: size, fontWeight: "800", letterSpacing: 2 }}>APPROVED ✓</Text>
    </Animated.View>
  );
}
function Onboarding({ onDone }) {
  const [page, setPage] = useState(0);
  const scrollRef = useRef(null);
  const [, setLangChoice] = useLang(); // re-render on RU/EN switch
  useEffect(() => { track("onboarding_view"); }, []);
  const W = Dimensions.get("window").width;
  const goTo = (i) => { scrollRef.current?.scrollTo({ x: i * W, animated: true }); setPage(i); };
  const last = page === 3;
  const PAGES = [
    { head: t("Every streak is a lie."), sub: t("You tap a checkbox nobody checks. So you quit — and nothing happens.") },
    { head: t("Cert makes it real."), sub: t("One photo a day. An AI judge decides if it counts — no faking a tap.") },
    { head: t("Worth bragging about."), sub: t("Share a streak nobody can fake. Challenge friends — last place spins the wheel.") },
    { head: t("What will you prove?"), sub: t("One goal. A streak that means something.") },
  ];
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: 20, paddingBottom: 0 }}>
        {[["ru", "RU"], ["en", "EN"]].map(([v, lbl]) => (
          <TouchableOpacity key={v} onPress={() => setLangChoice(v)} style={[s.langChip, activeLang() === v && s.langChipOn]}>
            <Text style={[s.langChipT, activeLang() === v && { color: C.bg }]}>{lbl}</Text>
          </TouchableOpacity>
        ))}
        {!last ? (
          <TouchableOpacity onPress={onDone} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={[s.langChipT, { paddingHorizontal: 6 }]}>{t("Skip")}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <ScrollView ref={scrollRef} horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={{ flex: 1 }}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / W))}>
        {/* 1 — the pain: a dead generic tracker */}
        <View style={{ width: W, justifyContent: "center" }}>
          <ObFrame>
            <Text style={[s.kicker, { textAlign: "center", marginBottom: 6 }]}>{t("your old habit app")}</Text>
            <ObMockRow label={t("Meditate")} dead />
            <ObMockRow label={t("Gym")} dead />
            <ObMockRow label={t("Read")} dead />
            <View style={{ position: "absolute", alignSelf: "center", top: "42%", transform: [{ rotate: "-10deg" }], borderWidth: 2.5, borderColor: C.err, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: C.isDark ? "rgba(10,13,18,0.4)" : "rgba(255,255,255,0.6)" }}>
              <Text style={{ color: C.err, fontSize: 20, fontWeight: "800", letterSpacing: 2 }}>{t("UNVERIFIED")}</Text>
            </View>
          </ObFrame>
        </View>
        {/* 2 — the magic (hero): a proof photo gets stamped APPROVED */}
        <View style={{ width: W, justifyContent: "center" }}>
          <ObFrame>
            <View style={{ borderRadius: 14, backgroundColor: C.isDark ? "#12151a" : "#eef1f6", height: 150, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="camera-outline" size={40} color={C.faint} />
              <Text style={[s.note, { marginTop: 8 }]}>{t("your daily photo")}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 10 }}>
              <Ionicons name="shield-checkmark" size={16} color={C.bronze} />
              <Text style={[s.note, { textAlign: "left", marginTop: 0, flex: 1 }]}>{t("AI judge: real workout. Counted.")}</Text>
            </View>
            <ObStamp active={page === 1} />
          </ObFrame>
        </View>
        {/* 3 — the flex: cert card + friends leaderboard */}
        <View style={{ width: W, justifyContent: "center" }}>
          <ObFrame>
            <View style={{ borderWidth: 1.5, borderColor: C.bronze, borderRadius: 14, padding: 14, alignItems: "center" }}>
              <Text style={{ color: C.bronze, fontSize: 44, fontWeight: "800", lineHeight: 46 }}>47</Text>
              <Text style={{ color: C.ink, fontSize: 11, letterSpacing: 3, fontWeight: "700" }}>{t("VERIFIED DAYS")}</Text>
              <Text style={{ color: C.bronze, fontSize: 10, letterSpacing: 2, fontWeight: "800", marginTop: 4 }}>{t("NOT FAKED")}</Text>
            </View>
            {[["1", "Yerdan", "8"], ["2", t("You"), "5"], ["3", "Mukhtar", "3"]].map(([m, n, d]) => (
              <View key={n} style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 9, marginTop: 7 }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.red, alignItems: "center", justifyContent: "center" }}><Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "800" }}>{m}</Text></View>
                <Avatar name={n} size={24} />
                <Text style={[s.goalText, { marginTop: 0, flex: 1, fontSize: 13 }]}>{n}</Text>
                <Text style={[s.note, { marginTop: 0 }]}>{d} {t("days")}</Text>
              </View>
            ))}
          </ObFrame>
        </View>
        {/* 4 — the start: one goal away */}
        <View style={{ width: W, justifyContent: "center" }}>
          <ObFrame>
            <Text style={[s.label, { marginBottom: 6 }]}>{t("Your goal")}</Text>
            <View style={[s.input, { justifyContent: "center" }]}>
              <Text style={s.goalText}>{t("gym 45 min")}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              <View style={[s.chip, s.chipOn]}><Text style={[s.chipText, { color: C.ink }]}>{t("Photo")}</Text></View>
              <View style={s.chip}><Text style={s.chipText}>{t("Video")}</Text></View>
              <View style={s.chip}><Text style={s.chipText}>{t("Geo")}</Text></View>
            </View>
            <View style={[s.btn, { marginTop: 18 }]}><Text style={s.btnText}>{t("Create")}</Text></View>
          </ObFrame>
        </View>
      </ScrollView>
      <View style={{ paddingHorizontal: 28, paddingBottom: 30 }}>
        <Text style={[s.h1, { fontSize: 26, lineHeight: 30, textAlign: "center" }]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.65}>{PAGES[page].head}</Text>
        <Text style={[s.lede, { textAlign: "center", marginTop: 6, marginBottom: 8 }]} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.8}>{PAGES[page].sub}</Text>
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 7, marginBottom: 2 }}>
          {PAGES.map((_, i) => (
            <View key={i} style={{ width: i === page ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: i === page ? C.bronze : C.line }} />
          ))}
        </View>
        <Btn label={last ? t("Start") + " →" : t("Next") + " →"} onPress={last ? onDone : () => goTo(page + 1)} />
      </View>
    </View>
  );
}

/* ---------- PRO INTRO (first-run, info-only: no purchase, always skippable) ---------- */
function ProIntro({ onDone }) {
  useEffect(() => { track("paywall_info_view"); }, []);
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingTop: 40, paddingBottom: 40 }]}>
      <View style={s.pwHero}>
        <View style={s.pwMark}><Ionicons name="shield-checkmark" size={34} color={C.bronze} /></View>
        <Text style={s.pwTitle}>{t("Go further with Pro")}</Text>
        <Text style={s.pwSub}>{t("Stronger proof methods, more goals, and deeper stats.")}</Text>
      </View>
      <View style={[s.card, { gap: 12, marginTop: 16 }]}>
        {PRO_FEATURES.map(([icon, f]) => (
          <View key={f} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Ionicons name={icon} size={20} color={C.bronze} />
            <Text style={[s.goalText, { marginTop: 0, flex: 1 }]}>{t(f)}</Text>
          </View>
        ))}
      </View>
      <Text style={[s.note, { marginTop: 14 }]}>{t("Start free. Upgrade anytime in the app.")}</Text>
      <Btn label={t("Continue")} onPress={onDone} />
      <TouchableOpacity onPress={onDone}><Text style={s.switchAuth}>{t("Skip")}</Text></TouchableOpacity>
    </ScrollView>
  );
}

function Main({ session }) {
  const [tab, setTab] = useState("home"); // home | challenges | stats | profile
  const [screen, setScreen] = useState(null); // overlay: new|submit|cert|badge|challengeNew|challengeJoin|challengeDetail
  // The paywall is a Modal ON TOP of whatever is open (not a screen swap), so
  // a half-filled form underneath keeps its state when the user backs out.
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [freezeSheetOpen, setFreezeSheetOpen] = useState(false); // ❄️ mini-paywall
  const [createChooser, setCreateChooser] = useState(false); // center "+" → goal or challenge
  const [goals, setGoals] = useState(null);
  const [certs, setCerts] = useState([]);
  const [subs, setSubs] = useState([]);
  const [profile, setProfile] = useState(null);
  const [active, setActive] = useState(null);
  const [activeCert, setActiveCert] = useState(null);
  const [activeBadge, setActiveBadge] = useState(null);
  const [activePlacement, setActivePlacement] = useState(null);
  const [activeChallenge, setActiveChallenge] = useState(null);
  const [activeReelGoal, setActiveReelGoal] = useState(null); // goal whose timelapse reel is open
  const [submitReturn, setSubmitReturn] = useState(null); // overlay to return to after Submit
  const [joinCode, setJoinCode] = useState(""); // prefilled from an invite link
  const [refreshing, setRefreshing] = useState(false);
  const [intro, setIntro] = useState(null); // null=loading | "onboarding" | "done" (fallback for pre-flag installs)

  // Invite links: cert://join?code=ABC123 (or the exp:// form in Expo Go).
  useEffect(() => {
    const handle = (url) => {
      if (!url) return;
      try {
        const parsed = Linking.parse(url);
        const isJoin = /(^|\/)join/.test(parsed?.path || "") || parsed?.hostname === "join";
        const code = parsed?.queryParams?.code;
        if (isJoin && code) { setJoinCode(String(code).toUpperCase()); setTab("challenges"); setScreen("challengeJoin"); }
      } catch (_) { /* ignore */ }
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  // First-run: how-it-works onboarding, then the paywall — once per install.
  useEffect(() => {
    AsyncStorage.getItem("cert_intro").then((v) => setIntro(v ? "done" : "onboarding")).catch(() => setIntro("done"));
  }, []);
  const finishIntro = () => { AsyncStorage.setItem("cert_intro", "1").catch(() => {}); setIntro("done"); };

  const load = useCallback(async () => {
    const [gRes, cRes, sRes, pRes] = await Promise.all([
      supabase.from("goals").select("*").order("created_at", { ascending: true }),
      supabase.from("certs").select("*").order("issued_at", { ascending: false }),
      supabase.from("submissions").select("goal_id,day,status").order("day", { ascending: true }),
      supabase.from("profiles").select("plan,freezes").eq("id", session.user.id).maybeSingle(),
    ]);
    if (gRes.error) Alert.alert("Cert", gRes.error.message);
    setGoals(gRes.data || []);
    setCerts(cRes.data || []);
    setSubs(sRes.data || []);
    setProfile(pRes.data || null);
    syncDeadlineReminders(gRes.data || []).catch(() => {}); // auto "deadline soon" nudges
  }, [session.user.id]);
  useEffect(() => { load(); }, [load]);

  // RevenueCat: identify this user so store purchases credit the right account.
  // Push: register this device for "streak at risk" notifications.
  useEffect(() => {
    initPurchases(session.user.id).catch(() => {});
    registerForPush(session.user.id).catch(() => {});
  }, [session.user.id]);
  const isPro = profile?.plan === "monthly" || profile?.plan === "yearly";
  const freezes = profile?.freezes ?? 0;
  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false); }

  // keep the profile timezone in sync with the device so day boundaries and
  // time-of-day deadlines are judged in the user's local time
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) supabase.from("profiles").update({ timezone: tz }).eq("id", session.user.id).then(() => {});
    } catch (_) { /* ignore */ }
  }, [session.user.id]);

  const openCert = (c) => { setActiveCert(c); setScreen("cert"); };
  const openBadge = (b) => { setActiveBadge(b); setScreen("badge"); };
  const openReel = (g) => { setActiveReelGoal(g); setScreen("reel"); };

  // ----- first-run: how-it-works onboarding, once per install (no auto-paywall) -----
  if (intro === "onboarding") return <Onboarding onDone={finishIntro} />;

  const openPaywall = () => setPaywallOpen(true);
  // Rendered inside every branch below so it overlays forms too (sheet on iOS,
  // fullscreen Modal on Android). The screen underneath stays mounted.
  const paywallModal = (
    <Modal visible={paywallOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPaywallOpen(false)}>
      {/* fresh provider: safe-area insets don't propagate into native Modals */}
      <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top"]}>
        <Paywall isPro={isPro} freezes={freezes} onDone={load} onBack={() => setPaywallOpen(false)} />
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
  const freezeModal = (
    <Modal visible={freezeSheetOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setFreezeSheetOpen(false)}>
      <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top"]}>
        <FreezeSheet freezes={freezes} onDone={load} onClose={() => setFreezeSheetOpen(false)} />
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );

  // ----- overlay screens (full screen, own back + swipe-from-left to go back) -----
  let overlay = null;
  if (screen === "new") { const back = () => setScreen(null); overlay = <SwipeBack onBack={back}><NewGoal session={session} isPro={isPro} onUpgrade={openPaywall} onDone={async () => { await load(); setScreen(null); }} onBack={back} /></SwipeBack>; }
  else if (screen === "submit" && active) { const back = () => { setScreen(submitReturn); setSubmitReturn(null); }; overlay = <SwipeBack onBack={back}><Submit goal={active} goalSubs={(subs || []).filter((x) => x.goal_id === active.id)} onDone={async () => { await load(); setScreen(submitReturn); setSubmitReturn(null); }} onViewBadge={openBadge} onBack={back} /></SwipeBack>; }
  else if (screen === "challengeNew") { const back = () => setScreen(null); overlay = <SwipeBack onBack={back}><CreateChallenge isPro={isPro} onUpgrade={openPaywall} onCreated={(id) => { setActiveChallenge(id); setScreen("challengeDetail"); }} onBack={back} /></SwipeBack>; }
  else if (screen === "challengeJoin") { const back = () => { setJoinCode(""); setScreen(null); }; overlay = <SwipeBack onBack={back}><JoinChallenge initialCode={joinCode} onJoined={(id) => { setJoinCode(""); setActiveChallenge(id); setScreen("challengeDetail"); }} onBack={back} /></SwipeBack>; }
  else if (screen === "challengeDetail" && activeChallenge) { const back = () => setScreen(null); overlay = <SwipeBack onBack={back}><ChallengeDetail challengeId={activeChallenge} onSubmitProof={(g) => { setActive(g); setSubmitReturn("challengeDetail"); setScreen("submit"); }} onReview={() => setScreen("review")} onSharePlacement={(rank, title) => { setActivePlacement({ rank, title }); setScreen("placement"); }} onBack={back} /></SwipeBack>; }
  else if (screen === "review") { overlay = <SwipeReview onBack={() => setScreen("challengeDetail")} />; }
  else if (screen === "placement" && activePlacement) { const back = () => setScreen("challengeDetail"); overlay = <SwipeBack onBack={back}><ShareScreen kind="placement" rank={activePlacement.rank} title={activePlacement.title} onBack={back} /></SwipeBack>; }
  else if (screen === "settings") { const back = () => setScreen(null); overlay = <SwipeBack onBack={back}><SettingsScreen session={session} onBack={back} /></SwipeBack>; }
  else if (screen === "cert" && activeCert) { const back = () => setScreen(null); overlay = <SwipeBack onBack={back}><ShareScreen kind="cert" days={activeCert.days} title={activeCert.title} subtitle={activeCert.issued_at ? "Earned " + new Date(activeCert.issued_at).toLocaleDateString() : null} onBack={back} /></SwipeBack>; }
  else if (screen === "badge" && activeBadge) { const back = () => setScreen(null); overlay = <SwipeBack onBack={back}><ShareScreen kind="milestone" days={activeBadge.days} title={activeBadge.title} onBack={back} /></SwipeBack>; }
  else if (screen === "reel" && activeReelGoal) { const back = () => setScreen(null); overlay = <SwipeBack onBack={back}><Reel goal={activeReelGoal} onBack={back} /></SwipeBack>; }
  if (overlay) return <View style={{ flex: 1, backgroundColor: C.bg }}>{overlay}{paywallModal}{freezeModal}</View>;

  // Delete a personal goal (cascades its submissions/appeals; Certs are kept,
  // their goal link just goes null). Verified-days total lives on the goal row,
  // so deleting drops it — that's expected for a removed goal.
  function deleteGoal(goal) {
    Alert.alert(t("Delete this goal?"), t("Removes the goal and its history. Your earned Certs stay. This can't be undone."), [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Delete"), style: "destructive", onPress: async () => {
        const { error } = await supabase.from("goals").delete().eq("id", goal.id);
        if (error) Alert.alert("Cert", error.message);
        else await load();
      } },
    ]);
  }

  // Delete a Cert (the achievement is the user's to remove).
  function deleteCert(cert) {
    Alert.alert(t("Delete this Cert?"), t("Removes it for good. This can't be undone."), [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Delete"), style: "destructive", onPress: async () => {
        const { error } = await supabase.from("certs").delete().eq("id", cert.id);
        if (error) Alert.alert("Cert", error.message);
        else await load();
      } },
    ]);
  }

  // Free tier = 1 active personal goal; a 2nd goal is a Pro upsell moment.
  function startNewGoal() {
    setCreateChooser(false);
    const activePersonal = (goals || []).filter((g) => !g.challenge_id && g.status !== "completed");
    if (!isPro && activePersonal.length >= 1) { openPaywall(); return; }
    setTab("home"); setScreen("new");
  }

  // Center "+" chooser: personal goal or friend challenge.
  const createChooserModal = (
    <Modal visible={createChooser} transparent animationType="fade" onRequestClose={() => setCreateChooser(false)}>
      <TouchableOpacity activeOpacity={1} onPress={() => setCreateChooser(false)} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ backgroundColor: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 34, borderTopWidth: 1, borderColor: C.line }}>
          <Text style={[s.h2, { marginBottom: 2 }]}>{t("Create")}</Text>
          <OptionCard icon="flag-outline" title={t("New goal")} desc={t("A personal streak only you do.")} onPress={startNewGoal} />
          <OptionCard icon="flame-outline" title={t("New challenge")} desc={t("Compete with friends on a shared goal.")} onPress={() => { setCreateChooser(false); setTab("challenges"); setScreen("challengeNew"); }} />
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );

  // ----- tab shell (horizontal swipe switches tabs) -----
  const TAB_ORDER = ["home", "challenges", "stats", "profile"];
  const tabSwipe = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 28 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
    onPanResponderRelease: (_, g) => {
      const i = TAB_ORDER.indexOf(tab);
      if (g.dx <= -55 && i < TAB_ORDER.length - 1) setTab(TAB_ORDER[i + 1]);
      else if (g.dx >= 55 && i > 0) setTab(TAB_ORDER[i - 1]);
    },
  });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1 }} {...tabSwipe.panHandlers}>
        {tab === "home" && (
          <HomeTab goals={goals} certs={certs} subs={subs} refreshing={refreshing} onRefresh={onRefresh}
            freezes={freezes} onBuyFreezes={() => setFreezeSheetOpen(true)}
            onNew={startNewGoal} onSubmit={(g) => { setActive(g); setSubmitReturn(null); setScreen("submit"); }} onOpenCert={openCert} onReel={openReel} onDelete={deleteGoal} onDeleteCert={deleteCert} />
        )}
        {tab === "challenges" && (
          <ChallengesScreen onOpen={(id) => { setActiveChallenge(id); setScreen("challengeDetail"); }}
            onCreate={() => setScreen("challengeNew")} onJoin={() => setScreen("challengeJoin")} />
        )}
        {tab === "stats" && <Stats goals={goals || []} subs={subs} onOpenBadge={openBadge} isPro={isPro} onUpgrade={openPaywall} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === "profile" && <ProfileTab session={session} goals={goals || []} certs={certs} subs={subs} freezes={freezes} onOpenCert={openCert} onOpenSettings={() => setScreen("settings")} onUpgrade={openPaywall} onBuyFreezes={() => setFreezeSheetOpen(true)} onReload={load} refreshing={refreshing} onRefresh={onRefresh} />}
      </View>
      <TabBar tab={tab} setTab={setTab} onCreate={() => setCreateChooser(true)} />
      {paywallModal}
      {freezeModal}
      {createChooserModal}
    </View>
  );
}

function TabBar({ tab, setTab, onCreate }) {
  const insets = useSafeAreaInsets();
  const items = [
    ["home", "home", "home-outline", "Home"],
    ["challenges", "flame", "flame-outline", "Versus"],
    ["stats", "stats-chart", "stats-chart-outline", "Stats"],
    ["profile", "person", "person-outline", "Profile"],
  ];
  // Raised center "+" — the quickest path to creating a challenge from anywhere.
  const renderItem = ([key, iconOn, iconOff, label]) => {
    const on = tab === key;
    return (
      <TouchableOpacity key={key} style={s.tabItem} onPress={() => setTab(key)} activeOpacity={0.7}>
        <Ionicons name={on ? iconOn : iconOff} size={22} color={on ? C.bronze : C.faint} />
        <Text style={[s.tabLabel, on && { color: C.bronze }]}>{t(label)}</Text>
      </TouchableOpacity>
    );
  };
  return (
    <View style={[s.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {items.slice(0, 2).map(renderItem)}
      <View style={s.tabItem}>
        <TouchableOpacity style={s.tabCreate} onPress={onCreate} activeOpacity={0.85}>
          <Ionicons name="add" size={30} color={C.isDark ? "#ffffff" : "#fff"} />
        </TouchableOpacity>
      </View>
      {items.slice(2).map(renderItem)}
    </View>
  );
}

function HomeTab({ goals, certs, subs, refreshing, onRefresh, freezes = 0, onBuyFreezes, onNew, onSubmit, onOpenCert, onReel, onDelete, onDeleteCert }) {
  const [showDone, setShowDone] = useState(false);
  const [showCerts, setShowCerts] = useState(false); // collapsed by default — keeps home clean
  const [hideStreak] = useHideStreak();
  const myGoals = (goals || []).filter((g) => !g.challenge_id); // challenge goals live under Versus
  const doneGoals = myGoals.filter((g) => g.status === "completed");
  const subsByGoal = {};
  for (const x of subs || []) { (subsByGoal[x.goal_id] = subsByGoal[x.goal_id] || []).push(x); }
  // Goals still needing today's proof float to the top; ones already done today
  // drop below (stable within each group, so creation order is otherwise kept).
  const todayStr = isoDateParts(new Date()).date;
  const doneToday = (g) => (subsByGoal[g.id] || []).some((x) => (x.status === "approved" || x.status === "frozen") && x.day === todayStr);
  const activeGoals = myGoals
    .filter((g) => g.status !== "completed")
    .map((g, i) => ({ g, i, done: doneToday(g) }))
    .sort((a, b) => (a.done - b.done) || (a.i - b.i))
    .map((x) => x.g);
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.bronze} />}>
      <View style={s.rowBetween}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Image source={LOGO} style={s.brandLogo} resizeMode="contain" />
          <Text style={s.brand}>CERT</Text>
        </View>
        <TouchableOpacity onPress={onBuyFreezes} activeOpacity={0.8} style={s.freezePill}>
          <Ionicons name="snow-outline" size={16} color={C.bronze} />
          <Text style={s.freezePillNum}>{freezes}</Text>
          <Ionicons name="add" size={14} color={C.faint} />
        </TouchableOpacity>
      </View>

      {certs.length > 0 ? (
        <View style={{ marginTop: 8, marginBottom: 6 }}>
          <TouchableOpacity onPress={() => setShowCerts((v) => !v)} activeOpacity={0.7}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}>
            <Text style={[s.kicker, { color: C.bronze, flex: 1 }]}>{t("Your Certs")} · {certs.length}</Text>
            <Ionicons name={showCerts ? "chevron-up" : "chevron-down"} size={18} color={C.bronze} />
          </TouchableOpacity>
          {showCerts ? certs.map((c) => (
            <TouchableOpacity key={c.id} style={s.certRow} onPress={() => onOpenCert(c)}>
              <Text style={s.certRowDays}>{c.days}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.certRowTitle} numberOfLines={1}>{c.title}</Text>
                <Text style={s.note}>{t("verified days · tap to share")}</Text>
              </View>
              {onDeleteCert ? (
                <TouchableOpacity onPress={() => onDeleteCert(c)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="trash-outline" size={17} color={C.faint} />
                </TouchableOpacity>
              ) : null}
              <Text style={s.certRowChevron}>›</Text>
            </TouchableOpacity>
          )) : null}
        </View>
      ) : null}

      {goals === null ? (
        <ActivityIndicator color={C.bronze} style={{ marginTop: 40 }} />
      ) : myGoals.length === 0 ? (
        <View style={[s.card, { alignItems: "center", marginTop: 24 }]}>
          <Text style={s.h2}>{t("No goals yet")}</Text>
          <Text style={[s.lede, { textAlign: "center" }]}>{t("Create your first goal and start a streak the judge can't fake.")}</Text>
          <Btn label={"+ " + t("New goal")} onPress={onNew} />
        </View>
      ) : (
        <>
          {activeGoals.map((g) => (
            <GoalCard key={g.id} goal={g} subs={subsByGoal[g.id] || []} doneToday={doneToday(g)} hideStreak={hideStreak} onSubmit={() => onSubmit(g)} onReel={() => onReel(g)}
              onOpenCert={() => { const c = certs.find((x) => x.goal_id === g.id); if (c) onOpenCert(c); }} onDelete={() => onDelete && onDelete(g)} />
          ))}
          <BtnGhost label={"+ " + t("Add a goal")} onPress={onNew} />
          {doneGoals.length > 0 ? (
            <>
              <TouchableOpacity onPress={() => setShowDone((v) => !v)} activeOpacity={0.7}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22, paddingVertical: 6 }}>
                <Ionicons name="checkmark-done-outline" size={16} color={C.mute} />
                <Text style={[s.kicker, { flex: 1 }]}>{t("Completed")} · {doneGoals.length}</Text>
                <Ionicons name={showDone ? "chevron-up" : "chevron-down"} size={18} color={C.mute} />
              </TouchableOpacity>
              {showDone ? doneGoals.map((g) => (
                <GoalCard key={g.id} goal={g} subs={subsByGoal[g.id] || []} onSubmit={() => onSubmit(g)} onReel={() => onReel(g)}
                  onOpenCert={() => { const c = certs.find((x) => x.goal_id === g.id); if (c) onOpenCert(c); }} onDelete={() => onDelete && onDelete(g)} />
              )) : null}
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

/* ---------- payments (RevenueCat) ---------- */
// The store charges the user; our revenuecat-webhook Edge Function is what
// actually credits freezes / sets the plan. After a purchase we reload the
// profile shortly after so the new balance/plan shows up.
async function purchaseFlow(productId, onReload) {
  try {
    const ok = await buyProduct(productId);
    if (!ok) return; // user cancelled
    Alert.alert("Cert", t("Purchase complete. Your account updates in a few seconds."));
    setTimeout(() => { onReload && onReload(); }, 2500);
  } catch (e) {
    const msg = e && e.message === "payments_unavailable"
      ? t("Payments need a dev/EAS build with RevenueCat installed.")
      : (e && e.message) || t("Purchase failed.");
    Alert.alert("Cert", msg);
  }
}
/* ---------- FREEZE SHEET (buying freezes gets its own mini-paywall) ---------- */
function FreezeSheet({ freezes = 0, onDone, onClose }) {
  const [packs, setPacks] = useState(null); // null=loading · []=unavailable
  const enabled = purchasesEnabled();
  useEffect(() => {
    let alive = true;
    if (!enabled) { setPacks([]); return; }
    getProducts().then((p) => { if (alive) setPacks(p.freezePacks || []); }).catch(() => { if (alive) setPacks([]); });
    return () => { alive = false; };
  }, [enabled]);
  const NAMES = { freeze_pack_3: t("3 freezes") };
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 40 }]}>
      <BackBar onBack={onClose} />
      <View style={s.pwHero}>
        <View style={s.pwGlow}><Ionicons name="snow" size={62} color={C.bronze} /></View>
        <Text style={s.pwTitle}>{t("Streak freezes")}</Text>
        <Text style={s.pwSub}>{t("Miss a day — a freeze is spent automatically overnight and your streak survives.")}</Text>
      </View>
      <View style={[s.freezePill, { alignSelf: "center", marginTop: 12 }]}>
        <Ionicons name="snow-outline" size={16} color={C.bronze} />
        <Text style={s.freezePillNum}>{t("You have {n} freezes", { n: freezes })}</Text>
      </View>
      {packs === null ? (
        <ActivityIndicator color={C.bronze} style={{ marginTop: 24 }} />
      ) : packs.length === 0 ? (
        <Text style={[s.note, { marginTop: 16 }]}>{t("Payments aren't configured yet (add your RevenueCat key in config.js).")}</Text>
      ) : (
        packs.map((p) => {
          return (
            <TouchableOpacity key={p.identifier} activeOpacity={0.85} onPress={() => purchaseFlow(p.identifier, onDone)} style={s.planLine}>
              <Ionicons name="snow-outline" size={22} color={C.bronze} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={[s.buyTitle, { fontSize: 15 }]}>{NAMES[p.identifier] || p.title || p.identifier}</Text>
                </View>
                <Text style={[s.planPer, { marginTop: 3 }]}>{t("One-time purchase · works on Free too")}</Text>
              </View>
              <Text style={s.planLinePrice}>{p.priceString || ""}</Text>
            </TouchableOpacity>
          );
        })
      )}
    </ScrollView>
  );
}

const PRO_FEATURES = [
  ["videocam", "Timelapse video proof — the AI watches the whole clip"],
  ["location", "Geo check-in — prove you were actually there"],
  ["infinite", "Unlimited goals at once"],
  ["stats-chart", "Analytics: consistency heatmap & trophies"],
  ["snow", "Monthly streak freezes included"],
];
function Paywall({ isPro, freezes = 0, onDone, onBack }) {
  const [products, setProducts] = useState(null); // { freezePacks:[], pro:[] }
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const enabled = purchasesEnabled();
  useEffect(() => {
    let alive = true;
    if (!enabled) { setLoading(false); return; }
    getProducts()
      .then((p) => {
        if (!alive) return;
        setProducts(p);
        const y = (p.pro || []).find((x) => x.identifier === "cert_pro_yearly");
        setSelected((y || (p.pro || [])[0])?.identifier || null); // default to yearly
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled]);

  const NAMES = { cert_pro_monthly: t("Monthly"), cert_pro_yearly: t("Yearly") };
  const buy = (id) => purchaseFlow(id, onDone);
  const pro = products?.pro || [];
  const nameOf = (p) => NAMES[p.identifier] || p.title || p.identifier;
  const monthly = pro.find((p) => p.identifier === "cert_pro_monthly");
  const yearly = pro.find((p) => p.identifier === "cert_pro_yearly");
  let savePct = null;
  if (monthly?.price && yearly?.price) { const v = Math.round((1 - yearly.price / (monthly.price * 12)) * 100); if (v > 0) savePct = v; }
  const selProduct = pro.find((p) => p.identifier === selected);
  // "≈ X/mo" for the yearly plan — a yearly lump sum scares, per-month sells
  const perMonth = (p) => {
    try {
      if (!p?.price || !p?.currencyCode) return null;
      return new Intl.NumberFormat(undefined, { style: "currency", currency: p.currencyCode, maximumFractionDigits: 2 }).format(p.price / 12);
    } catch (_) { return null; }
  };

  async function doRestore() {
    setRestoring(true);
    try { await restorePurchases(); setTimeout(() => onDone && onDone(), 1500); }
    catch (e) { Alert.alert("Cert", (e && e.message) || t("Nothing to restore.")); }
    finally { setRestoring(false); }
  }

  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 60 }]}>
      <BackBar onBack={onBack} />

      {/* Hero: the brand's stamp motif — same language as the APPROVED stamp */}
      <View style={s.pwHero}>
        <View style={s.pwStamp}>
          <Text style={s.pwStampT}>CERT PRO ✓</Text>
        </View>
        <Text style={[s.pwSub, { marginTop: 20 }]}>{t("Stronger proof methods, more goals, and deeper stats.")}</Text>
      </View>

      {/* Free vs Pro comparison — makes the upgrade reason obvious at a glance */}
      <View style={[s.card, { marginTop: 16, paddingVertical: 12 }]}>
        <View style={{ flexDirection: "row", paddingBottom: 9, borderBottomWidth: 1, borderColor: C.line }}>
          <Text style={[s.kicker, { flex: 1.5 }]}>{t("What you get")}</Text>
          <Text style={[s.kicker, { flex: 0.7, textAlign: "center" }]}>Free</Text>
          <Text style={[s.kicker, { flex: 0.7, textAlign: "center", color: C.bronze }]}>PRO</Text>
        </View>
        {[
          [t("Active goals"), "1", "∞"],
          [t("Photo proof"), "✓", "✓"],
          [t("Video & location proof"), "—", "✓"],
          [t("Analytics & trophies"), "—", "✓"],
          [t("Monthly freezes"), "—", "✓"],
        ].map(([f, a, b], i, arr) => (
          <View key={f} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: i === arr.length - 1 ? 0 : 1, borderColor: C.line }}>
            <Text style={[s.goalText, { flex: 1.5, marginTop: 0, fontSize: 13.5 }]}>{f}</Text>
            <Text style={{ flex: 0.7, textAlign: "center", color: C.faint, fontSize: 14 }}>{a}</Text>
            <Text style={{ flex: 0.7, textAlign: "center", color: C.bronze, fontSize: 15, fontWeight: "800" }}>{b}</Text>
          </View>
        ))}
      </View>

      {isPro ? (
        <View style={[s.card, { alignItems: "center", borderColor: C.bronze, marginTop: 16 }]}>
          <Ionicons name="checkmark-circle" size={26} color={C.bronze} />
          <Text style={[s.kicker, { color: C.bronze, marginTop: 6 }]}>{t("You're on Pro")}</Text>
          <Text style={s.note}>{t("Thanks for backing the streak you can't fake.")}</Text>
        </View>
      ) : !enabled ? (
        <Text style={[s.note, { marginTop: 16 }]}>{t("Payments aren't configured yet (add your RevenueCat key in config.js).")}</Text>
      ) : loading ? (
        <ActivityIndicator color={C.bronze} style={{ marginTop: 24 }} />
      ) : pro.length === 0 ? (
        <Text style={[s.note, { marginTop: 16 }]}>{t("No products found. Check the product IDs in RevenueCat.")}</Text>
      ) : (
        <>
          {/* Plans — vertical rows, yearly first with per-month framing */}
          {[yearly, monthly].filter(Boolean).map((p) => {
            const on = p.identifier === selected;
            const isYear = p.identifier === "cert_pro_yearly";
            const mo = isYear ? perMonth(p) : null;
            return (
              <TouchableOpacity key={p.identifier} activeOpacity={0.85} onPress={() => setSelected(p.identifier)} style={[s.planLine, on && s.planLineOn]}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={[s.buyTitle, { fontSize: 15 }, on && { color: C.bronze }]}>{nameOf(p)}</Text>
                    {isYear && savePct ? <Text style={s.planSave}>{t("SAVE {n}%", { n: savePct })}</Text> : null}
                  </View>
                  <Text style={[s.planPer, { marginTop: 3 }]}>
                    {isYear ? (mo ? t("≈ {p}/mo · billed once a year", { p: mo }) : t("billed once a year")) : t("billed monthly")}
                  </Text>
                </View>
                <Text style={s.planLinePrice}>{p.priceString}</Text>
                <Ionicons name={on ? "checkmark-circle" : "ellipse-outline"} size={22} color={on ? C.bronze : C.line} style={{ marginLeft: 10 }} />
              </TouchableOpacity>
            );
          })}

          <Btn label={selProduct ? `${t("Start Pro")}  ·  ${selProduct.priceString}` : t("Start Pro")} onPress={() => selected && buy(selected)} disabled={!selected} />
          <Text style={[s.note, { textAlign: "center", marginTop: 8 }]}>{t("Cancel anytime in your App Store settings.")}</Text>
        </>
      )}

      {/* fine print: one quiet links row + tiny auto-renew note */}
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 20, marginTop: 18 }}>
        <TouchableOpacity onPress={doRestore} disabled={restoring}>
          <Text style={s.finePrintLink}>{restoring ? t("Restoring…") : t("Restore purchases")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL("https://www.certapp.pro/terms.html")}>
          <Text style={s.finePrintLink}>{t("Terms of Use")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL("https://www.certapp.pro/privacy.html")}>
          <Text style={s.finePrintLink}>{t("Privacy Policy")}</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.finePrint}>{t("Cert Pro is an auto-renewing subscription that renews at the price shown for the same period, unless cancelled at least 24 hours before the period ends. Manage or cancel anytime in your store account.")}</Text>
    </ScrollView>
  );
}

function ProfileTab({ session, goals, certs, subs, freezes = 0, onOpenCert, onOpenSettings, onUpgrade, onBuyFreezes, onReload, refreshing, onRefresh }) {
  // The tab unmounts on every tab switch — render instantly from the module
  // cache and refresh silently in the background (no reload flash).
  const cached = _profileCache && _profileCache.uid === session.user.id ? _profileCache.data : null;
  const [profile, setProfile] = useState(cached);
  const [name, setName] = useState(cached?.name || "");
  const [avatar, setAvatar] = useState(cached?.avatar_url || null);
  const loadProfile = useCallback(() => {
    supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        _profileCache = { uid: session.user.id, data };
        setProfile(data); setName(data.name || ""); setAvatar(data.avatar_url || null);
      });
  }, [session.user.id]);
  useEffect(() => { loadProfile(); }, [loadProfile]);
  const handleRefresh = async () => { loadProfile(); if (onRefresh) await onRefresh(); };
  const st = computeStats(goals, subs);
  const plan = profile?.plan === "monthly" || profile?.plan === "yearly" ? "Pro" : "Free";

  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}
      keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive"
      refreshControl={<RefreshControl refreshing={!!refreshing} onRefresh={handleRefresh} tintColor={C.bronze} />}>
      <View style={s.rowBetween}>
        <Text style={s.h2}>{t("Profile")}</Text>
        <TouchableOpacity onPress={onOpenSettings} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="settings-outline" size={22} color={C.mute} />
        </TouchableOpacity>
      </View>
      {/* identity is display-only here — editing (name/photo) lives in Settings */}
      <TouchableOpacity style={[s.card, { alignItems: "center" }]} activeOpacity={0.85} onPress={onOpenSettings}>
        {avatar
          ? <Image source={{ uri: avatar }} style={s.avatar} />
          : <View style={[s.avatar, s.avatarEmpty]}><Image source={LOGO} style={{ width: 46, height: 46 }} resizeMode="contain" /></View>}
        <Text style={[s.goalText, { marginTop: 8, fontWeight: "700" }]}>{name || t("Your name")}</Text>
        <Text style={[s.kicker, { marginTop: 4 }]}>{t("PLAN")} · {plan}</Text>
        <Text style={[s.note, { marginTop: 6 }]}>{t("Edit in settings")} ›</Text>
      </TouchableOpacity>

      <View style={s.statRow}>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.verifiedTotal}</Text><Text style={s.statLabel}>{t("verified days")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.bestStreak}</Text><Text style={s.statLabel}>{t("best streak")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{certs.length}</Text><Text style={s.statLabel}>{t("certs")}</Text></View>
      </View>

      {/* Streak freeze — protects a missed day. Anyone can buy a pack, Pro or free. */}
      <View style={[s.card, { marginTop: 16 }]}>
        <View style={s.rowBetween}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={s.optIcon}><Ionicons name="snow-outline" size={20} color={C.bronze} /></View>
            <Text style={s.kicker}>{t("Streak freezes")}</Text>
          </View>
          <Text style={[s.statNum, { fontSize: 22 }]}>{freezes}</Text>
        </View>
        <Text style={[s.note, { marginTop: 8, textAlign: "left" }]}>{t("A freeze auto-protects a missed day so your streak survives. Used automatically by the nightly check.")}</Text>
        <Btn label={t("Buy freezes")} onPress={onBuyFreezes} />
      </View>

      {plan !== "Pro" ? (
        <TouchableOpacity style={[s.card, { marginTop: 12 }]} activeOpacity={0.85} onPress={onUpgrade}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={s.proChip}><Text style={s.proChipT}>PRO</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={[s.kicker, { color: C.bronze }]}>{t("Upgrade to Pro")}</Text>
              <Text style={[s.note, { textAlign: "left", marginTop: 3 }]}>{t("Video & location proof, unlimited goals, analytics, and monthly freezes.")}</Text>
            </View>
            <Text style={s.certRowChevron}>›</Text>
          </View>
        </TouchableOpacity>
      ) : null}

      {certs.length > 0 ? (
        <>
          <Text style={[s.kicker, { color: C.bronze, marginTop: 20, marginBottom: 8 }]}>{t("Your Certs")}</Text>
          {certs.map((c) => (
            <TouchableOpacity key={c.id} style={s.certRow} onPress={() => onOpenCert(c)}>
              <Text style={s.certRowDays}>{c.days}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.certRowTitle} numberOfLines={1}>{c.title}</Text>
                <Text style={s.note}>verified days · tap to share</Text>
              </View>
              <Text style={s.certRowChevron}>›</Text>
            </TouchableOpacity>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

/* ---------- SETTINGS ---------- */
function SettingsScreen({ session, onBack }) {
  const [remEnabled, setRemEnabled] = useState(false);
  const [remTime, setRemTime] = useState("20:00");
  const [tz, setTz] = useState("");
  const [busy, setBusy] = useState(false);
  const [themePref, setTheme] = useThemePref();
  const [langPref, setLang] = useLang();
  const [hideStreak, setHideStreak] = useHideStreak();
  const [showIntro, setShowIntro] = useState(false);
  // profile identity (name + avatar) is edited HERE, not on the Profile tab
  const cachedP = _profileCache && _profileCache.uid === session.user.id ? _profileCache.data : null;
  const [name, setName] = useState(cachedP?.name || "");
  const [avatar, setAvatar] = useState(cachedP?.avatar_url || null);
  const [savingP, setSavingP] = useState(false);
  useEffect(() => {
    if (cachedP) return;
    supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => { if (data) { _profileCache = { uid: session.user.id, data }; setName(data.name || ""); setAvatar(data.avatar_url || null); } });
  }, [session.user.id]);

  async function saveName() {
    setSavingP(true);
    const { error } = await supabase.from("profiles").update({ name: name.trim() }).eq("id", session.user.id);
    if (!error) {
      _cachedName = name.trim(); // keep challenge screens in sync
      if (_profileCache?.data) _profileCache.data.name = name.trim();
    }
    setSavingP(false);
    Alert.alert("Cert", error ? error.message : t("Saved."));
  }

  // Upload the avatar to Storage and save its URL (not a base64 blob in the DB —
  // that made every profile/leaderboard load pull a huge string and lag).
  async function pickAvatar() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert("Cert", t("Photo permission needed."));
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.5 });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    const a = res.assets[0];
    try {
      setSavingP(true);
      const bytes = await fetch(a.uri).then((r) => r.arrayBuffer());
      const ext = ((a.mimeType || "image/jpeg").split("/")[1] || "jpg").replace("jpeg", "jpg");
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("avatars").upload(path, bytes, { contentType: a.mimeType || "image/jpeg", upsert: true });
      if (upErr) throw upErr;
      const url = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
      const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", session.user.id);
      if (error) throw error;
      setAvatar(url);
      if (_profileCache?.data) _profileCache.data.avatar_url = url;
    } catch (e) {
      Alert.alert("Cert", (e && e.message) || t("Couldn't update photo."));
    } finally { setSavingP(false); }
  }

  function deleteAccount() {
    Alert.alert(
      t("Delete account?"),
      t("This permanently deletes your account and all your goals, proofs and stats. This can't be undone."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Delete"), style: "destructive", onPress: async () => {
          try {
            setBusy(true);
            const { error } = await supabase.functions.invoke("delete-account");
            if (error) throw error;
            await supabase.auth.signOut(); // back to the login screen
          } catch (e) {
            Alert.alert("Cert", e.message || t("Could not delete the account."));
          } finally { setBusy(false); }
        } },
      ]
    );
  }
  useEffect(() => {
    getReminderPref().then((p) => { setRemEnabled(p.enabled); setRemTime(p.time); });
    try { setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || ""); } catch (_) { /* */ }
  }, []);

  async function toggleReminder(on) {
    if (on) {
      const r = await enableReminder(remTime);
      if (!r.ok) { Alert.alert("Cert", "Enable notifications in your phone settings to get reminders."); return; }
      setRemEnabled(true);
    } else { await disableReminder(); setRemEnabled(false); }
  }
  async function pickTime(t) { if (!t) return; setRemTime(t); if (remEnabled) await enableReminder(t); }

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Settings")}</Text>

      {/* Profile identity — moved here from the Profile tab */}
      <View style={[s.card, { marginTop: 14 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <TouchableOpacity onPress={pickAvatar} activeOpacity={0.8} disabled={savingP}>
            {avatar
              ? <Image source={{ uri: avatar }} style={[s.avatar, { width: 62, height: 62, borderRadius: 31 }]} />
              : <View style={[s.avatar, s.avatarEmpty, { width: 62, height: 62, borderRadius: 31 }]}><Ionicons name="person-outline" size={26} color={C.faint} /></View>}
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>{t("Display name")}</Text>
            <TextInput style={s.input} placeholder={t("Your name")} placeholderTextColor={C.faint} value={name} onChangeText={setName} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-end" }}>
          <View style={{ flex: 1 }}><BtnGhost style={{ marginTop: 12 }} label={savingP ? "…" : t("Change photo")} onPress={pickAvatar} disabled={savingP} /></View>
          <View style={{ flex: 1 }}><Btn style={{ marginTop: 12 }} label={savingP ? t("Saving…") : t("Save name")} onPress={saveName} disabled={savingP} /></View>
        </View>
      </View>

      <View style={[s.card, { marginTop: 14 }]}>
        <Text style={s.label}>{t("Appearance")}</Text>
        <Text style={[s.kicker, { marginTop: 6, marginBottom: 6 }]}>{t("Theme")}</Text>
        <View style={s.rowGap}>
          <Pill label={t("System")} active={themePref === "system"} onPress={() => setTheme("system")} />
          <Pill label={t("Dark")} active={themePref === "dark"} onPress={() => setTheme("dark")} />
          <Pill label={t("Light")} active={themePref === "light"} onPress={() => setTheme("light")} />
        </View>
        <Text style={[s.kicker, { marginTop: 14, marginBottom: 6 }]}>{t("Language")}</Text>
        <View style={s.rowGap}>
          <Pill label={t("System")} active={langPref === "system"} onPress={() => setLang("system")} />
          <Pill label="EN" active={langPref === "en"} onPress={() => setLang("en")} />
          <Pill label="RU" active={langPref === "ru"} onPress={() => setLang("ru")} />
        </View>
        <View style={[s.rowBetween, { marginTop: 16 }]}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={[s.kicker, { marginBottom: 2 }]}>{t("Hide streak count")}</Text>
            <Text style={[s.note, { textAlign: "left", marginTop: 0 }]}>{t("Show up without the number staring at you.")}</Text>
          </View>
          <Switch value={hideStreak} onValueChange={setHideStreak} trackColor={{ true: C.bronze, false: C.line }} thumbColor={C.ink} />
        </View>
      </View>

      <View style={[s.card, { marginTop: 14 }]}>
        <View style={s.rowBetween}>
          <Text style={[s.h2, { flex: 1, marginRight: 12 }]} numberOfLines={2}>{t("Daily reminder")}</Text>
          <Switch value={remEnabled} onValueChange={toggleReminder} trackColor={{ true: C.bronze, false: C.line }} thumbColor={C.ink} />
        </View>
        <Text style={s.note}>{t("A nudge to submit your proof so you never break the streak.")}</Text>
        <TimeField value={remTime} onChange={pickTime} placeholder="Pick a time" />
      </View>

      <View style={s.card}>
        <Text style={s.label}>{t("Time zone")}</Text>
        <Text style={s.goalText}>{tz || "—"}</Text>
        <Text style={s.note}>{t("Used for day boundaries and deadlines, set from your device.")}</Text>
      </View>

      <TouchableOpacity style={[s.card, { flexDirection: "row", alignItems: "center", gap: 12 }]} activeOpacity={0.8} onPress={() => setShowIntro(true)}>
        <Ionicons name="help-circle-outline" size={22} color={C.bronze} />
        <Text style={[s.goalText, { flex: 1, marginTop: 0 }]}>{t("How Cert works")}</Text>
        <Text style={s.certRowChevron}>›</Text>
      </TouchableOpacity>

      <BtnGhost label={t("Log out")} onPress={() => supabase.auth.signOut()} disabled={busy} />
      <TouchableOpacity onPress={deleteAccount} disabled={busy} style={{ marginTop: 10, paddingVertical: 12, alignItems: "center" }}>
        <Text style={{ color: C.err, fontWeight: "700", fontSize: 14 }}>{busy ? "…" : t("Delete account")}</Text>
      </TouchableOpacity>
      <Text style={[s.note, { textAlign: "center", marginTop: 16 }]}>Cert · v1.0 — {t("[ the streak you can't fake ]")}</Text>

      <Modal visible={showIntro} animationType="slide" onRequestClose={() => setShowIntro(false)}>
        {/* fresh provider: safe-area insets don't propagate into native Modals */}
        <SafeAreaProvider>
          <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top", "bottom"]}>
            <Onboarding onDone={() => setShowIntro(false)} />
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </ScrollView>
  );
}

const DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function goalCadence(goal) {
  if (goal.type === "one_time") {
    if (goal.deadline) return `${t("One-time")} · ${t("by")} ${goal.deadline}${goal.daily_deadline ? " " + goal.daily_deadline : ""}`;
    return t("One-time");
  }
  let freq;
  if (goal.format === "custom") freq = (goal.custom_days || []).map((d) => t(DOW_NAMES[d])).join(", ") || t("Custom");
  else freq = goal.format === "3x" ? t("3× / week") : goal.format === "5x" ? t("5× / week") : t("Daily");
  const dur = goal.format === "daily" && goal.duration_days ? ` · ${t("{n}d goal", { n: goal.duration_days })}` : "";
  return goal.daily_deadline ? `${freq}${dur} · ${t("by")} ${goal.daily_deadline}` : `${freq}${dur}`;
}
/* Streak number that pulses when the value grows (the moment of approval). */
function AnimatedStreakNum({ value }) {
  const scale = useRef(new Animated.Value(1)).current;
  const prev = useRef(value);
  useEffect(() => {
    if (value > prev.current) {
      scale.setValue(1);
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.35, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 4, useNativeDriver: true }),
      ]).start();
    }
    prev.current = value;
  }, [value]);
  return <Animated.Text style={[s.streakNum, { transform: [{ scale }] }]}>{value}</Animated.Text>;
}

function GoalCard({ goal, subs, doneToday, hideStreak, onSubmit, onOpenCert, onReel, onDelete }) {
  const completed = goal.status === "completed";
  const isWeekly = goal.type === "recurring" && (goal.format === "3x" || goal.format === "5x" || goal.format === "custom");
  const isRecurring = goal.type === "recurring";
  const verifiedCount = (subs || []).filter((x) => x.status === "approved" || x.status === "frozen").length;
  return (
    <View style={s.card}>
      {onDelete ? (
        <TouchableOpacity onPress={onDelete} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={{ position: "absolute", top: 12, right: 12, zIndex: 2, padding: 2 }}>
          <Ionicons name="trash-outline" size={18} color={C.faint} />
        </TouchableOpacity>
      ) : null}
      {hideStreak ? (
        <View style={{ alignItems: "center", paddingVertical: 10 }}>
          <Ionicons name="eye-off-outline" size={22} color={C.faint} />
          <Text style={[s.kicker, { marginTop: 4 }]}>{t("streak hidden")}</Text>
        </View>
      ) : (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Ionicons name="flame" size={26} color={C.red} />
            <AnimatedStreakNum value={goal.streak} />
            <Text style={[s.kicker, { marginBottom: 0 }]}>{isWeekly ? t("weeks") : t("days")}</Text>
          </View>
          <Text style={s.kicker}>{t("verified by the judge")}</Text>
        </>
      )}
      <Text style={s.goalText}>{goal.text}</Text>
      <Text style={[s.spec, { color: C.mute }]}>{goalCadence(goal)}</Text>
      {goal.proof_type === "geo" ? <Text style={s.spec}>{goal.geo_place || t("geo check-in")}{goal.daily_start ? ` · ${t("from")} ${goal.daily_start}` : ""}</Text> : null}
      {proofSpec(goal) ? <Text style={s.spec}>{proofSpec(goal)}</Text> : null}
      {isRecurring && !hideStreak ? <StreakCalendar subs={subs} /> : null}
      {isRecurring && !completed && !hideStreak ? <MilestoneBar streak={goal.streak || 0} /> : null}
      {completed ? (
        <TouchableOpacity onPress={onOpenCert}><Text style={[s.kicker, { color: C.bronze, marginTop: 12 }]}>{t("Completed — view & share Cert")} ›</Text></TouchableOpacity>
      ) : doneToday ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 16, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: C.green }}>
          <Ionicons name="checkmark-circle" size={20} color={C.green} style={{ flexShrink: 0 }} />
          <Text style={[s.kicker, { color: C.green, flexShrink: 1, textAlign: "center" }]} numberOfLines={2}>{isWeekly ? t("Done for today · come back tomorrow") : t("Done for today")}</Text>
        </View>
      ) : (
        <Btn label={goal.proof_type === "geo" ? t("Check in now") : t("Submit today's proof")} onPress={onSubmit} />
      )}
      {verifiedCount >= 2 ? <BtnGhost label={t("Progress reel") + ` · ${verifiedCount} ` + t("days")} onPress={onReel} /> : null}
    </View>
  );
}

/* Last 5 weeks of verified days as a grid (recent streak at a glance).
   Rows of 7 flex cells, so the grid stretches to the card's full width. */
function StreakCalendar({ subs }) {
  const done = new Set((subs || []).filter((x) => x.status === "approved" || x.status === "frozen").map((x) => x.day));
  const today = new Date();
  const cells = [];
  for (let i = 34; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); cells.push({ key: isoDateParts(d).date, on: done.has(isoDateParts(d).date), isToday: i === 0 }); }
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  const off = C.isDark ? "#1f242c" : "#e8ecf1";
  return (
    <View style={{ gap: 4, marginTop: 14 }}>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: "row", gap: 4 }}>
          {row.map((c) => (
            <View key={c.key} style={{ flex: 1, aspectRatio: 1, borderRadius: 4, backgroundColor: c.on ? C.green : off, borderWidth: c.isToday ? 1.5 : 0, borderColor: C.bronze }} />
          ))}
        </View>
      ))}
    </View>
  );
}

/* Progress bar to the next milestone badge (7 / 30 / 100 verified days). */
function MilestoneBar({ streak }) {
  const next = MILESTONES.find((m) => m > streak);
  if (!next) return <Text style={[s.note, { marginTop: 12 }]}>{t("Legend — past {n} days", { n: MILESTONES[MILESTONES.length - 1] })}</Text>;
  const left = next - streak;
  const pct = Math.max(0.02, Math.min(1, streak / next));
  const track = C.isDark ? "#1f242c" : "#e8ecf1";
  return (
    <View style={{ marginTop: 14 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <Text style={s.note}>{t("{n} days to your {b}-day badge", { n: left, b: next })}</Text>
        <Text style={s.note}>{streak}/{next}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: track, overflow: "hidden" }}>
        <View style={{ height: 6, width: (pct * 100) + "%", backgroundColor: C.bronze }} />
      </View>
    </View>
  );
}

/* ---------- TIMELAPSE REEL (flip-through of a goal's verified proofs) ---------- */
function Reel({ goal, onBack }) {
  const [items, setItems] = useState(null); // null=loading · []=none · [{day,url,isVideo}]
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("submissions").select("day,photo_path,status")
        .eq("goal_id", goal.id).in("status", ["approved", "frozen"]).order("day", { ascending: true });
      const rows = (data || []).filter((r) => r.photo_path); // photos AND recorded clips
      const out = [];
      for (const r of rows) {
        const { data: signed } = await supabase.storage.from("proofs").createSignedUrl(r.photo_path, 3600);
        if (signed?.signedUrl) out.push({ day: r.day, url: signed.signedUrl, isVideo: /\.(mp4|mov|m4v|webm)$/i.test(r.photo_path) });
      }
      if (alive) { setItems(out); setIdx(0); }
    })();
    return () => { alive = false; };
  }, [goal.id]);

  const cur = items && items[idx];
  // One player, re-pointed at the current clip when the item is a video. Clips
  // play sped up (×REEL_SPEED) so a recorded video looks like a real timelapse.
  const REEL_SPEED = 3;
  const player = useVideoPlayer(null, (p) => { p.loop = false; p.playbackRate = REEL_SPEED; });
  useEffect(() => {
    if (!player) return;
    if (cur && cur.isVideo) {
      try { player.replace(cur.url); player.playbackRate = REEL_SPEED; if (playing) player.play(); } catch (_) { /* */ }
    } else { try { player.pause(); } catch (_) { /* */ } }
  }, [cur && cur.url, cur && cur.isVideo, playing]);
  // advance: images on a timer, videos when they finish
  useEffect(() => {
    if (!playing || !items || items.length < 2) return;
    if (cur && cur.isVideo) return;
    const tmr = setInterval(() => setIdx((i) => (i + 1) % items.length), 900);
    return () => clearInterval(tmr);
  }, [playing, items, cur && cur.isVideo]);
  useEffect(() => {
    if (!player) return;
    const sub = player.addListener("playToEnd", () => { if (items && items.length > 1) setIdx((i) => (i + 1) % items.length); });
    return () => { try { sub.remove(); } catch (_) { /* */ } };
  }, [player, items]);

  // Share the CURRENT proof as a real file (photo or clip) — a text-only share
  // had nothing to show.
  const [sharing, setSharing] = useState(false);
  async function share() {
    if (!cur) return;
    try {
      setSharing(true);
      const ext = cur.isVideo ? "mp4" : "jpg";
      const dl = await FileSystem.downloadAsync(cur.url, `${FileSystem.cacheDirectory}cert_share_${cur.day}.${ext}`);
      if (!dl?.uri || !(await Sharing.isAvailableAsync())) throw new Error("unavailable");
      await Sharing.shareAsync(dl.uri, { mimeType: cur.isVideo ? "video/mp4" : "image/jpeg" });
    } catch (_) {
      Alert.alert("Cert", t("Couldn't share this one. Try exporting instead."));
    } finally { setSharing(false); }
  }
  // Export the whole reel: download each proof and save it to the gallery, so it
  // can be turned into a story / video in any editor.
  async function exportAll() {
    if (!items || !items.length) return;
    try {
      setExporting(true);
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) { Alert.alert("Cert", t("Allow photo library access to export.")); return; }
      let saved = 0;
      for (const it of items) {
        try {
          const ext = it.isVideo ? "mp4" : "jpg";
          const target = `${FileSystem.cacheDirectory}cert_${goal.id}_${it.day}.${ext}`;
          const dl = await FileSystem.downloadAsync(it.url, target);
          if (dl?.uri) { await MediaLibrary.saveToLibraryAsync(dl.uri); saved++; }
        } catch (_) { /* skip one, keep going */ }
      }
      Alert.alert("Cert", t("Saved {n} to your gallery.", { n: saved }));
    } catch (e) {
      Alert.alert("Cert", (e && e.message) || t("Couldn't export."));
    } finally { setExporting(false); }
  }

  if (items === null) return <Center><ActivityIndicator color={C.bronze} /></Center>;
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Progress reel")}</Text>
      <Text style={s.lede} numberOfLines={2}>{goal.text}</Text>
      {items.length === 0 ? (
        <View style={[s.card, { alignItems: "center", marginTop: 16 }]}>
          <Text style={s.h2}>{t("No reel yet")}</Text>
          <Text style={[s.lede, { textAlign: "center" }]}>{t("Verify a few days and your reel builds itself.")}</Text>
        </View>
      ) : (
        <>
          <TouchableOpacity activeOpacity={0.95} onPress={() => setPlaying((p) => !p)}>
            {cur.isVideo ? (
              <VideoView player={player} nativeControls={false} contentFit="cover"
                style={{ width: "100%", aspectRatio: 1, borderRadius: 16, backgroundColor: "#12151a", marginTop: 8 }} />
            ) : (
              <Image source={{ uri: cur.url }} style={{ width: "100%", aspectRatio: 1, borderRadius: 16, backgroundColor: "#12151a", marginTop: 8 }} resizeMode="cover" />
            )}
          </TouchableOpacity>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: C.isDark ? "#1f242c" : "#e8ecf1", overflow: "hidden", marginTop: 12 }}>
            <View style={{ height: 4, width: ((idx + 1) / items.length * 100) + "%", backgroundColor: C.bronze }} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
            <Text style={s.note}>{t("Day")} {idx + 1} / {items.length}</Text>
            <Text style={s.note}>{cur.day}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 14 }}>
            <View style={{ flex: 1 }}><BtnGhost label={playing ? t("Pause") : t("Play")} onPress={() => setPlaying((p) => !p)} /></View>
            <View style={{ flex: 1 }}><BtnGhost label={sharing ? "…" : t("Share")} onPress={share} disabled={sharing} /></View>
          </View>
          <Btn label={exporting ? t("Exporting…") : t("⤓ Export to gallery")} onPress={exportAll} disabled={exporting} />
        </>
      )}
    </ScrollView>
  );
}

/* ---------- NEW GOAL ---------- */
const WEEKDAYS = [["Mon", 0], ["Tue", 1], ["Wed", 2], ["Thu", 3], ["Fri", 4], ["Sat", 5], ["Sun", 6]];
/* ---------- MAP PICKER (drop a point for a geo goal) ----------
   Native Apple Maps (react-native-maps, PROVIDER_DEFAULT on iOS — no API key).
   Tap the map or drag the pin; the chosen coordinate is reverse-geocoded for a
   human place label. */
function MapPicker({ visible, initial, onPick, onClose }) {
  const [pt, setPt] = useState(initial || null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPt(initial || null); }, [initial]);
  const region = {
    latitude: initial?.lat ?? 40,
    longitude: initial?.lng ?? 0,
    latitudeDelta: initial ? 0.01 : 80,
    longitudeDelta: initial ? 0.01 : 80,
  };
  async function confirm() {
    if (!pt) return onClose();
    setBusy(true);
    let place = null;
    try {
      const g = await Location.reverseGeocodeAsync({ latitude: pt.lat, longitude: pt.lng });
      const a = g && g[0];
      if (a) place = [a.name, a.city || a.subregion, a.country].filter(Boolean).slice(0, 2).join(", ");
    } catch (_) { /* label is optional */ }
    setBusy(false);
    onPick({ lat: pt.lat, lng: pt.lng, place });
  }
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* fresh provider: safe-area insets don't propagate into native Modals */}
      <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top", "bottom"]}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 }}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Ionicons name="close" size={24} color={C.ink} /></TouchableOpacity>
          <Text style={[s.h2, { fontSize: 18, marginTop: 0 }]}>{t("Pick the place")}</Text>
          <View style={{ width: 24 }} />
        </View>
        {visible ? (
          <MapView
            key={`${initial?.lat ?? "x"}_${initial?.lng ?? "y"}`} // remount (recenter) each open
            style={{ flex: 1 }} initialRegion={region} showsUserLocation showsMyLocationButton
            onPress={(e) => { const c = e.nativeEvent.coordinate; setPt({ lat: c.latitude, lng: c.longitude }); }}>
            {pt ? (
              <Marker draggable coordinate={{ latitude: pt.lat, longitude: pt.lng }}
                onDragEnd={(e) => { const c = e.nativeEvent.coordinate; setPt({ lat: c.latitude, lng: c.longitude }); }} />
            ) : null}
          </MapView>
        ) : <View style={{ flex: 1 }} />}
        <View style={{ padding: 16 }}>
          <Text style={[s.note, { textAlign: "center", marginTop: 0 }]}>{pt ? `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}` : t("Tap the map or drag the pin to your spot.")}</Text>
          <Btn label={busy ? "…" : t("Use this place")} onPress={confirm} disabled={busy || !pt} />
        </View>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function NewGoal({ session, isPro, onUpgrade, onDone, onBack }) {
  const [text, setText] = useState("");
  const [type, setType] = useState("recurring"); // recurring | one_time
  const [format, setFormat] = useState("daily");  // daily | 3x | 5x | custom
  const [customDays, setCustomDays] = useState([]); // 0=Mon..6=Sun
  const [duration, setDuration] = useState(null);   // null=ongoing, or 7/30/100 (daily only)
  const [deadline, setDeadline] = useState(null);  // "HH:MM" or null
  const [oneTimeDeadline, setOneTimeDeadline] = useState(null); // Date|null, for one_time goals
  const [proofType, setProofType] = useState("photo"); // 'photo' | 'timelapse' | 'geo'
  const [geoAnchor, setGeoAnchor] = useState(null); // {lat,lng,place} pinned at creation, or null → first check-in pins it
  const [geoPinning, setGeoPinning] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapInitial, setMapInitial] = useState(null); // where the map opens centered
  const [customDur, setCustomDur] = useState(false); // "Custom" length → number input
  const [sheet, setSheet] = useState(null); // which pill's picker is open: 'proof' | 'cadence' | 'duration'
  const [proofDesc, setProofDesc] = useState(""); // user's own "the photo will show…" promise
  const [busy, setBusy] = useState(false);
  const toggleDay = (d) => setCustomDays((arr) => arr.includes(d) ? arr.filter((x) => x !== d) : [...arr, d].sort());
  const isGeo = proofType === "geo";

  async function pinHere() {
    setGeoPinning(true);
    const g = await getGeoTimed();
    setGeoPinning(false);
    if (!g) return Alert.alert("Cert", t("Couldn't get your location. Enable location access and try again."));
    setGeoAnchor(g);
  }
  // Open the map centered on the current anchor, or the user's live location, or a world view.
  async function openMap() {
    setGeoPinning(true);
    let c = geoAnchor;
    if (!c) { const g = await getGeoTimed(); if (g) c = g; }
    setGeoPinning(false);
    setMapInitial(c ? { lat: c.lat, lng: c.lng } : null);
    setMapOpen(true);
  }

  async function create() {
    if (text.trim().length < 3) return Alert.alert("Cert", t("Describe your goal first."));
    if (type === "recurring" && format === "custom" && customDays.length === 0) return Alert.alert("Cert", t("Pick at least one day."));
    if (type === "one_time" && !oneTimeDeadline) return Alert.alert("Cert", t("Pick a deadline date & time."));
    setBusy(true);
    try {
      let spec = { en: null, ru: null };
      // The user's own "the photo will show…" promise IS the proof-spec — the
      // judge uses it as the checklist hint. Only fall back to the AI-generated
      // spec when the user left it empty. Timelapse/geo goals don't need one.
      if (proofType === "photo" && proofDesc.trim().length >= 3) {
        spec = { en: proofDesc.trim(), ru: proofDesc.trim() };
      } else if (proofType === "photo") {
        try {
          const { data } = await supabase.functions.invoke("proof-spec", { body: { goal: text.trim() } });
          if (data && (data.en || data.ru)) spec = data;
        } catch (_) { /* ignore — spec is optional */ }
      }

      const recurring = type === "recurring";
      const ot = !recurring && oneTimeDeadline ? isoDateParts(oneTimeDeadline) : null;
      const { error } = await supabase.from("goals").insert({
        user_id: session.user.id,
        text: text.trim(),
        category: "other",
        type,
        format: recurring ? format : null,
        custom_days: recurring && format === "custom" ? customDays : [],
        // daily: target in days; weekly (3x/5x/custom): target in weeks. The judge
        // completes the goal when the streak (days or weeks) reaches this.
        duration_days: recurring ? duration : null,
        deadline: ot ? ot.date : null,            // one_time: deadline date
        daily_deadline: recurring ? deadline : (ot ? ot.time : null), // recurring: time-of-day · one_time: deadline time
        proof_type: proofType,                    // 'photo' | 'timelapse' | 'geo'
        geo_lat: isGeo && geoAnchor ? geoAnchor.lat : null,
        geo_lng: isGeo && geoAnchor ? geoAnchor.lng : null,
        geo_place: isGeo && geoAnchor ? geoAnchor.place : null,
        proof_spec_en: spec.en,
        proof_spec_ru: spec.ru,
      });
      if (error) throw error;
      onDone();
    } catch (e) {
      // server-side free-tier limit (DB trigger) — route to the paywall
      if (String(e?.message || "").includes("free_goal_limit")) {
        Alert.alert("Cert", t("Free includes 1 active goal. Go Pro for unlimited."));
        onUpgrade && onUpgrade();
      } else {
        Alert.alert("Cert", e.message || t("Could not create goal."));
      }
    } finally { setBusy(false); }
  }

  const isWeekly = type === "recurring" && (format === "3x" || format === "5x" || format === "custom");
  const durationOpts = isWeekly
    ? [[null, t("Ongoing")], [4, t("4 wks")], [12, t("12 wks")]]
    : [[null, t("Ongoing")], [30, t("30 d")], [100, t("100 d")]];

  const proofLabel = proofType === "photo" ? t("a photo") : proofType === "timelapse" ? t("a video") : t("a check-in");
  const cadenceLabel = format === "daily" ? t("every day") : format === "3x" ? t("3× a week") : format === "5x" ? t("5× a week") : t("my days");
  const durLabel = duration == null && !customDur ? t("ongoing")
    : duration == null ? "…"
    : isWeekly ? t("for {n} weeks", { n: duration }) : t("for {n} days", { n: duration });
  const otLabel = oneTimeDeadline
    ? new Date(oneTimeDeadline).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : t("pick a date");
  const pickCadence = (v) => { setDuration(null); setCustomDur(false); setFormat(v); setSheet(null); };
  const pickProof = (v, locked) => { if (locked) { setSheet(null); onUpgrade && onUpgrade(); return; } setProofType(v); setSheet(null); };

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("New goal")}</Text>

      <View style={{ marginTop: 14 }}>
        <TabSwitch value={type} onChange={(v) => { setDuration(null); setCustomDur(false); setType(v); }}
          options={[{ value: "one_time", label: t("One-time") }, { value: "recurring", label: t("Repeating") }]} />
      </View>

      {/* the goal as one sentence — the bronze pills are the choices */}
      <View style={[s.card, { marginTop: 14, paddingVertical: 18 }]}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          <Text style={s.sentenceText}>{t("I'll prove it with")} </Text>
          <SegPill label={proofLabel} onPress={() => setSheet("proof")} />
          {isGeo ? (
            <>
              <Text style={s.sentenceText}> {t("at")} </Text>
              <SegPill label={geoAnchor?.place || (geoPinning ? "…" : t("pick on map"))} onPress={openMap} />
            </>
          ) : null}
          <Text style={s.sentenceText}>:</Text>
        </View>

        <TextInput style={[s.input, { marginTop: 10 }]} blurOnSubmit returnKeyType="done"
          placeholder={t("e.g. gym 45 min, or read 20 pages")} placeholderTextColor={C.faint}
          value={text} onChangeText={(val) => setText(val.replace(/\n/g, " "))} />

        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
          {type === "recurring" ? (
            <>
              <SegPill label={cadenceLabel} onPress={() => setSheet("cadence")} />
              <TimeField value={deadline} onChange={setDeadline} allowClear placeholder={t("any time")}
                trigger={(open) => <SegPill label={deadline ? t("by {t}", { t: deadline }) : t("any time")} onPress={open} />} />
              <SegPill label={durLabel} onPress={() => setSheet("duration")} />
            </>
          ) : (
            <>
              <Text style={s.sentenceText}>{t("by")} </Text>
              <DateTimeField value={oneTimeDeadline} onChange={setOneTimeDeadline}
                trigger={(open) => <SegPill label={otLabel} onPress={open} />} />
            </>
          )}
        </View>

        {type === "recurring" && format === "custom" ? (
          <View style={[s.chipRow, { marginTop: 12 }]}>
            {WEEKDAYS.map(([label, d]) => (
              <TouchableOpacity key={d} style={[s.chip, customDays.includes(d) && s.chipOn]} onPress={() => toggleDay(d)}>
                <Text style={[s.chipText, customDays.includes(d) && { color: C.ink }]}>{t(label)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
        {type === "recurring" && customDur ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 }}>
            <TextInput style={[s.input, { flex: 1 }]} keyboardType="number-pad" placeholder="—" placeholderTextColor={C.faint} autoFocus
              value={duration ? String(duration) : ""} onChangeText={(v) => { const n = parseInt(String(v).replace(/[^0-9]/g, ""), 10); setDuration(!n || n <= 0 ? null : n); }} />
            <Text style={[s.note, { marginTop: 0 }]}>{isWeekly ? t("weeks") : t("days")}</Text>
          </View>
        ) : null}
        {/* what exactly the photo will show — the user's own promise becomes the
            judge's checklist (skips the AI-generated proof-spec entirely) */}
        {proofType === "photo" ? (
          <View style={{ marginTop: 12 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
              <Text style={s.sentenceText}>{t("The photo will show")}:</Text>
            </View>
            <TextInput style={[s.input, { marginTop: 6 }]} blurOnSubmit returnKeyType="done"
              placeholder={t("e.g. me holding a glass of water at the gym")} placeholderTextColor={C.faint}
              value={proofDesc} onChangeText={(v) => setProofDesc(v.replace(/\n/g, " "))} />
          </View>
        ) : null}
        {/* geo: a live mini-map appears right here — tap it to (re)pin the point */}
        {isGeo ? (
          <TouchableOpacity activeOpacity={0.85} onPress={openMap} style={{ marginTop: 12, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: C.line }}>
            <View pointerEvents="none">
              <MapView style={{ height: 132 }} region={{
                latitude: geoAnchor?.lat ?? 40, longitude: geoAnchor?.lng ?? 0,
                latitudeDelta: geoAnchor ? 0.01 : 80, longitudeDelta: geoAnchor ? 0.01 : 80,
              }}>
                {geoAnchor ? <Marker coordinate={{ latitude: geoAnchor.lat, longitude: geoAnchor.lng }} /> : null}
              </MapView>
            </View>
            <View style={{ position: "absolute", bottom: 6, left: 8, right: 8, flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: C.red, backgroundColor: C.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: "hidden" }}>
                {geoAnchor ? (geoAnchor.place || t("pinned place")) : t("Tap to pin on the map")}
              </Text>
            </View>
          </TouchableOpacity>
        ) : null}
        {isGeo && geoAnchor ? (
          <TouchableOpacity onPress={() => setGeoAnchor(null)} style={{ marginTop: 10 }}>
            <Text style={[s.note, { textAlign: "left", marginTop: 0 }]}>{t("Unpin")}</Text>
          </TouchableOpacity>
        ) : null}
        {isGeo && !geoAnchor ? (
          <Text style={[s.note, { textAlign: "left", marginTop: 10 }]}>{t("Or skip — your first check-in pins it.")}</Text>
        ) : null}
      </View>

      {/* one-tap starters — kill the blank-page problem */}
      <View style={[s.chipRow, { marginTop: 12 }]}>
        {[t("Gym 45 min"), t("Read 20 pages"), t("Morning run"), t("Meditate 10 min")].map((sug) => (
          <TouchableOpacity key={sug} style={s.chip} onPress={() => setText(sug)}>
            <Text style={s.chipText}>{sug}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={[s.note, { textAlign: "left" }]}>{t("The AI judge reviews your proof before the day counts.")}</Text>

      {/* pill pickers */}
      <OptionSheet visible={sheet === "proof"} title={t("Proof")} onClose={() => setSheet(null)}>
        <OptionCard icon="camera-outline" title={t("Photo")} desc={t("One quick photo.")} active={proofType === "photo"} onPress={() => pickProof("photo", false)} />
        <OptionCard icon="videocam-outline" title={t("Video")} locked={!isPro} desc={t("Short clip, AI-judged.")} active={proofType === "timelapse"} onPress={() => pickProof("timelapse", !isPro)} />
        <OptionCard icon="location-outline" title={t("Location")} locked={!isPro} desc={t("Be at a place.")} active={proofType === "geo"} onPress={() => pickProof("geo", !isPro)} />
      </OptionSheet>
      <OptionSheet visible={sheet === "cadence"} title={t("How often?")} onClose={() => setSheet(null)}>
        <OptionCard icon="repeat" title={t("every day")} active={format === "daily"} onPress={() => pickCadence("daily")} />
        <OptionCard icon="calendar-outline" title={t("3× a week")} active={format === "3x"} onPress={() => pickCadence("3x")} />
        <OptionCard icon="calendar" title={t("5× a week")} active={format === "5x"} onPress={() => pickCadence("5x")} />
        <OptionCard icon="options-outline" title={t("my days")} desc={t("Pick weekdays")} active={format === "custom"} onPress={() => pickCadence("custom")} />
      </OptionSheet>
      <OptionSheet visible={sheet === "duration"} title={t("Length")} onClose={() => setSheet(null)}>
        <OptionCard icon="infinite" title={t("ongoing")} active={!customDur && duration == null} onPress={() => { setCustomDur(false); setDuration(null); setSheet(null); }} />
        {durationOpts.filter(([v]) => v != null).map(([v, label]) => (
          <OptionCard key={String(v)} icon="hourglass-outline" title={label} active={!customDur && duration === v} onPress={() => { setCustomDur(false); setDuration(v); setSheet(null); }} />
        ))}
        <OptionCard icon="create-outline" title={t("Other")} desc={isWeekly ? t("weeks") : t("days")} active={customDur} onPress={() => { setCustomDur(true); setDuration(null); setSheet(null); }} />
      </OptionSheet>

      <Btn label={busy ? t("Creating…") : t("Create")} onPress={create} disabled={busy} />

      <MapPicker visible={mapOpen} initial={mapInitial} onClose={() => setMapOpen(false)}
        onPick={(p) => { setGeoAnchor(p); setMapOpen(false); }} />
    </ScrollView>
  );
}

/* ---------- TIMELAPSE (recorded IN-APP; the AI judge watches the clip) ----------
   The proof is a short video the user records here — not picked from the library,
   so a pre-made / faked clip can't be used. Hard-capped in length + file size so
   the base64 payload stays under Gemini's ~20MB inline limit. Front/back camera. */
const TL_MAX_SECONDS = 15;             // recording auto-stops here
const TL_MIN_SECONDS = 3;              // enough to show a real attempt
// Gemini's ~20MB request cap applies to the base64-INFLATED payload (×1.33),
// so raw bytes must stay ≤ ~14MB. With the 2 Mbps bitrate below, 15s ≈ 4MB.
const TL_MAX_BYTES = 14 * 1024 * 1024;
const TL_BITRATE = 2000000; // 2 Mbps — plenty for the AI to judge motion


function TimelapseCapture({ onCancel, onDone }) {
  const [perm, requestPerm] = useCameraPermissions();
  const camRef = useRef(null);
  const [facing, setFacing] = useState("back");
  const [recording, setRecording] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef(null);
  const startedAt = useRef(0);

  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) requestPerm(); }, [perm]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  async function start() {
    if (recording || !camRef.current) return;
    setRecording(true); setElapsed(0); startedAt.current = Date.now();
    timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
    try {
      // resolves when recording stops — manually or at maxDuration. No maxFileSize
      // (it was cutting recordings to a few seconds); size is checked after instead.
      // codec is required on iOS for videoBitrate to take effect.
      const clip = await camRef.current.recordAsync({ maxDuration: TL_MAX_SECONDS, codec: "avc1" });
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      setRecording(false);
      const secs = Math.round((Date.now() - startedAt.current) / 1000);
      if (!clip?.uri) { onCancel(); return; }
      if (secs < TL_MIN_SECONDS) { Alert.alert("Cert", t("Record at least {n} seconds.", { n: TL_MIN_SECONDS })); return; }
      onDone({ uri: clip.uri }); // Submit uploads the file to storage itself
    } catch (e) {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      setRecording(false); setPreparing(false);
      Alert.alert("Cert", (e && e.message) || t("Couldn't record. Try again."));
    }
  }
  function stop() { try { camRef.current?.stopRecording(); } catch (_) { /* */ } }

  if (!perm) return <Center><ActivityIndicator color={C.bronze} /></Center>;
  if (!perm.granted) {
    return (
      <View style={[s.wrap, { flex: 1, justifyContent: "center" }]}>
        <Text style={s.h2}>{t("Camera needed")}</Text>
        <Text style={s.lede}>{t("Cert needs the camera to record your timelapse proof.")}</Text>
        <Btn label={t("Grant camera access")} onPress={requestPerm} />
        <BtnGhost label={t("Back")} onPress={onCancel} />
      </View>
    );
  }
  const remain = Math.max(0, TL_MAX_SECONDS - elapsed);
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView ref={camRef} style={{ flex: 1 }} facing={facing} mode="video" videoQuality="4:3" videoBitrate={TL_BITRATE} mute />
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, padding: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <TouchableOpacity onPress={() => { stop(); onCancel(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} disabled={preparing}>
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>✕</Text>
        </TouchableOpacity>
        {recording ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "rgba(0,0,0,.5)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: C.err }} />
            <Text style={{ color: "#fff", fontFamily: "System", fontSize: 13, fontWeight: "700" }}>REC · 0:{String(elapsed).padStart(2, "0")} / 0:{String(TL_MAX_SECONDS).padStart(2, "0")}</Text>
          </View>
        ) : (
          <TouchableOpacity onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} disabled={preparing}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,.5)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Ionicons name="camera-reverse-outline" size={18} color="#fff" />
            <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>{facing === "back" ? t("Front") : t("Back")}</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 24, paddingBottom: 38, backgroundColor: "rgba(0,0,0,.45)" }}>
        {preparing ? (
          <View style={{ alignItems: "center" }}>
            <ActivityIndicator color={C.bronze} />
            <Text style={{ color: "#c3cad4", textAlign: "center", marginTop: 10, fontSize: 13 }}>{t("Preparing your clip…")}</Text>
          </View>
        ) : recording ? (
          <>
            <Text style={{ color: "#c3cad4", textAlign: "center", marginBottom: 14, fontSize: 13 }}>{t("{n}s left — stops automatically.", { n: remain })}</Text>
            <Btn label={t("Stop & send")} onPress={stop} />
          </>
        ) : (
          <>
            <Text style={{ color: "#c3cad4", textAlign: "center", marginBottom: 14, fontSize: 13 }}>{t("Record up to {n}s of yourself actually doing it. The AI watches the whole clip.", { n: TL_MAX_SECONDS })}</Text>
            <Btn label={t("Start recording")} onPress={start} />
          </>
        )}
      </View>
    </View>
  );
}

/* ---------- APPROVAL CELEBRATION (branded stamp instead of a system alert) ----------
   The judge's approval is the product's magic moment — it deserves a stamp
   slamming in, not a grey Alert. Fixed dark backdrop works over both themes. */
function ApprovalOverlay({ data, goalSubs = [], onClose, onShare }) {
  // Full-screen streak celebration: badge pops in, flame springs up, the streak
  // number COUNTS UP to today's value, then the week row lights up today's cell.
  const badge = useRef(new Animated.Value(0)).current;   // "approved" pill
  const flame = useRef(new Animated.Value(0)).current;   // big flame spring
  const pop = useRef(new Animated.Value(1)).current;     // number pop at count end
  const todayCell = useRef(new Animated.Value(0)).current; // week-row today flip
  const rest = useRef(new Animated.Value(0)).current;    // reason + buttons
  const [shown, setShown] = useState(0);                 // the counting number
  useEffect(() => {
    if (!data) return;
    badge.setValue(0); flame.setValue(0); pop.setValue(1); todayCell.setValue(0); rest.setValue(0);
    const target = typeof data.streak === "number" ? data.streak : 1;
    setShown(Math.max(0, target - 1));
    Animated.sequence([
      Animated.spring(badge, { toValue: 1, friction: 6, tension: 120, useNativeDriver: true }),
      Animated.spring(flame, { toValue: 1, friction: 5, tension: 70, useNativeDriver: true }),
    ]).start(() => {
      setTimeout(() => {
        setShown(target); // the +1 tick
        Animated.sequence([
          Animated.spring(pop, { toValue: 1.35, friction: 3, tension: 160, useNativeDriver: true }),
          Animated.spring(pop, { toValue: 1, friction: 5, useNativeDriver: true }),
        ]).start();
        Animated.spring(todayCell, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }).start();
        Animated.timing(rest, { toValue: 1, duration: 320, delay: 250, useNativeDriver: true }).start();
      }, 450);
    });
  }, [data]);
  if (!data) return null;
  // last 7 days ending today; done = verified before OR (today, once animated)
  const days = lastNDays(7);
  const todayStr = days[6];
  const doneSet = new Set(goalSubs.filter((x) => x.status === "approved" || x.status === "frozen").map((x) => x.day));
  const dowShort = (d) => t(DOW_NAMES[(new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7]).slice(0, 2);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 28 }}>
        <Animated.View style={{ transform: [{ scale: badge.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }], opacity: badge, flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 2, borderColor: C.red, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 }}>
          <Ionicons name="checkmark-circle" size={18} color={C.red} />
          <Text style={{ color: C.red, fontSize: 14, fontWeight: "800", letterSpacing: 2 }}>{t("APPROVED")}</Text>
        </Animated.View>

        <Animated.View style={{ alignItems: "center", marginTop: 26, transform: [{ scale: flame.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) }], opacity: flame }}>
          <Ionicons name="flame" size={96} color={C.red} />
        </Animated.View>

        {typeof data.streak === "number" ? (
          <Animated.View style={{ alignItems: "center", marginTop: 8, transform: [{ scale: pop }] }}>
            <Text style={{ color: C.ink, fontSize: 72, fontWeight: "800", lineHeight: 76 }}>{shown}</Text>
            <Text style={{ color: C.mute, fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>{data.isWeekly ? t("week streak") : t("day streak")}</Text>
          </Animated.View>
        ) : null}

        {/* Duolingo-style week row — today's cell flips on with a spring */}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 22, alignSelf: "stretch", maxWidth: 340 }}>
          {days.map((d) => {
            const isToday = d === todayStr;
            const done = doneSet.has(d);
            const cell = (filled) => ({ flex: 1, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: filled ? C.red : (C.isDark ? "#1f242c" : "#eef1f6") });
            return (
              <View key={d} style={{ flex: 1, alignItems: "stretch" }}>
                <Text style={{ textAlign: "center", fontSize: 10, color: C.faint, marginBottom: 4 }}>{dowShort(d)}</Text>
                {isToday ? (
                  <View style={cell(false)}>
                    <Animated.View style={[cell(true), { position: "absolute", left: 0, right: 0, opacity: todayCell, transform: [{ scale: todayCell.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }]}>
                      <Ionicons name="checkmark" size={20} color="#ffffff" />
                    </Animated.View>
                  </View>
                ) : (
                  <View style={cell(done)}>{done ? <Ionicons name="checkmark" size={18} color="#ffffff" /> : null}</View>
                )}
              </View>
            );
          })}
        </View>

        <Animated.View style={{ opacity: rest, alignItems: "center", marginTop: 20, width: "100%" }}>
          {data.reason ? <Text style={{ color: C.mute, fontSize: 14, lineHeight: 20, textAlign: "center" }} numberOfLines={3}>{data.reason}</Text> : null}
          {data.completed ? <Text style={{ color: C.red, fontWeight: "800", marginTop: 10, textAlign: "center" }}>{t("Goal complete — Cert earned!")}</Text> : null}
          {data.milestone ? <Text style={{ color: C.red, fontWeight: "800", marginTop: 10, textAlign: "center" }}>{t("You just unlocked a {n}-day verified badge.", { n: data.milestone })}</Text> : null}
          <View style={{ width: "100%", maxWidth: 320 }}>
            {data.milestone ? <Btn label={t("Share badge")} onPress={onShare} /> : null}
            <Btn label={t("Continue")} onPress={onClose} style={data.milestone ? { marginTop: 10 } : null} />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

/* ---------- SUBMIT (camera -> judge) ---------- */
function Submit({ goal, goalSubs = [], onDone, onBack, onViewBadge }) {
  const isTimelapse = goal.proof_type === "timelapse";
  const isGeo = goal.proof_type === "geo";
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("idle"); // idle | judging
  const [todaysCheck, setTodaysCheck] = useState(null); // server is source of truth
  const [checkState, setCheckState] = useState("loading"); // loading | ok | error
  const [reject, setReject] = useState(null); // { submissionId, reason } after a rejection
  const [note, setNote] = useState("");
  const [appealBusy, setAppealBusy] = useState(false);
  const [deadline, setDeadline] = useState(null); // "HH:MM" or null
  const [late, setLate] = useState(false);        // past today's deadline
  const [scheduled, setScheduled] = useState(true); // custom-days: due today?
  const [windowStart, setWindowStart] = useState(null); // geo: be there FROM this time
  const [early, setEarly] = useState(false);            // before the window opens
  const [geoPlace, setGeoPlace] = useState(null);       // the goal's pinned place label
  const [anchorSet, setAnchorSet] = useState(true);     // false → first check-in pins it
  const [capturing, setCapturing] = useState(false);    // timelapse recorder open
  const [celebrate, setCelebrate] = useState(null);     // approval overlay payload

  // Ask the judge what today's anti-cheat check is, so the screen shows EXACTLY
  // what the server will enforce (no client/server day drift).
  const loadCheck = useCallback(async () => {
    setCheckState("loading");
    try {
      const { data, error } = await supabase.functions.invoke("judge", { body: { goalId: goal.id, peek: true } });
      if (error || !data?.dailyReq?.en) throw error || new Error("no check");
      setTodaysCheck(data.dailyReq); // keep both langs; pick at render so it follows the app language
      setDeadline(data.deadline || null);
      setLate(!!data.pastDeadline);
      setScheduled(data.scheduledToday !== false);
      setWindowStart(data.windowStart || null);
      setEarly(!!data.beforeStart);
      setGeoPlace(data.geoPlace || null);
      setAnchorSet(data.geoAnchorSet !== false);
      setCheckState("ok");
      // Restore an in-progress rejection from earlier today (survives leaving the
      // screen): retry if attempts remain, or open the appeal if they're used up.
      if (data.lastReject) {
        setReject({ submissionId: data.lastReject.submissionId, reason: data.lastReject.reason, attemptsLeft: data.attemptsLeft });
      }
    } catch (_) {
      setCheckState("error");
    }
  }, [goal.id]);
  useEffect(() => { loadCheck(); }, [loadCheck]);

  // Photo proof is camera-only — no gallery pick (a saved photo is trivially fakeable).
  async function takeAndJudge() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert("Cert", t("Camera permission needed."));
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.4 });
    if (res.canceled || !res.assets || !res.assets[0]?.base64) return;
    const a = res.assets[0];
    const mime = a.mimeType || "image/jpeg";
    const photo = `data:${mime};base64,${a.base64}`;
    await runJudge({ photo });
  }

  // Timelapse recorded in-app → upload the clip to storage, then send its PATH
  // to the judge (keeps the request body small — no giant base64 through the
  // function; the judge downloads it server-side).
  async function onTimelapseDone(result) {
    setCapturing(false);
    if (!result || !result.uri) return;
    setBusy(true); setStage("judging"); setReject(null);
    try {
      const bytes = await fetch(result.uri).then((r) => r.arrayBuffer());
      if (bytes.byteLength > TL_MAX_BYTES) {
        setBusy(false); setStage("idle");
        return Alert.alert("Cert", t("That clip is too heavy. Record a shorter one."));
      }
      const { data: sess } = await supabase.auth.getSession();
      const uidNow = sess?.session?.user?.id;
      if (!uidNow) throw new Error("no session");
      const path = `${uidNow}/${goal.id}/${Date.now()}.mp4`;
      const { error: upErr } = await supabase.storage.from("proofs").upload(path, bytes, { contentType: "video/mp4" });
      if (upErr) throw upErr;
      await runJudge({ videoPath: path });
    } catch (_) {
      // no raw error codes at the user — they can't act on them anyway
      setBusy(false); setStage("idle");
      Alert.alert("Cert", t("Couldn't send the video. Check your connection and try again."));
    }
  }

  async function runJudge(payload) {
    setBusy(true); setStage("judging"); setReject(null);
    try {
      const geo = await getGeoTimed();
      if (isGeo && !geo) { Alert.alert("Cert", t("Couldn't get your location. Enable location access and try again.")); return; }
      const geoPlaceNow = geo && geo.place ? geo.place : null;
      const { data, error } = await supabase.functions.invoke("judge", { body: { goalId: goal.id, geo, lang: activeLang(), ...payload } });
      if (error) throw error;
      if (data?.busy) { Alert.alert("Cert", t("The judge is busy — try again in a moment.")); return; }
      if (data?.error) {
        const msg = {
          no_checks_left: t("No attempts left today. Come back tomorrow, or appeal your last rejected photo."),
          already_done_today: t("You've already completed this goal today."),
          week_done: t("You've hit this week's target. Come back next week."),
          past_deadline: data.deadline ? t("Past today's deadline ({d}). Try again tomorrow before then.", { d: data.deadline }) : t("Past today's deadline. Try again tomorrow before then."),
          before_start: data.windowStart ? t("Too early — check in after {t}.", { t: data.windowStart }) : t("Too early — the window hasn't opened yet."),
          no_location: t("Couldn't get your location. Enable location access and try again."),
          not_scheduled_today: t("This goal isn't scheduled for today. Come back on your chosen days."),
          goal_not_active: t("This goal isn't active anymore."),
        }[data.error] || String(data.error);
        Alert.alert("Cert", msg);
        return;
      }
      const v = data.verdict;
      if (v.approved) {
        // Branded celebration overlay (stamp animation) instead of a system alert.
        setCelebrate({
          streak: typeof data.goal?.streak === "number" ? data.goal.streak : null,
          isWeekly: !!data.weekly,
          reason: (v.reason || "") + (!isGeo && geoPlaceNow ? "\n" + geoPlaceNow : ""),
          milestone: data.milestone || null,
          completed: !!data.completed,
        });
      } else {
        // Let them retry while attempts remain; the appeal flow opens only once
        // today's attempts are used up (attemptsLeft === 0).
        setReject({ submissionId: data.submissionId, reason: v.reason || t("Not approved."), attemptsLeft: data.attemptsLeft });
      }
    } catch (e) {
      Alert.alert("Cert", e.message || t("Could not reach the judge."));
    } finally { setBusy(false); setStage("idle"); }
  }

  async function submitAppeal() {
    if (!reject?.submissionId) return;
    setAppealBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("appeal", { body: { submissionId: reject.submissionId, note } });
      if (error) throw error;
      if (data?.busy) { Alert.alert("Cert", t("The reviewer is busy — try again in a moment.")); return; }
      if (data?.error) {
        Alert.alert("Cert", data.error === "already_appealed" ? t("You've already appealed this one.") : String(data.error));
        return;
      }
      if (data.restored) {
        Alert.alert(t("Appeal accepted"), t("Your streak is restored to {n}.", { n: data.streak }) + (data.completed ? "\n\n" + t("Goal complete — Cert earned!") : ""), [{ text: "OK", onPress: onDone }]);
      } else {
        Alert.alert(t("Appeal denied"), (data.verdict?.reason || t("The reviewer kept the original decision.")), [{ text: "OK", onPress: onDone }]);
      }
    } catch (e) {
      Alert.alert("Cert", e.message || t("Could not submit the appeal."));
    } finally { setAppealBusy(false); }
  }

  if (capturing) return <TimelapseCapture onCancel={() => setCapturing(false)} onDone={onTimelapseDone} />;

  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 60 }]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive">
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{isGeo ? t("Check in") : t("Submit proof")}</Text>
      <View style={s.card}>
        <Text style={[s.kicker, { color: C.bronze }]}>{isGeo ? t("Be at the place") : isTimelapse ? t("Record a timelapse of this") : t("Send a photo like this")}</Text>
        <Text style={s.goalText}>{(isGeo || isTimelapse) ? goal.text : (proofSpec(goal) || goal.text)}</Text>
        {isGeo ? (
          <Text style={[s.spec, { color: C.mute }]}>
            {anchorSet
              ? (geoPlace || t("pinned place"))
              : t("No place pinned yet — your first check-in pins it. Do it AT the right place.")}
          </Text>
        ) : null}
      </View>
      {isGeo ? (
        <View style={[s.card, { borderColor: C.bronze }]}>
          <Text style={[s.kicker, { color: C.bronze }]}>{t("How geo check-in works")}</Text>
          <Text style={s.note}>{t("Your GPS position is checked against the goal's place. Fake-GPS apps are detected and rejected.")}</Text>
        </View>
      ) : isTimelapse ? (
        <View style={[s.card, { borderColor: C.bronze }]}>
          <Text style={[s.kicker, { color: C.bronze }]}>{t("Why a timelapse")}</Text>
          <Text style={s.note}>{t("Record a short clip of your session — the AI watches the whole video, so it sees the activity actually happen. A propped photo or a pre-made clip won't pass.")}</Text>
        </View>
      ) : (
        // Fingers/poses retired: photos are captured live in-app — that IS the
        // freshness check. checkState still gates buttons (it carries deadlines).
        <View style={[s.card, { borderColor: C.bronze }]}>
          <Text style={[s.kicker, { color: C.bronze }]}>{t("Live proof")}</Text>
          <Text style={s.note}>{t("Photos are taken with the camera right here — no gallery, no old shots. Just show the goal happening.")}</Text>
          {checkState === "loading" ? <ActivityIndicator color={C.bronze} style={{ marginTop: 8, alignSelf: "flex-start" }} /> : null}
          {checkState === "error" ? <TouchableOpacity onPress={loadCheck}><Text style={[s.goalText, { color: C.err }]}>{t("Couldn't load — tap to retry")}</Text></TouchableOpacity> : null}
        </View>
      )}
      {windowStart || deadline ? (
        <View style={[s.card, { borderColor: late || early ? C.err : C.green, paddingVertical: 12 }]}>
          <Text style={[s.kicker, { color: late || early ? C.err : C.green }]}>
            {early ? t("Window opens at {t} — too early", { t: windowStart })
              : late ? t("Past today's deadline ({d})", { d: deadline })
              : windowStart && deadline ? t("Window: {a}–{b} today", { a: windowStart, b: deadline })
              : windowStart ? t("Check in after {t} today", { t: windowStart })
              : t("Submit before {d} today", { d: deadline })}
          </Text>
        </View>
      ) : null}
      {isGeo ? null : <Text style={s.note}>{t("The AI judges in a few seconds. A reject resets your streak — you can appeal once.")}</Text>}
      {stage === "judging" ? (
        <View style={{ alignItems: "center", marginTop: 24 }}>
          <ActivityIndicator color={C.bronze} />
          <Text style={[s.note, { marginTop: 10 }]}>{isGeo ? t("Checking your location…") : isTimelapse ? t("The judge is analyzing your timelapse…") : t("The judge is analyzing your photo…")}</Text>
        </View>
      ) : reject && reject.attemptsLeft === 0 ? (
        // Attempts used up today — now the appeal is the way out.
        <>
          <View style={[s.card, { borderColor: C.err }]}>
            <Text style={[s.kicker, { color: C.err }]}>{t("Rejected — no attempts left today")}</Text>
            <Text style={s.goalText}>{reject.reason}</Text>
          </View>
          <Text style={s.h2}>{t("Appeal once")}</Text>
          <Text style={s.lede}>{t("Think the judge got it wrong? Explain why this should count — a reviewer takes a second, more generous look at the same photo.")}</Text>
          <TextInput style={[s.input, { height: 90, textAlignVertical: "top" }]} multiline
            placeholder={t("e.g. The book is open on my desk and my hand shows 4 fingers on the left.")}
            placeholderTextColor={C.faint} value={note} onChangeText={setNote} />
          {reject.submissionId
            ? <Btn label={appealBusy ? t("Reviewing…") : t("Submit appeal")} onPress={submitAppeal} disabled={appealBusy} />
            : <Text style={s.note}>{t("This attempt can't be appealed.")}</Text>}
          <BtnGhost label={t("No, go back")} onPress={onDone} disabled={appealBusy} />
        </>
      ) : !scheduled ? (
        <View style={[s.card, { borderColor: C.line, alignItems: "center" }]}>
          <Text style={[s.kicker, { color: C.mute }]}>{t("Not scheduled today")}</Text>
          <Text style={s.note}>{t("This goal runs only on your chosen days. Come back then.")}</Text>
          <BtnGhost label={t("Back")} onPress={onBack} />
        </View>
      ) : late ? (
        <View style={[s.card, { borderColor: C.err, alignItems: "center" }]}>
          <Text style={[s.kicker, { color: C.err }]}>{t("Deadline passed")}</Text>
          <Text style={s.note}>{t("You missed today's {d} cutoff. Come back tomorrow before then.", { d: deadline })}</Text>
          <BtnGhost label={t("Back")} onPress={onBack} />
        </View>
      ) : early ? (
        <View style={[s.card, { borderColor: C.line, alignItems: "center" }]}>
          <Text style={[s.kicker, { color: C.mute }]}>{t("Too early")}</Text>
          <Text style={s.note}>{t("The check-in window opens at {t}. Come back then.", { t: windowStart })}</Text>
          <BtnGhost label={t("Back")} onPress={onBack} />
        </View>
      ) : (
        // First attempt, or a reject with attempts still left → let them retry.
        <>
          {reject ? (
            <View style={[s.card, { borderColor: C.err }]}>
              <Text style={[s.kicker, { color: C.err }]}>{t("Rejected — try again")}</Text>
              <Text style={s.goalText}>{reject.reason}</Text>
              {typeof reject.attemptsLeft === "number"
                ? <Text style={s.note}>{isGeo ? t("{n} attempts left today.", { n: reject.attemptsLeft }) : t("{n} attempts left today, then you can appeal.", { n: reject.attemptsLeft })}</Text>
                : null}
            </View>
          ) : null}
          {isGeo ? (
            <Btn label={reject ? t("Check in again") : t("Check in now")} onPress={() => runJudge({ checkin: true })} disabled={busy || checkState !== "ok"} />
          ) : isTimelapse ? (
            <Btn label={reject ? t("Record again") : t("Record timelapse")} onPress={() => setCapturing(true)} disabled={busy || checkState !== "ok"} />
          ) : (
            <Btn label={reject ? t("Retake photo") : t("Take a photo")} onPress={takeAndJudge} disabled={busy || checkState !== "ok"} />
          )}
        </>
      )}

      <ApprovalOverlay data={celebrate} goalSubs={goalSubs}
        onClose={() => { setCelebrate(null); onDone(); }}
        onShare={() => { const m = celebrate?.milestone; setCelebrate(null); if (m) onViewBadge({ days: m, title: goal.text }); }} />
    </ScrollView>
  );
}

/* ---------- SHAREABLE CARD (9:16 story image, captured to PNG) ----------
   One themed card for both completion certs and streak milestones. Rendered
   on screen and captured via react-native-view-shot, so what you see is what
   gets shared. */
const PLACE_PALETTE = {
  1: { bg: "#6366f1", fg: "#1e1b4e", sub: "#3730a3", label: "1ST PLACE", medal: "1" },
  2: { bg: "#b8bcc4", fg: "#16181c", sub: "#474b52", label: "2ND PLACE", medal: "2" },
  3: { bg: "#b5793f", fg: "#1a0f05", sub: "#3f2710", label: "3RD PLACE", medal: "3" },
};
function ShareableCard({ cardRef, kind, days, title, rank, bg, sticker }) {
  // ----- placement cert (gold / silver / bronze by rank) -----
  if (kind === "placement") {
    const p = PLACE_PALETTE[rank] || { bg: C.card, fg: C.ink, sub: C.mute, label: `#${rank}`, medal: `#${rank}` };
    return (
      <View ref={cardRef} collapsable={false} style={[s.shareCard, { backgroundColor: p.bg, borderColor: p.fg }]}>
        <View style={s.shareTop}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Image source={LOGO} style={s.shareLogo} resizeMode="contain" />
            <Text style={[s.shareBrand, { color: p.fg }]}>CERT</Text>
          </View>
          <Text style={[s.shareVerified, { color: p.fg, borderColor: p.fg }]}>✓ VERIFIED</Text>
        </View>
        <View style={{ alignItems: "center" }}>
          <Text style={{ fontSize: 90 }}>{p.medal}</Text>
          <Text style={[s.shareDaysLabel, { color: p.fg, marginTop: 6 }]}>{p.label}</Text>
          <Text style={[s.shareNotFaked, { color: p.fg }]}>CHALLENGE FINISHED</Text>
        </View>
        <View>
          <Text style={[s.shareGoal, { color: p.fg }]} numberOfLines={3}>{title}</Text>
          <Text style={[s.shareTagline, { color: p.sub }]}>Proven against friends. The streak you can't fake.</Text>
        </View>
      </View>
    );
  }
  const head = kind === "milestone" ? "STREAK UNLOCKED" : "CERTIFIED";
  // ----- sticker: transparent PNG overlay to layer over YOUR OWN photo -----
  // (saved to the gallery; text shadows keep it readable on any background)
  if (sticker) {
    const sh = { textShadowColor: "rgba(0,0,0,0.6)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 7 };
    return (
      <View ref={cardRef} collapsable={false} style={{ width: "100%", aspectRatio: 9 / 16, backgroundColor: "transparent", padding: 28, justifyContent: "space-between" }}>
        <View style={s.shareTop}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Image source={LOGO} style={s.shareLogo} resizeMode="contain" />
            <Text style={[s.shareBrand, { color: "#f2f4f7" }, sh]}>CERT</Text>
          </View>
          <Text style={[s.shareVerified, sh]}>✓ VERIFIED</Text>
        </View>
        <View style={{ alignItems: "center" }}>
          <Text style={[s.shareKicker, { color: "#e8ecf1" }, sh]}>{head}</Text>
          <Text style={[s.shareDays, sh]}>{days}</Text>
          <Text style={[s.shareDaysLabel, { color: "#f2f4f7" }, sh]}>VERIFIED DAYS</Text>
          <Text style={[s.shareNotFaked, sh]}>NOT FAKED</Text>
        </View>
        <View>
          <Text style={[s.shareGoal, { color: "#f2f4f7" }, sh]} numberOfLines={3}>{title}</Text>
          <Text style={[s.shareTagline, { color: "#e8ecf1" }, sh]}>The streak you can't fake.</Text>
        </View>
      </View>
    );
  }
  // Strava-style: your photo underneath, the cert on top. A dark scrim keeps
  // the type readable, and text is forced to light ink over a photo (the
  // theme's ink may be dark in light mode).
  const inkOnBg = bg ? { color: "#f2f4f7" } : null;
  const subOnBg = bg ? { color: "#c3cad4" } : null;
  return (
    <View ref={cardRef} collapsable={false} style={[s.shareCard, bg && { overflow: "hidden", borderColor: "rgba(244,239,232,0.4)" }]}>
      {bg ? <Image source={{ uri: bg }} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} resizeMode="cover" /> : null}
      {bg ? <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(10,13,18,0.52)" }} /> : null}
      <View style={s.shareTop}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Image source={LOGO} style={s.shareLogo} resizeMode="contain" />
          <Text style={[s.shareBrand, inkOnBg]}>CERT</Text>
        </View>
        <Text style={s.shareVerified}>✓ VERIFIED</Text>
      </View>
      <View style={{ alignItems: "center" }}>
        {bg ? null : <Image source={LOGO} style={s.shareLogoBig} resizeMode="contain" />}
        <Text style={[s.shareKicker, subOnBg]}>{head}</Text>
        <Text style={s.shareDays}>{days}</Text>
        <Text style={[s.shareDaysLabel, inkOnBg]}>VERIFIED DAYS</Text>
        <Text style={s.shareNotFaked}>NOT FAKED</Text>
      </View>
      <View>
        <Text style={[s.shareGoal, inkOnBg]} numberOfLines={3}>{title}</Text>
        <Text style={[s.shareTagline, subOnBg]}>Every single day judged by AI. The streak you can't fake.</Text>
      </View>
    </View>
  );
}

/* shared capture+share helper used by the Cert screen and milestone moment */
async function shareCardImage(cardRef, dialogTitle) {
  const uri = await captureRef(cardRef, { format: "png", quality: 1 });
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert("Cert", "Sharing isn't available on this device.");
    return;
  }
  await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle });
}

/* ---------- SHARE SCREEN (cert, milestone badge, or placement) ---------- */
function ShareScreen({ kind, days, title, subtitle, rank, onBack }) {
  const cardRef = useRef();
  const [busy, setBusy] = useState(false);
  const [bg, setBg] = useState(null); // photo behind the card (Strava-style)
  const [mode, setMode] = useState("card"); // card | photo | sticker
  const isSticker = mode === "sticker" && kind !== "placement";
  const usePhoto = mode === "photo" && kind !== "placement";
  const shareLabel = kind === "placement" ? "↗ Share my result" : kind === "milestone" ? "↗ Share my badge" : "↗ Share my Cert";

  async function share() {
    try {
      setBusy(true);
      await shareCardImage(cardRef, kind === "placement" ? "Share your result" : kind === "milestone" ? "Share your badge" : "Share your Cert");
    } catch (e) {
      Alert.alert("Cert", e.message || "Couldn't share.");
    } finally { setBusy(false); }
  }

  async function pickBg() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert("Cert", "Photo permission needed.");
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    setBg(res.assets[0].uri);
  }

  // Save the transparent sticker PNG to the gallery, so it can be layered
  // over any photo in stories / photo editors (like Strava's stickers).
  async function saveSticker() {
    try {
      setBusy(true);
      const perm = await MediaLibrary.requestPermissionsAsync(true); // write-only where the OS supports it
      if (!perm.granted) { Alert.alert("Cert", t("Allow photo library access to save the sticker.")); return; }
      const uri = await captureRef(cardRef, { format: "png", quality: 1 });
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert("Cert", t("Saved to your gallery. Layer it over any photo in stories or your editor."));
    } catch (e) {
      Alert.alert("Cert", e.message || "Couldn't save.");
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <BackBar onBack={onBack} />
      <View style={{ paddingHorizontal: 16, marginTop: 8, borderRadius: 22, backgroundColor: isSticker ? (C.isDark ? "#12151a" : "#e8ecf1") : "transparent", paddingVertical: isSticker ? 12 : 0 }}>
        <ShareableCard cardRef={cardRef} kind={kind} days={days} title={title} rank={rank} bg={usePhoto ? bg : null} sticker={isSticker} />
      </View>

      {kind !== "placement" ? (
        <>
          <TabSwitch value={mode} onChange={(m) => { setMode(m); if (m === "photo" && !bg) pickBg(); }}
            options={[{ value: "card", label: t("Card") }, { value: "photo", label: t("Photo") }, { value: "sticker", label: t("Sticker") }]} />
          {usePhoto ? (
            <TouchableOpacity onPress={pickBg}><Text style={[s.note, { textAlign: "center" }]}>{bg ? t("Change photo") : t("Choose a photo")}</Text></TouchableOpacity>
          ) : isSticker ? (
            <Text style={[s.note, { textAlign: "center" }]}>{t("Transparent — save it, then layer over your own photo.")}</Text>
          ) : null}
        </>
      ) : null}

      {isSticker
        ? <Btn label={busy ? "…" : t("Save to gallery")} onPress={saveSticker} disabled={busy} />
        : <Btn label={busy ? "Preparing…" : shareLabel} onPress={share} disabled={busy} />}
      {subtitle ? <Text style={[s.note, { textAlign: "center" }]}>{subtitle}</Text> : null}
    </ScrollView>
  );
}

/* ---------- STATS ---------- */
// Last N UTC day-strings (YYYY-MM-DD), oldest first. UTC to match server `day`.
function lastNDays(n) {
  const out = [];
  const t = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
// Derive every stat + the earned-badge list from goals + submissions in one place.
function computeStats(goals, subs) {
  const approved = subs.filter((s) => s.status === "approved" || s.status === "frozen").length;
  const rejected = subs.filter((s) => s.status === "rejected").length;
  const judged = approved + rejected;
  const approvalRate = judged ? Math.round((approved / judged) * 100) : null;
  const bestStreak = goals.reduce((m, g) => Math.max(m, g.best_streak || 0), 0);
  const curStreak = goals.reduce((m, g) => Math.max(m, g.streak || 0), 0);
  // Eternal counter: prefer the server's verified_days_total, fall back to
  // counting approved/frozen submissions (older rows without the column).
  const verifiedTotal = Math.max(approved, goals.reduce((sum, g) => sum + (g.verified_days_total || 0), 0));
  const badges = [];
  for (const g of goals) for (const m of MILESTONES) if ((g.best_streak || 0) >= m) badges.push({ key: g.id + "-" + m, days: m, title: g.text });
  badges.sort((a, b) => b.days - a.days);
  const byDay = {};
  const countByDay = {}; // real approvals per day — drives contribution-graph intensity
  for (const s of subs) {
    if (s.status === "approved") { byDay[s.day] = "approved"; countByDay[s.day] = (countByDay[s.day] || 0) + 1; }
  }
  for (const s of subs) {
    // frozen days show as ice (Duolingo-style) — only when no real approval that day
    if (s.status === "frozen") { if (!byDay[s.day]) byDay[s.day] = "frozen"; }
    else if (s.status === "missed") { if (!byDay[s.day]) byDay[s.day] = "missed"; }
    else if (s.status === "rejected") { if (!byDay[s.day]) byDay[s.day] = "rejected"; }
  }
  const frozenUsed = subs.filter((s) => s.status === "frozen").length;
  return { approved, rejected, approvalRate, bestStreak, curStreak, verifiedTotal, badges, byDay, countByDay, frozenUsed };
}

/* Contribution-style graph (GitHub-like): weeks as columns, Mon at the top,
   month labels above, weekday labels on the left, and 3 intensity levels of
   the accent driven by how many proofs were verified that day. */
const HEAT_EMPTY = () => (C.isDark ? "#161b22" : "#eef1f6");
const HEAT_LEVELS = () => (C.isDark
  ? ["rgba(99,102,241,0.35)", "rgba(99,102,241,0.65)", "#6366f1"]
  : ["rgba(79,70,229,0.30)", "rgba(79,70,229,0.60)", "#4f46e5"]);
function Heatmap({ byDay, countByDay = {} }) {
  // 26 calendar-aligned weeks (~6 months), columns start on Monday. The grid
  // scrolls horizontally and opens at the latest week; weekday labels stay
  // fixed on the left. Trailing days after today render as blanks. Frozen days
  // draw as accent-OUTLINED cells (no fill) — distinct without a new color.
  const scrollRef = useRef(null);
  const now = new Date();
  const t0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monday = new Date(t0); monday.setUTCDate(t0.getUTCDate() - ((t0.getUTCDay() + 6) % 7));
  const start = new Date(monday); start.setUTCDate(monday.getUTCDate() - 7 * 25); // 25 weeks back → 26 columns
  const days = [];
  for (const d = new Date(start); d <= t0; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  while (days.length % 7) days.push(null); // pad current week's future days
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const levels = HEAT_LEVELS();
  const cellColor = (d) => {
    if (!d) return "transparent";
    const st = byDay[d];
    if (st === "approved") { const n = countByDay[d] || 1; return levels[n >= 3 ? 2 : n === 2 ? 1 : 0]; }
    if (st === "rejected") return "rgba(220,38,38,0.5)";
    if (st === "missed") return C.isDark ? "#2a3140" : "#dde3ec";
    return HEAT_EMPTY();
  };
  // month label above the first week-column of each new month
  const monthOf = (wk) => { try { return new Date(wk[0] + "T00:00:00").toLocaleString(activeLang() === "ru" ? "ru" : "en", { month: "short" }); } catch (_) { return ""; } };
  let prevMonth = null;
  const monthLabels = weeks.map((wk) => { const m = monthOf(wk); const out = m !== prevMonth ? m : ""; prevMonth = m; return out; });
  const CELL = 15, GAP = 4;
  const dowLabels = [t("Mon"), "", t("Wed"), "", t("Fri"), "", ""];
  return (
    <View style={{ marginTop: 10 }}>
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: 26, marginTop: 15 + 3, gap: GAP }}>
          {dowLabels.map((lbl, i) => (
            <Text key={i} style={{ height: CELL, fontSize: 9, color: C.faint, lineHeight: CELL }}>{lbl}</Text>
          ))}
        </View>
        <ScrollView ref={scrollRef} horizontal showsHorizontalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}>
          <View>
            <View style={{ flexDirection: "row", height: 15 }}>
              {monthLabels.map((m, i) => (
                <Text key={i} style={{ width: CELL + GAP, fontSize: 9, color: C.faint }} numberOfLines={1}>{m}</Text>
              ))}
            </View>
            <View style={{ flexDirection: "row", marginTop: 3 }}>
              {weeks.map((wk, wi) => (
                <View key={wi} style={{ gap: GAP, marginRight: GAP }}>
                  {wk.map((d, di) => {
                    const frozen = d && byDay[d] === "frozen";
                    return <View key={d || "pad" + di} style={{ width: CELL, height: CELL, borderRadius: 3, backgroundColor: frozen ? "transparent" : cellColor(d), borderWidth: frozen ? 1.5 : 0, borderColor: C.red }} />;
                  })}
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 10 }}>
        <Text style={{ fontSize: 10, color: C.faint }}>{t("Less")}</Text>
        <View style={{ width: 11, height: 11, borderRadius: 2.5, backgroundColor: HEAT_EMPTY() }} />
        {levels.map((clr, i) => <View key={i} style={{ width: 11, height: 11, borderRadius: 2.5, backgroundColor: clr }} />)}
        <Text style={{ fontSize: 10, color: C.faint }}>{t("More")}</Text>
      </View>
    </View>
  );
}

function Stats({ goals, subs, onOpenBadge, isPro, onUpgrade, refreshing, onRefresh }) {
  const st = computeStats(goals, subs);
  const windowVerified = lastNDays(182).filter((d) => st.byDay[d] === "approved").length;
  // week pager: 0 = current week, 1 = last week, … (up to ~6 months back)
  const [weekOff, setWeekOff] = useState(0);
  const week = lastNDays(7 * (weekOff + 1)).slice(0, 7); // that week's 7 days, oldest first
  const thisWeek = week.filter((d) => st.byDay[d] === "approved" || st.byDay[d] === "frozen").length;
  const fmtDay = (d) => { try { return new Date(d + "T00:00:00").toLocaleString(activeLang() === "ru" ? "ru" : "en", { day: "numeric", month: "short" }); } catch (_) { return d; } };
  const weekTitle = weekOff === 0 ? t("This week") : `${fmtDay(week[0])} – ${fmtDay(week[6])}`;
  const dayDot = (d) => (st.byDay[d] === "approved" ? C.bronze
    : st.byDay[d] === "rejected" || st.byDay[d] === "missed" ? "rgba(220,38,38,0.45)"
    : (C.isDark ? "#1f242c" : "#e8ecf1"));
  // strongest weekday: which day of the week collects the most verified proofs
  const dowCount = [0, 0, 0, 0, 0, 0, 0];
  for (const d of Object.keys(st.byDay)) {
    if (st.byDay[d] === "approved") dowCount[(new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7]++;
  }
  const bestDow = Math.max(...dowCount) > 0 ? dowCount.indexOf(Math.max(...dowCount)) : null;
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}
      refreshControl={<RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.bronze} />}>
      <Text style={s.h2}>{t("Your stats")}</Text>

      {/* Hero: the current streak, big, with progress toward the next badge. */}
      <View style={[s.card, { alignItems: "center" }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ionicons name="flame" size={30} color={C.red} />
          <Text style={[s.statNum, { fontSize: 46, color: C.ink }]} numberOfLines={1} adjustsFontSizeToFit>{st.curStreak}</Text>
        </View>
        <Text style={s.statLabel}>{t("current streak")}</Text>
        <View style={{ alignSelf: "stretch" }}><MilestoneBar streak={st.curStreak} /></View>
      </View>

      {/* Permanent counters — they only ever grow, cushioning the brutal reset. */}
      <View style={[s.statRow, { marginTop: 10 }]}>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.verifiedTotal}</Text><Text style={s.statLabel}>{t("verified days")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.bestStreak}</Text><Text style={s.statLabel}>{t("best streak")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.approvalRate == null ? "—" : st.approvalRate + "%"}</Text><Text style={s.statLabel}>{t("approval rate")}</Text></View>
      </View>

      {/* Week-by-week view — ‹ › page through past weeks; frozen = outlined */}
      <View style={[s.card, { marginTop: 12 }]}>
        <View style={s.rowBetween}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <TouchableOpacity onPress={() => setWeekOff((v) => Math.min(v + 1, 25))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="chevron-back" size={18} color={weekOff >= 25 ? C.line : C.mute} />
            </TouchableOpacity>
            <Text style={s.kicker}>{weekTitle}</Text>
            <TouchableOpacity onPress={() => setWeekOff((v) => Math.max(v - 1, 0))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} disabled={weekOff === 0}>
              <Ionicons name="chevron-forward" size={18} color={weekOff === 0 ? C.line : C.mute} />
            </TouchableOpacity>
          </View>
          <Text style={[s.kicker, { color: C.bronze }]}>{thisWeek}/7</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          {week.map((d) => {
            const frozen = st.byDay[d] === "frozen";
            return (
              <View key={d} style={{ flex: 1, height: 26, borderRadius: 8, backgroundColor: frozen ? "transparent" : dayDot(d), borderWidth: frozen ? 1.5 : 0, borderColor: C.red, alignItems: "center", justifyContent: "center" }}>
                {st.byDay[d] === "approved" ? <Ionicons name="checkmark" size={14} color="#ffffff" />
                  : frozen ? <Ionicons name="snow" size={13} color={C.red} /> : null}
              </View>
            );
          })}
        </View>
        <Text style={[s.note, { textAlign: "left", marginTop: 10 }]}>
          {t("freezes used")}: {st.frozenUsed}{bestDow == null ? "" : " · " + t("strongest day") + ": " + t(DOW_NAMES[bestDow])}
        </Text>
      </View>

      {/* Analytics (heatmap + trophies) is a Pro feature. */}
      {isPro ? (
        <>
          <View style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.kicker}>{t("Last 6 months")}</Text>
              <Text style={s.note}>{windowVerified} {t("verified")}</Text>
            </View>
            <Heatmap byDay={st.byDay} countByDay={st.countByDay} />
            <View style={{ flexDirection: "row", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
              <Legend color={C.red} outline label={t("frozen")} />
              <Legend color="rgba(220,38,38,0.5)" label={t("rejected")} />
              <Legend color={C.isDark ? "#2a3140" : "#dde3ec"} label={t("missed")} />
            </View>
          </View>

          <Text style={[s.kicker, { color: C.bronze, marginTop: 20, marginBottom: 8 }]}>{t("Trophy shelf")} · {st.badges.length}</Text>
          {st.badges.length === 0 ? (
            <Text style={s.note}>{t("Hit a 7, 30 or 100-day verified streak to earn shareable badges.")}</Text>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {st.badges.map((b) => (
                <TouchableOpacity key={b.key} style={s.trophy} onPress={() => onOpenBadge(b)}>
                  <Text style={s.trophyDays}>{b.days}</Text>
                  <Text style={s.trophyLabel} numberOfLines={1}>{b.title}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      ) : (
        // Locked state teases the real thing: a faded heatmap behind a lock
        // sells analytics better than an emoji ever did.
        <TouchableOpacity style={s.card} activeOpacity={0.85} onPress={onUpgrade}>
          <View>
            <View style={{ opacity: 0.35 }}>
              {[
                [1,1,0,1,1,1,0,1,1,1,1,0],
                [0,1,1,1,0,1,1,1,0,1,1,1],
                [1,0,1,1,1,1,1,0,1,1,0,1],
                [1,1,1,0,1,1,0,1,1,1,1,1],
              ].map((row, r) => (
                <View key={r} style={{ flexDirection: "row", gap: 4, marginTop: r === 0 ? 0 : 4 }}>
                  {row.map((v, i) => (
                    <View key={i} style={{ flex: 1, aspectRatio: 1, borderRadius: 3, backgroundColor: v ? C.bronze : (C.isDark ? "#161b22" : "#eef1f6") }} />
                  ))}
                </View>
              ))}
            </View>
            <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
              <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.bronze, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="lock-closed" size={20} color={C.bronze} />
              </View>
            </View>
          </View>
          <Text style={[s.kicker, { color: C.bronze, textAlign: "center", marginTop: 14 }]}>{t("Analytics is a Pro feature")}</Text>
          <Text style={[s.note, { textAlign: "center" }]}>{t("Unlock the 12-week consistency heatmap, trophy shelf and trends.")}</Text>
          <Text style={[s.kicker, { color: C.bronze, textAlign: "center", marginTop: 8 }]}>{t("Upgrade →")}</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}
function Legend({ color, label, outline }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={outline
        ? { width: 11, height: 11, borderRadius: 3, borderWidth: 1.5, borderColor: color }
        : { width: 11, height: 11, borderRadius: 3, backgroundColor: color }} />
      <Text style={s.note}>{label}</Text>
    </View>
  );
}

/* ---------- CHALLENGES ---------- */
function timeLeft(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "Ended";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d}d ${h}h left` : `${h}h left`;
}
function medal(rank) { return `#${rank}`; }
function cadenceLabel(ch) {
  if (ch.goal_type === "one_time") return t("One-time");
  return ch.goal_format === "3x" ? t("3× / week") : ch.goal_format === "5x" ? t("5× / week") : t("Daily");
}
const SPIN_FLAVOR = ["20 push-ups…", "goofy selfie…", "sing a song…", "30 squats…", "2-min plank…", "opera voice…", "15 burpees…", "clothes inside out…"];

// Wheel-of-fortune dares — MUST mirror the server list in
// supabase/functions/challenge/index.ts so the wheel can land on the chosen one.
const WHEEL_DARES = [
  "Do 20 push-ups, film it, send to the group. 💪",
  "Post a goofy selfie to your story for 1 hour. 🤡",
  "Send the group a voice message singing a song chorus. 🎤",
  "Do 30 squats right now, on camera. 🏋️",
  "Set a silly profile picture for 24 hours. 🖼️",
  "Hold a 2-minute plank and film the timer. ⏱️",
  "Text someone 'I lost a bet and now I owe you a coffee'. ☕",
  "Read your last message out loud in an opera voice (voice memo). 🎭",
  "Do 15 burpees and send proof to the group. 🔥",
  "Wear your clothes inside out for an hour and send a pic. 👕",
  "Do 10 jumping jacks counting in another language. 🌍",
  "Send the group your goofiest camera-roll photo. 📸",
];
const WHEEL_COLORS = ["#4f46e5", "#27303c", "#6366f1", "#1d242e"];

const dareIndex = (d, list = WHEEL_DARES) => { const i = list.indexOf(d); return i >= 0 ? i : 0; };

// Animated wheel of fortune. Pass landIndex to spin + settle on that slice
// (under the top pointer). N pie slices drawn with CSS-triangle wedges (no SVG dep).
// dares: the challenge's pool (friends' custom dares padded with defaults).
function WheelOfFortune({ landIndex, size = 268, dares = WHEEL_DARES }) {
  const rot = useRef(new Animated.Value(0)).current;
  const R = size / 2;
  const N = Math.max(dares.length, 2);
  const seg = 360 / N;
  const base = 2 * R * Math.tan((seg / 2) * Math.PI / 180); // slice base width at the rim
  useEffect(() => {
    if (landIndex == null) return;
    rot.setValue(0);
    const target = 360 * 5 - landIndex * seg; // 5 full turns, then slice center under the pointer
    Animated.timing(rot, { toValue: target, duration: 3800, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [landIndex]);
  const spin = rot.interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ width: size, height: size, borderRadius: R, overflow: "hidden", borderWidth: 5, borderColor: C.bronze, backgroundColor: C.bg, transform: [{ rotate: spin }] }}>
      {dares.map((d, i) => (
        <View key={i} style={{ position: "absolute", width: size, height: size, transform: [{ rotate: `${i * seg}deg` }] }}>
          <View style={{ position: "absolute", top: 0, left: (size - base) / 2, width: 0, height: 0, borderLeftWidth: base / 2, borderRightWidth: base / 2, borderTopWidth: R, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: WHEEL_COLORS[i % WHEEL_COLORS.length] }} />
          <Text style={{ position: "absolute", top: 10, left: 0, width: size, textAlign: "center", fontSize: 13, fontWeight: "800", color: "#ffffff" }}>{i + 1}</Text>
        </View>
      ))}
      <View style={{ position: "absolute", top: R - 17, left: R - 17, width: 34, height: 34, borderRadius: 17, backgroundColor: C.bronze, borderWidth: 3, borderColor: C.bg }} />
    </Animated.View>
  );
}

function ChallengesScreen({ onOpen, onCreate, onJoin }) {
  const [rows, setRows] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase.from("challenge_members").select("challenge_id, final_rank, challenges(*)").order("joined_at", { ascending: false });
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false); }
  // Remove a challenge from my list (server "leave"). For an active challenge
  // this exits it — the group keeps going without me.
  function removeChallenge(ch, ended) {
    Alert.alert(
      ended ? t("Remove from your list?") : t("Leave this challenge?"),
      ended ? t("Removes it from your history. The others keep theirs.") : t("You'll drop off the leaderboard; the challenge continues for the others."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: ended ? t("Remove") : t("Leave"), style: "destructive", onPress: async () => {
          try {
            const { data } = await supabase.functions.invoke("challenge", { body: { action: "leave", challengeId: ch.id } });
            if (data?.error) throw new Error(data.error);
            await load();
          } catch (e) { Alert.alert("Cert", e.message || t("Couldn't load.")); }
        } },
      ]
    );
  }
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.bronze} />}>
      <Text style={s.h2}>{t("Challenges")}</Text>
      <Text style={s.lede}>{t("Compete with friends on one shared goal. Last place spins the wheel of fortune.")}</Text>
      <Btn label={"+ " + t("Create a challenge")} onPress={onCreate} />
      <BtnGhost label={t("Join by code")} onPress={onJoin} />
      {rows === null ? <ActivityIndicator color={C.bronze} style={{ marginTop: 24 }} /> : (() => {
        const mems = (rows || []).filter((m) => m.challenges);
        const isEnded = (ch) => ch.status === "ended" || Date.now() >= new Date(ch.ends_at).getTime();
        const active = mems.filter((m) => !isEnded(m.challenges));
        const past = mems.filter((m) => isEnded(m.challenges));
        if (mems.length === 0) return <Text style={[s.note, { marginTop: 18 }]}>{t("No challenges yet. Create one and share the code with friends.")}</Text>;
        return (
          <>
            {active.map((m) => {
              const ch = m.challenges;
              return (
                <TouchableOpacity key={ch.id} style={s.card} onPress={() => onOpen(ch.id)}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.goalText}>{ch.title}</Text>
                      <Text style={s.note}>{timeLeft(ch.ends_at)} · {t("code")} {ch.code}</Text>
                    </View>
                    <TouchableOpacity onPress={() => removeChallenge(ch, false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="trash-outline" size={19} color={C.faint} />
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              );
            })}
            {past.length > 0 ? (
              <>
                <TouchableOpacity style={s.historyHead} onPress={() => setShowHistory((v) => !v)} activeOpacity={0.7}>
                  <Ionicons name="time-outline" size={16} color={C.mute} />
                  <Text style={[s.kicker, { flex: 1 }]}>{t("History")} · {past.length}</Text>
                  <Ionicons name={showHistory ? "chevron-up" : "chevron-down"} size={18} color={C.mute} />
                </TouchableOpacity>
                {showHistory ? past.map((m) => {
                  const ch = m.challenges;
                  return (
                    <TouchableOpacity key={ch.id} style={[s.card, { opacity: 0.75 }]} onPress={() => onOpen(ch.id)}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                        {m.final_rank ? <Text style={{ fontSize: 22 }}>{medal(m.final_rank)}</Text> : null}
                        <View style={{ flex: 1 }}>
                          <Text style={s.goalText}>{ch.title}</Text>
                          <Text style={s.note}>{t("Ended")}{ch.dare ? " · " + t("wheel spun") : ""}</Text>
                        </View>
                        <TouchableOpacity onPress={() => removeChallenge(ch, true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Ionicons name="trash-outline" size={19} color={C.faint} />
                        </TouchableOpacity>
                        <Text style={s.certRowChevron}>›</Text>
                      </View>
                    </TouchableOpacity>
                  );
                }) : null}
              </>
            ) : null}
          </>
        );
      })()}
    </ScrollView>
  );
}

function CreateChallenge({ isPro, onUpgrade, onCreated, onBack }) {
  // 3-step wizard: goal → schedule → judging (+ inline confirm). Every answer
  // lives here at the parent level, so moving between steps (or opening the
  // paywall modal on top) never loses what's already filled in.
  const [step, setStep] = useState(0);
  const [goalText, setGoalText] = useState("");
  const [name, setName] = useState("");
  const [hasProfileName, setHasProfileName] = useState(false);
  const [dur, setDur] = useState(7);
  const [type, setType] = useState("recurring"); // recurring | one_time
  const [format, setFormat] = useState("daily");  // daily | 3x | 5x
  const [oneTimeDeadline, setOneTimeDeadline] = useState(null); // Date|null, for one_time
  const [judgeMode, setJudgeMode] = useState("ai"); // ai | peer
  const [proofType, setProofType] = useState("photo"); // photo | timelapse (AI judge only, Pro)
  const [dare, setDare] = useState(""); // my wheel-of-fortune dare for the loser (optional)
  const [busy, setBusy] = useState(false);
  const stepAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => { loadMyName().then((n) => { if (n) { setName(n); setHasProfileName(true); } }); }, []);
  useEffect(() => {
    stepAnim.setValue(0);
    Animated.timing(stepAnim, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [step]);

  const STEPS = 3;
  function next() {
    if (step === 0) {
      if (goalText.trim().length < 3) return Alert.alert("Cert", t("Describe the shared goal."));
      if (!name.trim()) return Alert.alert("Cert", t("Enter your name for the leaderboard."));
    }
    if (step === 1 && type === "one_time" && !oneTimeDeadline) return Alert.alert("Cert", t("Pick a deadline date & time."));
    setStep((v) => Math.min(v + 1, STEPS - 1));
  }
  async function create() {
    if (type === "one_time" && !oneTimeDeadline) return Alert.alert("Cert", t("Pick a deadline date & time."));
    setBusy(true);
    try {
      if (!hasProfileName) await saveMyName(name.trim());
      const { data, error } = await supabase.functions.invoke("challenge", { body: {
        action: "create", title: goalText.trim(), goalText: goalText.trim(), durationDays: dur,
        name: name.trim(), goalType: type, goalFormat: format, judgeMode,
        proofType: judgeMode === "ai" ? proofType : "photo",
        endsAt: type === "one_time" && oneTimeDeadline ? oneTimeDeadline.toISOString() : null,
        dare: dare.trim() || null,
      } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      onCreated(data.challenge.id);
    } catch (e) { Alert.alert("Cert", e.message || t("Couldn't create challenge.")); }
    finally { setBusy(false); }
  }
  const fmtDeadline = (d) => d ? d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const scheduleSummary = type === "one_time"
    ? `${t("One-time")} · ${fmtDeadline(oneTimeDeadline)}`
    : `${format === "daily" ? t("Daily") : format === "3x" ? t("3× / week") : t("5× / week")} · ${t("{n} days", { n: dur })}`;
  const SummaryRow = ({ label, value, goStep }) => (
    <TouchableOpacity style={s.rowBetween} onPress={() => setStep(goStep)} activeOpacity={0.7}>
      <View style={{ flex: 1, marginRight: 10 }}>
        <Text style={s.kicker}>{label}</Text>
        <Text style={[s.goalText, { marginTop: 3 }]} numberOfLines={2}>{value}</Text>
      </View>
      <Text style={[s.kicker, { color: C.bronze }]}>{t("Edit")}</Text>
    </TouchableOpacity>
  );
  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <BackBar onBack={step === 0 ? onBack : () => setStep((v) => v - 1)} />
      <View style={s.rowBetween}>
        <Text style={s.h2}>{t("Create a challenge")}</Text>
        <Text style={s.kicker}>{t("Step {a} of {b}", { a: step + 1, b: STEPS })}</Text>
      </View>
      {/* step progress */}
      <View style={{ flexDirection: "row", gap: 6, marginTop: 10 }}>
        {Array.from({ length: STEPS }).map((_, i) => (
          <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= step ? C.bronze : C.line }} />
        ))}
      </View>

      <Animated.View style={{ opacity: stepAnim, transform: [{ translateX: stepAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }] }}>
        {step === 0 ? (
          <>
            <Text style={[s.label, { marginTop: 18 }]}>{t("Shared goal")}</Text>
            <TextInput style={[s.input, { height: 78, textAlignVertical: "top" }]} multiline blurOnSubmit returnKeyType="done" placeholder={t("e.g. gym 45 min with equipment")} placeholderTextColor={C.faint} value={goalText} onChangeText={(val) => setGoalText(val.replace(/\n/g, " "))} />
            <Text style={[s.note, { textAlign: "left" }]}>{t("Add a time if you want — e.g. \"gym at 19:00\".")}</Text>
            {hasProfileName
              ? <Text style={[s.note, { marginTop: 12 }]}>{t("Playing as")} <Text style={{ color: C.bronze, fontWeight: "800" }}>{name}</Text> · {t("change it in Profile")}</Text>
              : (<>
                  <Text style={[s.label, { marginTop: 14 }]}>{t("Your name (leaderboard)")}</Text>
                  <TextInput style={s.input} placeholder={t("e.g. Zhanibek")} placeholderTextColor={C.faint} value={name} onChangeText={(val) => setName(val.replace(/\n/g, " "))} />
                </>)}
          </>
        ) : step === 1 ? (
          <>
            <Text style={[s.label, { marginTop: 18 }]}>{t("Type")}</Text>
            <TabSwitch value={type} onChange={setType}
              options={[{ value: "recurring", label: t("Repeating") }, { value: "one_time", label: t("One-time") }]} />
            {type === "recurring" ? (
              <>
                <Text style={[s.label, { marginTop: 14 }]}>{t("How often?")}</Text>
                <View style={s.chipRow}>
                  {[["daily", t("Daily")], ["3x", t("3×/wk")], ["5x", t("5×/wk")]].map(([v, label]) => (
                    <TouchableOpacity key={v} style={[s.chip, format === v && s.chipOn]} onPress={() => setFormat(v)}>
                      <Text style={[s.chipText, format === v && { color: C.ink }]}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={[s.label, { marginTop: 14 }]}>{t("How long?")}</Text>
                <View style={s.rowGap}>
                  {[7, 14, 30].map((d) => <Pill key={d} label={t("{n} days", { n: d })} active={dur === d} onPress={() => setDur(d)} />)}
                </View>
              </>
            ) : (
              <>
                <Text style={[s.label, { marginTop: 14 }]}>{t("Deadline")}</Text>
                <DateTimeField value={oneTimeDeadline} onChange={setOneTimeDeadline} placeholder={t("Pick date & time")} />
              </>
            )}
          </>
        ) : (
          <>
            <Text style={[s.label, { marginTop: 18 }]}>{t("Who judges proofs?")}</Text>
            <TabSwitch value={judgeMode} onChange={setJudgeMode}
              options={[{ value: "ai", label: t("AI judge") }, { value: "peer", label: t("Friends vote") }]} />
            {judgeMode === "ai" ? (
              <>
                <Text style={[s.label, { marginTop: 14 }]}>{t("Proof")}</Text>
                <ProofSelect value={proofType} onChange={setProofType} isPro={isPro} onUpgrade={onUpgrade} />
              </>
            ) : null}
            <Text style={[s.label, { marginTop: 16 }]}>{t("Dare for the loser (optional)")}</Text>
            <TextInput style={s.input} placeholder={t("e.g. Sing a song chorus 🎤")} placeholderTextColor={C.faint} value={dare} onChangeText={(val) => setDare(val.replace(/\n/g, " "))} maxLength={120} />
            <Text style={[s.note, { textAlign: "left" }]}>{t("Last place spins the wheel of everyone's dares.")}</Text>
            {/* inline confirm — the goal + schedule from the earlier steps */}
            <View style={[s.card, { gap: 12, marginTop: 16 }]}>
              <SummaryRow label={t("Goal")} value={goalText.trim() || "—"} goStep={0} />
              <SummaryRow label={t("Schedule")} value={scheduleSummary} goStep={1} />
            </View>
          </>
        )}
      </Animated.View>

      {step < STEPS - 1
        ? <Btn label={t("Next") + " →"} onPress={next} />
        : <Btn label={busy ? t("Creating…") : t("Create & get code")} onPress={create} disabled={busy} />}
    </ScrollView>
  );
}

function JoinChallenge({ onJoined, onBack, initialCode }) {
  const [code, setCode] = useState(initialCode || "");
  const [name, setName] = useState("");
  const [hasProfileName, setHasProfileName] = useState(false);
  const [dare, setDare] = useState(""); // my dare for the loser's wheel (optional)
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadMyName().then((n) => { if (n) { setName(n); setHasProfileName(true); } }); }, []);
  async function join() {
    if (code.trim().length < 4) return Alert.alert("Cert", t("Enter the challenge code."));
    if (!name.trim()) return Alert.alert("Cert", t("Enter your name for the leaderboard."));
    setBusy(true);
    try {
      if (!hasProfileName) await saveMyName(name.trim());
      const { data, error } = await supabase.functions.invoke("challenge", { body: { action: "join", code: code.trim(), name: name.trim(), dare: dare.trim() || null } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error === "not_found" ? t("No challenge with that code.") : data.error);
      onJoined(data.challenge.id);
    } catch (e) { Alert.alert("Cert", e.message || t("Couldn't join.")); }
    finally { setBusy(false); }
  }
  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Join a challenge")}</Text>
      <Text style={s.label}>{t("Challenge code")}</Text>
      <TextInput style={s.input} placeholder="ABC123" placeholderTextColor={C.faint} autoCapitalize="characters" value={code} onChangeText={setCode} />
      {hasProfileName
        ? <Text style={[s.note, { marginTop: 12 }]}>{t("Joining as")} <Text style={{ color: C.bronze, fontWeight: "800" }}>{name}</Text> · {t("change it in Profile")}</Text>
        : (<>
            <Text style={[s.label, { marginTop: 14 }]}>{t("Your name (shown on leaderboard)")}</Text>
            <TextInput style={s.input} placeholder={t("e.g. Zhanibek")} placeholderTextColor={C.faint} value={name} onChangeText={(val) => setName(val.replace(/\n/g, " "))} />
          </>)}
      <Text style={[s.label, { marginTop: 14 }]}>{t("Your dare for the loser (optional)")}</Text>
      <TextInput style={s.input} placeholder={t("e.g. Sing a song chorus in a voice message 🎤")} placeholderTextColor={C.faint} value={dare} onChangeText={(val) => setDare(val.replace(/\n/g, " "))} maxLength={120} />
      <Text style={[s.note, { textAlign: "left" }]}>{t("Everyone writes one. Last place spins the wheel over the dares your group wrote.")}</Text>
      <Btn label={busy ? t("Joining…") : t("Join")} onPress={join} disabled={busy} />
    </ScrollView>
  );
}

function ChallengeDetail({ challengeId, onSubmitProof, onReview, onSharePlacement, onBack }) {
  const [board, setBoard] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [peerBusy, setPeerBusy] = useState(false);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [wheelPreview, setWheelPreview] = useState(false);
  const [landIndex, setLandIndex] = useState(null);   // slice the wheel settles on
  const [revealed, setRevealed] = useState(null);     // dare text shown after the spin
  const [spinningWheel, setSpinningWheel] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke("challenge", { body: { action: "board", challengeId } });
    if (error || data?.error) { Alert.alert("Cert", data?.error || error?.message || t("Couldn't load.")); return; }
    setBoard(data);
  }, [challengeId]);
  useEffect(() => { load(); }, [load]);
  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false); }

  // Wheel slices = this challenge's dare pool (friends' custom dares padded
  // with defaults) — the server builds the same list for board and spin.
  const boardDares = board?.dares?.length ? board.dares : WHEEL_DARES;

  // Auto-show the wheel ONCE when an ended challenge opens (the result, or the
  // spin prompt if you're last). Seen-state persists so it never re-pops.
  useEffect(() => {
    if (!board || !board.ended) return;
    const key = "wheel_seen_" + challengeId;
    let cancelled = false;
    AsyncStorage.getItem(key).then((seen) => {
      if (cancelled || seen) return;
      if (board.dare) { setLandIndex(dareIndex(board.dare, boardDares)); setRevealed(board.dare); setWheelPreview(false); setWheelOpen(true); AsyncStorage.setItem(key, "1"); }
      else if (board.canSpin) { setLandIndex(null); setRevealed(null); setWheelPreview(false); setWheelOpen(true); AsyncStorage.setItem(key, "1"); }
    });
    return () => { cancelled = true; };
  }, [board, challengeId]);

  function closeWheel() { setWheelOpen(false); setWheelPreview(false); setSpinningWheel(false); setLandIndex(null); setRevealed(null); }

  async function submitPeer() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert("Cert", t("Camera permission needed."));
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.4 });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    const a = res.assets[0];
    const photo = `data:${a.mimeType || "image/jpeg"};base64,${a.base64}`;
    setPeerBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("challenge", { body: { action: "submit", challengeId, photo } });
      if (error) throw error;
      if (data?.error) {
        const m = data.error === "already_today" ? t("You've already submitted today.")
          : data.error === "rejected_today" ? t("Your proof didn't pass today. One attempt per day — come back tomorrow.")
          : String(data.error);
        Alert.alert("Cert", m); return;
      }
      Alert.alert("Cert", t("Sent! Your friends will vote on it."));
      await load();
    } catch (e) { Alert.alert("Cert", e.message || t("Couldn't submit.")); }
    finally { setPeerBusy(false); }
  }

  // Real spin: ask the server for the dare, then land the wheel on it.
  function doSpin() {
    setSpinningWheel(true);
    supabase.functions.invoke("challenge", { body: { action: "spin", challengeId } })
      .then(({ data }) => {
        if (!data?.dare) { setSpinningWheel(false); Alert.alert("Cert", data?.error || "Spin failed."); return; }
        setLandIndex(dareIndex(data.dare, boardDares)); // wheel animates ~3.8s
        setTimeout(async () => { setRevealed(data.dare); setSpinningWheel(false); await load(); }, 3900);
      })
      .catch((e) => { setSpinningWheel(false); Alert.alert("Cert", e.message || "Spin failed."); });
  }
  function openResultWheel() { setWheelPreview(false); setLandIndex(dareIndex(board.dare, boardDares)); setRevealed(board.dare); setWheelOpen(true); }
  function openSpinWheel() { setWheelPreview(false); setLandIndex(null); setRevealed(null); setWheelOpen(true); }

  if (!board) return <Center><ActivityIndicator color={C.bronze} /></Center>;
  const ch = board.challenge;
  const isWk = ch.goal_type === "recurring" && (ch.goal_format === "3x" || ch.goal_format === "5x");
  const shareInvite = () => {
    // https link (clickable in messengers, unlike a raw cert:// scheme) —
    // the landing page redirects into the app or shows the code + install steps.
    const link = `https://www.certapp.pro/join.html?code=${ch.code}`;
    Share.share({ message: t("Join my Cert challenge \"{goal}\" — tap to join:\n{link}\n\n(or enter code {code} in the app)", { goal: ch.goal_text, link, code: ch.code }) });
  };
  function previewWheel() {
    const idx = Math.floor(Math.random() * boardDares.length);
    setWheelPreview(true); setRevealed(null); setLandIndex(null); setWheelOpen(true);
    setTimeout(() => setLandIndex(idx), 60);          // start the spin
    setTimeout(() => setRevealed(boardDares[idx]), 4000); // reveal after it settles
  }
  function endNow() {
    Alert.alert(t("End challenge now?"), t("Ends it for everyone and locks the leaderboard. Last place spins the wheel."), [
      { text: t("Cancel"), style: "cancel" },
      { text: t("End now"), style: "destructive", onPress: async () => {
        const { data } = await supabase.functions.invoke("challenge", { body: { action: "end", challengeId } });
        if (data?.ok) await load();
        else Alert.alert("Cert", data?.error || t("Couldn't end the challenge."));
      } },
    ]);
  }
  return (
    <ScrollView contentContainerStyle={s.wrap}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.bronze} />}>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{ch.title}</Text>
      <View style={s.card}>
        <Text style={s.goalText}>{ch.goal_text}</Text>
        <Text style={[s.note, { textAlign: "left" }]}>{cadenceLabel(ch)} · {board.ended ? t("Ended") : timeLeft(ch.ends_at)}</Text>
        <Text style={[s.note, { textAlign: "left" }]}>{t("share code")} <Text style={{ color: C.bronze, fontWeight: "800", letterSpacing: 1 }}>{ch.code}</Text></Text>
      </View>
      <BtnGhost label={t("Share invite link")} onPress={shareInvite} />

      {board.members.map((m) => (
        <View key={m.userId} style={[s.lbRow, m.isMe && { borderColor: C.bronze }]}>
          <Text style={[s.lbRank, { minWidth: 26 }]}>{m.rank <= 3 ? medal(m.rank) : m.rank}</Text>
          <Avatar uri={m.avatar} name={m.name} size={38} />
          <View style={{ flex: 1 }}>
            <Text style={s.lbName}>{m.name}{m.isMe ? " (" + t("you") + ")" : ""}</Text>
            <Text style={s.note}>{m.verifiedDays} {t("verified")} · {m.streak}{isWk ? t("w") : t("d")} {t("streak")}</Text>
          </View>
          {board.ended && board.loser && board.loser.userId === m.userId ? <Text style={s.lbLast}>{t("LAST")}</Text> : null}
        </View>
      ))}

      {!board.ended && board.myGoal ? (
        board.weekly && board.weekly.weekDone ? (
          <View style={[s.card, { borderColor: C.green, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.green }]}>{t("Week complete")} · {board.weekly.thisWeek}/{board.weekly.quota}</Text>
            <Text style={s.note}>{t("You hit this week's target. Come back next week.")}</Text>
          </View>
        ) : board.awaitingVotes ? (
          <View style={[s.card, { borderColor: C.bronze, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.bronze }]}>{t("Awaiting friends' votes")}</Text>
            <Text style={s.note}>{t("Your proof is in the queue. It counts once a friend approves it.")}</Text>
          </View>
        ) : board.doneToday ? (
          <View style={[s.card, { borderColor: C.green, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.green }]}>{board.myGoal.status === "completed" ? t("Goal completed") : t("Done for today")}</Text>
            <Text style={s.note}>{board.myGoal.status === "completed" ? t("You finished this challenge goal.") : board.weekly ? t("This week: {a}/{b}. Come back another day.", { a: board.weekly.thisWeek, b: board.weekly.quota }) : t("Come back tomorrow to keep your lead.")}</Text>
          </View>
        ) : board.rejectedToday ? (
          <View style={[s.card, { borderColor: C.err, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.err }]}>{t("Declined by friends")}</Text>
            <Text style={s.note}>{t("Your proof didn't pass today. One attempt per day — come back tomorrow.")}</Text>
          </View>
        ) : (
          <>
            {board.weekly ? <Text style={[s.note, { textAlign: "center", marginTop: 14 }]}>{t("This week: {a}/{b} done", { a: board.weekly.thisWeek, b: board.weekly.quota })}</Text> : null}
            {board.judgeMode === "peer"
              ? <Btn label={peerBusy ? t("Sending…") : t("Submit for friends to judge")} onPress={submitPeer} disabled={peerBusy} />
              : <Btn label={t("Submit today's proof")} onPress={() => onSubmitProof(board.myGoal)} />}
          </>
        )
      ) : null}

      {!board.ended && board.judgeMode === "peer" && board.pendingForMe > 0
        ? <Btn label={t("Review friends' proofs ({n})", { n: board.pendingForMe })} onPress={onReview} />
        : null}

      {!board.ended && board.isHost ? <BtnGhost label={t("End challenge now (host)")} onPress={endNow} /> : null}

      {board.ended ? (
        <View style={[s.card, { borderColor: C.err, marginTop: 18 }]}>
          {board.dare ? (
            <>
              <Text style={[s.kicker, { color: C.err }]}>{t("Wheel of fortune")}</Text>
              <Text style={s.goalText}>{t("{name} must:", { name: board.loser ? board.loser.name : t("Last place") })}</Text>
              <Text style={[s.h2, { color: C.bronze }]}>{board.dare}</Text>
              <BtnGhost label={t("Replay the spin")} onPress={openResultWheel} />
            </>
          ) : board.canSpin ? (
            <>
              <Text style={[s.kicker, { color: C.err }]}>{t("You came last")}</Text>
              <Text style={s.lede}>{t("Spin the wheel of fortune and accept your dare.")}</Text>
              <Btn label={t("Spin the wheel")} onPress={openSpinWheel} />
            </>
          ) : (
            <>
              <Text style={[s.kicker, { color: C.bronze }]}>{t("Winner: {name}", { name: board.members[0]?.name })}</Text>
              <Text style={s.note}>{t("Waiting for last place to spin the wheel…")}</Text>
            </>
          )}
        </View>
      ) : null}

      {board.ended ? (
        <Btn label={t("Share your placement")} onPress={() => onSharePlacement((board.members.find((m) => m.isMe)?.rank) || board.members.length, ch.goal_text)} />
      ) : null}

      {/* Wheel of fortune — spinning modal (auto-opens once when an ended challenge loads) */}
      <Modal visible={wheelOpen} transparent animationType="fade" onRequestClose={closeWheel}>
        <View style={s.wheelBackdrop}>
          <Text style={s.wheelTitle}>{t("Wheel of fortune")}</Text>
          <Text style={s.wheelSub}>
            {wheelPreview ? t("Preview — what a spin looks like")
              : board?.loser ? t("{name} finished last", { name: `${board.loser.name}${board.loser.isMe ? " (" + t("you") + ")" : ""}` })
              : t("Spin for your dare")}
          </Text>
          <View style={s.wheelStage}>
            <View style={s.wheelPointer} />
            <WheelOfFortune landIndex={landIndex} dares={boardDares} />
          </View>
          {revealed ? (
            <View style={s.wheelResult}>
              <Text style={[s.kicker, { color: C.err, textAlign: "center" }]}>{wheelPreview ? t("Could be…") : t("The dare")}</Text>
              <Text style={s.wheelDare}>{revealed}</Text>
            </View>
          ) : null}
          <View style={{ width: "100%", maxWidth: 320, marginTop: 18 }}>
            {(!wheelPreview && board?.canSpin && !revealed)
              ? <Btn label={spinningWheel ? t("Spinning…") : t("Spin the wheel")} onPress={doSpin} disabled={spinningWheel} />
              : null}
            {(revealed || wheelPreview || (!board?.canSpin))
              ? <BtnGhost label={revealed ? t("Done") : t("Close")} onPress={closeWheel} disabled={spinningWheel} />
              : null}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

/* ---------- SWIPE REVIEW (peer voting, Tinder-style) ---------- */
function SwipeReview({ onBack }) {
  const SCREEN_W = Dimensions.get("window").width;
  const [queue, setQueue] = useState(null);
  const [idx, setIdx] = useState(0);
  const pan = useRef(new Animated.ValueXY()).current;
  const loadQ = useCallback(async () => {
    const { data } = await supabase.functions.invoke("challenge", { body: { action: "reviewQueue" } });
    setQueue(data?.queue || []); setIdx(0); pan.setValue({ x: 0, y: 0 });
  }, [pan]);
  useEffect(() => { loadQ(); }, [loadQ]);

  const current = queue && queue[idx];
  function swipe(dir) {
    const v = dir === "right" ? "approve" : "decline";
    if (current) supabase.functions.invoke("challenge", { body: { action: "vote", submissionId: current.submissionId, vote: v } }).catch(() => {});
    Animated.timing(pan, { toValue: { x: dir === "right" ? SCREEN_W * 1.5 : -SCREEN_W * 1.5, y: 0 }, duration: 220, useNativeDriver: false })
      .start(() => { pan.setValue({ x: 0, y: 0 }); setIdx((i) => i + 1); });
  }
  // UGC moderation (App Store 1.2): report objectionable content, block a user.
  function reportProof() {
    if (!current) return;
    const item = current;
    Alert.alert(t("Report this proof?"), t("Report content that's objectionable or abusive. We review reports within 24 hours."), [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Report"), style: "destructive", onPress: async () => {
        try { await supabase.functions.invoke("challenge", { body: { action: "report", submissionId: item.submissionId, reportedUserId: item.userId, reason: "objectionable" } }); } catch (_) {}
        Alert.alert("Cert", t("Thanks — we'll review this within 24 hours."));
        pan.setValue({ x: 0, y: 0 }); setIdx((i) => i + 1);
      } },
    ]);
  }
  function blockUser() {
    if (!current) return;
    const item = current;
    Alert.alert(t("Block {name}?", { name: item.name }), t("You won't see their proofs again. This can't be undone in the app."), [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Block"), style: "destructive", onPress: async () => {
        try { await supabase.functions.invoke("challenge", { body: { action: "block", blockedUserId: item.userId } }); } catch (_) {}
        pan.setValue({ x: 0, y: 0 }); setIdx((i) => i + 1);
      } },
    ]);
  }
  const panResponder = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8,
    onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_, g) => {
      if (g.dx > 110) swipe("right");
      else if (g.dx < -110) swipe("left");
      else Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
    },
  });
  const rotate = pan.x.interpolate({ inputRange: [-SCREEN_W, 0, SCREEN_W], outputRange: ["-11deg", "0deg", "11deg"] });
  const okOpacity = pan.x.interpolate({ inputRange: [0, 110], outputRange: [0, 1], extrapolate: "clamp" });
  const noOpacity = pan.x.interpolate({ inputRange: [-110, 0], outputRange: [1, 0], extrapolate: "clamp" });

  if (queue === null) return <Center><ActivityIndicator color={C.bronze} /></Center>;
  return (
    <View style={{ flex: 1, padding: 20 }}>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Review proofs")}</Text>
      {!current ? (
        <View style={[s.card, { alignItems: "center", marginTop: 24 }]}>
          <Text style={s.h2}>{t("All caught up")}</Text>
          <Text style={[s.lede, { textAlign: "center" }]}>{t("No proofs waiting for your vote right now.")}</Text>
          <Btn label={t("Back")} onPress={onBack} />
        </View>
      ) : (
        <>
          <View style={{ position: "relative", justifyContent: "center" }}>
            {/* swipe affordance: arrows hint which way to drag */}
            <View pointerEvents="none" style={[s.swipeHint, { left: 2 }]}>
              <Ionicons name="arrow-back-circle" size={30} color={C.err} />
              <Text style={[s.swipeHintT, { color: C.err }]}>{t("Decline")}</Text>
            </View>
            <View pointerEvents="none" style={[s.swipeHint, { right: 2 }]}>
              <Ionicons name="arrow-forward-circle" size={30} color={C.green} />
              <Text style={[s.swipeHintT, { color: C.green }]}>{t("Approve")}</Text>
            </View>
            <Animated.View {...panResponder.panHandlers} style={[s.swipeCard, { transform: [{ translateX: pan.x }, { translateY: pan.y }, { rotate }] }]}>
              <Animated.View style={[s.swipeStamp, { borderColor: C.green, left: 16, opacity: okOpacity }]}><Text style={[s.swipeStampT, { color: C.green }]}>APPROVE</Text></Animated.View>
              <Animated.View style={[s.swipeStamp, { borderColor: C.err, right: 16, opacity: noOpacity }]}><Text style={[s.swipeStampT, { color: C.err }]}>DECLINE</Text></Animated.View>
              {current.photoUrl
                ? <Image source={{ uri: current.photoUrl }} style={s.swipePhoto} resizeMode="cover" />
                : <View style={[s.swipePhoto, { alignItems: "center", justifyContent: "center" }]}><Text style={s.note}>{t("no photo")}</Text></View>}
              <Text style={[s.lbName, { marginTop: 12 }]}>{current.name}</Text>
              <Text style={s.note}>{current.goalText} · {current.day}</Text>
            </Animated.View>
          </View>
          <View style={{ flexDirection: "row", gap: 14, marginTop: 16 }}>
            <View style={{ flex: 1 }}><BtnGhost label={t("Decline")} onPress={() => swipe("left")} /></View>
            <View style={{ flex: 1 }}><Btn label={t("Approve")} onPress={() => swipe("right")} /></View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 6 }}>
            <Ionicons name="swap-horizontal" size={16} color={C.faint} />
            <Text style={s.note}>{t("Swipe the photo · {n} left", { n: queue.length - idx })}</Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 26, marginTop: 14 }}>
            <TouchableOpacity onPress={reportProof} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Ionicons name="flag-outline" size={15} color={C.faint} />
              <Text style={s.note}>{t("Report")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={blockUser} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Ionicons name="ban-outline" size={15} color={C.faint} />
              <Text style={s.note}>{t("Block")}</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

/* ---------- little UI bits ---------- */
// Edge swipe-from-left to go back (iOS-style). Only claims a gesture that
// starts near the left edge and moves right, so it won't fight scrolling.
function SwipeBack({ onBack, children }) {
  const responder = PanResponder.create({
    onMoveShouldSetPanResponder: (e, g) => (e.nativeEvent.pageX - g.dx) < 44 && g.dx > 14 && g.dx > Math.abs(g.dy) * 1.4,
    onPanResponderRelease: (_, g) => { if (g.dx > 60) onBack(); },
  });
  return <View style={{ flex: 1 }} {...responder.panHandlers}>{children}</View>;
}
function BackBar({ onBack }) {
  return (
    <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.backBar}>
      <Ionicons name="chevron-back" size={22} color={C.ink} />
      <Text style={s.backText}>Back</Text>
    </TouchableOpacity>
  );
}
function Btn({ label, onPress, disabled, style }) {
  return <TouchableOpacity style={[s.btn, style, disabled && { opacity: 0.5 }]} onPress={onPress} disabled={disabled}><Text style={s.btnText}>{label}</Text></TouchableOpacity>;
}
/* Touchable that springs down slightly while pressed (tactile card feedback). */
function PressScale({ onPress, children, style, disabled }) {
  const v = useRef(new Animated.Value(1)).current;
  return (
    <TouchableOpacity activeOpacity={0.9} disabled={disabled} onPress={onPress}
      onPressIn={() => Animated.spring(v, { toValue: 0.97, friction: 6, useNativeDriver: true }).start()}
      onPressOut={() => Animated.spring(v, { toValue: 1, friction: 6, useNativeDriver: true }).start()}>
      <Animated.View style={[style, { transform: [{ scale: v }] }]}>{children}</Animated.View>
    </TouchableOpacity>
  );
}
/* Forfeit-style option card: icon + title + description + selected check. */
function OptionCard({ icon, title, desc, active, locked, onPress }) {
  return (
    <PressScale onPress={onPress} style={[s.optCard, active && s.optCardOn]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={[s.optIcon, active && { borderColor: C.bronze }]}>
          <Ionicons name={icon} size={20} color={active ? C.bronze : C.mute} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.buyTitle, { fontSize: 15 }, active && { color: C.bronze }]}>{title}{locked ? "  ·  PRO" : ""}</Text>
          {desc ? <Text style={[s.note, { textAlign: "left", marginTop: 2 }]}>{desc}</Text> : null}
        </View>
        <Ionicons name={active ? "checkmark-circle" : "ellipse-outline"} size={22} color={active ? C.bronze : C.line} />
      </View>
    </PressScale>
  );
}
function BtnGhost({ label, onPress, disabled, style }) {
  return <TouchableOpacity style={[s.btnGhost, style, disabled && { opacity: 0.5 }]} onPress={onPress} disabled={disabled}><Text style={s.btnGhostText}>{label}</Text></TouchableOpacity>;
}
/* Rounded segmented control (iOS-style tab switcher). options: [{value,label}]. */
function TabSwitch({ options, value, onChange }) {
  return (
    <View style={s.tabSwitch}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <TouchableOpacity key={o.value} style={[s.tabSwitchItem, on && s.tabSwitchItemOn]} onPress={() => onChange(o.value)} activeOpacity={0.85}>
            <Text style={[s.tabSwitchText, on && s.tabSwitchTextOn]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
/* ---------- SENTENCE BUILDER PARTS ----------
   Goal creation reads as one plain sentence; the changeable parts are inline
   bronze pills that open bottom-sheet pickers. One decision per tap. */
function SegPill({ label, onPress }) {
  return (
    <TouchableOpacity style={s.segPill} onPress={onPress} activeOpacity={0.75}>
      <Text style={s.segPillText} numberOfLines={1}>{label}</Text>
      <Ionicons name="chevron-down" size={13} color={C.bronze} />
    </TouchableOpacity>
  );
}
function OptionSheet({ visible, title, children, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ backgroundColor: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 34, borderTopWidth: 1, borderColor: C.line }}>
          <Text style={[s.h2, { marginBottom: 2 }]}>{title}</Text>
          {children}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

/* Proof-type picker as a collapsed dropdown — shows just the current choice
   until tapped, so the creation screen isn't a wall of cards. */
function ProofSelect({ value, onChange, isPro, onUpgrade, withGeo }) {
  const [open, setOpen] = useState(false);
  const meta = { photo: ["camera-outline", t("Photo")], timelapse: ["videocam-outline", t("Video")], geo: ["location-outline", t("Location")] };
  const [icon, label] = meta[value] || meta.photo;
  const pick = (v, locked) => { if (locked) { onUpgrade && onUpgrade(); return; } onChange(v); setOpen(false); };
  return (
    <>
      <TouchableOpacity style={s.dropdown} onPress={() => setOpen((o) => !o)} activeOpacity={0.8}>
        <Ionicons name={icon} size={20} color={C.bronze} />
        <Text style={s.dropdownText}>{label}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={C.mute} />
      </TouchableOpacity>
      {open ? (
        <View style={{ marginTop: 2 }}>
          <OptionCard icon="camera-outline" title={t("Photo")} desc={t("One quick photo.")} active={value === "photo"} onPress={() => pick("photo", false)} />
          <OptionCard icon="videocam-outline" title={t("Video")} locked={!isPro} desc={t("Short clip, AI-judged.")} active={value === "timelapse"} onPress={() => pick("timelapse", !isPro)} />
          {withGeo ? <OptionCard icon="location-outline" title={t("Location")} locked={!isPro} desc={t("Be at a place.")} active={value === "geo"} onPress={() => pick("geo", !isPro)} /> : null}
        </View>
      ) : null}
    </>
  );
}
/* Round avatar — photo if set, else the name's initial on a bronze circle. */
function Avatar({ uri, name, size = 38 }) {
  const initial = (String(name || "?").trim().charAt(0) || "?").toUpperCase();
  if (uri) return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.card }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: C.bronze, fontWeight: "800", fontSize: Math.round(size * 0.42) }}>{initial}</Text>
    </View>
  );
}
function Pill({ label, active, onPress }) {
  return <TouchableOpacity style={[s.pill, active && s.pillOn]} onPress={onPress}><Text style={[s.pillText, active && { color: C.ink }]}>{label}</Text></TouchableOpacity>;
}
// Reusable time-of-day picker. value/onChange use "HH:MM" (24h). Native dialog
// on Android, spinner-in-modal on iOS. allowClear shows a clear button (→ null).
// `trigger` (optional) replaces the default chip with a custom element — used by
// the sentence builder to render the field as an inline pill.
function TimeField({ value, onChange, allowClear, placeholder = "Pick a time", trigger }) {
  const [show, setShow] = useState(false);
  const [temp, setTemp] = useState(null);
  const base = () => { const d = new Date(); if (value) { const [h, m] = value.split(":"); d.setHours(+h, +m, 0, 0); } else { d.setHours(9, 0, 0, 0); } return d; };
  const fmt = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  function open() { setTemp(base()); setShow(true); }
  function onAndroid(e, d) { setShow(false); if (e.type === "set" && d) onChange(fmt(d)); }
  return (
    <View style={trigger ? null : { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 }}>
      {trigger ? trigger(open) : (
        <>
          <TouchableOpacity style={[s.chip, value && s.chipOn]} onPress={open}>
            <Text style={[s.chipText, value && { color: C.ink }]}>{value || placeholder}</Text>
          </TouchableOpacity>
          {allowClear && value ? <TouchableOpacity onPress={() => onChange(null)}><Text style={[s.note, { marginTop: 0 }]}>clear</Text></TouchableOpacity> : null}
        </>
      )}
      {show && Platform.OS === "android" ? (
        <DateTimePicker value={base()} mode="time" is24Hour display="clock" onChange={onAndroid} />
      ) : null}
      {Platform.OS === "ios" ? (
        <Modal visible={show} transparent animationType="fade" onRequestClose={() => setShow(false)}>
          <View style={s.modalWrap}>
            <View style={s.modalCard}>
              <DateTimePicker value={temp || base()} mode="time" is24Hour display="spinner" textColor={C.ink} themeVariant="dark" onChange={(e, d) => { if (d) setTemp(d); }} />
              <Btn label="Done" onPress={() => { if (temp) onChange(fmt(temp)); setShow(false); }} />
              {trigger && allowClear && value ? <BtnGhost label={placeholder} onPress={() => { onChange(null); setShow(false); }} /> : null}
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}
// Date + time picker. value/onChange use a Date (or null). Android chains a
// date dialog then a time dialog; iOS shows a single datetime spinner in a modal.
function DateTimeField({ value, onChange, placeholder = "Pick date & time", trigger }) {
  const [show, setShow] = useState(false);           // ios modal
  const [androidStep, setAndroidStep] = useState(null); // "date" | "time" | null
  const [temp, setTemp] = useState(null);
  const base = () => { if (value) return new Date(value); const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(23, 59, 0, 0); return d; };
  const fmt = (d) => d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function open() { setTemp(base()); if (Platform.OS === "android") setAndroidStep("date"); else setShow(true); }
  function onAndroidChange(e, d) {
    if (e.type !== "set" || !d) { setAndroidStep(null); return; }
    if (androidStep === "date") {
      const picked = new Date(temp || base()); picked.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
      setTemp(picked); setAndroidStep("time");
    } else {
      const picked = new Date(temp || base()); picked.setHours(d.getHours(), d.getMinutes(), 0, 0);
      setAndroidStep(null); onChange(picked);
    }
  }
  return (
    <View style={trigger ? null : { marginTop: 6 }}>
      {trigger ? trigger(open) : (
        <TouchableOpacity style={[s.chip, value && s.chipOn]} onPress={open}>
          <Text style={[s.chipText, value && { color: C.ink }]}>{value ? fmt(value) : placeholder}</Text>
        </TouchableOpacity>
      )}
      {Platform.OS === "android" && androidStep ? (
        <DateTimePicker value={temp || base()} mode={androidStep} is24Hour display="default" minimumDate={new Date()} onChange={onAndroidChange} />
      ) : null}
      {Platform.OS === "ios" ? (
        <Modal visible={show} transparent animationType="fade" onRequestClose={() => setShow(false)}>
          <View style={s.modalWrap}>
            <View style={s.modalCard}>
              <DateTimePicker value={temp || base()} mode="datetime" display="spinner" minimumDate={new Date()} textColor={C.ink} themeVariant="dark" onChange={(e, d) => { if (d) setTemp(d); }} />
              <Btn label="Done" onPress={() => { onChange(temp || base()); setShow(false); }} />
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}
function Center({ children }) { return <View style={[s.safe, { justifyContent: "center", alignItems: "center" }]}>{children}</View>; }

function makeStyles() { return StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  wrap: { padding: 20, paddingBottom: 60 },
  authWrap: { padding: 24, paddingTop: 80, paddingBottom: 60 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  rowGap: { flexDirection: "row", gap: 10, marginTop: 6, marginBottom: 4 },
  brand: { color: C.ink, fontSize: 22, fontWeight: "800", letterSpacing: 4 },
  // bronze, not red: on auth it sat between bronze lang chips and a red CTA —
  // three accents at once read as random coloring
  kickerRed: { color: C.bronze, fontSize: 11, letterSpacing: 1, marginBottom: 16, textTransform: "uppercase" },
  kicker: { color: C.mute, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" },
  h1: { color: C.ink, fontSize: 40, fontWeight: "800", lineHeight: 42 },
  h2: { color: C.ink, fontSize: 24, fontWeight: "800", marginTop: 8 },
  lede: { color: C.mute, fontSize: 15, lineHeight: 22, marginTop: 10, marginBottom: 18 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 18, marginTop: 14 },
  label: { color: C.mute, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 },
  input: { backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.inputLine, borderRadius: 10, color: C.ink, fontSize: 16, padding: 14 },
  note: { color: C.faint, fontSize: 12, marginTop: 12, textAlign: "center" },
  // Dark theme: solid red button. Light theme: a light cream button with a gold
  // border + dark-gold text (per request — a light button, not a filled block).
  btn: { backgroundColor: C.red, borderRadius: 10, padding: 16, marginTop: 16, alignItems: "center" },
  btnText: { color: "#ffffff", fontWeight: "800", fontSize: 15, letterSpacing: 1 },
  btnGhost: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 16, marginTop: 10, alignItems: "center" },
  btnGhostText: { color: C.ink, fontWeight: "700", fontSize: 14 },
  googleBtn: { backgroundColor: "#fff", borderRadius: 10, padding: 15, marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  googleText: { color: "#1f1f1f", fontWeight: "700", fontSize: 15 },
  orText: { color: C.faint, fontSize: 12, textAlign: "center", marginVertical: 14 },
  infoBanner: { color: C.bronze, backgroundColor: C.isDark ? "rgba(99,102,241,0.08)" : "rgba(79,70,229,0.10)", borderWidth: 1, borderColor: C.isDark ? "rgba(99,102,241,0.35)" : "rgba(79,70,229,0.35)", borderRadius: 10, padding: 12, fontSize: 13, lineHeight: 18 },
  switchAuth: { color: C.bronze, fontSize: 14, fontWeight: "600", textAlign: "center", marginTop: 20 },
  skipBtn: { borderWidth: 1, borderColor: C.bronze, borderRadius: 10, padding: 13, marginTop: 22, alignItems: "center" },
  skipText: { color: C.bronze, fontWeight: "700", fontSize: 14 },
  pill: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingVertical: 12, alignItems: "center" },
  // Selection is ALWAYS bronze (red is reserved for CTAs/destructive) — mixed
  // red/gold selected states in the wizards read as random coloring.
  pillOn: { borderColor: C.bronze, backgroundColor: C.isDark ? "rgba(99,102,241,0.12)" : "rgba(79,70,229,0.14)" },
  pillText: { color: C.mute, fontSize: 13 },
  streakNum: { color: C.bronze, fontSize: 56, fontWeight: "800", textAlign: "center" },
  goalText: { color: C.ink, fontSize: 15, lineHeight: 22, marginTop: 8 },
  spec: { color: C.bronze, fontSize: 12, lineHeight: 18, marginTop: 8 },
  modalWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: C.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, borderTopWidth: 1, borderColor: C.line },
  swipeCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 18, padding: 16, marginTop: 18 },
  swipePhoto: { width: "100%", height: 360, borderRadius: 12, backgroundColor: "#12151a" },
  swipeStamp: { position: "absolute", top: 28, zIndex: 2, borderWidth: 3, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, transform: [{ rotate: "-12deg" }] },
  swipeStampT: { fontSize: 22, fontWeight: "800", letterSpacing: 2 },
  historyHead: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 4, paddingVertical: 4 },
  swipeHint: { position: "absolute", zIndex: 0, alignItems: "center", gap: 2 },
  swipeHintT: { fontSize: 10, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  wheelBackdrop: { flex: 1, backgroundColor: "rgba(8,10,13,0.95)", alignItems: "center", justifyContent: "center", padding: 24 },
  wheelTitle: { color: C.ink, fontSize: 24, fontWeight: "800" },
  wheelSub: { color: C.err, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginTop: 6, marginBottom: 16, textAlign: "center" },
  wheelStage: { alignItems: "center", justifyContent: "center", paddingTop: 18 },
  wheelPointer: { position: "absolute", top: 0, zIndex: 5, width: 0, height: 0, borderLeftWidth: 13, borderRightWidth: 13, borderTopWidth: 24, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: C.ink },
  wheelResult: { marginTop: 20, borderWidth: 1, borderColor: C.err, borderRadius: 12, padding: 16, backgroundColor: C.card, maxWidth: 320 },
  wheelDare: { color: C.bronze, fontSize: 18, fontWeight: "800", textAlign: "center", lineHeight: 24, marginTop: 6 },
  backBar: { flexDirection: "row", alignItems: "center", gap: 2, marginBottom: 10, alignSelf: "flex-start", paddingVertical: 4, paddingRight: 8 },
  backText: { color: C.ink, fontSize: 15, fontWeight: "600" },
  avatar: { width: 92, height: 92, borderRadius: 46, borderWidth: 2, borderColor: C.bronze },
  avatarEmpty: { backgroundColor: C.bg, alignItems: "center", justifyContent: "center" },
  certRow: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.bronze, borderRadius: 12, padding: 14, marginBottom: 8 },
  certRowDays: { color: C.bronze, fontSize: 28, fontWeight: "800", minWidth: 44, textAlign: "center" },
  certRowTitle: { color: C.ink, fontSize: 15, fontWeight: "700" },
  certRowChevron: { color: C.faint, fontSize: 24 },
  // Cert artifact: fixed deep-indigo card (theme-independent — it's a shareable
  // image, so it must look the same everywhere).
  shareCard: { width: "100%", aspectRatio: 9 / 16, backgroundColor: "#1e1b4e", borderWidth: 2, borderColor: "#818cf8", borderRadius: 22, padding: 28, justifyContent: "space-between" },
  shareTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  shareLogo: { width: 30, height: 30 },
  shareLogoBig: { width: 72, height: 72, marginBottom: 14 },
  brandLogo: { width: 28, height: 28 },
  authLogo: { width: 72, height: 72, marginBottom: 18 },
  statsLink: { paddingVertical: 6, marginBottom: 6 },
  statsLinkText: { color: C.bronze, fontSize: 13, fontWeight: "700" },
  statRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  statBox: { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, alignItems: "center" },
  statNum: { color: C.bronze, fontSize: 26, fontWeight: "800" },
  statLabel: { color: C.mute, fontSize: 11, letterSpacing: 0.3, marginTop: 4, textAlign: "center" },
  trophy: { width: "31%", backgroundColor: C.card, borderWidth: 1, borderColor: C.bronze, borderRadius: 12, padding: 12, alignItems: "center" },
  trophyDays: { color: C.bronze, fontSize: 26, fontWeight: "800" },
  trophyLabel: { color: C.mute, fontSize: 11, marginTop: 2, textAlign: "center" },
  lbRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, marginTop: 8 },
  lbRank: { fontSize: 22, fontWeight: "800", minWidth: 34, textAlign: "center", color: C.ink },
  lbName: { color: C.ink, fontSize: 15, fontWeight: "700" },
  lbLast: { color: C.err, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  tabBar: { flexDirection: "row", borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card, paddingTop: 7 },
  tabItem: { flex: 1, alignItems: "center", gap: 3 },
  tabCreate: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.bronze, alignItems: "center", justifyContent: "center", marginTop: -22, borderWidth: 3, borderColor: C.card, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 5 },
  tabLabel: { fontSize: 10.5, color: C.faint, fontWeight: "700", letterSpacing: 0.3 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  chipOn: { borderColor: C.bronze, backgroundColor: C.isDark ? "rgba(99,102,241,0.14)" : "rgba(79,70,229,0.16)" },
  // sentence-builder: plain text + inline tappable pills (the only accent on the screen)
  sentenceText: { color: C.ink, fontSize: 17, lineHeight: 38, fontWeight: "600" },
  segPill: { flexDirection: "row", alignItems: "center", gap: 3, borderWidth: 1.5, borderColor: C.bronze, backgroundColor: C.isDark ? "rgba(99,102,241,0.10)" : "rgba(79,70,229,0.10)", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5, marginHorizontal: 2, marginVertical: 4, maxWidth: 240 },
  segPillText: { color: C.bronze, fontWeight: "700", fontSize: 15.5 },
  chipText: { color: C.mute, fontSize: 13 },
  freezePill: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: C.card },
  freezePillNum: { color: C.ink, fontWeight: "800", fontSize: 14 },
  langChip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  langChipOn: { backgroundColor: C.bronze, borderColor: C.bronze },
  langChipT: { color: C.mute, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  tabSwitch: { flexDirection: "row", backgroundColor: C.inputBg, borderRadius: 12, padding: 4, borderWidth: 1, borderColor: C.inputLine, marginTop: 8 },
  tabSwitchItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  tabSwitchItemOn: { backgroundColor: C.bronze },
  tabSwitchText: { color: C.mute, fontWeight: "800", fontSize: 14, letterSpacing: 0.3 },
  tabSwitchTextOn: { color: "#ffffff" },
  dropdown: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.inputLine, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, marginTop: 8 },
  dropdownText: { flex: 1, color: C.ink, fontSize: 15, fontWeight: "700" },
  optCard: { backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, borderRadius: 14, padding: 14, marginTop: 10 },
  optCardOn: { borderColor: C.bronze, backgroundColor: C.isDark ? "rgba(99,102,241,0.08)" : "rgba(154,122,28,0.08)" },
  optIcon: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center", backgroundColor: C.bg },
  buyCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 16, marginTop: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  buyCardOn: { borderColor: C.bronze },
  buyTitle: { color: C.ink, fontSize: 16, fontWeight: "800" },
  buyPrice: { color: C.bronze, fontSize: 16, fontWeight: "800" },
  buyBadge: { color: "#ffffff", backgroundColor: C.bronze, fontSize: 10, fontWeight: "800", letterSpacing: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  pwHero: { alignItems: "center", marginTop: 6, marginBottom: 4 },
  pwMark: { width: 64, height: 64, borderRadius: 20, borderWidth: 1, borderColor: C.bronze, alignItems: "center", justifyContent: "center", backgroundColor: C.card },
  pwGlow: { width: 118, height: 118, borderRadius: 59, borderWidth: 2, borderColor: C.bronze, alignItems: "center", justifyContent: "center", backgroundColor: C.card, shadowColor: "#6366f1", shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 0 }, elevation: 8 },
  pwStamp: { transform: [{ rotate: "-8deg" }], borderWidth: 3.5, borderColor: C.bronze, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 9, marginTop: 14, shadowColor: "#6366f1", shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 0 }, elevation: 6 },
  pwStampT: { color: C.bronze, fontSize: 28, fontWeight: "800", letterSpacing: 3 },
  proChip: { borderWidth: 2, borderColor: C.bronze, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 2, transform: [{ rotate: "-6deg" }] },
  proChipT: { color: C.bronze, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  planLine: { flexDirection: "row", alignItems: "center", backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, borderRadius: 14, padding: 14, marginTop: 10 },
  planLineOn: { borderColor: C.bronze, backgroundColor: C.isDark ? "rgba(99,102,241,0.08)" : "rgba(79,70,229,0.08)" },
  planLinePrice: { color: C.ink, fontSize: 17, fontWeight: "800", marginLeft: 8 },
  finePrint: { color: C.faint, fontSize: 10.5, lineHeight: 15, textAlign: "center", marginTop: 10, opacity: 0.85 },
  finePrintLink: { color: C.mute, fontSize: 12, textDecorationLine: "underline" },
  pwTitle: { color: C.ink, fontSize: 30, fontWeight: "800", textAlign: "center", marginTop: 12 },
  pwSub: { color: C.mute, fontSize: 14, textAlign: "center", marginTop: 6, lineHeight: 20, paddingHorizontal: 10 },
  planRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  plan: { flex: 1, borderWidth: 1.5, borderColor: C.line, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 12, alignItems: "center", backgroundColor: C.card },
  planOn: { borderColor: C.bronze, backgroundColor: C.isDark ? "rgba(99,102,241,0.10)" : "rgba(154,122,28,0.10)" },
  planName: { color: C.mute, fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  planPrice: { color: C.ink, fontSize: 22, fontWeight: "800", marginTop: 8 },
  planPer: { color: C.faint, fontSize: 12, marginTop: 3 },
  planSave: { color: "#ffffff", backgroundColor: C.bronze, fontSize: 10, fontWeight: "800", letterSpacing: 0.5, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, overflow: "hidden", marginTop: 10 },
  restore: { color: C.mute, fontSize: 13, fontWeight: "700", textAlign: "center", marginTop: 14, paddingVertical: 6 },
  // share-card text: fixed colors matched to the deep-indigo card above
  shareBrand: { color: "#ffffff", fontSize: 22, fontWeight: "800", letterSpacing: 5 },
  shareVerified: { color: "#a5b4fc", fontSize: 12, fontWeight: "800", letterSpacing: 1, borderWidth: 1, borderColor: "#a5b4fc", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  shareKicker: { color: "#a5b4fc", fontSize: 13, letterSpacing: 3, fontWeight: "700", marginBottom: 4 },
  shareDays: { color: "#ffffff", fontSize: 120, fontWeight: "800", lineHeight: 124 },
  shareDaysLabel: { color: "#c7d2fe", fontSize: 15, letterSpacing: 4, fontWeight: "700" },
  shareNotFaked: { color: "#a5b4fc", fontSize: 14, letterSpacing: 3, fontWeight: "800", marginTop: 14 },
  shareGoal: { color: "#ffffff", fontSize: 22, fontWeight: "800", lineHeight: 28, marginBottom: 12 },
  shareTagline: { color: "#8b93d8", fontSize: 13, lineHeight: 18 },
}); }
