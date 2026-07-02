// =====================================================================
// CERT — RevenueCat client wrapper.
// Freezes are a CONSUMABLE anyone can buy (including free users); Pro is a
// subscription. The store tells our backend what was bought via the
// revenuecat-webhook Edge Function, which is the ONLY thing that credits
// profiles.freezes / sets profiles.plan. This file just drives the native
// purchase sheet and identifies the user to RevenueCat.
//
// react-native-purchases is a NATIVE module → needs a dev client / EAS build
// (it won't run in plain Expo Go). We lazy-require it so the rest of the app
// still loads if it isn't installed yet; callers get a friendly error.
//
// Install:  npx expo install react-native-purchases
// =====================================================================
import { Platform } from "react-native";
import {
  REVENUECAT_IOS_KEY, REVENUECAT_ANDROID_KEY,
  FREEZE_PACK_PRODUCTS, PRO_PRODUCTS,
} from "./config";

let Purchases = null;
let configured = false;

function load() {
  if (Purchases) return Purchases;
  try { Purchases = require("react-native-purchases").default; }
  catch (_) { Purchases = null; }
  return Purchases;
}

export function purchasesEnabled() {
  const key = Platform.OS === "ios" ? REVENUECAT_IOS_KEY : REVENUECAT_ANDROID_KEY;
  return !!key && !!load();
}

// Call once after login. appUserID = Supabase user id so the webhook's
// event.app_user_id maps straight to profiles.id.
export async function initPurchases(supabaseUserId) {
  const P = load();
  if (!P) return false;
  const key = Platform.OS === "ios" ? REVENUECAT_IOS_KEY : REVENUECAT_ANDROID_KEY;
  if (!key) return false;
  if (!configured) { P.configure({ apiKey: key, appUserID: supabaseUserId }); configured = true; }
  else { try { await P.logIn(supabaseUserId); } catch (_) { /* ignore */ } }
  return true;
}

// Returns the store products we care about, split into freeze packs + pro.
export async function getProducts() {
  const P = load();
  if (!P) throw new Error("payments_unavailable");
  const ids = [...FREEZE_PACK_PRODUCTS, ...PRO_PRODUCTS];
  const products = await P.getProducts(ids);
  return {
    freezePacks: products.filter((p) => FREEZE_PACK_PRODUCTS.includes(p.identifier)),
    pro: products.filter((p) => PRO_PRODUCTS.includes(p.identifier)),
  };
}

// Buy a product by identifier. The webhook credits the account server-side;
// we just need the purchase to go through. Returns true on success, false if
// the user cancelled. Throws on real errors.
export async function buyProduct(productId) {
  const P = load();
  if (!P) throw new Error("payments_unavailable");
  const products = await P.getProducts([productId]);
  if (!products.length) throw new Error("product_not_found");
  try {
    await P.purchaseStoreProduct(products[0]);
    return true;
  } catch (e) {
    if (e && e.userCancelled) return false;
    throw e;
  }
}

export async function restorePurchases() {
  const P = load();
  if (!P) throw new Error("payments_unavailable");
  return await P.restorePurchases();
}
