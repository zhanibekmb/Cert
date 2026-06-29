# Going native (EAS) — Cert mobile

We are leaving **Expo Go** and moving to an **EAS Dev Client**. This is required for:

- 🔒 **App-lock on a failed day** (iOS Screen Time API / Android accessibility) — native, can't run in Expo Go.
- 🎞️ **Real timelapse video export** (the in-app reel works today; exporting an `.mp4` needs native).
- 📲 **Shipping to the App Store / Google Play** at all.

You still write JS/React the same way and still get Fast Refresh. The only change: instead of the Expo Go app, you install a **custom dev build of Cert** once, then run `npx expo start --dev-client`.

---

## One-time setup

```powershell
cd "C:\Users\janib\OneDrive\Рабочий стол\Cert\mobile"

# 1. EAS CLI + login (free Expo account)
npm i -g eas-cli
eas login

# 2. Link this project (writes the EAS projectId into app.json -> extra.eas.projectId)
eas init

# 3. Add the dev-client runtime
npx expo install expo-dev-client
```

## Build the dev client (do this once per platform, rebuild only when native deps change)

```powershell
# Android first (no Mac needed, installs as an .apk on your phone)
eas build --profile development --platform android

# iOS (needs an Apple Developer account, $99/yr; build runs in Expo's cloud, no Mac needed)
eas build --profile development --platform ios
```

Install the build on your phone from the link EAS prints, then daily dev is:

```powershell
npx expo start --dev-client
```

## Production / store builds (later)

```powershell
eas build --profile production --platform android
eas build --profile production --platform ios
eas submit  --profile production --platform ios   # uploads to App Store Connect
```

---

## The app-lock feature (Phase 2 — flagship)

> Miss your goal → the social apps you chose are blocked until you make it up.

### iOS — Screen Time API
1. **Request the entitlement from Apple** (long lead time — start now):
   `com.apple.developer.family-controls` via the Apple Developer "Account → Contact" / distribution request form. Without it, App Store builds with Family Controls are rejected.
2. Add the wrapper module: `npx expo install react-native-device-activity`
   (wraps `FamilyControls` + `ManagedSettings` + `DeviceActivity`).
3. The user authorizes Family Controls once, then **picks which apps to lock** via Apple's system picker (`FamilyActivityPicker`) — we get opaque tokens, never the app identities. On a failed day we **shield** that set; on make-up we unshield.
4. Add the entitlement + an extension target in the EAS build config (config plugin).

### Android — accessibility / overlay
- No Screen Time API. We detect the foreground app via an **Accessibility Service** and draw a block overlay (`SYSTEM_ALERT_WINDOW`), the AppBlock/Stay-Focused approach.
- Needs a small custom native module + a clear Play Store data-safety/accessibility disclosure.

Both are real work (weeks, per-platform) — tracked as the next milestone after streaks + reel + geolocation.
