import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { Platform, Share } from 'react-native';

import { runAfterSignOut } from './auth';
import { inviteLink, normalizeInviteCode, PENDING_INVITE_KEY, pendingInviteCode } from './inviteCode';
import { supabase } from './supabase';

export { formatInviteCode, INVITE_SITE, inviteLink, normalizeInviteCode } from './inviteCode';

// Where friends can get Peekaboo.
// Android: this download installs the app directly (and it keeps updating itself after that). When there's a
// newer Android download, change this one line. It's only added to invites sent from an Android phone.
// iPhone: the App Store app (it gets its updates on the "production" channel) sends the App Store link. Test
// copies (TestFlight, Expo Go) still send the TestFlight link: friends install the free TestFlight app, then
// Peekaboo from there.
// The website's invite page (scripts/build-website.mjs) reads ANDROID_LINK and APP_STORE_LINK from these lines.
export const ANDROID_LINK: string | null = 'https://expo.dev/artifacts/eas/7-FSOjuqu58hI0bg_-BNsih5vi4Sv6DIjqKIz9n8jvg.apk';
export const APP_STORE_LINK = 'https://apps.apple.com/app/id6829561855';
export const TESTFLIGHT_LINK = 'https://testflight.apple.com/join/3DWqzxhS';
const isStoreApp = Updates.channel === 'production';
export const IPHONE_LINK: string | null = isStoreApp ? APP_STORE_LINK : TESTFLIGHT_LINK;

// Adds the download links to a message.
export function withAppLink(message: string): string {
  const lines = [message, ''];
  if (ANDROID_LINK && Platform.OS === 'android') lines.push(`📱 Android: ${ANDROID_LINK}`);
  lines.push(IPHONE_LINK ? `🍎 iPhone: ${IPHONE_LINK}` : '🍎 iPhone: coming to the App Store soon 🔜');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Your personal invite link
// ---------------------------------------------------------------------------

// The invite message with your personal link (and the download links).
export function inviteMessage(link: string): string {
  return withAppLink(`Come hang out with me on Peekaboo 👀 Tap my link to add me: ${link}`);
}

// The old invite message: used when your link can't be loaded (no internet, or an older server).
function plainInviteMessage(username?: string | null): string {
  const me = username ? ` I'm @${username} – add me!` : '';
  return withAppLink(`Come hang out with me on Peekaboo 👀 Photos, stories and daily dares.${me}`);
}

// Your code, remembered while the app is open – only for the account that loaded it.
let cached: { userId: string; code: string } | null = null;
// Goes up when you get a new link, so an older answer that arrives late can't bring the old code back.
let generation = 0;
const loading = new Map<string, Promise<string>>();

// Your invite code (made the first time you ask). `me` is who is logged in.
export function fetchMyInviteCode(me: string): Promise<string> {
  if (cached?.userId === me) return Promise.resolve(cached.code);
  const already = loading.get(me);
  if (already) return already;
  const started = generation;
  const request = (async () => {
    const { data, error } = await supabase.rpc('my_invite_code');
    if (error) throw error;
    const code = normalizeInviteCode(typeof data === 'string' ? data : null);
    if (!code) throw new Error("Couldn't load your invite link");
    if (started === generation) cached = { userId: me, code };
    return code;
  })().finally(() => {
    if (loading.get(me) === request) loading.delete(me);
  });
  loading.set(me, request);
  return request;
}

// Loads your code in the background (Home, Friends and Settings do this), so sharing is instant later.
export function prefetchInviteCode(me: string | null | undefined): void {
  if (!me) return;
  fetchMyInviteCode(me).catch(() => {
    // No problem: sharing tries again, and falls back to the old message.
  });
}

// "Get a new link": the old link and code stop working, and you get a new code.
export async function resetInviteCode(me: string): Promise<string> {
  generation++;
  cached = null;
  loading.delete(me);
  const { data, error } = await supabase.rpc('reset_invite_code');
  if (error) throw error;
  const code = normalizeInviteCode(typeof data === 'string' ? data : null);
  if (!code) throw new Error("Couldn't make a new invite link");
  generation++;
  cached = { userId: me, code };
  return code;
}

// The person who made an invite (only shown to people who are logged in).
export type InvitePerson = { id: string; username: string; display_name: string; avatar_path: string | null };

// Who made this invite. null = the code doesn't work (wrong, replaced by a new link, account gone, or blocked).
export async function previewInvite(code: string): Promise<InvitePerson | null> {
  const { data, error } = await supabase.rpc('invite_preview', { invite_code: code });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as InvitePerson | null | undefined;
  return row && typeof row.id === 'string' ? row : null;
}

// What happened when you tapped "Add":
// - 'friends': you're friends now
// - 'requested': a friend request was sent (it never says why)
// - 'already': you were already friends
// - 'self': it's your own invite
export type InviteResult = 'friends' | 'requested' | 'already' | 'self';

export async function acceptInvite(code: string, me: string): Promise<InviteResult> {
  const { data, error } = await supabase.rpc('accept_invite', { invite_code: code, expected_user_id: me });
  if (error) throw error;
  // Anything unexpected counts as a request (it never claims you're friends when you might not be).
  return data === 'friends' || data === 'already' || data === 'self' ? data : 'requested';
}

// The server's words for an invite that doesn't work (any reason – a block is never revealed).
export const INVITE_GONE = "This invite link doesn't work any more";

export function isInviteGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '');
  return message.includes(INVITE_GONE);
}

// Are you a grown-up (18 or over) on this birthday ('YYYY-MM-DD')? Worked out like the server does (UTC date).
export function isAdultBirthday(birthday: string | null | undefined, now: Date = new Date()): boolean {
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return false;
  const pad = (value: number) => String(value).padStart(2, '0');
  const limit = `${now.getUTCFullYear() - 18}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  return birthday <= limit;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

// Shares your personal link (the "Share my link" button).
export async function shareInviteLink(code: string): Promise<void> {
  try {
    await Share.share({ message: inviteMessage(inviteLink(code)) });
  } catch (error) {
    console.warn('Could not open the share sheet', error);
  }
}

let sharing = false;

// Opens the phone's share sheet (Messages, WhatsApp, Instagram, copy…) with an invite to the app.
// It puts your personal link in the message. If the link takes more than 3 seconds (or can't be loaded),
// it sends the old message instead, so the button always works. A second tap while it's busy does nothing.
export async function inviteFriends(username?: string | null): Promise<void> {
  if (sharing) return;
  sharing = true;
  try {
    const code = await withTimeLimit(myCodeForSharing(), 3000);
    const message = code ? inviteMessage(inviteLink(code)) : plainInviteMessage(username);
    await Share.share({ message });
  } catch (error) {
    console.warn('Could not open the share sheet', error);
  } finally {
    sharing = false;
  }
}

// Your code for an invite, for whoever is logged in right now (never a code from an earlier login).
async function myCodeForSharing(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const me = data.session?.user.id;
    if (!me) return null;
    const code = await fetchMyInviteCode(me);
    const { data: after } = await supabase.auth.getSession();
    return after.session?.user.id === me ? code : null;
  } catch {
    return null;
  }
}

function withTimeLimit<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

// ---------------------------------------------------------------------------
// An invite opened on this phone (kept for up to 7 days, for example while you log in or sign up)
// src/app/+native-intent.tsx saves it; components/PendingInvite.tsx opens it once you're in the app.
// ---------------------------------------------------------------------------

export async function readPendingInvite(now: number = Date.now()): Promise<string | null> {
  let saved: string | null = null;
  try {
    saved = await AsyncStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
  const code = pendingInviteCode(saved, now);
  // Too old or broken: tidy it away.
  if (saved && !code) await AsyncStorage.removeItem(PENDING_INVITE_KEY).catch(() => {});
  return code;
}

// Forgets the saved invite. With a code, only if the saved one is that code (a newer invite stays).
export async function clearPendingInvite(code?: string): Promise<void> {
  try {
    if (code) {
      const saved = await AsyncStorage.getItem(PENDING_INVITE_KEY);
      if (!saved) return;
      const savedCode = pendingInviteCode(saved, Date.now());
      if (savedCode && savedCode !== code) return;
    }
    await AsyncStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Nothing else to do: it expires by itself after 7 days.
  }
}

// Logging out forgets your code and any invite waiting on this phone (the next person must not get them).
runAfterSignOut(() => {
  cached = null;
  generation++;
  loading.clear();
  clearPendingInvite().catch(() => {});
});
