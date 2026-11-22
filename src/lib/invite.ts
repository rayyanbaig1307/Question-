import AsyncStorage from '@react-native-async-storage/async-storage';
import { Share } from 'react-native';

import { runAfterSignOut } from './auth';
import { normalizeInviteCode, PENDING_INVITE_KEY, pendingInviteCode } from './inviteCode';
import { supabase } from './supabase';

export { formatInviteCode, INVITE_SITE, inviteLink, normalizeInviteCode } from './inviteCode';

// Where friends get Peekaboo.
// Every invite the app sends is just your username and the App Store link (the owner, 22 Nov: "just send your
// username, and that's it"). The App Store link is always the LAST line, on its own, so Messages shows the App
// Store card with the Peekaboo icon. There is no TestFlight link and no Android download link in any message.
// Your friend gets the app, searches your username and adds you.
// The website's invite page (scripts/build-website.mjs) still reads ANDROID_LINK and APP_STORE_LINK from these
// lines, for invite links people already sent. When there's a newer Android download, change ANDROID_LINK.
export const ANDROID_LINK: string | null = 'https://expo.dev/artifacts/eas/7-FSOjuqu58hI0bg_-BNsih5vi4Sv6DIjqKIz9n8jvg.apk';
export const APP_STORE_LINK = 'https://apps.apple.com/app/id6829561855';

// Adds the App Store link to a message, as the last line with nothing after it.
export function withAppLink(message: string): string {
  return `${message.trimEnd()}\n${APP_STORE_LINK}`;
}

// A username ready to show after "@" (null if there isn't one).
function cleanUsername(username?: string | null): string | null {
  const name = typeof username === 'string' ? username.trim().replace(/^@+/, '') : '';
  return name ? name : null;
}

// The invite message: your username, then the App Store link.
//   Add me on Peekaboo 👀 My username is @alice
//   https://apps.apple.com/app/id6829561855
export function inviteMessage(username?: string | null): string {
  const name = cleanUsername(username);
  return withAppLink(name ? `Add me on Peekaboo 👀 My username is @${name}` : 'Come hang out with me on Peekaboo 👀');
}

// ---------------------------------------------------------------------------
// Invite codes (from invite links people sent before 22 Nov – they still work, and "Got a code from a friend?"
// still opens them). The app doesn't put codes or links in new invites any more.
// ---------------------------------------------------------------------------

// Your code, remembered for a short while – only for the account that loaded it. loadedAt is when (in ms).
let cached: { userId: string; code: string; loadedAt: number } | null = null;
// How long a remembered code is used before we ask the server again (you may have made a new link on another
// phone or tablet – then the old code doesn't work any more).
const REMEMBER_MS = 10 * 60 * 1000;
// Goes up when you get a new link (or ask the server again), so an older answer that arrives late can't bring
// the old code back.
let generation = 0;
const loading = new Map<string, Promise<string>>();

// Your code as it was last loaded on this phone, if that was less than 10 minutes ago (null otherwise).
export function rememberedInviteCode(me: string): string | null {
  if (!cached || cached.userId !== me) return null;
  const age = Date.now() - cached.loadedAt;
  return age >= 0 && age < REMEMBER_MS ? cached.code : null;
}

// Your invite code (made the first time you ask). `me` is who is logged in.
// `fresh: true` always asks the server, instead of using the code remembered from the last 10 minutes.
// (Nothing in the app shows or shares your code any more; this stays for the tests and for later.)
export function fetchMyInviteCode(me: string, options: { fresh?: boolean } = {}): Promise<string> {
  if (!options.fresh) {
    const remembered = rememberedInviteCode(me);
    if (remembered) return Promise.resolve(remembered);
    const already = loading.get(me);
    if (already) return already;
  } else {
    // An answer to an older question must not replace the one we're about to get.
    generation++;
  }
  const started = generation;
  const request = (async () => {
    const { data, error } = await supabase.rpc('my_invite_code');
    if (error) throw error;
    const code = normalizeInviteCode(typeof data === 'string' ? data : null);
    if (!code) throw new Error("Couldn't load your invite link");
    if (started === generation) cached = { userId: me, code, loadedAt: Date.now() };
    return code;
  })().finally(() => {
    if (loading.get(me) === request) loading.delete(me);
  });
  loading.set(me, request);
  return request;
}

// Loads your code in the background. No screen calls this any more (invites are just your username now).
export function prefetchInviteCode(me: string | null | undefined): void {
  if (!me) return;
  fetchMyInviteCode(me).catch(() => {
    // No problem: nothing needs it straight away.
  });
}

// "Turn off my old invite link": the old link and code stop working (a new code is made but never shown).
export async function resetInviteCode(me: string): Promise<string> {
  generation++;
  cached = null;
  loading.delete(me);
  const { data, error } = await supabase.rpc('reset_invite_code');
  if (error) throw error;
  const code = normalizeInviteCode(typeof data === 'string' ? data : null);
  if (!code) throw new Error("Couldn't make a new invite link");
  generation++;
  cached = { userId: me, code, loadedAt: Date.now() };
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
// - 'busy': the link was used a lot today, so nothing was added ("This invite link is busy – try again tomorrow")
export type InviteResult = 'friends' | 'requested' | 'already' | 'self' | 'busy';

export async function acceptInvite(code: string, me: string): Promise<InviteResult> {
  const { data, error } = await supabase.rpc('accept_invite', { invite_code: code, expected_user_id: me });
  if (error) throw error;
  // Anything unexpected counts as a request (it never claims you're friends when you might not be).
  return data === 'friends' || data === 'already' || data === 'self' || data === 'busy' ? data : 'requested';
}

// The server's words for an invite that doesn't work (any reason – a block is never revealed).
export const INVITE_GONE = "This invite link doesn't work any more";

export function isInviteGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '');
  return message.includes(INVITE_GONE);
}

// The server's words for a link that can't be used right now (too busy today). A "busy" answer and a "busy" error
// must look exactly the same in the app, so nobody can tell which rule stopped them.
export const INVITE_BUSY = 'This invite link is busy – try again tomorrow';

export function isInviteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '');
  return message.includes(INVITE_BUSY);
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

let sharing = false;

// Opens the phone's share sheet (Messages, WhatsApp, Instagram, copy…) with an invite: your username and the
// App Store link. It opens straight away (nothing to load). A second tap while it's open does nothing.
export async function inviteFriends(username?: string | null): Promise<void> {
  if (sharing) return;
  sharing = true;
  try {
    await Share.share({ message: inviteMessage(username) });
  } catch (error) {
    console.warn('Could not open the share sheet', error);
  } finally {
    sharing = false;
  }
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

// Logging out – or a login that ends by itself (src/lib/auth.tsx runs these steps then too) – forgets your
// code and any invite waiting on this phone (the next person must not get them).
runAfterSignOut(() => {
  cached = null;
  generation++;
  loading.clear();
  clearPendingInvite().catch(() => {});
});
