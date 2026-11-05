import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

import { useMe } from './auth';
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

// The owner's account (@coolname).
const TESTERS = new Set(['df5aae76-7e6a-4e91-9645-5b897a533156']);

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

// RevenueCat sends new info whenever something changes (bought, renewed, ran out…).
function onCustomerInfo(info: CustomerInfo) {
  setMine({ store: storeHasPlus(info) });
}

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

// The RevenueCat account we're set up for (the Supabase user id), so switching accounts logs in again.
let configuredFor: string | null = null;
let listening = false;

// Call once you're logged in (src/app/(app)/_layout.tsx does). Sets up payments for this account and checks
// whether you have Plus. Never throws.
export async function configurePurchases(userId: string): Promise<void> {
  if (mine.userId !== userId) setMine({ userId, store: false, serverUntil: null });
  loadMyServerPlus(userId);
  if (!Purchases) return;
  const previous = configuredFor;
  configuredFor = userId;
  try {
    if (previous === null) {
      // The RevenueCat account is the same as the Peekaboo account, so the webhook knows who paid.
      Purchases.configure({ apiKey: REVENUECAT_IOS_KEY, appUserID: userId });
    } else if (previous !== userId) {
      // Someone else logged in on this phone.
      const { customerInfo } = await Purchases.logIn(userId);
      onCustomerInfo(customerInfo);
    }
    if (!listening) {
      Purchases.addCustomerInfoUpdateListener(onCustomerInfo);
      listening = true;
    }
    onCustomerInfo(await Purchases.getCustomerInfo());
  } catch (error) {
    console.warn('Could not set up Peekaboo+ payments', error);
  }
}

// Whether someone has Plus, using only what's known right away (testers, and your own Plus once it's loaded).
export function hasPlus(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (TESTERS.has(userId)) return true;
  if (userId === mine.userId) return mine.store || (mine.serverUntil !== null && mine.serverUntil > Date.now());
  return cache.get(userId)?.plus ?? false;
}

// True when the person using the app has Peekaboo+.
export function usePlus(): boolean {
  const { userId } = useMe();
  // Re-draws when your Plus changes (the snapshot is the little "mine" object, replaced on every change).
  useSyncExternalStore(watchMine, () => mine);
  return hasPlus(userId);
}

// ---------------------------------------------------------------------------
// Buying, restoring and the price.
// ---------------------------------------------------------------------------

// The monthly package from the "default" offering in RevenueCat.
async function monthlyPackage(): Promise<PurchasesPackage | null> {
  if (!Purchases) return null;
  const offerings = await Purchases.getOfferings();
  const offering = offerings.all[OFFERING] ?? offerings.current;
  return offering?.monthly ?? offering?.availablePackages[0] ?? null;
}

// The price in the person's own money, e.g. "$6.99" or "CA$9.99". Null when it can't be bought here.
export async function getPlusPrice(): Promise<string | null> {
  try {
    return (await monthlyPackage())?.product.priceString ?? null;
  } catch (error) {
    console.warn('Could not load the Peekaboo+ price', error);
    return null;
  }
}

export type BuyResult = 'bought' | 'cancelled';

// Opens Apple's "Subscribe" sheet. Returns 'cancelled' if the person closed it. Throws on real problems.
export async function buyPlus(): Promise<BuyResult> {
  if (!Purchases) throw new Error('Peekaboo+ is coming soon.');
  const pack = await monthlyPackage();
  if (!pack) throw new Error("Peekaboo+ isn't for sale right now. Please try again later.");
  try {
    const { customerInfo } = await Purchases.purchasePackage(pack);
    onCustomerInfo(customerInfo);
  } catch (error) {
    if ((error as { userCancelled?: boolean | null }).userCancelled) return 'cancelled';
    throw error;
  }
  if (mine.userId) loadMyServerPlus(mine.userId);
  return 'bought';
}

// "Restore purchases": asks the App Store again for anything you already paid for (new phone, reinstall).
// Returns true if you have Plus afterwards.
export async function restorePurchases(): Promise<boolean> {
  if (mine.userId) await loadMyServerPlus(mine.userId);
  if (Purchases) onCustomerInfo(await Purchases.restorePurchases());
  return hasPlus(mine.userId);
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
