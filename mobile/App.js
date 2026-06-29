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
  Animated, PanResponder, Dimensions, Easing,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import * as Sharing from "expo-sharing";
import { captureRef } from "react-native-view-shot";
import { supabase } from "./lib/supabase";
import { getReminderPref, enableReminder, disableReminder } from "./lib/reminders";

WebBrowser.maybeCompleteAuthSession();

/* ---------- theme (matches the Cert brand: dark + bronze + red) ---------- */
const C = {
  bg: "#070608", card: "#120f14", line: "#241f29",
  ink: "#f4efe8", mute: "#9a948d", faint: "#6f6a63",
  red: "#e23b2e", bronze: "#c9a227", green: "#34c759",
};
const F = { display: "System", mono: "System" };

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

/* Split a Date into a "YYYY-MM-DD" date and an "HH:MM" time (local). */
function isoDateParts(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/* ===================================================================== */
export default function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setBooting(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
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
          if (error) console.warn("Cert auth deep-link exchange failed:", error.message);
          // onAuthStateChange flips to Main on success
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
        <StatusBar barStyle="light-content" />
        {booting ? <Center><ActivityIndicator color={C.bronze} /></Center>
          : session ? <Main session={session} /> : <Auth />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ---------- AUTH: email + password, or Google ---------- */
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function Auth() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null); // success/info banner (e.g. "confirm your email")

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

  async function forgotPassword() {
    const mail = email.trim();
    if (!emailOk(mail)) return Alert.alert("Cert", "Type your email above first, then tap “Forgot password”.");
    try {
      setBusy(true); setInfo(null);
      const { error } = await supabase.auth.resetPasswordForEmail(mail, { redirectTo: Linking.createURL("/") });
      if (error) throw error;
      setInfo("Password reset link sent. Open it from your email on this phone.");
    } catch (e) {
      Alert.alert("Cert", e.message || "Could not send the reset email.");
    } finally {
      setBusy(false);
    }
  }

  const isSignup = mode === "signup";
  return (
    <ScrollView contentContainerStyle={s.authWrap} keyboardShouldPersistTaps="handled">
      <Image source={LOGO} style={s.authLogo} resizeMode="contain" />
      <Text style={s.kickerRed}>[ the streak you can't fake ]</Text>
      <Text style={s.h1}>{isSignup ? "Create your\naccount" : "Welcome\nback"}</Text>
      <Text style={s.lede}>One goal. A daily photo. An honest AI judge.</Text>

      <TouchableOpacity style={s.googleBtn} onPress={signInWithGoogle} disabled={busy}>
        <Ionicons name="logo-google" size={18} color="#1f1f1f" style={{ marginRight: 9 }} />
        <Text style={s.googleText}>{busy ? "…" : "Continue with Google"}</Text>
      </TouchableOpacity>

      <Text style={s.orText}>— or with email —</Text>

      {info ? <Text style={s.infoBanner}>{info}</Text> : null}

      <View style={s.card}>
        <Text style={s.label}>Email</Text>
        <TextInput style={s.input} placeholder="you@email.com" placeholderTextColor={C.faint}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
          value={email} onChangeText={setEmail} />
        <Text style={[s.label, { marginTop: 14 }]}>Password</Text>
        <TextInput style={s.input} placeholder="••••••••" placeholderTextColor={C.faint}
          secureTextEntry autoCapitalize="none" autoCorrect={false}
          value={password} onChangeText={setPassword} />
        <Btn label={busy ? "…" : isSignup ? "Create account →" : "Sign in →"} onPress={submitEmail} disabled={busy} />
        {isSignup
          ? <Text style={s.note}>At least 6 characters.</Text>
          : <TouchableOpacity onPress={forgotPassword} disabled={busy}><Text style={s.note}>Forgot password?</Text></TouchableOpacity>}
      </View>

      <TouchableOpacity onPress={() => { setMode(isSignup ? "signin" : "signup"); setInfo(null); }} disabled={busy}>
        <Text style={s.switchAuth}>
          {isSignup ? "Already have an account?  Sign in" : "New here?  Create an account"}
        </Text>
      </TouchableOpacity>

      {/* Demo: enter without logging in (anonymous session) */}
      <TouchableOpacity style={s.skipBtn} onPress={enterDemo} disabled={busy}>
        <Text style={s.skipText}>{busy ? "…" : "Enter demo (no login) →"}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

/* ---------- MAIN (tab shell + overlay screens) ---------- */
function Main({ session }) {
  const [tab, setTab] = useState("home"); // home | challenges | stats | profile
  const [screen, setScreen] = useState(null); // overlay: new|submit|cert|badge|challengeNew|challengeJoin|challengeDetail
  const [goals, setGoals] = useState(null);
  const [certs, setCerts] = useState([]);
  const [subs, setSubs] = useState([]);
  const [active, setActive] = useState(null);
  const [activeCert, setActiveCert] = useState(null);
  const [activeBadge, setActiveBadge] = useState(null);
  const [activePlacement, setActivePlacement] = useState(null);
  const [activeChallenge, setActiveChallenge] = useState(null);
  const [submitReturn, setSubmitReturn] = useState(null); // overlay to return to after Submit
  const [joinCode, setJoinCode] = useState(""); // prefilled from an invite link
  const [refreshing, setRefreshing] = useState(false);

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

  const load = useCallback(async () => {
    const [gRes, cRes, sRes] = await Promise.all([
      supabase.from("goals").select("*").order("created_at", { ascending: true }),
      supabase.from("certs").select("*").order("issued_at", { ascending: false }),
      supabase.from("submissions").select("day,status").order("day", { ascending: true }),
    ]);
    if (gRes.error) Alert.alert("Cert", gRes.error.message);
    setGoals(gRes.data || []);
    setCerts(cRes.data || []);
    setSubs(sRes.data || []);
  }, []);
  useEffect(() => { load(); }, [load]);
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

  // ----- overlay screens (full screen, own back + swipe-from-left to go back) -----
  if (screen === "new") { const back = () => setScreen(null); return <SwipeBack onBack={back}><NewGoal session={session} onDone={async () => { await load(); setScreen(null); }} onBack={back} /></SwipeBack>; }
  if (screen === "submit" && active) { const back = () => { setScreen(submitReturn); setSubmitReturn(null); }; return <SwipeBack onBack={back}><Submit goal={active} onDone={async () => { await load(); setScreen(submitReturn); setSubmitReturn(null); }} onViewBadge={openBadge} onBack={back} /></SwipeBack>; }
  if (screen === "challengeNew") { const back = () => setScreen(null); return <SwipeBack onBack={back}><CreateChallenge onCreated={(id) => { setActiveChallenge(id); setScreen("challengeDetail"); }} onBack={back} /></SwipeBack>; }
  if (screen === "challengeJoin") { const back = () => { setJoinCode(""); setScreen(null); }; return <SwipeBack onBack={back}><JoinChallenge initialCode={joinCode} onJoined={(id) => { setJoinCode(""); setActiveChallenge(id); setScreen("challengeDetail"); }} onBack={back} /></SwipeBack>; }
  if (screen === "challengeDetail" && activeChallenge) { const back = () => setScreen(null); return <SwipeBack onBack={back}><ChallengeDetail challengeId={activeChallenge} onSubmitProof={(g) => { setActive(g); setSubmitReturn("challengeDetail"); setScreen("submit"); }} onReview={() => setScreen("review")} onSharePlacement={(rank, title) => { setActivePlacement({ rank, title }); setScreen("placement"); }} onBack={back} /></SwipeBack>; }
  if (screen === "review") return <SwipeReview onBack={() => setScreen("challengeDetail")} />;
  if (screen === "placement" && activePlacement) { const back = () => setScreen("challengeDetail"); return <SwipeBack onBack={back}><ShareScreen kind="placement" rank={activePlacement.rank} title={activePlacement.title} onBack={back} /></SwipeBack>; }
  if (screen === "settings") { const back = () => setScreen(null); return <SwipeBack onBack={back}><SettingsScreen session={session} onBack={back} /></SwipeBack>; }
  if (screen === "cert" && activeCert) { const back = () => setScreen(null); return <SwipeBack onBack={back}><ShareScreen kind="cert" days={activeCert.days} title={activeCert.title} subtitle={activeCert.issued_at ? "Earned " + new Date(activeCert.issued_at).toLocaleDateString() : null} onBack={back} /></SwipeBack>; }
  if (screen === "badge" && activeBadge) { const back = () => setScreen(null); return <SwipeBack onBack={back}><ShareScreen kind="milestone" days={activeBadge.days} title={activeBadge.title} onBack={back} /></SwipeBack>; }

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
          <HomeTab goals={goals} certs={certs} refreshing={refreshing} onRefresh={onRefresh}
            onNew={() => setScreen("new")} onSubmit={(g) => { setActive(g); setSubmitReturn(null); setScreen("submit"); }} onOpenCert={openCert} />
        )}
        {tab === "challenges" && (
          <ChallengesScreen onOpen={(id) => { setActiveChallenge(id); setScreen("challengeDetail"); }}
            onCreate={() => setScreen("challengeNew")} onJoin={() => setScreen("challengeJoin")} />
        )}
        {tab === "stats" && <Stats goals={goals || []} subs={subs} onOpenBadge={openBadge} />}
        {tab === "profile" && <ProfileTab session={session} goals={goals || []} certs={certs} subs={subs} onOpenCert={openCert} onOpenSettings={() => setScreen("settings")} />}
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
            <Text style={[s.tabLabel, on && { color: C.bronze }]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function HomeTab({ goals, certs, refreshing, onRefresh, onNew, onSubmit, onOpenCert }) {
  const myGoals = (goals || []).filter((g) => !g.challenge_id); // challenge goals live under Versus
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.bronze} />}>
      <View style={s.rowBetween}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Image source={LOGO} style={s.brandLogo} resizeMode="contain" />
          <Text style={s.brand}>CERT</Text>
        </View>
      </View>

      {certs.length > 0 ? (
        <View style={{ marginTop: 8, marginBottom: 6 }}>
          <Text style={[s.kicker, { color: C.bronze, marginBottom: 8 }]}>🏅 Your Certs · {certs.length}</Text>
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
        </View>
      ) : null}

      {goals === null ? (
        <ActivityIndicator color={C.bronze} style={{ marginTop: 40 }} />
      ) : myGoals.length === 0 ? (
        <View style={[s.card, { alignItems: "center", marginTop: 24 }]}>
          <Text style={s.h2}>No goals yet</Text>
          <Text style={[s.lede, { textAlign: "center" }]}>Create your first goal and start a streak the judge can't fake.</Text>
          <Btn label="+ New goal" onPress={onNew} />
        </View>
      ) : (
        <>
          {myGoals.map((g) => (
            <GoalCard key={g.id} goal={g} onSubmit={() => onSubmit(g)}
              onOpenCert={() => { const c = certs.find((x) => x.goal_id === g.id); if (c) onOpenCert(c); }} />
          ))}
          <BtnGhost label="+ Add a goal" onPress={onNew} />
        </>
      )}
    </ScrollView>
  );
}

function ProfileTab({ session, goals, certs, subs, onOpenCert, onOpenSettings }) {
  const [profile, setProfile] = useState(null);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => { setProfile(data); setName(data?.name || ""); setAvatar(data?.avatar_url || null); });
  }, [session.user.id]);
  const st = computeStats(goals, subs);
  const plan = profile?.plan === "monthly" || profile?.plan === "yearly" ? "Pro" : "Free";

  async function save() {
    setSaving(true);
    const { error } = await supabase.from("profiles").update({ name: name.trim() }).eq("id", session.user.id);
    if (!error) _cachedName = name.trim(); // keep challenge screens in sync
    setSaving(false);
    Alert.alert("Cert", error ? error.message : "Saved.");
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
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}>
      <View style={s.rowBetween}>
        <Text style={s.h2}>Profile</Text>
        <TouchableOpacity onPress={onOpenSettings} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="settings-outline" size={22} color={C.mute} />
        </TouchableOpacity>
      </View>
      <View style={[s.card, { alignItems: "center" }]}>
        <TouchableOpacity onPress={pickAvatar} activeOpacity={0.8} style={{ alignItems: "center" }}>
          {avatar
            ? <Image source={{ uri: avatar }} style={s.avatar} />
            : <View style={[s.avatar, s.avatarEmpty]}><Image source={LOGO} style={{ width: 46, height: 46 }} resizeMode="contain" /></View>}
          <Text style={[s.note, { textAlign: "center", marginTop: 6 }]}>tap to change photo</Text>
        </TouchableOpacity>
        <Text style={[s.kicker, { marginTop: 6 }]}>PLAN · {plan}</Text>
      </View>

      <Text style={[s.label, { marginTop: 16 }]}>Display name</Text>
      <TextInput style={s.input} placeholder="Your name" placeholderTextColor={C.faint} value={name} onChangeText={setName} />
      <Btn label={saving ? "Saving…" : "Save name"} onPress={save} disabled={saving} />

      <View style={s.statRow}>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.approved}</Text><Text style={s.statLabel}>verified days</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.bestStreak}</Text><Text style={s.statLabel}>best streak</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{certs.length}</Text><Text style={s.statLabel}>certs</Text></View>
      </View>

      {certs.length > 0 ? (
        <>
          <Text style={[s.kicker, { color: C.bronze, marginTop: 20, marginBottom: 8 }]}>🏅 Your Certs</Text>
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
      <Text style={s.h2}>Settings</Text>

      <View style={[s.card, { marginTop: 14 }]}>
        <View style={s.rowBetween}>
          <Text style={s.h2}>Daily reminder</Text>
          <Switch value={remEnabled} onValueChange={toggleReminder} trackColor={{ true: C.bronze, false: C.line }} thumbColor={C.ink} />
        </View>
        <Text style={s.note}>A nudge to submit your proof so you never break the streak.</Text>
        <TimeField value={remTime} onChange={pickTime} placeholder="Pick a time" />
      </View>

      <View style={s.card}>
        <Text style={s.label}>Time zone</Text>
        <Text style={s.goalText}>{tz || "—"}</Text>
        <Text style={s.note}>Used for day boundaries and deadlines, set from your device.</Text>
      </View>

      <BtnGhost label="Sign out" onPress={() => supabase.auth.signOut()} />
      <Text style={[s.note, { textAlign: "center", marginTop: 16 }]}>Cert · v1.0 — the streak you can't fake</Text>
    </ScrollView>
  );
}

const DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function goalCadence(goal) {
  if (goal.type === "one_time") {
    if (goal.deadline) return `One-time · by ${goal.deadline}${goal.daily_deadline ? " " + goal.daily_deadline : ""}`;
    return "One-time";
  }
  let freq;
  if (goal.format === "custom") freq = (goal.custom_days || []).map((d) => DOW_NAMES[d]).join(", ") || "Custom";
  else freq = goal.format === "3x" ? "3× / week" : goal.format === "5x" ? "5× / week" : "Daily";
  const dur = goal.format === "daily" && goal.duration_days ? ` · ${goal.duration_days}d goal` : "";
  return goal.daily_deadline ? `${freq}${dur} · by ${goal.daily_deadline}` : `${freq}${dur}`;
}
function GoalCard({ goal, onSubmit, onOpenCert }) {
  const completed = goal.status === "completed";
  const isWeekly = goal.type === "recurring" && (goal.format === "3x" || goal.format === "5x" || goal.format === "custom");
  return (
    <View style={s.card}>
      <Text style={s.streakNum}>{goal.streak}</Text>
      <Text style={s.kicker}>{isWeekly ? "week" : "day"} streak · verified by the judge</Text>
      <Text style={s.goalText}>{goal.text}</Text>
      <Text style={[s.spec, { color: C.mute }]}>{goalCadence(goal)}</Text>
      {goal.proof_spec_en ? <Text style={s.spec}>📸 {goal.proof_spec_en}</Text> : null}
      {completed
        ? <TouchableOpacity onPress={onOpenCert}><Text style={[s.kicker, { color: C.bronze, marginTop: 12 }]}>🏆 Completed — view & share Cert ›</Text></TouchableOpacity>
        : <Btn label="📷 Submit today's proof" onPress={onSubmit} />}
    </View>
  );
}

/* ---------- NEW GOAL ---------- */
const WEEKDAYS = [["Mon", 0], ["Tue", 1], ["Wed", 2], ["Thu", 3], ["Fri", 4], ["Sat", 5], ["Sun", 6]];
function NewGoal({ session, onDone, onBack }) {
  const [text, setText] = useState("");
  const [type, setType] = useState("recurring"); // recurring | one_time
  const [format, setFormat] = useState("daily");  // daily | 3x | 5x | custom
  const [customDays, setCustomDays] = useState([]); // 0=Mon..6=Sun
  const [duration, setDuration] = useState(null);   // null=ongoing, or 7/30/100 (daily only)
  const [deadline, setDeadline] = useState(null);  // "HH:MM" or null
  const [oneTimeDeadline, setOneTimeDeadline] = useState(null); // Date|null, for one_time goals
  const [busy, setBusy] = useState(false);
  const toggleDay = (d) => setCustomDays((arr) => arr.includes(d) ? arr.filter((x) => x !== d) : [...arr, d].sort());

  async function create() {
    if (text.trim().length < 3) return Alert.alert("Cert", "Describe your goal first.");
    if (type === "recurring" && format === "custom" && customDays.length === 0) return Alert.alert("Cert", "Pick at least one day.");
    if (type === "one_time" && !oneTimeDeadline) return Alert.alert("Cert", "Pick a deadline date & time.");
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
        proof_spec_en: spec.en,
        proof_spec_ru: spec.ru,
      });
      if (error) throw error;
      onDone();
    } catch (e) {
      Alert.alert("Cert", e.message || "Could not create goal.");
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <BackBar onBack={onBack} />
      <Text style={s.h2}>What will you prove?</Text>
      <Text style={s.lede}>Write it in your own words. The AI judge reads exactly this.</Text>
      <TextInput style={[s.input, { height: 90, textAlignVertical: "top" }]} multiline blurOnSubmit returnKeyType="done"
        placeholder="e.g. Wake up and send a photo, or gym 45 min" placeholderTextColor={C.faint}
        value={text} onChangeText={(t) => setText(t.replace(/\n/g, " "))} />

      <Text style={[s.label, { marginTop: 14 }]}>Type</Text>
      <View style={s.rowGap}>
        <Pill label="Repeating" active={type === "recurring"} onPress={() => setType("recurring")} />
        <Pill label="One-time" active={type === "one_time"} onPress={() => setType("one_time")} />
      </View>

      {type === "recurring" ? (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>How often?</Text>
          <View style={s.chipRow}>
            {[["daily", "Daily"], ["3x", "3×/wk"], ["5x", "5×/wk"], ["custom", "Custom days"]].map(([v, label]) => (
              <TouchableOpacity key={v} style={[s.chip, format === v && s.chipOn]} onPress={() => setFormat(v)}>
                <Text style={[s.chipText, format === v && { color: C.ink }]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {format === "custom" ? (
            <>
              <Text style={[s.label, { marginTop: 14 }]}>Which days?</Text>
              <View style={s.chipRow}>
                {WEEKDAYS.map(([label, d]) => (
                  <TouchableOpacity key={d} style={[s.chip, customDays.includes(d) && s.chipOn]} onPress={() => toggleDay(d)}>
                    <Text style={[s.chipText, customDays.includes(d) && { color: C.ink }]}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}

          {format === "daily" ? (
            <>
              <Text style={[s.label, { marginTop: 14 }]}>Duration</Text>
              <View style={s.rowGap}>
                {[[null, "Ongoing"], [7, "7 days"], [30, "30 days"], [100, "100 days"]].map(([v, label]) => (
                  <Pill key={label} label={label} active={duration === v} onPress={() => setDuration(v)} />
                ))}
              </View>
              <Text style={s.note}>Reach the target to complete the goal and earn a Cert.</Text>
            </>
          ) : null}

          <Text style={[s.label, { marginTop: 14 }]}>Deadline (must submit before)</Text>
          <TimeField value={deadline} onChange={setDeadline} allowClear placeholder="No deadline" />
          <Text style={s.note}>Pick any time. Proof after it won't count for the day. Judged in your local time.</Text>
        </>
      ) : (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>Deadline (date & time)</Text>
          <DateTimeField value={oneTimeDeadline} onChange={setOneTimeDeadline} placeholder="Pick deadline" />
          <Text style={s.note}>Submit your proof before this. One photo, judged once.</Text>
        </>
      )}

      <Btn label={busy ? "Creating…" : "Start the streak →"} onPress={create} disabled={busy} />
    </ScrollView>
  );
}

/* ---------- SUBMIT (camera -> judge) ---------- */
function Submit({ goal, onDone, onBack, onViewBadge }) {
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
      setTodaysCheck(data.dailyReq.en);
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

    setBusy(true); setStage("judging"); setReject(null);
    try {
      const { data, error } = await supabase.functions.invoke("judge", { body: { goalId: goal.id, photo } });
      if (error) throw error;
      if (data?.busy) { Alert.alert("Cert", "The judge is busy — try again in a moment."); return; }
      if (data?.error) {
        const msg = {
          no_checks_left: "No attempts left today. Come back tomorrow, or appeal your last rejected photo.",
          already_done_today: "You've already completed this goal today. 🎉",
          week_done: "You've hit this week's target. Come back next week. 🎉",
          past_deadline: `Past today's deadline${data.deadline ? " (" + data.deadline + ")" : ""}. Try again tomorrow before then. ⏰`,
          not_scheduled_today: "This goal isn't scheduled for today. Come back on your chosen days.",
          goal_not_active: "This goal isn't active anymore.",
        }[data.error] || String(data.error);
        Alert.alert("Cert", msg);
        return;
      }
      const v = data.verdict;
      if (v.approved) {
        if (data.milestone) {
          // Streak hit 7/30/100 — offer the celebratory shareable badge.
          Alert.alert(
            `🏅 ${data.milestone}-DAY STREAK!`,
            (v.reason || "") + `\n\nYou just unlocked a ${data.milestone}-day verified badge.`,
            [
              { text: "Share badge", onPress: () => onViewBadge({ days: data.milestone, title: goal.text }) },
              { text: "Later", style: "cancel", onPress: onDone },
            ]
          );
        } else {
          Alert.alert("✅ APPROVED", (v.reason || "") + (data.completed ? "\n\n🏆 Goal complete — Cert earned!" : ""), [{ text: "OK", onPress: onDone }]);
        }
      } else {
        // Let them retry while attempts remain; the appeal flow opens only once
        // today's attempts are used up (attemptsLeft === 0).
        setReject({ submissionId: data.submissionId, reason: v.reason || "Not approved.", attemptsLeft: data.attemptsLeft });
      }
    } catch (e) {
      Alert.alert("Cert", e.message || "Could not reach the judge.");
    } finally { setBusy(false); setStage("idle"); }
  }

  async function submitAppeal() {
    if (!reject?.submissionId) return;
    setAppealBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("appeal", { body: { submissionId: reject.submissionId, note } });
      if (error) throw error;
      if (data?.busy) { Alert.alert("Cert", "The reviewer is busy — try again in a moment."); return; }
      if (data?.error) {
        Alert.alert("Cert", data.error === "already_appealed" ? "You've already appealed this one." : String(data.error));
        return;
      }
      if (data.restored) {
        Alert.alert("✅ Appeal accepted", `Your streak is restored to ${data.streak}.` + (data.completed ? "\n\n🏆 Goal complete — Cert earned!" : ""), [{ text: "OK", onPress: onDone }]);
      } else {
        Alert.alert("Appeal denied", (data.verdict?.reason || "The reviewer kept the original decision."), [{ text: "OK", onPress: onDone }]);
      }
    } catch (e) {
      Alert.alert("Cert", e.message || "Could not submit the appeal.");
    } finally { setAppealBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>Submit proof</Text>
      <View style={s.card}>
        <Text style={[s.kicker, { color: C.bronze }]}>📸 Send a photo like this</Text>
        <Text style={s.goalText}>{goal.proof_spec_en || goal.text}</Text>
      </View>
      <View style={[s.card, { borderColor: C.red }]}>
        <Text style={[s.kicker, { color: C.red }]}>🔒 Today's anti-cheat check</Text>
        {checkState === "ok"
          ? <Text style={s.goalText}>{todaysCheck}</Text>
          : checkState === "loading"
            ? <ActivityIndicator color={C.red} style={{ marginTop: 8, alignSelf: "flex-start" }} />
            : <TouchableOpacity onPress={loadCheck}><Text style={[s.goalText, { color: C.red }]}>Couldn't load — tap to retry</Text></TouchableOpacity>}
        <Text style={s.note}>Changes every day so an old photo can't be reused. Include it in the same shot.</Text>
      </View>
      {deadline ? (
        <View style={[s.card, { borderColor: late ? C.red : C.green, paddingVertical: 12 }]}>
          <Text style={[s.kicker, { color: late ? C.red : C.green }]}>⏰ {late ? `Past today's deadline (${deadline})` : `Submit before ${deadline} today`}</Text>
        </View>
      ) : null}
      <Text style={s.note}>The AI judges in a few seconds. A reject resets your streak — you can appeal once.</Text>
      {stage === "judging" ? (
        <View style={{ alignItems: "center", marginTop: 24 }}>
          <ActivityIndicator color={C.red} />
          <Text style={[s.note, { marginTop: 10 }]}>The judge is analyzing your photo…</Text>
        </View>
      ) : reject && reject.attemptsLeft === 0 ? (
        // Attempts used up today — now the appeal is the way out.
        <>
          <View style={[s.card, { borderColor: C.red }]}>
            <Text style={[s.kicker, { color: C.red }]}>❌ Rejected — no attempts left today</Text>
            <Text style={s.goalText}>{reject.reason}</Text>
          </View>
          <Text style={s.h2}>Appeal once</Text>
          <Text style={s.lede}>Think the judge got it wrong? Explain why this should count — a reviewer takes a second, more generous look at the same photo.</Text>
          <TextInput style={[s.input, { height: 90, textAlignVertical: "top" }]} multiline
            placeholder="e.g. The book is open on my desk and my hand shows 4 fingers on the left."
            placeholderTextColor={C.faint} value={note} onChangeText={setNote} />
          {reject.submissionId
            ? <Btn label={appealBusy ? "Reviewing…" : "Submit appeal →"} onPress={submitAppeal} disabled={appealBusy} />
            : <Text style={s.note}>This attempt can't be appealed.</Text>}
          <BtnGhost label="No, go back" onPress={onDone} disabled={appealBusy} />
        </>
      ) : !scheduled ? (
        <View style={[s.card, { borderColor: C.line, alignItems: "center" }]}>
          <Text style={[s.kicker, { color: C.mute }]}>📅 Not scheduled today</Text>
          <Text style={s.note}>This goal runs only on your chosen days. Come back then.</Text>
          <BtnGhost label="Back" onPress={onBack} />
        </View>
      ) : late ? (
        <View style={[s.card, { borderColor: C.red, alignItems: "center" }]}>
          <Text style={[s.kicker, { color: C.red }]}>⏰ Deadline passed</Text>
          <Text style={s.note}>You missed today's {deadline} cutoff. Come back tomorrow before then.</Text>
          <BtnGhost label="Back" onPress={onBack} />
        </View>
      ) : (
        // First attempt, or a reject with attempts still left → let them retry.
        <>
          {reject ? (
            <View style={[s.card, { borderColor: C.red }]}>
              <Text style={[s.kicker, { color: C.red }]}>❌ Rejected — try again</Text>
              <Text style={s.goalText}>{reject.reason}</Text>
              {typeof reject.attemptsLeft === "number"
                ? <Text style={s.note}>{reject.attemptsLeft} attempt{reject.attemptsLeft === 1 ? "" : "s"} left today, then you can appeal.</Text>
                : null}
            </View>
          ) : null}
          <Btn label={reject ? "📷 Retake photo" : "📷 Take a photo"} onPress={() => takeAndJudge(false)} disabled={busy || checkState !== "ok"} />
          <BtnGhost label="📁 Choose from gallery" onPress={() => takeAndJudge(true)} disabled={busy || checkState !== "ok"} />
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
  const badges = [];
  for (const g of goals) for (const m of MILESTONES) if ((g.best_streak || 0) >= m) badges.push({ key: g.id + "-" + m, days: m, title: g.text });
  badges.sort((a, b) => b.days - a.days);
  const byDay = {};
  for (const s of subs) {
    if (s.status === "approved" || s.status === "frozen") byDay[s.day] = "approved";
    else if (!byDay[s.day]) byDay[s.day] = "rejected";
  }
  return { approved, rejected, approvalRate, bestStreak, badges, byDay };
}

function Heatmap({ byDay }) {
  const days = lastNDays(84); // 12 weeks
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const cellColor = (st) => (st === "approved" ? C.bronze : st === "rejected" ? "rgba(226,59,46,0.5)" : "#1c1922");
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

function Stats({ goals, subs, onOpenBadge }) {
  const st = computeStats(goals, subs);
  const windowVerified = lastNDays(84).filter((d) => st.byDay[d] === "approved").length;
  const thisWeek = lastNDays(7).filter((d) => st.byDay[d] === "approved").length;
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}>
      <Text style={s.h2}>Your stats</Text>

      <View style={s.statRow}>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.approved}</Text><Text style={s.statLabel}>verified days</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.bestStreak}</Text><Text style={s.statLabel}>best streak</Text></View>
        <View style={s.statBox}><Text style={s.statNum} numberOfLines={1} adjustsFontSizeToFit>{st.approvalRate === null ? "—" : st.approvalRate + "%"}</Text><Text style={s.statLabel}>approval</Text></View>
      </View>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <Text style={s.kicker}>Last 12 weeks</Text>
          <Text style={s.note}>{windowVerified} verified · {thisWeek}/7 this week</Text>
        </View>
        <Heatmap byDay={st.byDay} />
        <View style={{ flexDirection: "row", gap: 14, marginTop: 14 }}>
          <Legend color={C.bronze} label="verified" />
          <Legend color="rgba(226,59,46,0.5)" label="rejected" />
          <Legend color="#1c1922" label="none" />
        </View>
      </View>

      <Text style={[s.kicker, { color: C.bronze, marginTop: 20, marginBottom: 8 }]}>🏆 Trophy shelf · {st.badges.length}</Text>
      {st.badges.length === 0 ? (
        <Text style={s.note}>Hit a 7, 30 or 100-day verified streak to earn shareable badges.</Text>
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
  if (ch.goal_type === "one_time") return "One-time";
  return ch.goal_format === "3x" ? "3× / week" : ch.goal_format === "5x" ? "5× / week" : "Daily";
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
  const load = useCallback(async () => {
    const { data } = await supabase.from("challenge_members").select("challenge_id, final_rank, challenges(*)").order("joined_at", { ascending: false });
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <ScrollView contentContainerStyle={[s.wrap, { paddingBottom: 96 }]}>
      <Text style={s.h2}>Challenges</Text>
      <Text style={s.lede}>Compete with friends on one shared goal. Last place spins the wheel of fortune.</Text>
      <Btn label="+ Create a challenge" onPress={onCreate} />
      <BtnGhost label="Join by code" onPress={onJoin} />
      {rows === null ? <ActivityIndicator color={C.bronze} style={{ marginTop: 24 }} /> : (() => {
        const mems = (rows || []).filter((m) => m.challenges);
        const isEnded = (ch) => ch.status === "ended" || Date.now() >= new Date(ch.ends_at).getTime();
        const active = mems.filter((m) => !isEnded(m.challenges));
        const past = mems.filter((m) => isEnded(m.challenges));
        if (mems.length === 0) return <Text style={[s.note, { marginTop: 18 }]}>No challenges yet. Create one and share the code with friends.</Text>;
        return (
          <>
            {active.map((m) => {
              const ch = m.challenges;
              return (
                <TouchableOpacity key={ch.id} style={s.card} onPress={() => onOpen(ch.id)}>
                  <Text style={s.goalText}>{ch.title}</Text>
                  <Text style={s.note}>🟢 {timeLeft(ch.ends_at)} · code {ch.code}</Text>
                </TouchableOpacity>
              );
            })}
            {past.length > 0 ? (
              <>
                <TouchableOpacity style={s.historyHead} onPress={() => setShowHistory((v) => !v)} activeOpacity={0.7}>
                  <Ionicons name="time-outline" size={16} color={C.mute} />
                  <Text style={[s.kicker, { flex: 1 }]}>History · {past.length}</Text>
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
                          <Text style={s.note}>🏁 Ended{ch.dare ? " · wheel spun" : ""}</Text>
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

function CreateChallenge({ onCreated, onBack }) {
  const [goalText, setGoalText] = useState("");
  const [name, setName] = useState("");
  const [hasProfileName, setHasProfileName] = useState(false);
  const [dur, setDur] = useState(7);
  const [type, setType] = useState("recurring"); // recurring | one_time
  const [format, setFormat] = useState("daily");  // daily | 3x | 5x
  const [oneTimeDeadline, setOneTimeDeadline] = useState(null); // Date|null, for one_time
  const [judgeMode, setJudgeMode] = useState("ai"); // ai | peer
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadMyName().then((n) => { if (n) { setName(n); setHasProfileName(true); } }); }, []);
  async function create() {
    if (goalText.trim().length < 3) return Alert.alert("Cert", "Describe the shared goal.");
    if (!name.trim()) return Alert.alert("Cert", "Enter your name for the leaderboard.");
    if (type === "one_time" && !oneTimeDeadline) return Alert.alert("Cert", "Pick a deadline date & time.");
    setBusy(true);
    try {
      if (!hasProfileName) await saveMyName(name.trim());
      const { data, error } = await supabase.functions.invoke("challenge", { body: {
        action: "create", title: goalText.trim(), goalText: goalText.trim(), durationDays: dur,
        name: name.trim(), goalType: type, goalFormat: format, judgeMode,
        endsAt: type === "one_time" && oneTimeDeadline ? oneTimeDeadline.toISOString() : null,
      } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      onCreated(data.challenge.id);
    } catch (e) { Alert.alert("Cert", e.message || "Couldn't create challenge."); }
    finally { setBusy(false); }
  }
  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <BackBar onBack={onBack} />
      <Text style={s.h2}>Create a challenge</Text>
      {hasProfileName
        ? <Text style={[s.note, { marginTop: 4 }]}>Playing as <Text style={{ color: C.bronze, fontWeight: "800" }}>{name}</Text> · change it in Profile</Text>
        : (<>
            <Text style={s.label}>Your name (shown on leaderboard)</Text>
            <TextInput style={s.input} placeholder="e.g. Zhanibek" placeholderTextColor={C.faint} value={name} onChangeText={(t) => setName(t.replace(/\n/g, " "))} />
          </>)}
      <Text style={[s.label, { marginTop: 14 }]}>The shared goal everyone does</Text>
      <TextInput style={[s.input, { height: 80, textAlignVertical: "top" }]} multiline blurOnSubmit returnKeyType="done" placeholder="e.g. Gym 45 min, photo with equipment" placeholderTextColor={C.faint} value={goalText} onChangeText={(t) => setGoalText(t.replace(/\n/g, " "))} />

      <Text style={[s.label, { marginTop: 14 }]}>Type</Text>
      <View style={s.rowGap}>
        <Pill label="Repeating" active={type === "recurring"} onPress={() => setType("recurring")} />
        <Pill label="One-time" active={type === "one_time"} onPress={() => setType("one_time")} />
      </View>

      {type === "recurring" ? (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>How often?</Text>
          <View style={s.rowGap}>
            <Pill label="Daily" active={format === "daily"} onPress={() => setFormat("daily")} />
            <Pill label="3× / week" active={format === "3x"} onPress={() => setFormat("3x")} />
            <Pill label="5× / week" active={format === "5x"} onPress={() => setFormat("5x")} />
          </View>
        </>
      ) : null}

      {type === "one_time" ? (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>Deadline (date & time)</Text>
          <DateTimeField value={oneTimeDeadline} onChange={setOneTimeDeadline} placeholder="Pick deadline" />
          <Text style={s.note}>The challenge ends at this moment. Last place spins the wheel.</Text>
        </>
      ) : (
        <>
          <Text style={[s.label, { marginTop: 14 }]}>How long?</Text>
          <View style={s.rowGap}>
            {[7, 14, 30].map((d) => <Pill key={d} label={d + " days"} active={dur === d} onPress={() => setDur(d)} />)}
          </View>
        </>
      )}

      <Text style={[s.label, { marginTop: 14 }]}>Who judges proofs?</Text>
      <View style={s.rowGap}>
        <Pill label="AI judge" active={judgeMode === "ai"} onPress={() => setJudgeMode("ai")} />
        <Pill label="Friends vote" active={judgeMode === "peer"} onPress={() => setJudgeMode("peer")} />
      </View>
      <Text style={s.note}>{judgeMode === "peer" ? "Members swipe to approve/decline each other's photos." : "The AI judge checks each photo automatically."}</Text>

      <Btn label={busy ? "Creating…" : "Create & get code →"} onPress={create} disabled={busy} />
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
    if (code.trim().length < 4) return Alert.alert("Cert", "Enter the challenge code.");
    if (!name.trim()) return Alert.alert("Cert", "Enter your name for the leaderboard.");
    setBusy(true);
    try {
      if (!hasProfileName) await saveMyName(name.trim());
      const { data, error } = await supabase.functions.invoke("challenge", { body: { action: "join", code: code.trim(), name: name.trim() } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error === "not_found" ? "No challenge with that code." : data.error);
      onJoined(data.challenge.id);
    } catch (e) { Alert.alert("Cert", e.message || "Couldn't join."); }
    finally { setBusy(false); }
  }
  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <BackBar onBack={onBack} />
      <Text style={s.h2}>Join a challenge</Text>
      <Text style={s.label}>Challenge code</Text>
      <TextInput style={s.input} placeholder="ABC123" placeholderTextColor={C.faint} autoCapitalize="characters" value={code} onChangeText={setCode} />
      {hasProfileName
        ? <Text style={[s.note, { marginTop: 12 }]}>Joining as <Text style={{ color: C.bronze, fontWeight: "800" }}>{name}</Text> · change it in Profile</Text>
        : (<>
            <Text style={[s.label, { marginTop: 14 }]}>Your name (shown on leaderboard)</Text>
            <TextInput style={s.input} placeholder="e.g. Zhanibek" placeholderTextColor={C.faint} value={name} onChangeText={(t) => setName(t.replace(/\n/g, " "))} />
          </>)}
      <Btn label={busy ? "Joining…" : "Join →"} onPress={join} disabled={busy} />
    </ScrollView>
  );
}

function ChallengeDetail({ challengeId, onSubmitProof, onReview, onSharePlacement, onBack }) {
  const [board, setBoard] = useState(null);
  const [peerBusy, setPeerBusy] = useState(false);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [wheelPreview, setWheelPreview] = useState(false);
  const [landIndex, setLandIndex] = useState(null);   // slice the wheel settles on
  const [revealed, setRevealed] = useState(null);     // dare text shown after the spin
  const [spinningWheel, setSpinningWheel] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke("challenge", { body: { action: "board", challengeId } });
    if (error || data?.error) { Alert.alert("Cert", data?.error || error?.message || "Couldn't load."); return; }
    setBoard(data);
  }, [challengeId]);
  useEffect(() => { load(); }, [load]);

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
    if (!perm.granted) return Alert.alert("Cert", "Camera permission needed.");
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.4 });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    const a = res.assets[0];
    const photo = `data:${a.mimeType || "image/jpeg"};base64,${a.base64}`;
    setPeerBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("challenge", { body: { action: "submit", challengeId, photo } });
      if (error) throw error;
      if (data?.error) { Alert.alert("Cert", data.error === "already_today" ? "You've already submitted today." : String(data.error)); return; }
      Alert.alert("Cert", "Sent! Your friends will vote on it. 🗳️");
      await load();
    } catch (e) { Alert.alert("Cert", e.message || "Couldn't submit."); }
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
    Alert.alert("End challenge now?", "Ends it for everyone and locks the leaderboard. Last place spins the wheel.", [
      { text: "Cancel", style: "cancel" },
      { text: "End now", style: "destructive", onPress: async () => {
        const { data } = await supabase.functions.invoke("challenge", { body: { action: "end", challengeId } });
        if (data?.ok) await load();
        else Alert.alert("Cert", data?.error || "Couldn't end the challenge.");
      } },
    ]);
  }
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <BackBar onBack={onBack} />
      <Text style={s.h2}>{ch.title}</Text>
      <View style={s.card}>
        <Text style={s.goalText}>{ch.goal_text}</Text>
        <Text style={[s.note, { textAlign: "left" }]}>{cadenceLabel(ch)} · {board.ended ? "🏁 Ended" : "🟢 " + timeLeft(ch.ends_at)}</Text>
        <Text style={[s.note, { textAlign: "left" }]}>share code <Text style={{ color: C.bronze, fontWeight: "800", letterSpacing: 1 }}>{ch.code}</Text></Text>
      </View>
      <BtnGhost label="🔗 Share invite link" onPress={shareInvite} />

      {board.members.map((m) => (
        <View key={m.userId} style={[s.lbRow, m.isMe && { borderColor: C.bronze }]}>
          <Text style={s.lbRank}>{medal(m.rank)}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.lbName}>{m.name}{m.isMe ? " (you)" : ""}</Text>
            <Text style={s.note}>{m.verifiedDays} verified · {m.streak}{isWk ? "w" : "d"} streak</Text>
          </View>
          {board.ended && board.loser && board.loser.userId === m.userId ? <Text style={s.lbLast}>LAST</Text> : null}
        </View>
      ))}

      {!board.ended && board.myGoal ? (
        board.weekly && board.weekly.weekDone ? (
          <View style={[s.card, { borderColor: C.green, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.green }]}>✅ Week complete · {board.weekly.thisWeek}/{board.weekly.quota}</Text>
            <Text style={s.note}>You hit this week's target. Come back next week.</Text>
          </View>
        ) : board.awaitingVotes ? (
          <View style={[s.card, { borderColor: C.bronze, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.bronze }]}>🗳️ Awaiting friends' votes</Text>
            <Text style={s.note}>Your proof is in the queue. It counts once a friend approves it.</Text>
          </View>
        ) : board.doneToday ? (
          <View style={[s.card, { borderColor: C.green, alignItems: "center" }]}>
            <Text style={[s.kicker, { color: C.green }]}>{board.myGoal.status === "completed" ? "✅ Goal completed" : "✅ Done for today"}</Text>
            <Text style={s.note}>{board.myGoal.status === "completed" ? "You finished this challenge goal." : board.weekly ? `This week: ${board.weekly.thisWeek}/${board.weekly.quota}. Come back another day.` : "Come back tomorrow to keep your lead."}</Text>
          </View>
        ) : (
          <>
            {board.weekly ? <Text style={[s.note, { textAlign: "center", marginTop: 14 }]}>This week: {board.weekly.thisWeek}/{board.weekly.quota} done</Text> : null}
            {board.judgeMode === "peer"
              ? <Btn label={peerBusy ? "Sending…" : "📷 Submit for friends to judge"} onPress={submitPeer} disabled={peerBusy} />
              : <Btn label="📷 Submit today's proof" onPress={() => onSubmitProof(board.myGoal)} />}
          </>
        )
      ) : null}

      {!board.ended && board.judgeMode === "peer" && board.pendingForMe > 0
        ? <Btn label={`🗳️ Review friends' proofs (${board.pendingForMe})`} onPress={onReview} />
        : null}

      {!board.ended && board.isHost ? <BtnGhost label="🏁 End challenge now (host)" onPress={endNow} /> : null}
      <BtnGhost label="🎰 Preview the wheel" onPress={previewWheel} />

      {board.ended ? (
        <View style={[s.card, { borderColor: C.red, marginTop: 18 }]}>
          {board.dare ? (
            <>
              <Text style={[s.kicker, { color: C.red }]}>🎰 Wheel of fortune</Text>
              <Text style={s.goalText}>{board.loser ? board.loser.name : "Last place"} must:</Text>
              <Text style={[s.h2, { color: C.bronze }]}>{board.dare}</Text>
              <BtnGhost label="🎰 Replay the spin" onPress={openResultWheel} />
            </>
          ) : board.canSpin ? (
            <>
              <Text style={[s.kicker, { color: C.red }]}>You came last 😅</Text>
              <Text style={s.lede}>Spin the wheel of fortune and accept your dare.</Text>
              <Btn label="🎰 Spin the wheel" onPress={openSpinWheel} />
            </>
          ) : (
            <>
              <Text style={[s.kicker, { color: C.bronze }]}>🏆 Winner: {board.members[0]?.name}</Text>
              <Text style={s.note}>Waiting for last place to spin the wheel…</Text>
            </>
          )}
        </View>
      ) : null}

      {board.ended ? (
        <Btn label="🏆 Share your placement" onPress={() => onSharePlacement((board.members.find((m) => m.isMe)?.rank) || board.members.length, ch.goal_text)} />
      ) : null}

      {/* Wheel of fortune — spinning modal (auto-opens once when an ended challenge loads) */}
      <Modal visible={wheelOpen} transparent animationType="fade" onRequestClose={closeWheel}>
        <View style={s.wheelBackdrop}>
          <Text style={s.wheelTitle}>🎰 Wheel of fortune</Text>
          <Text style={s.wheelSub}>
            {wheelPreview ? "Preview — what a spin looks like"
              : board?.loser ? `${board.loser.name}${board.loser.isMe ? " (you)" : ""} finished last`
              : "Spin for your dare"}
          </Text>
          <View style={s.wheelStage}>
            <View style={s.wheelPointer} />
            <WheelOfFortune landIndex={landIndex} />
          </View>
          {revealed ? (
            <View style={s.wheelResult}>
              <Text style={[s.kicker, { color: C.red, textAlign: "center" }]}>{wheelPreview ? "Could be…" : "The dare"}</Text>
              <Text style={s.wheelDare}>{revealed}</Text>
            </View>
          ) : null}
          <View style={{ width: "100%", maxWidth: 320, marginTop: 18 }}>
            {(!wheelPreview && board?.canSpin && !revealed)
              ? <Btn label={spinningWheel ? "Spinning…" : "🎰 Spin the wheel"} onPress={doSpin} disabled={spinningWheel} />
              : null}
            {(revealed || wheelPreview || (!board?.canSpin))
              ? <BtnGhost label={revealed ? "Done" : "Close"} onPress={closeWheel} disabled={spinningWheel} />
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
      <Text style={s.h2}>Review proofs</Text>
      {!current ? (
        <View style={[s.card, { alignItems: "center", marginTop: 24 }]}>
          <Text style={s.h2}>All caught up 🎉</Text>
          <Text style={[s.lede, { textAlign: "center" }]}>No proofs waiting for your vote right now.</Text>
          <Btn label="Back" onPress={onBack} />
        </View>
      ) : (
        <>
          <View style={{ position: "relative", justifyContent: "center" }}>
            {/* swipe affordance: arrows hint which way to drag */}
            <View pointerEvents="none" style={[s.swipeHint, { left: 2 }]}>
              <Ionicons name="arrow-back-circle" size={30} color={C.red} />
              <Text style={[s.swipeHintT, { color: C.red }]}>Decline</Text>
            </View>
            <View pointerEvents="none" style={[s.swipeHint, { right: 2 }]}>
              <Ionicons name="arrow-forward-circle" size={30} color={C.green} />
              <Text style={[s.swipeHintT, { color: C.green }]}>Approve</Text>
            </View>
            <Animated.View {...panResponder.panHandlers} style={[s.swipeCard, { transform: [{ translateX: pan.x }, { translateY: pan.y }, { rotate }] }]}>
              <Animated.View style={[s.swipeStamp, { borderColor: C.green, left: 16, opacity: okOpacity }]}><Text style={[s.swipeStampT, { color: C.green }]}>APPROVE</Text></Animated.View>
              <Animated.View style={[s.swipeStamp, { borderColor: C.red, right: 16, opacity: noOpacity }]}><Text style={[s.swipeStampT, { color: C.red }]}>DECLINE</Text></Animated.View>
              {current.photoUrl
                ? <Image source={{ uri: current.photoUrl }} style={s.swipePhoto} resizeMode="cover" />
                : <View style={[s.swipePhoto, { alignItems: "center", justifyContent: "center" }]}><Text style={s.note}>no photo</Text></View>}
              <Text style={[s.lbName, { marginTop: 12 }]}>{current.name}</Text>
              <Text style={s.note}>{current.goalText} · {current.day}</Text>
            </Animated.View>
          </View>
          <View style={{ flexDirection: "row", gap: 14, marginTop: 16 }}>
            <View style={{ flex: 1 }}><BtnGhost label="✕ Decline" onPress={() => swipe("left")} /></View>
            <View style={{ flex: 1 }}><Btn label="✓ Approve" onPress={() => swipe("right")} /></View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 6 }}>
            <Ionicons name="swap-horizontal" size={16} color={C.faint} />
            <Text style={s.note}>Swipe the photo · {queue.length - idx} left</Text>
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
        <Text style={[s.chipText, value && { color: C.ink }]}>🕐 {value || placeholder}</Text>
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

const s = StyleSheet.create({
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
  input: { backgroundColor: "#0d0c11", borderWidth: 1, borderColor: "#2a2731", borderRadius: 10, color: C.ink, fontSize: 16, padding: 14 },
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
  shareBrand: { color: C.ink, fontSize: 22, fontWeight: "800", letterSpacing: 5 },
  shareVerified: { color: C.bronze, fontSize: 12, fontWeight: "800", letterSpacing: 1, borderWidth: 1, borderColor: C.bronze, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  shareKicker: { color: C.mute, fontSize: 13, letterSpacing: 3, fontWeight: "700", marginBottom: 4 },
  shareDays: { color: C.bronze, fontSize: 120, fontWeight: "800", lineHeight: 124 },
  shareDaysLabel: { color: C.ink, fontSize: 15, letterSpacing: 4, fontWeight: "700" },
  shareNotFaked: { color: C.red, fontSize: 14, letterSpacing: 3, fontWeight: "800", marginTop: 14 },
  shareGoal: { color: C.ink, fontSize: 22, fontWeight: "800", lineHeight: 28, marginBottom: 12 },
  shareTagline: { color: C.faint, fontSize: 13, lineHeight: 18 },
});
