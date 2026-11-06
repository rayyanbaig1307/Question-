import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

import { runAfterSignOut, useMe } from './auth';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Peekaboo+ ⭐ – who has it, and buying it.
//
// Someone has Peekaboo+ when any of these is true:
//  1. they are one of the testers below (the owner, so every Plus feature can be tried for free),
//  2. the App Store says they're paying (RevenueCat tells the app on the phone), or
//  3. the server says so: public.plus_members has their row and it hasn't run out yet. The RevenueCat
//     webhook (supabase/functions/revenuecat-webhook) keeps that table up to date.
//
// Paying works on iPhone only for now (Peekaboo isn't on Google Play yet). Without the RevenueCat key, in
// Expo Go, on Android or on an older download, the Plus screen just says "Peekaboo+ is coming soon".
// ---------------------------------------------------------------------------

// Accounts that always have Plus in the app, for testing. Empty on purpose: the owner (@coolname) asked to be
// taken off (6 Nov 2026) so he can test buying the subscription like everyone else. An App Store reviewer must
// also see the real paywall, so keep this empty for release builds.
const TESTERS = new Set<string>([]);

// Names used in App Store Connect and RevenueCat.
const ENTITLEMENT = 'plus';
const OFFERING = 'default';

// RevenueCat's "public" iPhone key (it starts with "appl_"). It's not a secret – it's built into every copy
// of the app. Until it's set, Peekaboo+ shows "coming soon".
const REVENUECAT_IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '';

const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Asking first, because the payments library crashes if it's loaded without its native part (Expo Go and
// older downloads don't have it).
const Purchases: typeof import('react-native-purchases').default | null =
  Platform.OS === 'ios' &&
  !inExpoGo &&
  REVENUECAT_IOS_KEY &&
  (NativeModules.RNPurchases || TurboModuleRegistry.get('RNPurchases'))
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('react-native-purchases').default
    : null;

type CustomerInfo = import('react-native-purchases').CustomerInfo;
type PurchasesPackage = import('react-native-purchases').PurchasesPackage;

// True when buying Peekaboo+ is possible on this phone.
export const CAN_BUY_PLUS = Purchases !== null;

// ---------------------------------------------------------------------------
// Your own Plus (kept in one place, so every screen updates together).
// ---------------------------------------------------------------------------

type MyPlus = {
  userId: string | null;
  // The App Store says you're paying right now.
  store: boolean;
  // When your Plus runs out according to the server (milliseconds), or null for "no row".
  serverUntil: number | null;
};

let mine: MyPlus = { userId: null, store: false, serverUntil: null };
const watchers = new Set<() => void>();

function setMine(change: Partial<MyPlus>) {
  mine = { ...mine, ...change };
  watchers.forEach((watcher) => watcher());
}

function watchMine(watcher: () => void) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

const storeHasPlus = (info: CustomerInfo) => !!info.entitlements.active[ENTITLEMENT]?.isActive;
const serverHasPlus = (plus: MyPlus) => plus.serverUntil !== null && plus.serverUntil > Date.now();

// Reads your own row in public.plus_members. Any problem (no internet, or the table isn't set up yet)
// simply counts as "no row".
async function loadMyServerPlus(userId: string) {
  let until: number | null = null;
  try {
    const { data, error } = await supabase
      .from('plus_members')
      .select('expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (!error && data?.expires_at) until = new Date(data.expires_at).getTime();
  } catch {
    // counts as no row
  }
  if (mine.userId === userId) setMine({ serverUntil: until });
  remember(userId, until !== null && until > Date.now());
}

// Right after buying (or restoring), the App Store knows at once, but the server only hears it from RevenueCat a
// few seconds later. So we ask the server again after about 2, 5 and 10 seconds. That way the server features
// (who viewed your profile, Peek-a-Save, …) switch on without closing the app.
const SERVER_CHECKS_MS = [2_000, 5_000, 10_000];
let serverChecks: ReturnType<typeof setTimeout>[] = [];

function checkServerSoon(userId: string) {
  serverChecks.forEach((check) => clearTimeout(check));
  serverChecks = SERVER_CHECKS_MS.map((ms) =>
    setTimeout(() => {
      if (mine.userId === userId && !serverHasPlus(mine)) loadMyServerPlus(userId);
    }, ms),
  );
}

// ---------------------------------------------------------------------------
// Which RevenueCat account the phone is using. It must always be the Peekaboo account that is logged in
// (the Supabase user id), so a purchase is credited to the right person and the webhook knows who paid.
// ---------------------------------------------------------------------------

// The Peekaboo account RevenueCat is known to be using right now (null = not sure, or nobody).
// Only set once configure/logIn has really worked, so a failed switch is tried again next time.
let configuredFor: string | null = null;
let configured = false;
let listening = false;

// Account changes, buying and restoring wait in one line, so they never mix (for example, a purchase can't
// start halfway through switching to another account).
let line: Promise<unknown> = Promise.resolve();
function inLine<T>(job: () => Promise<T>): Promise<T> {
  const run = line.then(job);
  line = run.catch(() => {});
  return run;
}

// Uses the App Store's answer only when it's about the person who is logged in. When it says Plus has just
// switched on (bought, a parent said yes, renewed) and the server doesn't know yet, ask the server again soon.
function showStoreInfo(info: CustomerInfo) {
  const userId = configuredFor;
  if (userId === null || userId !== mine.userId) return;
  const store = storeHasPlus(info);
  const switchedOn = store && !mine.store;
  setMine({ store });
  if (switchedOn && !serverHasPlus(mine)) checkServerSoon(userId);
}

// Makes RevenueCat use this Peekaboo account (sets it up the first time, logs in again after a switch).
// Throws if that didn't work. Call it only inside inLine().
async function switchStoreAccount(userId: string): Promise<void> {
  if (!Purchases) return;
  if (!configured) {
    // After an app update reloads the app, RevenueCat is still set up from before, so don't set it up twice.
    if (!(await Purchases.isConfigured())) {
      Purchases.configure({ apiKey: REVENUECAT_IOS_KEY, appUserID: userId });
      configured = true;
      configuredFor = userId;
      return;
    }
    configured = true;
  }
  if ((await Purchases.getAppUserID()) !== userId) {
    // Someone else was using RevenueCat on this phone (another account, or nobody after a logout).
    configuredFor = null;
    const { customerInfo } = await Purchases.logIn(userId);
    configuredFor = userId;
    showStoreInfo(customerInfo);
    return;
  }
  configuredFor = userId;
}

// Call once you're logged in (src/app/(app)/_layout.tsx does). Sets up payments for this account and checks
// whether you have Plus. Never throws.
export async function configurePurchases(userId: string): Promise<void> {
  if (mine.userId !== userId) setMine({ userId, store: false, serverUntil: null });
  loadMyServerPlus(userId);
  if (!Purchases) return;
  const store = Purchases;
  try {
    await inLine(async () => {
      await switchStoreAccount(userId);
      if (!listening) {
        // RevenueCat sends new info whenever something changes (bought, renewed, ran out…).
        store.addCustomerInfoUpdateListener(showStoreInfo);
        listening = true;
      }
      showStoreInfo(await store.getCustomerInfo());
    });
  } catch (error) {
    console.warn('Could not set up Peekaboo+ payments', error);
  }
}

// When someone logs out, RevenueCat stops using their account on this phone. Never throws.
export function logOutPurchases(userId: string): Promise<void> {
  if (mine.userId === userId) setMine({ userId: null, store: false, serverUntil: null });
  serverChecks.forEach((check) => clearTimeout(check));
  serverChecks = [];
  const store = Purchases;
  if (!store) return Promise.resolve();
  return inLine(async () => {
    configuredFor = null;
    try {
      // RevenueCat can't log out when it was never set up, or when it isn't using an account.
      if (!(await store.isConfigured()) || (await store.isAnonymous())) return;
      await store.logOut();
    } catch (error) {
      console.warn('Could not log out of Peekaboo+ payments', error);
    }
  });
}

// src/lib/auth.tsx runs this after every logout on this phone.
runAfterSignOut((userId) => {
  logOutPurchases(userId);
});

// ---------------------------------------------------------------------------
// Who has Plus.
// ---------------------------------------------------------------------------

// Whether someone has Plus, using only what's known right away (testers, and your own Plus once it's loaded).
export function hasPlus(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (TESTERS.has(userId)) return true;
  if (userId === mine.userId) return mine.store || serverHasPlus(mine);
  return cache.get(userId)?.plus ?? false;
}

// True when the person using the app has Peekaboo+.
export function usePlus(): boolean {
  const { userId } = useMe();
  // Re-draws when your Plus changes (the snapshot is the little "mine" object, replaced on every change).
  useSyncExternalStore(watchMine, () => mine);
  return hasPlus(userId);
}

// True when the App Store says you're paying for Peekaboo+ right now (so Apple keeps billing you until you
// cancel – Delete account warns about that).
export function useStorePlus(): boolean {
  const { userId } = useMe();
  const now = useSyncExternalStore(watchMine, () => mine);
  return now.userId === userId && now.store;
}

// True when the server already knows you have Peekaboo+ (the server features check this). Right after
// buying it can still be false for a few seconds.
export function useServerPlus(): boolean {
  const { userId } = useMe();
  const now = useSyncExternalStore(watchMine, () => mine);
  return now.userId === userId && serverHasPlus(now);
}

// ---------------------------------------------------------------------------
// Buying, restoring and the price.
// ---------------------------------------------------------------------------

// The monthly package from the "default" offering in RevenueCat. Only the monthly one, so "/month" on the
// Plus screen is always true. Null when there isn't one.
async function monthlyPackage(): Promise<PurchasesPackage | null> {
  if (!Purchases) return null;
  const offerings = await Purchases.getOfferings();
  const offering = offerings.all[OFFERING] ?? offerings.current;
  return offering?.monthly ?? null;
}

// The price in the person's own money, e.g. "$6.99" or "CA$9.99". Null when it can't be bought here
// (the Plus screen then shows "Couldn't load the price · Retry").
export async function getPlusPrice(): Promise<string | null> {
  try {
    // Wait for payments to be set up first (it starts when you log in).
    await line;
    return (await monthlyPackage())?.product.priceString ?? null;
  } catch (error) {
    console.warn('Could not load the Peekaboo+ price', error);
    return null;
  }
}

// Errors with messages we write ourselves (they're already in plain words). Marked with `plain`, so they're
// shown as they are.
function plainError(message: string): Error {
  return Object.assign(new Error(message), { plain: true });
}
const isPlainError = (error: unknown): error is Error => (error as { plain?: unknown } | null)?.plain === true;

const NOT_FOR_SALE = "Peekaboo+ isn't for sale right now. Please try again later.";
const STORE_TROUBLE = "The App Store couldn't complete this. Try again in a minute.";
// Shown when a parent has to say yes first (Ask to Buy).
export const WAITING_FOR_PARENT = "Waiting for a parent to approve. You'll get Peekaboo+ as soon as it's approved.";

// RevenueCat's error number ("1", "20", …), or null when it isn't a RevenueCat error.
function storeErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return code !== undefined && code !== null && /^\d+$/.test(String(code)) ? String(code) : null;
}

// Turns an App Store / RevenueCat problem into plain words.
function storeErrorText(error: unknown): string {
  if (isPlainError(error)) return error.message;
  const code = storeErrorCode(error);
  if (!Purchases || code === null) return STORE_TROUBLE;
  const CODE = Purchases.PURCHASES_ERROR_CODE;
  switch (code) {
    case CODE.PRODUCT_ALREADY_PURCHASED_ERROR:
      return 'You already have Peekaboo+ – tap Restore purchases.';
    case CODE.RECEIPT_ALREADY_IN_USE_ERROR:
    case CODE.RECEIPT_IN_USE_BY_OTHER_SUBSCRIBER_ERROR:
    case CODE.PURCHASE_BELONGS_TO_OTHER_USER:
      return "This Apple Account's Peekaboo+ is on another Peekaboo account.";
    case CODE.PURCHASE_NOT_ALLOWED_ERROR:
      return 'Purchases are turned off on this iPhone (Screen Time).';
    case CODE.NETWORK_ERROR:
    case CODE.OFFLINE_CONNECTION_ERROR:
      return 'No internet – try again.';
    case CODE.PAYMENT_PENDING_ERROR:
      return WAITING_FOR_PARENT;
    case CODE.OPERATION_ALREADY_IN_PROGRESS_ERROR:
      return 'The App Store is still busy with your last tap. Wait a moment, then try again.';
    // Store problems, set-up problems and anything else.
    default:
      return STORE_TROUBLE;
  }
}

// What happened when you tapped Subscribe:
// - 'bought': paid, and Peekaboo+ is switched on;
// - 'cancelled': you closed Apple's sheet (nothing to say);
// - 'pending': waiting for a parent to say yes (Ask to Buy) – Plus switches on by itself once they do;
// - 'not-active': Apple took it, but Peekaboo+ didn't switch on (yet).
// Any other problem throws an error with a plain message.
export type BuyResult = 'bought' | 'cancelled' | 'pending' | 'not-active';

// Opens Apple's "Subscribe" sheet.
export async function buyPlus(): Promise<BuyResult> {
  const store = Purchases;
  if (!store) throw plainError('Peekaboo+ is coming soon.');
  const userId = mine.userId;
  if (!userId) throw plainError('Log in first to get Peekaboo+.');
  const CODE = store.PURCHASES_ERROR_CODE;
  let result: BuyResult;
  try {
    result = await inLine(async () => {
      // Make sure the purchase goes to the account that is logged in.
      await switchStoreAccount(userId);
      const pack = await monthlyPackage();
      if (!pack) throw plainError(NOT_FOR_SALE);
      const { customerInfo } = await store.purchasePackage(pack);
      showStoreInfo(customerInfo);
      return storeHasPlus(customerInfo) ? 'bought' : 'not-active';
    });
  } catch (error) {
    const code = storeErrorCode(error);
    if (code === CODE.PURCHASE_CANCELLED_ERROR) return 'cancelled';
    if (code === CODE.PAYMENT_PENDING_ERROR) return 'pending';
    if (!isPlainError(error)) console.warn('Peekaboo+ purchase failed', error);
    throw plainError(storeErrorText(error));
  }
  if (mine.userId === userId) {
    loadMyServerPlus(userId);
    checkServerSoon(userId);
  }
  return result;
}

// What "Restore purchases" found: 'restored' (you have Plus now), 'not-found', or 'cancelled' (you closed
// Apple's sign-in).
export type RestoreResult = 'restored' | 'not-found' | 'cancelled';

// "Restore purchases": asks the App Store again for anything you already paid for (new phone, reinstall).
// Any problem throws an error with a plain message.
export async function restorePurchases(): Promise<RestoreResult> {
  const userId = mine.userId;
  if (!userId) return 'not-found';
  const server = loadMyServerPlus(userId);
  const store = Purchases;
  if (store) {
    try {
      await inLine(async () => {
        await switchStoreAccount(userId);
        showStoreInfo(await store.restorePurchases());
      });
    } catch (error) {
      await server;
      if (storeErrorCode(error) === store.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return 'cancelled';
      console.warn('Could not restore Peekaboo+', error);
      throw plainError(storeErrorText(error));
    }
  }
  await server;
  if (mine.userId === userId && mine.store && !serverHasPlus(mine)) checkServerSoon(userId);
  return hasPlus(userId) ? 'restored' : 'not-found';
}

// Where people cancel or change their subscription (Apple's own page).
export const MANAGE_SUBSCRIPTION_URL = 'https://apps.apple.com/account/subscriptions';

// ---------------------------------------------------------------------------
// Other people's ⭐ badge: read from public.plus_members, kept for a few minutes. Lots of rows asking at
// once (a list of people) are put together into one question to the server.
// ---------------------------------------------------------------------------

const CACHE_MINUTES = 10;
const cache = new Map<string, { plus: boolean; at: number }>();
const cacheWatchers = new Map<string, Set<() => void>>();
let waiting = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function remember(userId: string, plus: boolean) {
  cache.set(userId, { plus, at: Date.now() });
  cacheWatchers.get(userId)?.forEach((watcher) => watcher());
}

async function askServer(ids: string[]) {
  const found = new Set<string>();
  try {
    const { data, error } = await supabase
      .from('plus_members')
      .select('user_id')
      .in('user_id', ids)
      .gt('expires_at', new Date().toISOString());
    if (!error) (data ?? []).forEach((row: { user_id: string }) => found.add(row.user_id));
  } catch {
    // counts as "no Plus"
  }
  ids.forEach((id) => remember(id, found.has(id)));
}

function lookUp(userId: string) {
  const known = cache.get(userId);
  if (known && Date.now() - known.at < CACHE_MINUTES * 60_000) return;
  waiting.add(userId);
  if (timer) return;
  timer = setTimeout(() => {
    const ids = [...waiting];
    waiting = new Set();
    timer = null;
    // Mark them as being looked up, so they aren't asked twice.
    ids.forEach((id) => cache.set(id, { plus: cache.get(id)?.plus ?? false, at: Date.now() }));
    askServer(ids);
  }, 50);
}

// True when this person has Peekaboo+ (for the ⭐ badge next to their name).
export function usePersonPlus(userId: string | null | undefined): boolean {
  const me = usePlus();
  const { userId: myId } = useMe();
  const [, redraw] = useState(0);
  const isMe = !!userId && userId === myId;

  useEffect(() => {
    if (!userId || isMe || TESTERS.has(userId)) return;
    const watcher = () => redraw((n) => n + 1);
    let set = cacheWatchers.get(userId);
    if (!set) cacheWatchers.set(userId, (set = new Set()));
    set.add(watcher);
    lookUp(userId);
    return () => {
      set.delete(watcher);
    };
  }, [userId, isMe]);

  if (isMe) return me;
  return hasPlus(userId);
}
