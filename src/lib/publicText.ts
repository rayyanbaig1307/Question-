import { checkClean, plainLetters } from './cleanWords';

// ---------------------------------------------------------------------------
// The checks on public chat 💬 messages: how a message is tidied, and no links and no phone numbers. The database
// runs the very same checks before a message is saved (private.public_text_tidy, private.public_message_problem
// and private.public_text_problem in supabase/migrations/20270102000000_public_chat_text.sql), so an old or
// changed app can't skip them. Change both together: tests/support/public-text-cases.json runs against both, and
// tests/unit/public-text.test.mjs checks the four lists below match the database's.
// ---------------------------------------------------------------------------

export const PUBLIC_TEXT_MAX = 300;

// What comes after the dot in a web address (".com"). Common words people type straight after a full stop
// ("so", "it", "to", "lol", "at", "us"…) are left out on purpose, so "ok.so tired" isn't taken for a link.
// (A dotted name followed by "/" is always a link, whatever its ending: "zoom.us/j/1".)
export const LINK_ENDINGS = [
  'com', 'net', 'org', 'info', 'biz', 'xyz', 'app', 'dev', 'io', 'ai', 'co', 'me', 'ly', 'gg', 'tv', 'fm',
  'link', 'site', 'online', 'store', 'shop', 'live', 'club', 'vip', 'pro', 'page', 'bio', 'click', 'website',
  'blog', 'cam', 'porn', 'sex', 'xxx', 'adult', 'onion', 'tk', 'ml', 'ga', 'cf', 'gq', 'pw', 'ru', 'su', 'cn',
  'uk', 'ca', 'de', 'fr', 'es', 'nl', 'au', 'nz', 'in', 'be', 'ee', 'eu', 'ch', 'jp', 'kr', 'br', 'mx', 'ws',
  'cc', 'sh', 'gl', 'la', 'icu', 'buzz', 'ink', 'tech', 'top', 'fun', 'gd', 'gy', 'ph', 'world', 'party',
  'mobi', 'cyou', 'sbs', 'cfd', 'bond',
];
// The ones also caught when the dot is written out ("site dot com", "site (dot) com").
export const SAID_ENDINGS = [
  'com', 'net', 'org', 'io', 'co', 'me', 'ly', 'gg', 'xyz', 'app', 'tv', 'uk', 'ca', 'ru', 'info', 'link',
  'site',
];
// The ones also caught with a space after the dot ("site. com", "site . com"). Only endings that are never
// everyday words, so "Love it. Me too" stays fine.
export const SPACED_ENDINGS = ['com', 'net', 'org', 'io', 'ly', 'xyz', 'ru'];
// Email services caught even without the ending ("name@gmail").
export const MAIL_NAMES = [
  'gmail', 'googlemail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'icloud', 'protonmail', 'proton', 'aol',
  'gmx', 'yandex',
];

const WORD = '[a-z0-9-]+';
const STOP = '([^a-z0-9]|$)';
const LINKS = [
  /:\/\//,
  /(https?|ftp)[:/]/,
  /www *\./,
  // site.com, site .com, site.co.uk
  new RegExp(`${WORD} ?\\.(${LINK_ENDINGS.join('|')})${STOP}`),
  // site. com, site . com
  new RegExp(`${WORD} ?\\. (${SPACED_ENDINGS.join('|')})${STOP}`),
  // anything.xx/… : a web address with a path, whatever its ending (bit.do/x, zoom.us/j/1, shorturl.at/x)
  new RegExp(`${WORD} ?\\.[a-z]{2,}/`),
  // site dot com, site dotcom, site d0t com, site (dot) com, site [.] com
  new RegExp(`${WORD} ?(\\(dot\\)|\\[dot\\]|\\{dot\\}|\\(\\.\\)|\\[\\.\\]| d[o0]t ?) ?(${SAID_ENDINGS.join('|')})${STOP}`),
  // name@anything.xx
  new RegExp(`[a-z0-9._%+-]+@${WORD}(\\.${WORD})*\\.[a-z][a-z]`),
  // name@gmail, name @ gmail
  new RegExp(`@ ?(${MAIL_NAMES.join('|')})${STOP}`),
  // 1.2.3.4
  /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/,
];

// 。 · ‧ ⸱ ・ ∙ ⋅ are all dots in a web address too.
const LOOK_ALIKE_DOTS = /[\u3002\u00B7\u2027\u2E31\u30FB\u2219\u22C5]/g;
// Arabic, Persian, Hindi, Bengali and Thai digits (each block starts at its 0).
const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50];
const OTHER_DIGITS = /[\u0660-\u0669\u06F0-\u06F9\u0966-\u096F\u09E6-\u09EF\u0E50-\u0E59]/g;
function plainDigit(digit: string): string {
  const code = digit.codePointAt(0)!;
  const start = DIGIT_BLOCKS.find((block) => code >= block && code <= block + 9)!;
  return String(code - start);
}
// Numbers that aren't phone numbers, set aside before the phone check (each becomes the letter n): times
// (10:30), dates with slashes (12/25/2026) and big numbers with commas (1,000,000).
const NOT_PHONE_NUMBERS = [
  /(^|[^0-9])[0-9]{1,2}:[0-9]{2}(?![0-9]|:[0-9])/g,
  /(^|[^0-9])[0-9]{1,2}\/[0-9]{1,2}\/([0-9]{4}|[0-9]{2})(?![0-9]|\/[0-9])/g,
  /(^|[^0-9])[0-9]{1,3}(,[0-9]{3})+(?![0-9]|,[0-9])/g,
];
// Digits with up to 3 other characters between them are joined (spaces, dots, dashes, brackets, slashes,
// commas…; not letters, money signs or %). "u" so an emoji counts as one character, like the database.
const BETWEEN_DIGITS = /([0-9])[^a-z0-9$%\u20AC\u00A3\u00A5]{1,3}(?=[0-9])/gu;

// 'link', 'phone', or null when the text is fine. Same steps as the database: the text is made plain like the
// word filter does (fancy look-alike letters and full-width dots become plain ones, invisible characters go),
// then A–Z become a–z (only those, like the database), look-alike dots become dots and other digits 0–9.
export function publicTextProblem(text: string): 'link' | 'phone' | null {
  const t = plainLetters(text)
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(LOOK_ALIKE_DOTS, '.')
    .replace(OTHER_DIGITS, plainDigit);
  if (LINKS.some((pattern) => pattern.test(t))) return 'link';
  const numbers = NOT_PHONE_NUMBERS.reduce((text, pattern) => text.replace(pattern, '$1n'), t);
  // A phone number: 7 or more digits (after joining them as above).
  if (/[0-9]{7}/.test(numbers.replace(BETWEEN_DIGITS, '$1'))) return 'phone';
  return null;
}

// The characters that change which way text runs: one of them can make "moc.elpmaxe" show up on screen as
// "example.com". They're taken out of messages.
const DIRECTION_MARKS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// Every kind of space and line break, and the blank-looking characters (U+2800, U+3164, U+FFA0).
const SPACES = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\u2800\u3164\uFFA0]+/g;
// Accent marks (the same five blocks the word filter takes off).
const MARKS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]{4}/;

// A message as it is saved: direction characters out, every run of spaces and line breaks becomes one space, no
// spaces at the ends (the server does exactly the same: private.public_text_tidy).
export function tidyPublicText(text: string): string {
  return text.replace(DIRECTION_MARKS, '').replace(SPACES, ' ').replace(/^ | $/g, '');
}

// Is there anything to see? Not when a message is only spaces and invisible characters (zero-width spaces…).
export function hasPublicText(text: string): boolean {
  return plainLetters(tidyPublicText(text)).replace(/ /g, '') !== '';
}

function splitAccents(text: string): string {
  try {
    return text.normalize('NFD');
  } catch {
    // A phone without this built in checks the text as it is (the server checks again).
    return text;
  }
}

export type PublicMessageProblem = 'size' | 'marks' | 'word' | 'link' | 'phone';

// What's wrong with a message, or null when it can be sent. The same checks in the same order as the server
// (private.public_message_problem): 1–300 characters with something you can see, no more than 3 accent marks on
// one letter, no slurs, then no links or phone numbers.
export function publicMessageProblem(text: string): PublicMessageProblem | null {
  if (text.length > 2000) return 'size';
  const tidy = tidyPublicText(text);
  const length = Array.from(tidy).length;
  if (length < 1 || length > PUBLIC_TEXT_MAX || !hasPublicText(tidy)) return 'size';
  if (MARKS.test(splitAccents(tidy))) return 'marks';
  if (checkClean(tidy, 'content')) return 'word';
  return publicTextProblem(tidy);
}

// Does one of these names (a display name or username) hold a link or a phone number? Then it can't be shown in
// the public chat, and the server won't let you post there with it (private.check_public_chat_name).
export function hasLinkOrPhone(...names: (string | null | undefined)[]): boolean {
  return names.some((name) => !!name && publicTextProblem(name) !== null);
}
