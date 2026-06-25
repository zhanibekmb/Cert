# Cert — mobile app (Expo / React Native)

The product runs here (the website is just the landing). One codebase →
iPhone + Android. You develop on **Windows** and test on your real phone.

## What it does (v1)
- Sign in with an email **one-time code** (Google comes next).
- See your goals + streak, create a goal (AI suggests what photo to send).
- Submit a daily photo → the **judge** Edge Function (Gemini) approves/rejects
  → your streak updates. Finishing a goal mints a **Cert**.

---

## Run it on Windows (first time)

You need **Node.js** and the **Expo Go** app on your phone. No Android Studio /
Xcode required.

1. **Install Node.js LTS** (if you don't have it): https://nodejs.org → download
   the LTS installer → next-next-finish. Reopen your terminal after.

2. **Install Expo Go on your phone** (the app that runs your project):
   - iPhone: App Store → "Expo Go".
   - Android: Play Store → "Expo Go".

3. **Add your Supabase keys.** Open `mobile/config.js` and paste your
   **Project URL** and **anon key** (Supabase → Project Settings → API).

4. **Install + start** (in a terminal):
   ```powershell
   cd "C:\Users\janib\OneDrive\Рабочий стол\Cert\mobile"
   npm install
   npx expo install --fix    # aligns package versions to your Expo SDK
   npx expo start
   ```

5. A **QR code** appears in the terminal.
   - iPhone: open the **Camera** app, point at the QR → tap the banner → it opens in Expo Go.
   - Android: open **Expo Go** → "Scan QR code".
   - Your phone and PC must be on the **same Wi-Fi**. If it won't connect, run
     `npx expo start --tunnel` instead.

6. The app loads on your phone. Sign in with your email → enter the 6-digit code.

> Edit any file and save → the app reloads on your phone instantly (Fast Refresh).

---

## Notes
- **Backend:** all data + auth + the AI judge live in Supabase (see `../SUPABASE.md`).
  Make sure you ran the SQL migration and deployed the `judge` + `proof-spec`
  functions, and set the `GEMINI_API_KEY` secret.
- **Google sign-in:** added in a later step (needs a deep-link redirect setup).
  Email code works today with zero extra config.
- **Building real App Store / Play Store binaries:** later, via `eas build`
  (Expo's cloud build — works from Windows, no Mac needed).
