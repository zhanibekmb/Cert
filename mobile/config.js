// Paste your Supabase project values here.
// Supabase Dashboard → Project Settings → API
export const SUPABASE_URL = "https://hiydsiiuzpneykbjddsr.supabase.co";        // base project URL — NO /rest/v1/ on the end
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpeWRzaWl1enBuZXlrYmpkZHNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyOTcwOTUsImV4cCI6MjA5Nzg3MzA5NX0.x1-PnDgiyn8wohw4nymhiSuBUe1v2byFQhoUC0fmFiE";   // the "anon public" key (safe to ship in the app)

// RevenueCat (payments). Dashboard → Project → API keys → "Public app-specific".
// Leave empty to keep purchases disabled (the UI shows "payments not configured").
export const REVENUECAT_IOS_KEY = "appl_jFdSFoCwbDAFSjdVGXnzcxcMzmK";      // appl_xxx
export const REVENUECAT_ANDROID_KEY = "goog_UjMToAwyMgreizfJiDxSwmWoBXc";  // goog_xxx

// Product / package identifiers — must match RevenueCat AND the
// revenuecat-webhook FREEZE_PACKS / PRO_PRODUCTS maps.
export const FREEZE_PACK_PRODUCTS = ["freeze_pack_3"]; // consumable (free users too) — freeze_pack_10 removed (too much for one pack)
export const PRO_PRODUCTS = ["cert_pro_monthly", "cert_pro_yearly"];     // subscription
