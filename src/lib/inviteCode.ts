// ---------------------------------------------------------------------------
// Invite codes and invite links – the small, plain parts.
//
// This file has NO imports on purpose: src/app/+native-intent.tsx uses it while the app is still starting up
// (before anything else is loaded), and the website build (scripts/build-website.mjs) reads the alphabet from it.
// ---------------------------------------------------------------------------

// Every invite code is 10 characters from this list: no vowels (so no rude words) and nothing that looks alike
// (no 0/O, 1/I/L, …). The database makes the codes (supabase/migrations/20261223000000_invite_links.sql).
export const INVITE_CODE_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXZ';
export const INVITE_CODE_LENGTH = 10;

// The public website. Your personal link is INVITE_SITE/invite?c=<your code>.
export const INVITE_SITE = 'https://peekaboo-4gz.pages.dev';

// Where the phone keeps an invite you opened (for example before you logged in), and for how long.
export const PENDING_INVITE_KEY = 'peekaboo-pending-invite';
export const PENDING_INVITE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Turns whatever someone typed or pasted into a clean code: spaces and dashes are dropped and small letters
// become capitals ("bcdfg-hjklm" → "BCDFGHJKLM"). Gives back null if it can't be a real code.
export function normalizeInviteCode(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const code = text.trim().toUpperCase().replace(/[\s\-‐-―]/g, '');
  if (code.length !== INVITE_CODE_LENGTH) return null;
  for (const letter of code) if (!INVITE_CODE_ALPHABET.includes(letter)) return null;
  return code;
}

// A code in two halves, easier to read and type: "BCDFG-HJKLM".
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

// Your personal invite link.
export function inviteLink(code: string): string {
  return `${INVITE_SITE}/invite?c=${code}`;
}

// Finds the invite code in a link the phone opened. Gives back null for every other link.
// Works with:
//   peekaboo://invite/<code>                        (the "Open in Peekaboo" button on the website)
//   exp://192.168.1.2:8081/--/invite/<code>         (the same link in Expo Go, while testing)
//   /invite/<code>                                  (a path inside the app)
//   https://peekaboo-4gz.pages.dev/invite?c=<code>  (the website link itself; also …/invite#<code>)
// Anything after ? or # in the app links is ignored.
export function inviteCodeFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  const inApp =
    text.match(/^peekaboo:\/\/\/?invite\/([^/?#]+)\/?(?:[?#].*)?$/i) ??
    text.match(/^exps?:\/\/[^/?#]*\/--\/invite\/([^/?#]+)\/?(?:[?#].*)?$/i) ??
    text.match(/^\/invite\/([^/?#]+)\/?(?:[?#].*)?$/);
  if (inApp) return normalizeInviteCode(decodePart(inApp[1]));

  const site = text.match(/^https:\/\/peekaboo-4gz\.pages\.dev\/invite(?:\.html)?\/?(?:\?([^#]*))?(?:#(.*))?$/i);
  if (!site) return null;
  const fromQuery = (site[1] ?? '')
    .split('&')
    .map((pair) => pair.split('='))
    .find(([name]) => name === 'c');
  return normalizeInviteCode(decodePart(fromQuery?.[1] ?? site[2] ?? ''));
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

// What's saved on the phone: { code, savedAt } (savedAt in milliseconds).
export function pendingInviteToSave(code: string, now: number): string {
  return JSON.stringify({ code, savedAt: now });
}

// Reads a saved invite back. Gives back the code, or null if there's none, it's broken, or it's older than
// 7 days (a phone clock that jumped back a little is fine).
export function pendingInviteCode(saved: string | null | undefined, now: number): string | null {
  if (!saved) return null;
  try {
    const value = JSON.parse(saved) as { code?: unknown; savedAt?: unknown };
    const code = normalizeInviteCode(typeof value?.code === 'string' ? value.code : null);
    const savedAt = typeof value?.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : null;
    if (!code || savedAt === null) return null;
    const age = now - savedAt;
    if (age < -DAY_MS || age > PENDING_INVITE_DAYS * DAY_MS) return null;
    return code;
  } catch {
    return null;
  }
}
