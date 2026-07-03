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
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import * as WebBrowser from "expo-web-browser";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import * as Sharing from "expo-sharing";
import { captureRef } from "react-native-view-shot";
import { supabase } from "./lib/supabase";
import { getReminderPref, enableReminder, disableReminder, refreshReminderLanguage } from "./lib/reminders";
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

/* ---------- theme (Cert brand: bronze + red, dark default, light option) ----------
   C and s are module-level `let` bindings read live by every component on each
   render. Reassigning them + forcing the root to re-render repaints the whole
   tree — so a theme switch needs no per-component wiring. */
const DARK = {
  bg: "#070608", card: "#120f14", line: "#241f29",
  ink: "#f4efe8", mute: "#9a948d", faint: "#6f6a63",
  red: "#e23b2e", bronze: "#c9a227", green: "#34c759",
  inputBg: "#0d0c11", inputLine: "#2a2731", isDark: true,
};
const LIGHT = {
  bg: "#faf7f2", card: "#ffffff", line: "#e7e1d8",
  ink: "#1a1714", mute: "#6b655d", faint: "#a39c92",
  red: "#cf3327", bronze: "#9a7a1c", green: "#2e9e4f",
  inputBg: "#f3efe8", inputLine: "#ddd6cc", isDark: false,
};
let C = DARK;
const F = { display: "System", mono: "System" };

// theme preference: 'system' | 'dark' | 'light'
let _themePref = "system";
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

/* Streak milestones that mint a shareable badge. Keep in sync with the judge. */
const MILESTONES = [7, 30, 100];

/* Gladiator brand mark (transparent PNG). */
const LOGO = require("./assets/gladiator-logo.png");

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
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, place };
  } catch (_) { return null; }
}
async function getGeoTimed() { return Promise.race([getGeo(), new Promise((r) => setTimeout(() => r(null), 6000))]); }

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

  // restore saved theme + language preferences once at startup
  useEffect(() => {
    AsyncStorage.getItem("cert_theme").then((p) => { if (p) applyThemePref(p); }).catch(() => {});
    initLang();
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setBooting(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
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
        {booting ? <Center><ActivityIndicator color={C.bronze} /></Center>
          : (session && recovery) ? <SetNewPassword onDone={() => setRecovery(false)} />
          : session ? <Main session={session} /> : <Auth />}
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
/* ---------- ONBOARDING (first-run how-it-works) ---------- */
const ONBOARD_STEPS = [
  ["flag-outline", "Set a goal", "Pick something you'll prove every single day."],
  ["camera-outline", "Send a daily photo", "Snap proof of what you actually did today."],
  ["shield-checkmark-outline", "The AI judge decides", "Approved or not — you can't fake a tap."],
  ["flame-outline", "Keep your streak", "A streak that's genuinely verified, so it means something."],
];
function Onboarding({ onDone }) {
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 40 }]}>
      <View style={{ alignItems: "center", marginTop: 16 }}>
        <Image source={LOGO} style={s.authLogo} resizeMode="contain" />
        <Text style={s.h2}>{t("How Cert works")}</Text>
      </View>
      <View style={{ gap: 16, marginTop: 22 }}>
        {ONBOARD_STEPS.map(([icon, title, desc]) => (
          <View key={title} style={{ flexDirection: "row", gap: 14, alignItems: "flex-start" }}>
            <View style={{ width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center", backgroundColor: C.card }}>
              <Ionicons name={icon} size={20} color={C.bronze} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.buyTitle}>{t(title)}</Text>
              <Text style={[s.note, { textAlign: "left", marginTop: 3 }]}>{t(desc)}</Text>
            </View>
          </View>
        ))}
      </View>
      <Btn label={t("Get started")} onPress={onDone} />
    </ScrollView>
  );
}

function Main({ session }) {
  const [tab, setTab] = useState("home"); // home | challenges | stats | profile
  const [screen, setScreen] = useState(null); // overlay: new|submit|cert|badge|challengeNew|challengeJoin|challengeDetail
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
  const [intro, setIntro] = useState(null); // null=loading | "onboarding" | "paywall" | "done"

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

  // ----- overlay screens (full screen, own back + swipe-from-left to go back) -----
  if (screen === "new") { const back = () => setScreen(null); return <SwipeBack onBack={back}><NewGoal session={session} isPro={isPro} onUpgrade={() => setScreen("paywall")} onDone={async () => { await load(); setScreen(null); }} onBack={back} /></SwipeBack>; }
  if (screen === "paywall") { const back = () => setScreen(null); return <SwipeBack onBack={back}><Paywall isPro={isPro} freezes={freezes} onDone={async () => { await load(); }} onBack={back} /></SwipeBack>; }
  if (screen === "submit" && active) { const back = () => { setScreen(submitReturn); setSubmitReturn(null); }; return <SwipeBack onBack={back}><Submit goal={active} onDone={async () => { await load(); setScreen(submitReturn); setSubmitReturn(null); }} onViewBadge={openBadge} onBack={back} /></SwipeBack>; }
  if (screen === "challengeNew") { const back = () => setScreen(null); return <SwipeBack onBack={back}><CreateChallenge isPro={isPro} onUpgrade={() => setScreen("paywall")} onCreated={(id) => { setActiveChallenge(id); setScreen("challengeDetail"); }} onBack={back} /></SwipeBack>; }
  if (screen === "challengeJoin") { const back = () => { setJoinCode(""); setScreen(null); }; return <SwipeBack onBack={back}><JoinChallenge initialCode={joinCode} onJoined={(id) => { setJoinCode(""); setActiveChallenge(id); setScreen("challengeDetail"); }} onBack={back} /></SwipeBack>; }
  if (screen === "challengeDetail" && activeChallenge) { const back = () => setScreen(null); return <SwipeBack onBack={back}><ChallengeDetail challengeId={activeChallenge} onSubmitProof={(g) => { setActive(g); setSubmitReturn("challengeDetail"); setScreen("submit"); }} onReview={() => setScreen("review")} onSharePlacement={(rank, title) => { setActivePlacement({ rank, title }); setScreen("placement"); }} onBack={back} /></SwipeBack>; }
  if (screen === "review") return <SwipeReview onBack={() => setScreen("challengeDetail")} />;
  if (screen === "placement" && activePlacement) { const back = () => setScreen("challengeDetail"); return <SwipeBack onBack={back}><ShareScreen kind="placement" rank={activePlacement.rank} title={activePlacement.title} onBack={back} /></SwipeBack>; }
  if (screen === "settings") { const back = () => setScreen(null); return <SwipeBack onBack={back}><SettingsScreen session={session} onBack={back} /></SwipeBack>; }
  if (screen === "cert" && activeCert) { const back = () => setScreen(null); return <SwipeBack onBack={back}><ShareScreen kind="cert" days={activeCert.days} title={activeCert.title} subtitle={activeCert.issued_at ? "Earned " + new Date(activeCert.issued_at).toLocaleDateString() : null} onBack={back} /></SwipeBack>; }
  if (screen === "badge" && activeBadge) { const back = () => setScreen(null); return <SwipeBack onBack={back}><ShareScreen kind="milestone" days={activeBadge.days} title={activeBadge.title} onBack={back} /></SwipeBack>; }
  if (screen === "reel" && activeReelGoal) { const back = () => setScreen(null); return <SwipeBack onBack={back}><Reel goal={activeReelGoal} onBack={back} /></SwipeBack>; }

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
            freezes={freezes} onBuyFreezes={() => setScreen("paywall")}
            onNew={() => setScreen("new")} onSubmit={(g) => { setActive(g); setSubmitReturn(null); setScreen("submit"); }} onOpenCert={openCert} onReel={openReel} />
        )}
        {tab === "challenges" && (
          <ChallengesScreen onOpen={(id) => { setActiveChallenge(id); setScreen("challengeDetail"); }}
            onCreate={() => setScreen("challengeNew")} onJoin={() => setScreen("challengeJoin")} />
        )}
        {tab === "stats" && <Stats goals={goals || []} subs={subs} onOpenBadge={openBadge} isPro={isPro} onUpgrade={() => setScreen("paywall")} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === "profile" && <ProfileTab session={session} goals={goals || []} certs={certs} subs={subs} freezes={freezes} onOpenCert={openCert} onOpenSettings={() => setScreen("settings")} onUpgrade={() => setScreen("paywall")} onReload={load} refreshing={refreshing} onRefresh={onRefresh} />}
      </View>
      <TabBar tab={tab} setTab={setTab} />
    </View>
  );
}

function TabBar({ tab, setTab }) {
  const insets = useSafeAreaInsets();
  const items = [
    ["home", "home", "home-outline", "Home"],
    ["challenges", "flame", "flame-outline", "Versus"],
    ["stats", "stats-chart", "stats-chart-outline", "Stats"],
    ["profile", "person", "person-outline", "Profile"],
  ];
  return (
    <View style={[s.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {items.map(([key, iconOn, iconOff, label]) => {
        const on = tab === key;
        return (
          <TouchableOpacity key={key} style={s.tabItem} onPress={() => setTab(key)} activeOpacity={0.7}>
            <Ionicons name={on ? iconOn : iconOff} size={22} color={on ? C.bronze : C.faint} />
            <Text style={[s.tabLabel, on && { color: C.bronze }]}>{t(label)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function HomeTab({ goals, certs, subs, refreshing, onRefresh, freezes = 0, onBuyFreezes, onNew, onSubmit, onOpenCert, onReel }) {
  const [showDone, setShowDone] = useState(false);
  const myGoals = (goals || []).filter((g) => !g.challenge_id); // challenge goals live under Versus
  const activeGoals = myGoals.filter((g) => g.status !== "completed");
  const doneGoals = myGoals.filter((g) => g.status === "completed");
  const subsByGoal = {};
  for (const x of subs || []) { (subsByGoal[x.goal_id] = subsByGoal[x.goal_id] || []).push(x); }
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
          <Text style={[s.kicker, { color: C.bronze, marginBottom: 8 }]}>🏅 {t("Your Certs")} · {certs.length}</Text>
          {certs.map((c) => (
            <TouchableOpacity key={c.id} style={s.certRow} onPress={() => onOpenCert(c)}>
              <Text style={s.certRowDays}>{c.days}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.certRowTitle} numberOfLines={1}>{c.title}</Text>
                <Text style={s.note}>{t("verified days · tap to share")}</Text>
              </View>
              <Text style={s.certRowChevron}>›</Text>
            </TouchableOpacity>
          ))}
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
            <GoalCard key={g.id} goal={g} subs={subsByGoal[g.id] || []} onSubmit={() => onSubmit(g)} onReel={() => onReel(g)}
              onOpenCert={() => { const c = certs.find((x) => x.goal_id === g.id); if (c) onOpenCert(c); }} />
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
                  onOpenCert={() => { const c = certs.find((x) => x.goal_id === g.id); if (c) onOpenCert(c); }} />
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
function buyFreezeFlow(onReload) {
  if (!purchasesEnabled()) {
    Alert.alert("Cert", t("Payments aren't configured yet (add your RevenueCat key in config.js)."));
    return;
  }
  const labels = { freeze_pack_3: t("3 freezes"), freeze_pack_10: t("10 freezes") };
  const buttons = FREEZE_PACK_PRODUCTS.map((id) => ({ text: labels[id] || id, onPress: () => purchaseFlow(id, onReload) }));
  buttons.push({ text: t("Cancel"), style: "cancel" });
  Alert.alert(t("Buy streak freezes"), t("A freeze protects a missed day. Pick a pack:"), buttons);
}

const PRO_FEATURES = [
  ["infinite", "Multiple goals at once"],
  ["videocam", "Timelapse proof — much harder to fake"],
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

  const NAMES = { cert_pro_monthly: t("Monthly"), cert_pro_yearly: t("Yearly"), freeze_pack_3: t("3 freezes"), freeze_pack_10: t("10 freezes") };
  const PER = { cert_pro_monthly: t("per month"), cert_pro_yearly: t("per year") };
  const buy = (id) => purchaseFlow(id, onDone);
  const pro = products?.pro || [];
  const packs = products?.freezePacks || [];
  const nameOf = (p) => NAMES[p.identifier] || p.title || p.identifier;
  const monthly = pro.find((p) => p.identifier === "cert_pro_monthly");
  const yearly = pro.find((p) => p.identifier === "cert_pro_yearly");
  let savePct = null;
  if (monthly?.price && yearly?.price) { const v = Math.round((1 - yearly.price / (monthly.price * 12)) * 100); if (v > 0) savePct = v; }
  const selProduct = pro.find((p) => p.identifier === selected);

  async function doRestore() {
    setRestoring(true);
    try { await restorePurchases(); setTimeout(() => onDone && onDone(), 1500); }
    catch (e) { Alert.alert("Cert", (e && e.message) || t("Nothing to restore.")); }
    finally { setRestoring(false); }
  }

  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 60 }]}>
      <BackBar onBack={onBack} />

      {/* Hero header */}
      <View style={s.pwHero}>
        <View style={s.pwMark}><Ionicons name="shield-checkmark" size={34} color={C.bronze} /></View>
        <Text style={s.pwTitle}>{t("Cert Pro")}</Text>
        <Text style={s.pwSub}>{t("Everything you need for a streak nobody can fake.")}</Text>
      </View>

      {/* Current freeze balance */}
      <View style={[s.freezePill, { alignSelf: "center", marginTop: 12 }]}>
        <Ionicons name="snow-outline" size={16} color={C.bronze} />
        <Text style={s.freezePillNum}>{t("You have {n} freezes", { n: freezes })}</Text>
      </View>

      {/* Feature list */}
      <View style={[s.card, { gap: 12, marginTop: 16 }]}>
        {PRO_FEATURES.map(([icon, f]) => (
          <View key={f} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Ionicons name={icon} size={20} color={C.bronze} />
            <Text style={[s.goalText, { marginTop: 0, flex: 1 }]}>{t(f)}</Text>
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
          {/* Pricing grid */}
          <Text style={[s.kicker, { marginTop: 22, marginBottom: 2 }]}>{t("Choose your plan")}</Text>
          <View style={s.planRow}>
            {pro.map((p) => {
              const on = p.identifier === selected;
              const best = p.identifier === "cert_pro_yearly";
              return (
                <TouchableOpacity key={p.identifier} activeOpacity={0.85} onPress={() => setSelected(p.identifier)} style={[s.plan, on && s.planOn]}>
                  <Text style={[s.planName, on && { color: C.bronze }]}>{nameOf(p)}</Text>
                  <Text style={s.planPrice}>{p.priceString}</Text>
                  <Text style={s.planPer}>{PER[p.identifier] || ""}</Text>
                  {best && savePct ? <Text style={s.planSave}>{t("SAVE {n}%", { n: savePct })}</Text> : null}
                </TouchableOpacity>
              );
            })}
          </View>

          <Btn label={selProduct ? `${t("Continue")}  ·  ${selProduct.priceString}` : t("Continue")} onPress={() => selected && buy(selected)} disabled={!selected} />
          <TouchableOpacity onPress={doRestore} disabled={restoring}>
            <Text style={s.restore}>{restoring ? t("Restoring…") : t("Restore purchases")}</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Freeze packs — for everyone, Pro or Free */}
      {enabled && packs.length > 0 ? (
        <>
          <Text style={[s.kicker, { marginTop: 24 }]}>{t("Streak freezes")}</Text>
          <Text style={s.note}>{t("A freeze auto-protects a missed day. Stock up before a busy stretch.")}</Text>
          {packs.map((p) => (
            <TouchableOpacity key={p.identifier} activeOpacity={0.85} onPress={() => buy(p.identifier)} style={s.buyCard}>
              <Ionicons name="snow" size={22} color={C.bronze} />
              <Text style={[s.buyTitle, { flex: 1 }]}>{nameOf(p)}</Text>
              <Text style={s.buyPrice}>{p.priceString || ""}</Text>
            </TouchableOpacity>
          ))}
        </>
      ) : null}

      <Text style={[s.note, { textAlign: "center", marginTop: 18 }]}>{t("Cert Pro is an auto-renewing subscription that renews at the price shown for the same period, unless cancelled at least 24 hours before the period ends. Manage or cancel anytime in your store account.")}</Text>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 22, marginTop: 10 }}>
        <TouchableOpacity onPress={() => Linking.openURL("https://www.certapp.pro/terms.html")}>
          <Text style={{ color: C.bronze, fontSize: 12, textDecorationLine: "underline" }}>{t("Terms of Use")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL("https://www.certapp.pro/privacy.html")}>
          <Text style={{ color: C.bronze, fontSize: 12, textDecorationLine: "underline" }}>{t("Privacy Policy")}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function ProfileTab({ session, goals, certs, subs, freezes = 0, onOpenCert, onOpenSettings, onUpgrade, onReload, refreshing, onRefresh }) {
  const [profile, setProfile] = useState(null);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(null);
  const [saving, setSaving] = useState(false);
  const loadProfile = useCallback(() => {
    supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => { setProfile(data); setName(data?.name || ""); setAvatar(data?.avatar_url || null); });
  }, [session.user.id]);
  useEffect(() => { loadProfile(); }, [loadProfile]);
  const handleRefresh = async () => { loadProfile(); if (onRefresh) await onRefresh(); };
  const st = computeStats(goals, subs);
  const plan = profile?.plan === "monthly" || profile?.plan === "yearly" ? "Pro" : "Free";

  async function save() {
    setSaving(true);
    const { error } = await supabase.from("profiles").update({ name: name.trim() }).eq("id", session.user.id);
    if (!error) _cachedName = name.trim(); // keep challenge screens in sync
    setSaving(false);
    Alert.alert("Cert", error ? error.message : t("Saved."));
  }

  async function pickAvatar() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert("Cert", "Photo permission needed.");
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.3, base64: true });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    const a = res.assets[0];
    const uri = `data:${a.mimeType || "image/jpeg"};base64,${a.base64}`;
    setAvatar(uri);
    const { error } = await supabase.from("profiles").update({ avatar_url: uri }).eq("id", session.user.id);
    if (error) Alert.alert("Cert", error.message);
  }

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
      <View style={[s.card, { alignItems: "center" }]}>
        <TouchableOpacity onPress={pickAvatar} activeOpacity={0.8} style={{ alignItems: "center" }}>
          {avatar
            ? <Image source={{ uri: avatar }} style={s.avatar} />
            : <View style={[s.avatar, s.avatarEmpty]}><Image source={LOGO} style={{ width: 46, height: 46 }} resizeMode="contain" /></View>}
          <Text style={[s.note, { textAlign: "center", marginTop: 6 }]}>{t("tap to change photo")}</Text>
        </TouchableOpacity>
        <Text style={[s.kicker, { marginTop: 6 }]}>{t("PLAN")} · {plan}</Text>
      </View>

      <Text style={[s.label, { marginTop: 16 }]}>{t("Display name")}</Text>
      <TextInput style={s.input} placeholder={t("Your name")} placeholderTextColor={C.faint} value={name} onChangeText={setName} />
      <Btn label={saving ? t("Saving…") : t("Save name")} onPress={save} disabled={saving} />

      <View style={s.statRow}>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.verifiedTotal}</Text><Text style={s.statLabel}>{t("verified days")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.bestStreak}</Text><Text style={s.statLabel}>{t("best streak")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{certs.length}</Text><Text style={s.statLabel}>{t("certs")}</Text></View>
      </View>

      {/* Streak freeze — protects a missed day. Anyone can buy a pack, Pro or free. */}
      <View style={[s.card, { marginTop: 16 }]}>
        <View style={s.rowBetween}>
          <Text style={s.kicker}>{t("🧊 Streak freezes")}</Text>
          <Text style={[s.statNum, { fontSize: 22 }]}>{freezes}</Text>
        </View>
        <Text style={[s.note, { marginTop: 4 }]}>{t("A freeze auto-protects a missed day so your streak survives. Used automatically by the nightly check.")}</Text>
        <Btn label={t("Buy freezes")} onPress={onUpgrade} />
      </View>

      {plan !== "Pro" ? (
        <TouchableOpacity style={[s.card, { marginTop: 12, alignItems: "center", gap: 4 }]} activeOpacity={0.85} onPress={onUpgrade}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name="flash" size={16} color={C.bronze} />
            <Text style={[s.kicker, { color: C.bronze }]}>{t("Upgrade to Pro")}</Text>
          </View>
          <Text style={[s.note, { textAlign: "center" }]}>{t("Multiple goals, timelapse proof, analytics, and monthly freezes.")}</Text>
        </TouchableOpacity>
      ) : null}

      {certs.length > 0 ? (
        <>
          <Text style={[s.kicker, { color: C.bronze, marginTop: 20, marginBottom: 8 }]}>🏅 {t("Your Certs")}</Text>
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
    <ScrollView contentContainerStyle={s.wrap}>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Settings")}</Text>

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

      <BtnGhost label={t("Log out")} onPress={() => supabase.auth.signOut()} disabled={busy} />
      <TouchableOpacity onPress={deleteAccount} disabled={busy} style={{ marginTop: 10, paddingVertical: 12, alignItems: "center" }}>
        <Text style={{ color: C.red, fontWeight: "700", fontSize: 14 }}>{busy ? "…" : t("Delete account")}</Text>
      </TouchableOpacity>
      <Text style={[s.note, { textAlign: "center", marginTop: 16 }]}>Cert · v1.0 — {t("[ the streak you can't fake ]")}</Text>
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
function GoalCard({ goal, subs, onSubmit, onOpenCert, onReel }) {
  const completed = goal.status === "completed";
  const isWeekly = goal.type === "recurring" && (goal.format === "3x" || goal.format === "5x" || goal.format === "custom");
  const isRecurring = goal.type === "recurring";
  const verifiedCount = (subs || []).filter((x) => x.status === "approved" || x.status === "frozen").length;
  return (
    <View style={s.card}>
      <Text style={s.streakNum}>{goal.streak}</Text>
      <Text style={s.kicker}>{isWeekly ? t("week streak · verified by the judge") : t("day streak · verified by the judge")}</Text>
      <Text style={s.goalText}>{goal.text}</Text>
      <Text style={[s.spec, { color: C.mute }]}>{goalCadence(goal)}</Text>
      {proofSpec(goal) ? <Text style={s.spec}>{proofSpec(goal)}</Text> : null}
      {isRecurring ? <StreakCalendar subs={subs} /> : null}
      {isRecurring && !completed ? <MilestoneBar streak={goal.streak || 0} /> : null}
      {completed
        ? <TouchableOpacity onPress={onOpenCert}><Text style={[s.kicker, { color: C.bronze, marginTop: 12 }]}>{t("Completed — view & share Cert")} ›</Text></TouchableOpacity>
        : <Btn label={t("Submit today's proof")} onPress={onSubmit} />}
      {verifiedCount >= 2 ? <BtnGhost label={t("Progress reel") + ` · ${verifiedCount} ` + t("days")} onPress={onReel} /> : null}
    </View>
  );
}

/* Last 5 weeks of verified days as a grid (recent streak at a glance). */
function StreakCalendar({ subs }) {
  const done = new Set((subs || []).filter((x) => x.status === "approved" || x.status === "frozen").map((x) => x.day));
  const today = new Date();
  const cells = [];
  for (let i = 34; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); cells.push({ key: isoDateParts(d).date, on: done.has(isoDateParts(d).date), isToday: i === 0 }); }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, width: 7 * 18, marginTop: 14 }}>
      {cells.map((c) => (
        <View key={c.key} style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: c.on ? C.green : "#1c1822", borderWidth: c.isToday ? 1.5 : 0, borderColor: C.bronze }} />
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
  return (
    <View style={{ marginTop: 14 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <Text style={s.note}>{t("{n} days to your {b}-day badge", { n: left, b: next })}</Text>
        <Text style={s.note}>{streak}/{next}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: "#1c1822", overflow: "hidden" }}>
        <View style={{ height: 6, width: (pct * 100) + "%", backgroundColor: C.bronze }} />
      </View>
    </View>
  );
}

/* ---------- TIMELAPSE REEL (flip-through of a goal's verified proofs) ---------- */
function Reel({ goal, onBack }) {
  const [photos, setPhotos] = useState(null); // null=loading · []=none · [{day,url}]
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("submissions").select("day,photo_path,status")
        .eq("goal_id", goal.id).in("status", ["approved", "frozen"]).order("day", { ascending: true });
      const rows = (data || []).filter((r) => r.photo_path);
      const out = [];
      for (const r of rows) {
        const { data: signed } = await supabase.storage.from("proofs").createSignedUrl(r.photo_path, 3600);
        if (signed?.signedUrl) out.push({ day: r.day, url: signed.signedUrl });
      }
      if (alive) { setPhotos(out); setIdx(0); }
    })();
    return () => { alive = false; };
  }, [goal.id]);
  useEffect(() => {
    if (!playing || !photos || photos.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % photos.length), 650);
    return () => clearInterval(t);
  }, [playing, photos]);
  async function share() {
    try { await Share.share({ message: `My Cert timelapse — "${goal.text}": ${(photos || []).length} days, each one verified by AI. The streak you can't fake.` }); } catch (_) { /* */ }
  }
  if (photos === null) return <Center><ActivityIndicator color={C.bronze} /></Center>;
  const cur = photos[idx];
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Progress reel")}</Text>
      <Text style={s.lede} numberOfLines={2}>{goal.text}</Text>
      {photos.length === 0 ? (
        <View style={[s.card, { alignItems: "center", marginTop: 16 }]}>
          <Text style={s.h2}>{t("No reel yet")}</Text>
          <Text style={[s.lede, { textAlign: "center" }]}>{t("Verify a few days with photos and your timelapse builds itself.")}</Text>
        </View>
      ) : (
        <>
          <TouchableOpacity activeOpacity={0.95} onPress={() => setPlaying((p) => !p)}>
            <Image source={{ uri: cur.url }} style={{ width: "100%", aspectRatio: 1, borderRadius: 16, backgroundColor: "#0d0c11", marginTop: 8 }} resizeMode="cover" />
          </TouchableOpacity>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: "#1c1822", overflow: "hidden", marginTop: 12 }}>
            <View style={{ height: 4, width: ((idx + 1) / photos.length * 100) + "%", backgroundColor: C.red }} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
            <Text style={s.note}>{t("Day")} {idx + 1} / {photos.length}</Text>
            <Text style={s.note}>{cur.day}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 14 }}>
            <View style={{ flex: 1 }}><BtnGhost label={playing ? t("Pause") : t("Play")} onPress={() => setPlaying((p) => !p)} /></View>
            <View style={{ flex: 1 }}><Btn label={t("Share")} onPress={share} /></View>
          </View>
          <Text style={[s.note, { textAlign: "center", marginTop: 14 }]}>{t("Save as a video file — coming with the app build.")}</Text>
        </>
      )}
    </ScrollView>
  );
}

/* ---------- NEW GOAL ---------- */
const WEEKDAYS = [["Mon", 0], ["Tue", 1], ["Wed", 2], ["Thu", 3], ["Fri", 4], ["Sat", 5], ["Sun", 6]];
function NewGoal({ session, isPro, onUpgrade, onDone, onBack }) {
  const [text, setText] = useState("");
  const [type, setType] = useState("recurring"); // recurring | one_time
  const [format, setFormat] = useState("daily");  // daily | 3x | 5x | custom
  const [customDays, setCustomDays] = useState([]); // 0=Mon..6=Sun
  const [duration, setDuration] = useState(null);   // null=ongoing, or 7/30/100 (daily only)
  const [deadline, setDeadline] = useState(null);  // "HH:MM" or null
  const [oneTimeDeadline, setOneTimeDeadline] = useState(null); // Date|null, for one_time goals
  const [proofType, setProofType] = useState("photo"); // 'photo' | 'timelapse'
  const [busy, setBusy] = useState(false);
  const toggleDay = (d) => setCustomDays((arr) => arr.includes(d) ? arr.filter((x) => x !== d) : [...arr, d].sort());

  async function create() {
    if (text.trim().length < 3) return Alert.alert("Cert", t("Describe your goal first."));
    if (type === "recurring" && format === "custom" && customDays.length === 0) return Alert.alert("Cert", t("Pick at least one day."));
    if (type === "one_time" && !oneTimeDeadline) return Alert.alert("Cert", t("Pick a deadline date & time."));
    setBusy(true);
    try {
      let spec = { en: null, ru: null };
      try {
        const { data } = await supabase.functions.invoke("proof-spec", { body: { goal: text.trim() } });
        if (data && (data.en || data.ru)) spec = data;
      } catch (_) { /* ignore — spec is optional */ }

      const recurring = type === "recurring";
      const ot = !recurring && oneTimeDeadline ? isoDateParts(oneTimeDeadline) : null;
      const { error } = await supabase.from("goals").insert({
        user_id: session.user.id,
        text: text.trim(),
        category: "other",
        type,
        format: recurring ? format : null,
        custom_days: recurring && format === "custom" ? customDays : [],
        duration_days: recurring && format === "daily" ? duration : null,
        deadline: ot ? ot.date : null,            // one_time: deadline date
        daily_deadline: recurring ? deadline : (ot ? ot.time : null), // recurring: time-of-day · one_time: deadline time
        proof_type: proofType,                    // 'photo' | 'timelapse'
        proof_spec_en: spec.en,
        proof_spec_ru: spec.ru,
      });
      if (error) throw error;
      onDone();
    } catch (e) {
      Alert.alert("Cert", e.message || t("Could not create goal."));
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("What will you prove?")}</Text>
      <Text style={s.lede}>{t("Write it in your own words. The AI judge reads exactly this.")}</Text>
      <TextInput style={[s.input, { height: 90, textAlignVertical: "top" }]} multiline blurOnSubmit returnKeyType="done"
        placeholder={t("e.g. Wake up and send a photo, or gym 45 min")} placeholderTextColor={C.faint}
        value={text} onChangeText={(val) => setText(val.replace(/\n/g, " "))} />

      <Text style={[s.label, { marginTop: 14 }]}>{t("How do you prove it?")}</Text>
      <View style={s.rowGap}>
        <Pill label={t("📷 Quick photo")} active={proofType === "photo"} onPress={() => setProofType("photo")} />
        <Pill label={isPro ? t("🎥 Timelapse") : t("🎥 Timelapse 🔒")} active={proofType === "timelapse"}
          onPress={() => { if (isPro) setProofType("timelapse"); else onUpgrade && onUpgrade(); }} />
      </View>
      <Text style={s.note}>{proofType === "timelapse" ? t("Record your session — the app captures frames over time and the AI judges the whole thing. Much harder to fake.") : (isPro ? t("Snap one photo. Fast, good for things a single shot can prove.") : t("Snap one photo. Timelapse proof is a Pro feature."))}</Text>

      <Text style={[s.label, { marginTop: 14 }]}>{t("Type")}</Text>
      <View style={s.rowGap}>
        <Pill label={t("Repeating")} active={type === "recurring"} onPress={() => setType("recurring")} />
        <Pill label={t("One-time")} active={type === "one_time"} onPress={() => setType("one_time")} />
      </View>

      {type === "recurring" ? (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>{t("How often?")}</Text>
          <View style={s.chipRow}>
            {[["daily", t("Daily")], ["3x", t("3×/wk")], ["5x", t("5×/wk")], ["custom", t("Custom days")]].map(([v, label]) => (
              <TouchableOpacity key={v} style={[s.chip, format === v && s.chipOn]} onPress={() => setFormat(v)}>
                <Text style={[s.chipText, format === v && { color: C.ink }]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {format === "custom" ? (
            <>
              <Text style={[s.label, { marginTop: 14 }]}>{t("Which days?")}</Text>
              <View style={s.chipRow}>
                {WEEKDAYS.map(([label, d]) => (
                  <TouchableOpacity key={d} style={[s.chip, customDays.includes(d) && s.chipOn]} onPress={() => toggleDay(d)}>
                    <Text style={[s.chipText, customDays.includes(d) && { color: C.ink }]}>{t(label)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}

          {format === "daily" ? (
            <>
              <Text style={[s.label, { marginTop: 14 }]}>{t("Duration")}</Text>
              <View style={s.rowGap}>
                {[[null, t("Ongoing")], [7, t("7 days")], [30, t("30 days")], [100, t("100 days")]].map(([v, label]) => (
                  <Pill key={label} label={label} active={duration === v} onPress={() => setDuration(v)} />
                ))}
              </View>
              <Text style={s.note}>{t("Reach the target to complete the goal and earn a Cert.")}</Text>
            </>
          ) : null}

          <Text style={[s.label, { marginTop: 14 }]}>{t("Deadline (must submit before)")}</Text>
          <TimeField value={deadline} onChange={setDeadline} allowClear placeholder={t("No deadline")} />
          <Text style={s.note}>{t("Pick any time. Proof after it won't count for the day. Judged in your local time.")}</Text>
        </>
      ) : (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>{t("Deadline (date & time)")}</Text>
          <DateTimeField value={oneTimeDeadline} onChange={setOneTimeDeadline} placeholder={t("Pick deadline")} />
          <Text style={s.note}>{t("Submit your proof before this. One photo, judged once.")}</Text>
        </>
      )}

      <Btn label={busy ? t("Creating…") : t("Start the streak")} onPress={create} disabled={busy} />
    </ScrollView>
  );
}

/* ---------- TIMELAPSE CAPTURE (snaps frames over the session for the AI) ---------- */
const TL_INTERVAL_MS = 3500;  // a frame every ~3.5s
const TL_MAX_FRAMES = 12;     // hard cap — recording auto-stops here (bounds AI cost + payload)
const TL_MIN_FRAMES = 3;      // enough to show it is a real session
function TimelapseCapture({ onCancel, onDone }) {
  const [perm, requestPerm] = useCameraPermissions();
  const camRef = useRef(null);
  const [recording, setRecording] = useState(false);
  const [frames, setFrames] = useState([]);
  const timer = useRef(null);
  const countRef = useRef(0);
  const stopRef = useRef(() => {});

  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) requestPerm(); }, [perm]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  async function snap() {
    try {
      const p = await camRef.current?.takePictureAsync({ base64: true, quality: 0.3, skipProcessing: true, imageType: "jpg" });
      if (p?.base64) setFrames((f) => (f.length >= TL_MAX_FRAMES ? f : [...f, `data:image/jpeg;base64,${p.base64}`]));
    } catch (_) { /* skip a dropped frame */ }
  }
  function stop() {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    setRecording(false);
  }
  stopRef.current = stop;
  function start() {
    setFrames([]); countRef.current = 0; setRecording(true);
    const tick = async () => {
      if (countRef.current >= TL_MAX_FRAMES) { stopRef.current(); return; }
      countRef.current += 1;
      await snap();
    };
    tick();
    timer.current = setInterval(tick, TL_INTERVAL_MS);
  }

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
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView ref={camRef} style={{ flex: 1 }} facing="back" />
      {/* overlay */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, padding: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <TouchableOpacity onPress={() => { stop(); onCancel(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>✕</Text>
        </TouchableOpacity>
        {recording ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "rgba(0,0,0,.5)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: C.red }} />
            <Text style={{ color: "#fff", fontFamily: "System", fontSize: 13, fontWeight: "700" }}>REC · {frames.length}/{TL_MAX_FRAMES}</Text>
          </View>
        ) : <Text style={{ color: "#fff", fontSize: 12 }}>{frames.length > 0 ? `${frames.length} frames` : ""}</Text>}
      </View>
      <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 24, paddingBottom: 38, backgroundColor: "rgba(0,0,0,.45)" }}>
        {!recording && frames.length === 0 ? (
          <>
            <Text style={{ color: "#cfc8bf", textAlign: "center", marginBottom: 14, fontSize: 13 }}>{t("Prop your phone or hold it steady. Tap record while you do the activity — a frame every few seconds, up to {n} (then it stops automatically).", { n: TL_MAX_FRAMES })}</Text>
            <Btn label={t("Start recording")} onPress={start} />
          </>
        ) : recording ? (
          <Btn label={t("Stop ({n} frames)", { n: frames.length })} onPress={stop} />
        ) : (
          <>
            <Text style={{ color: "#cfc8bf", textAlign: "center", marginBottom: 14, fontSize: 13 }}>{t("{n} frames captured.", { n: frames.length })}{frames.length < TL_MIN_FRAMES ? " " + t("Record at least {n}.", { n: TL_MIN_FRAMES }) : ""}</Text>
            {frames.length >= TL_MIN_FRAMES
              ? <Btn label={t("Send to the judge")} onPress={() => onDone(frames)} />
              : <Btn label={t("Record again")} onPress={start} />}
            <BtnGhost label={t("Retake")} onPress={start} />
          </>
        )}
      </View>
    </View>
  );
}

/* ---------- SUBMIT (camera -> judge) ---------- */
function Submit({ goal, onDone, onBack, onViewBadge }) {
  const isTimelapse = goal.proof_type === "timelapse";
  const [capturing, setCapturing] = useState(false);
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

  async function takeAndJudge(fromLibrary) {
    const perm = fromLibrary
      ? await ImagePicker.requestMediaLibraryPermissionsAsync()
      : await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert("Cert", "Permission needed to add a photo.");

    const res = fromLibrary
      ? await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.4, mediaTypes: ["images"] })
      : await ImagePicker.launchCameraAsync({ base64: true, quality: 0.4 });
    if (res.canceled || !res.assets || !res.assets[0]?.base64) return;

    const a = res.assets[0];
    const mime = a.mimeType || "image/jpeg";
    const photo = `data:${mime};base64,${a.base64}`;
    await runJudge({ photo });
  }

  function onTimelapseFrames(frames) {
    setCapturing(false);
    if (frames && frames.length) runJudge({ frames });
  }

  async function runJudge(payload) {
    setBusy(true); setStage("judging"); setReject(null);
    try {
      const geo = await getGeoTimed();
      const geoPlace = geo && geo.place ? geo.place : null;
      const { data, error } = await supabase.functions.invoke("judge", { body: { goalId: goal.id, geo, lang: activeLang(), ...payload } });
      if (error) throw error;
      if (data?.busy) { Alert.alert("Cert", t("The judge is busy — try again in a moment.")); return; }
      if (data?.error) {
        const msg = {
          no_checks_left: t("No attempts left today. Come back tomorrow, or appeal your last rejected photo."),
          already_done_today: t("You've already completed this goal today."),
          week_done: t("You've hit this week's target. Come back next week."),
          past_deadline: data.deadline ? t("Past today's deadline ({d}). Try again tomorrow before then.", { d: data.deadline }) : t("Past today's deadline. Try again tomorrow before then."),
          not_scheduled_today: t("This goal isn't scheduled for today. Come back on your chosen days."),
          goal_not_active: t("This goal isn't active anymore."),
        }[data.error] || String(data.error);
        Alert.alert("Cert", msg);
        return;
      }
      const v = data.verdict;
      if (v.approved) {
        if (data.milestone) {
          // Streak hit 7/30/100 — offer the celebratory shareable badge.
          Alert.alert(
            t("{n}-DAY STREAK!", { n: data.milestone }),
            (v.reason || "") + "\n\n" + t("You just unlocked a {n}-day verified badge.", { n: data.milestone }),
            [
              { text: t("Share badge"), onPress: () => onViewBadge({ days: data.milestone, title: goal.text }) },
              { text: t("Later"), style: "cancel", onPress: onDone },
            ]
          );
        } else {
          Alert.alert(t("APPROVED"), (v.reason || "") + (geoPlace ? "\n" + geoPlace : "") + (data.completed ? "\n\n" + t("Goal complete — Cert earned!") : ""), [{ text: "OK", onPress: onDone }]);
        }
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

  if (capturing) return <TimelapseCapture onCancel={() => setCapturing(false)} onDone={onTimelapseFrames} />;

  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 60 }]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive">
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Submit proof")}</Text>
      <View style={s.card}>
        <Text style={[s.kicker, { color: C.bronze }]}>{isTimelapse ? t("Record a timelapse of this") : t("Send a photo like this")}</Text>
        <Text style={s.goalText}>{proofSpec(goal) || goal.text}</Text>
      </View>
      {isTimelapse ? (
        <View style={[s.card, { borderColor: C.red }]}>
          <Text style={[s.kicker, { color: C.red }]}>{t("Why a timelapse")}</Text>
          <Text style={s.note}>{t("The app captures frames over your session, so the AI sees the activity actually happen. A single propped photo won't pass.")}</Text>
        </View>
      ) : (
        <View style={[s.card, { borderColor: C.red }]}>
          <Text style={[s.kicker, { color: C.red }]}>{t("Today's anti-cheat check")}</Text>
          {checkState === "ok"
            ? <Text style={s.goalText}>{activeLang() === "ru" ? (todaysCheck?.ru || todaysCheck?.en) : (todaysCheck?.en || todaysCheck?.ru)}</Text>
            : checkState === "loading"
              ? <ActivityIndicator color={C.red} style={{ marginTop: 8, alignSelf: "flex-start" }} />
              : <TouchableOpacity onPress={loadCheck}><Text style={[s.goalText, { color: C.red }]}>{t("Couldn't load — tap to retry")}</Text></TouchableOpacity>}
          <Text style={s.note}>{t("Changes every day so an old photo can't be reused. Include it in the same shot.")}</Text>
        </View>
      )}
      {deadline ? (
        <View style={[s.card, { borderColor: late ? C.red : C.green, paddingVertical: 12 }]}>
          <Text style={[s.kicker, { color: late ? C.red : C.green }]}>{late ? t("Past today's deadline ({d})", { d: deadline }) : t("Submit before {d} today", { d: deadline })}</Text>
        </View>
      ) : null}
      <Text style={s.note}>{t("The AI judges in a few seconds. A reject resets your streak — you can appeal once.")}</Text>
      {stage === "judging" ? (
        <View style={{ alignItems: "center", marginTop: 24 }}>
          <ActivityIndicator color={C.red} />
          <Text style={[s.note, { marginTop: 10 }]}>{isTimelapse ? t("The judge is analyzing your timelapse…") : t("The judge is analyzing your photo…")}</Text>
        </View>
      ) : reject && reject.attemptsLeft === 0 ? (
        // Attempts used up today — now the appeal is the way out.
        <>
          <View style={[s.card, { borderColor: C.red }]}>
            <Text style={[s.kicker, { color: C.red }]}>{t("Rejected — no attempts left today")}</Text>
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
        <View style={[s.card, { borderColor: C.red, alignItems: "center" }]}>
          <Text style={[s.kicker, { color: C.red }]}>{t("Deadline passed")}</Text>
          <Text style={s.note}>{t("You missed today's {d} cutoff. Come back tomorrow before then.", { d: deadline })}</Text>
          <BtnGhost label={t("Back")} onPress={onBack} />
        </View>
      ) : (
        // First attempt, or a reject with attempts still left → let them retry.
        <>
          {reject ? (
            <View style={[s.card, { borderColor: C.red }]}>
              <Text style={[s.kicker, { color: C.red }]}>{t("Rejected — try again")}</Text>
              <Text style={s.goalText}>{reject.reason}</Text>
              {typeof reject.attemptsLeft === "number"
                ? <Text style={s.note}>{t("{n} attempts left today, then you can appeal.", { n: reject.attemptsLeft })}</Text>
                : null}
            </View>
          ) : null}
          {isTimelapse ? (
            <Btn label={reject ? t("Record again") : t("Record timelapse")} onPress={() => setCapturing(true)} disabled={busy || checkState !== "ok"} />
          ) : (
            <>
              <Btn label={reject ? t("Retake photo") : t("Take a photo")} onPress={() => takeAndJudge(false)} disabled={busy || checkState !== "ok"} />
              <BtnGhost label={t("Choose from gallery")} onPress={() => takeAndJudge(true)} disabled={busy || checkState !== "ok"} />
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

/* ---------- SHAREABLE CARD (9:16 story image, captured to PNG) ----------
   One themed card for both completion certs and streak milestones. Rendered
   on screen and captured via react-native-view-shot, so what you see is what
   gets shared. */
const PLACE_PALETTE = {
  1: { bg: "#c9a227", fg: "#1a1405", sub: "#5a4a12", label: "1ST PLACE", medal: "🥇" },
  2: { bg: "#b8bcc4", fg: "#16181c", sub: "#474b52", label: "2ND PLACE", medal: "🥈" },
  3: { bg: "#b5793f", fg: "#1a0f05", sub: "#3f2710", label: "3RD PLACE", medal: "🥉" },
};
function ShareableCard({ cardRef, kind, days, title, rank }) {
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
  return (
    <View ref={cardRef} collapsable={false} style={s.shareCard}>
      <View style={s.shareTop}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Image source={LOGO} style={s.shareLogo} resizeMode="contain" />
          <Text style={s.shareBrand}>CERT</Text>
        </View>
        <Text style={s.shareVerified}>✓ VERIFIED</Text>
      </View>
      <View style={{ alignItems: "center" }}>
        <Image source={LOGO} style={s.shareLogoBig} resizeMode="contain" />
        <Text style={s.shareKicker}>{head}</Text>
        <Text style={s.shareDays}>{days}</Text>
        <Text style={s.shareDaysLabel}>VERIFIED DAYS</Text>
        <Text style={s.shareNotFaked}>NOT FAKED</Text>
      </View>
      <View>
        <Text style={s.shareGoal} numberOfLines={3}>{title}</Text>
        <Text style={s.shareTagline}>Every single day judged by AI. The streak you can't fake.</Text>
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
  const shareLabel = kind === "placement" ? "↗ Share my result" : kind === "milestone" ? "↗ Share my badge" : "↗ Share my Cert";

  async function share() {
    try {
      setBusy(true);
      await shareCardImage(cardRef, kind === "placement" ? "Share your result" : kind === "milestone" ? "Share your badge" : "Share your Cert");
    } catch (e) {
      Alert.alert("Cert", e.message || "Couldn't share.");
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <BackBar onBack={onBack} />
      <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
        <ShareableCard cardRef={cardRef} kind={kind} days={days} title={title} rank={rank} />
      </View>
      <Btn label={busy ? "Preparing…" : shareLabel} onPress={share} disabled={busy} />
      {subtitle ? <Text style={[s.note, { textAlign: "center" }]}>{subtitle}</Text> : null}
      <Text style={s.note}>{kind === "placement"
        ? "Your finish was earned against real friends — verified, not faked."
        : `Every one of these ${days} days was a fresh photo an AI judge approved. That's why it means something.`}</Text>
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
  for (const s of subs) {
    if (s.status === "approved" || s.status === "frozen") byDay[s.day] = "approved";
    else if (s.status === "missed") { if (!byDay[s.day]) byDay[s.day] = "missed"; }
    else if (!byDay[s.day]) byDay[s.day] = "rejected";
  }
  return { approved, rejected, approvalRate, bestStreak, curStreak, verifiedTotal, badges, byDay };
}

function Heatmap({ byDay }) {
  const days = lastNDays(84); // 12 weeks
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const cellColor = (st) => (st === "approved" ? C.bronze : st === "rejected" ? "rgba(226,59,46,0.5)" : st === "missed" ? "#3a2326" : "#1c1922");
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 10 }}>
      {weeks.map((wk, wi) => (
        <View key={wi} style={{ gap: 5 }}>
          {wk.map((d) => <View key={d} style={{ width: 15, height: 15, borderRadius: 3, backgroundColor: cellColor(byDay[d]) }} />)}
        </View>
      ))}
    </View>
  );
}

function Stats({ goals, subs, onOpenBadge, isPro, onUpgrade, refreshing, onRefresh }) {
  const st = computeStats(goals, subs);
  const windowVerified = lastNDays(84).filter((d) => st.byDay[d] === "approved").length;
  const thisWeek = lastNDays(7).filter((d) => st.byDay[d] === "approved").length;
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}
      refreshControl={<RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.bronze} />}>
      <Text style={s.h2}>{t("Your stats")}</Text>

      {/* Heroes: permanent, only ever grow — they cushion the brutal streak reset. */}
      <View style={s.statRow}>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.verifiedTotal}</Text><Text style={s.statLabel}>{t("verified days")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.bestStreak}</Text><Text style={s.statLabel}>{t("best streak")}</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.curStreak}</Text><Text style={s.statLabel}>{t("current")}</Text></View>
      </View>

      {/* Analytics (heatmap + trophies) is a Pro feature. */}
      {isPro ? (
        <>
          <View style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.kicker}>{t("Last 12 weeks")}</Text>
              <Text style={s.note}>{windowVerified} {t("verified")} · {thisWeek}/7{st.approvalRate === null ? "" : " · " + st.approvalRate + "%"}</Text>
            </View>
            <Heatmap byDay={st.byDay} />
            <View style={{ flexDirection: "row", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
              <Legend color={C.bronze} label={t("verified")} />
              <Legend color="rgba(226,59,46,0.5)" label={t("rejected")} />
              <Legend color="#3a2326" label={t("missed")} />
              <Legend color="#1c1922" label={t("none")} />
            </View>
          </View>

          <Text style={[s.kicker, { color: C.bronze, marginTop: 20, marginBottom: 8 }]}>🏆 {t("Trophy shelf")} · {st.badges.length}</Text>
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
        <TouchableOpacity style={[s.card, { alignItems: "center", gap: 6 }]} activeOpacity={0.85} onPress={onUpgrade}>
          <Text style={{ fontSize: 26 }}>📊🔒</Text>
          <Text style={[s.kicker, { color: C.bronze }]}>{t("Analytics is a Pro feature")}</Text>
          <Text style={[s.note, { textAlign: "center" }]}>{t("Unlock the 12-week consistency heatmap, trophy shelf and trends.")}</Text>
          <Text style={[s.kicker, { color: C.bronze, marginTop: 6 }]}>{t("Upgrade →")}</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}
function Legend({ color, label }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={{ width: 11, height: 11, borderRadius: 3, backgroundColor: color }} />
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
function medal(rank) { return rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`; }
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
const WHEEL_COLORS = ["#e23b2e", "#1c1822", "#c9a227", "#241f29"];
const dareEmoji = (d) => String(d || "").trim().split(/\s+/).pop() || "🎯";
const dareIndex = (d) => { const i = WHEEL_DARES.indexOf(d); return i >= 0 ? i : 0; };

// Animated wheel of fortune. Pass landIndex to spin + settle on that slice
// (under the top pointer). N pie slices drawn with CSS-triangle wedges (no SVG dep).
function WheelOfFortune({ landIndex, size = 268 }) {
  const rot = useRef(new Animated.Value(0)).current;
  const R = size / 2;
  const N = WHEEL_DARES.length;
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
      {WHEEL_DARES.map((d, i) => (
        <View key={i} style={{ position: "absolute", width: size, height: size, transform: [{ rotate: `${i * seg}deg` }] }}>
          <View style={{ position: "absolute", top: 0, left: (size - base) / 2, width: 0, height: 0, borderLeftWidth: base / 2, borderRightWidth: base / 2, borderTopWidth: R, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: WHEEL_COLORS[i % WHEEL_COLORS.length] }} />
          <Text style={{ position: "absolute", top: 12, left: 0, width: size, textAlign: "center", fontSize: 20 }}>{dareEmoji(d)}</Text>
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
                  <Text style={s.goalText}>{ch.title}</Text>
                  <Text style={s.note}>{timeLeft(ch.ends_at)} · {t("code")} {ch.code}</Text>
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
  const [goalText, setGoalText] = useState("");
  const [name, setName] = useState("");
  const [hasProfileName, setHasProfileName] = useState(false);
  const [dur, setDur] = useState(7);
  const [type, setType] = useState("recurring"); // recurring | one_time
  const [format, setFormat] = useState("daily");  // daily | 3x | 5x
  const [oneTimeDeadline, setOneTimeDeadline] = useState(null); // Date|null, for one_time
  const [judgeMode, setJudgeMode] = useState("ai"); // ai | peer
  const [proofType, setProofType] = useState("photo"); // photo | timelapse (AI judge only, Pro)
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadMyName().then((n) => { if (n) { setName(n); setHasProfileName(true); } }); }, []);
  async function create() {
    if (goalText.trim().length < 3) return Alert.alert("Cert", t("Describe the shared goal."));
    if (!name.trim()) return Alert.alert("Cert", t("Enter your name for the leaderboard."));
    if (type === "one_time" && !oneTimeDeadline) return Alert.alert("Cert", t("Pick a deadline date & time."));
    setBusy(true);
    try {
      if (!hasProfileName) await saveMyName(name.trim());
      const { data, error } = await supabase.functions.invoke("challenge", { body: {
        action: "create", title: goalText.trim(), goalText: goalText.trim(), durationDays: dur,
        name: name.trim(), goalType: type, goalFormat: format, judgeMode,
        proofType: judgeMode === "ai" ? proofType : "photo",
        endsAt: type === "one_time" && oneTimeDeadline ? oneTimeDeadline.toISOString() : null,
      } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      onCreated(data.challenge.id);
    } catch (e) { Alert.alert("Cert", e.message || t("Couldn't create challenge.")); }
    finally { setBusy(false); }
  }
  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{t("Create a challenge")}</Text>
      {hasProfileName
        ? <Text style={[s.note, { marginTop: 4 }]}>{t("Playing as")} <Text style={{ color: C.bronze, fontWeight: "800" }}>{name}</Text> · {t("change it in Profile")}</Text>
        : (<>
            <Text style={s.label}>{t("Your name (shown on leaderboard)")}</Text>
            <TextInput style={s.input} placeholder={t("e.g. Zhanibek")} placeholderTextColor={C.faint} value={name} onChangeText={(val) => setName(val.replace(/\n/g, " "))} />
          </>)}
      <Text style={[s.label, { marginTop: 14 }]}>{t("The shared goal everyone does")}</Text>
      <TextInput style={[s.input, { height: 80, textAlignVertical: "top" }]} multiline blurOnSubmit returnKeyType="done" placeholder={t("e.g. Gym 45 min, photo with equipment")} placeholderTextColor={C.faint} value={goalText} onChangeText={(val) => setGoalText(val.replace(/\n/g, " "))} />

      <Text style={[s.label, { marginTop: 14 }]}>{t("Type")}</Text>
      <View style={s.rowGap}>
        <Pill label={t("Repeating")} active={type === "recurring"} onPress={() => setType("recurring")} />
        <Pill label={t("One-time")} active={type === "one_time"} onPress={() => setType("one_time")} />
      </View>

      {type === "recurring" ? (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>{t("How often?")}</Text>
          <View style={s.rowGap}>
            <Pill label={t("Daily")} active={format === "daily"} onPress={() => setFormat("daily")} />
            <Pill label={t("3× / week")} active={format === "3x"} onPress={() => setFormat("3x")} />
            <Pill label={t("5× / week")} active={format === "5x"} onPress={() => setFormat("5x")} />
          </View>
        </>
      ) : null}

      {type === "one_time" ? (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>{t("Deadline (date & time)")}</Text>
          <DateTimeField value={oneTimeDeadline} onChange={setOneTimeDeadline} placeholder={t("Pick deadline")} />
          <Text style={s.note}>{t("The challenge ends at this moment. Last place spins the wheel.")}</Text>
        </>
      ) : (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>{t("How long?")}</Text>
          <View style={s.rowGap}>
            {[7, 14, 30].map((d) => <Pill key={d} label={t("{n} days", { n: d })} active={dur === d} onPress={() => setDur(d)} />)}
          </View>
        </>
      )}

      <Text style={[s.label, { marginTop: 14 }]}>{t("Who judges proofs?")}</Text>
      <View style={s.rowGap}>
        <Pill label={t("AI judge")} active={judgeMode === "ai"} onPress={() => setJudgeMode("ai")} />
        <Pill label={t("Friends vote")} active={judgeMode === "peer"} onPress={() => setJudgeMode("peer")} />
      </View>
      <Text style={s.note}>{judgeMode === "peer" ? t("Members swipe to approve/decline each other's photos.") : t("The AI judge checks each photo automatically.")}</Text>

      {judgeMode === "ai" ? (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>{t("How do you prove it?")}</Text>
          <View style={s.rowGap}>
            <Pill label={t("📷 Quick photo")} active={proofType === "photo"} onPress={() => setProofType("photo")} />
            <Pill label={isPro ? t("🎥 Timelapse") : t("🎥 Timelapse 🔒")} active={proofType === "timelapse"}
              onPress={() => { if (isPro) setProofType("timelapse"); else onUpgrade && onUpgrade(); }} />
          </View>
          <Text style={s.note}>{proofType === "timelapse" ? t("Everyone in the challenge records a timelapse. Much harder to fake.") : (isPro ? t("Everyone sends one photo per check.") : t("Everyone sends one photo. Timelapse proof is a Pro feature."))}</Text>
        </>
      ) : null}

      <Btn label={busy ? t("Creating…") : t("Create & get code")} onPress={create} disabled={busy} />
    </ScrollView>
  );
}

function JoinChallenge({ onJoined, onBack, initialCode }) {
  const [code, setCode] = useState(initialCode || "");
  const [name, setName] = useState("");
  const [hasProfileName, setHasProfileName] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadMyName().then((n) => { if (n) { setName(n); setHasProfileName(true); } }); }, []);
  async function join() {
    if (code.trim().length < 4) return Alert.alert("Cert", t("Enter the challenge code."));
    if (!name.trim()) return Alert.alert("Cert", t("Enter your name for the leaderboard."));
    setBusy(true);
    try {
      if (!hasProfileName) await saveMyName(name.trim());
      const { data, error } = await supabase.functions.invoke("challenge", { body: { action: "join", code: code.trim(), name: name.trim() } });
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

  // Auto-show the wheel ONCE when an ended challenge opens (the result, or the
  // spin prompt if you're last). Seen-state persists so it never re-pops.
  useEffect(() => {
    if (!board || !board.ended) return;
    const key = "wheel_seen_" + challengeId;
    let cancelled = false;
    AsyncStorage.getItem(key).then((seen) => {
      if (cancelled || seen) return;
      if (board.dare) { setLandIndex(dareIndex(board.dare)); setRevealed(board.dare); setWheelPreview(false); setWheelOpen(true); AsyncStorage.setItem(key, "1"); }
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
        setLandIndex(dareIndex(data.dare)); // wheel animates ~3.8s
        setTimeout(async () => { setRevealed(data.dare); setSpinningWheel(false); await load(); }, 3900);
      })
      .catch((e) => { setSpinningWheel(false); Alert.alert("Cert", e.message || "Spin failed."); });
  }
  function openResultWheel() { setWheelPreview(false); setLandIndex(dareIndex(board.dare)); setRevealed(board.dare); setWheelOpen(true); }
  function openSpinWheel() { setWheelPreview(false); setLandIndex(null); setRevealed(null); setWheelOpen(true); }

  if (!board) return <Center><ActivityIndicator color={C.bronze} /></Center>;
  const ch = board.challenge;
  const isWk = ch.goal_type === "recurring" && (ch.goal_format === "3x" || ch.goal_format === "5x");
  const shareInvite = () => {
    const link = Linking.createURL("join", { queryParams: { code: ch.code } });
    Share.share({ message: `Join my Cert challenge "${ch.goal_text}" — tap to join:\n${link}\n\n(or enter code ${ch.code} in the app)` });
  };
  function previewWheel() {
    const idx = Math.floor(Math.random() * WHEEL_DARES.length);
    setWheelPreview(true); setRevealed(null); setLandIndex(null); setWheelOpen(true);
    setTimeout(() => setLandIndex(idx), 60);          // start the spin
    setTimeout(() => setRevealed(WHEEL_DARES[idx]), 4000); // reveal after it settles
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
          <Text style={s.lbRank}>{medal(m.rank)}</Text>
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
          <View style={[s.card, { borderColor: C.red, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.red }]}>{t("Declined by friends")}</Text>
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
        <View style={[s.card, { borderColor: C.red, marginTop: 18 }]}>
          {board.dare ? (
            <>
              <Text style={[s.kicker, { color: C.red }]}>{t("Wheel of fortune")}</Text>
              <Text style={s.goalText}>{t("{name} must:", { name: board.loser ? board.loser.name : t("Last place") })}</Text>
              <Text style={[s.h2, { color: C.bronze }]}>{board.dare}</Text>
              <BtnGhost label={t("Replay the spin")} onPress={openResultWheel} />
            </>
          ) : board.canSpin ? (
            <>
              <Text style={[s.kicker, { color: C.red }]}>{t("You came last")}</Text>
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
            <WheelOfFortune landIndex={landIndex} />
          </View>
          {revealed ? (
            <View style={s.wheelResult}>
              <Text style={[s.kicker, { color: C.red, textAlign: "center" }]}>{wheelPreview ? t("Could be…") : t("The dare")}</Text>
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
              <Ionicons name="arrow-back-circle" size={30} color={C.red} />
              <Text style={[s.swipeHintT, { color: C.red }]}>{t("Decline")}</Text>
            </View>
            <View pointerEvents="none" style={[s.swipeHint, { right: 2 }]}>
              <Ionicons name="arrow-forward-circle" size={30} color={C.green} />
              <Text style={[s.swipeHintT, { color: C.green }]}>{t("Approve")}</Text>
            </View>
            <Animated.View {...panResponder.panHandlers} style={[s.swipeCard, { transform: [{ translateX: pan.x }, { translateY: pan.y }, { rotate }] }]}>
              <Animated.View style={[s.swipeStamp, { borderColor: C.green, left: 16, opacity: okOpacity }]}><Text style={[s.swipeStampT, { color: C.green }]}>APPROVE</Text></Animated.View>
              <Animated.View style={[s.swipeStamp, { borderColor: C.red, right: 16, opacity: noOpacity }]}><Text style={[s.swipeStampT, { color: C.red }]}>DECLINE</Text></Animated.View>
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
function Btn({ label, onPress, disabled }) {
  return <TouchableOpacity style={[s.btn, disabled && { opacity: 0.5 }]} onPress={onPress} disabled={disabled}><Text style={s.btnText}>{label}</Text></TouchableOpacity>;
}
function BtnGhost({ label, onPress, disabled }) {
  return <TouchableOpacity style={[s.btnGhost, disabled && { opacity: 0.5 }]} onPress={onPress} disabled={disabled}><Text style={s.btnGhostText}>{label}</Text></TouchableOpacity>;
}
function Pill({ label, active, onPress }) {
  return <TouchableOpacity style={[s.pill, active && s.pillOn]} onPress={onPress}><Text style={[s.pillText, active && { color: C.ink }]}>{label}</Text></TouchableOpacity>;
}
// Reusable time-of-day picker. value/onChange use "HH:MM" (24h). Native dialog
// on Android, spinner-in-modal on iOS. allowClear shows a clear button (→ null).
function TimeField({ value, onChange, allowClear, placeholder = "Pick a time" }) {
  const [show, setShow] = useState(false);
  const [temp, setTemp] = useState(null);
  const base = () => { const d = new Date(); if (value) { const [h, m] = value.split(":"); d.setHours(+h, +m, 0, 0); } else { d.setHours(9, 0, 0, 0); } return d; };
  const fmt = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  function open() { setTemp(base()); setShow(true); }
  function onAndroid(e, d) { setShow(false); if (e.type === "set" && d) onChange(fmt(d)); }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 }}>
      <TouchableOpacity style={[s.chip, value && s.chipOn]} onPress={open}>
        <Text style={[s.chipText, value && { color: C.ink }]}>{value || placeholder}</Text>
      </TouchableOpacity>
      {allowClear && value ? <TouchableOpacity onPress={() => onChange(null)}><Text style={[s.note, { marginTop: 0 }]}>clear</Text></TouchableOpacity> : null}
      {show && Platform.OS === "android" ? (
        <DateTimePicker value={base()} mode="time" is24Hour display="clock" onChange={onAndroid} />
      ) : null}
      {Platform.OS === "ios" ? (
        <Modal visible={show} transparent animationType="fade" onRequestClose={() => setShow(false)}>
          <View style={s.modalWrap}>
            <View style={s.modalCard}>
              <DateTimePicker value={temp || base()} mode="time" is24Hour display="spinner" textColor={C.ink} themeVariant="dark" onChange={(e, d) => { if (d) setTemp(d); }} />
              <Btn label="Done" onPress={() => { if (temp) onChange(fmt(temp)); setShow(false); }} />
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}
// Date + time picker. value/onChange use a Date (or null). Android chains a
// date dialog then a time dialog; iOS shows a single datetime spinner in a modal.
function DateTimeField({ value, onChange, placeholder = "Pick date & time" }) {
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
    <View style={{ marginTop: 6 }}>
      <TouchableOpacity style={[s.chip, value && s.chipOn]} onPress={open}>
        <Text style={[s.chipText, value && { color: C.ink }]}>📅 {value ? fmt(value) : placeholder}</Text>
      </TouchableOpacity>
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
  kickerRed: { color: C.red, fontSize: 11, letterSpacing: 1, marginBottom: 16, textTransform: "uppercase" },
  kicker: { color: C.mute, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" },
  h1: { color: C.ink, fontSize: 40, fontWeight: "800", lineHeight: 42 },
  h2: { color: C.ink, fontSize: 24, fontWeight: "800", marginTop: 8 },
  lede: { color: C.mute, fontSize: 15, lineHeight: 22, marginTop: 10, marginBottom: 18 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 18, marginTop: 14 },
  label: { color: C.mute, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 },
  input: { backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.inputLine, borderRadius: 10, color: C.ink, fontSize: 16, padding: 14 },
  note: { color: C.faint, fontSize: 12, marginTop: 12, textAlign: "center" },
  btn: { backgroundColor: C.red, borderRadius: 10, padding: 16, marginTop: 16, alignItems: "center" },
  btnText: { color: "#120606", fontWeight: "800", fontSize: 15, letterSpacing: 1 },
  btnGhost: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 16, marginTop: 10, alignItems: "center" },
  btnGhostText: { color: C.ink, fontWeight: "700", fontSize: 14 },
  googleBtn: { backgroundColor: "#fff", borderRadius: 10, padding: 15, marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  googleText: { color: "#1f1f1f", fontWeight: "700", fontSize: 15 },
  orText: { color: C.faint, fontSize: 12, textAlign: "center", marginVertical: 14 },
  infoBanner: { color: C.green, backgroundColor: "rgba(52,199,89,0.08)", borderWidth: 1, borderColor: "#1f3b25", borderRadius: 10, padding: 12, fontSize: 13, lineHeight: 18 },
  switchAuth: { color: C.bronze, fontSize: 14, fontWeight: "600", textAlign: "center", marginTop: 20 },
  skipBtn: { borderWidth: 1, borderColor: C.bronze, borderRadius: 10, padding: 13, marginTop: 22, alignItems: "center" },
  skipText: { color: C.bronze, fontWeight: "700", fontSize: 14 },
  pill: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingVertical: 12, alignItems: "center" },
  pillOn: { borderColor: C.red, backgroundColor: "rgba(226,59,46,0.1)" },
  pillText: { color: C.mute, fontSize: 13 },
  streakNum: { color: C.bronze, fontSize: 56, fontWeight: "800", textAlign: "center" },
  goalText: { color: C.ink, fontSize: 15, lineHeight: 22, marginTop: 8 },
  spec: { color: C.bronze, fontSize: 12, lineHeight: 18, marginTop: 8 },
  modalWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: C.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, borderTopWidth: 1, borderColor: C.line },
  swipeCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 18, padding: 16, marginTop: 18 },
  swipePhoto: { width: "100%", height: 360, borderRadius: 12, backgroundColor: "#0d0c11" },
  swipeStamp: { position: "absolute", top: 28, zIndex: 2, borderWidth: 3, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, transform: [{ rotate: "-12deg" }] },
  swipeStampT: { fontSize: 22, fontWeight: "800", letterSpacing: 2 },
  historyHead: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 4, paddingVertical: 4 },
  swipeHint: { position: "absolute", zIndex: 0, alignItems: "center", gap: 2 },
  swipeHintT: { fontSize: 10, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  wheelBackdrop: { flex: 1, backgroundColor: "rgba(5,4,6,0.95)", alignItems: "center", justifyContent: "center", padding: 24 },
  wheelTitle: { color: C.ink, fontSize: 24, fontWeight: "800" },
  wheelSub: { color: C.red, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginTop: 6, marginBottom: 16, textAlign: "center" },
  wheelStage: { alignItems: "center", justifyContent: "center", paddingTop: 18 },
  wheelPointer: { position: "absolute", top: 0, zIndex: 5, width: 0, height: 0, borderLeftWidth: 13, borderRightWidth: 13, borderTopWidth: 24, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: C.ink },
  wheelResult: { marginTop: 20, borderWidth: 1, borderColor: C.red, borderRadius: 12, padding: 16, backgroundColor: C.card, maxWidth: 320 },
  wheelDare: { color: C.bronze, fontSize: 18, fontWeight: "800", textAlign: "center", lineHeight: 24, marginTop: 6 },
  backBar: { flexDirection: "row", alignItems: "center", gap: 2, marginBottom: 10, alignSelf: "flex-start", paddingVertical: 4, paddingRight: 8 },
  backText: { color: C.ink, fontSize: 15, fontWeight: "600" },
  avatar: { width: 92, height: 92, borderRadius: 46, borderWidth: 2, borderColor: C.bronze },
  avatarEmpty: { backgroundColor: C.bg, alignItems: "center", justifyContent: "center" },
  certRow: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.bronze, borderRadius: 12, padding: 14, marginBottom: 8 },
  certRowDays: { color: C.bronze, fontSize: 28, fontWeight: "800", minWidth: 44, textAlign: "center" },
  certRowTitle: { color: C.ink, fontSize: 15, fontWeight: "700" },
  certRowChevron: { color: C.faint, fontSize: 24 },
  shareCard: { width: "100%", aspectRatio: 9 / 16, backgroundColor: C.bg, borderWidth: 2, borderColor: C.bronze, borderRadius: 22, padding: 28, justifyContent: "space-between" },
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
  lbLast: { color: C.red, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  tabBar: { flexDirection: "row", borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card, paddingTop: 7 },
  tabItem: { flex: 1, alignItems: "center", gap: 3 },
  tabLabel: { fontSize: 10.5, color: C.faint, fontWeight: "700", letterSpacing: 0.3 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  chipOn: { borderColor: C.red, backgroundColor: "rgba(226,59,46,0.12)" },
  chipText: { color: C.mute, fontSize: 13 },
  freezePill: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: C.card },
  freezePillNum: { color: C.ink, fontWeight: "800", fontSize: 14 },
  langChip: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  langChipOn: { backgroundColor: C.bronze, borderColor: C.bronze },
  langChipT: { color: C.mute, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  buyCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 16, marginTop: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  buyCardOn: { borderColor: C.bronze },
  buyTitle: { color: C.ink, fontSize: 16, fontWeight: "800" },
  buyPrice: { color: C.bronze, fontSize: 16, fontWeight: "800" },
  buyBadge: { color: "#120606", backgroundColor: C.bronze, fontSize: 10, fontWeight: "800", letterSpacing: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  pwHero: { alignItems: "center", marginTop: 6, marginBottom: 4 },
  pwMark: { width: 64, height: 64, borderRadius: 20, borderWidth: 1, borderColor: C.bronze, alignItems: "center", justifyContent: "center", backgroundColor: C.card },
  pwTitle: { color: C.ink, fontSize: 30, fontWeight: "800", textAlign: "center", marginTop: 12 },
  pwSub: { color: C.mute, fontSize: 14, textAlign: "center", marginTop: 6, lineHeight: 20, paddingHorizontal: 10 },
  planRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  plan: { flex: 1, borderWidth: 1.5, borderColor: C.line, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 12, alignItems: "center", backgroundColor: C.card },
  planOn: { borderColor: C.bronze, backgroundColor: C.isDark ? "rgba(201,162,39,0.10)" : "rgba(154,122,28,0.10)" },
  planName: { color: C.mute, fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  planPrice: { color: C.ink, fontSize: 22, fontWeight: "800", marginTop: 8 },
  planPer: { color: C.faint, fontSize: 12, marginTop: 3 },
  planSave: { color: "#120606", backgroundColor: C.bronze, fontSize: 10, fontWeight: "800", letterSpacing: 0.5, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, overflow: "hidden", marginTop: 10 },
  restore: { color: C.mute, fontSize: 13, fontWeight: "700", textAlign: "center", marginTop: 14, paddingVertical: 6 },
  shareBrand: { color: C.ink, fontSize: 22, fontWeight: "800", letterSpacing: 5 },
  shareVerified: { color: C.bronze, fontSize: 12, fontWeight: "800", letterSpacing: 1, borderWidth: 1, borderColor: C.bronze, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  shareKicker: { color: C.mute, fontSize: 13, letterSpacing: 3, fontWeight: "700", marginBottom: 4 },
  shareDays: { color: C.bronze, fontSize: 120, fontWeight: "800", lineHeight: 124 },
  shareDaysLabel: { color: C.ink, fontSize: 15, letterSpacing: 4, fontWeight: "700" },
  shareNotFaked: { color: C.red, fontSize: 14, letterSpacing: 3, fontWeight: "800", marginTop: 14 },
  shareGoal: { color: C.ink, fontSize: 22, fontWeight: "800", lineHeight: 28, marginBottom: 12 },
  shareTagline: { color: C.faint, fontSize: 13, lineHeight: 18 },
}); }
