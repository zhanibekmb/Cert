# Cert — mobile app (Expo / React Native)

The product runs here (the website is just the landing). One codebase →
iPhone + Android. You develop on **Windows** and test on your real phone.

## What it does (v1)
- Sign up / sign in with **email + password**, or **Continue with Google**.
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

## Auth setup (one-time, in the dashboards)

The app code is done. To make sign-in actually work, configure the providers:

### Email + password
1. Supabase → **Authentication → Providers → Email** → make sure it's **enabled**.
2. **Confirm email** (same screen):
   - **On** (recommended for production): after sign-up the user must tap the
     link in their email. The app handles that link via the `cert://` deep link
     and signs them in automatically.
   - **Off** (fastest for testing): sign-up logs them straight in, no email step.
3. Supabase → **Authentication → URL Configuration → Redirect URLs**, add the
   app's deep links so confirmation / reset links return to the app:
   - `cert://` (real build)
   - `exp://` *and* the LAN URL Expo prints, e.g. `exp://192.168.1.20:8081/--/*`
     (only needed while testing in **Expo Go**).

> The exact redirect URL the app uses is `Linking.createURL("/")`. If a link
> won't open the app, log that value and paste it into the Redirect URLs list.

### Google
1. **Google Cloud Console** → create an **OAuth 2.0 Client ID** (type: *Web
   application*). Under *Authorized redirect URIs* add Supabase's callback:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`
   (your ref is `hiydsiiuzpneykbjddsr`).
2. Copy the **Client ID** and **Client secret**.
3. Supabase → **Authentication → Providers → Google** → enable it, paste the
   Client ID + secret, save.
4. Make sure the redirect URLs from the Email section above are also present
   (Google returns through the same `cert://` / `exp://` deep link).

> **Expo Go vs real build:** Google OAuth opens a browser tab and returns via
> the deep link. In **Expo Go** the redirect is `exp://…` (add it to Supabase).
> In a real **EAS build** it's `cert://`. Both are handled in code.

## Notes
- **Backend:** all data + auth + the AI judge live in Supabase (see `../SUPABASE.md`).
  Make sure you ran the SQL migration and deployed the `judge` + `proof-spec`
  functions, and set the `GEMINI_API_KEY` secret.
- **Building real App Store / Play Store binaries:** later, via `eas build`
  (Expo's cloud build — works from Windows, no Mac needed).
