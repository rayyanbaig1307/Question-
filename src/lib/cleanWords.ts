// ---------------------------------------------------------------------------
// Keeps hateful slurs out of Peekaboo (the app stores require a filter like this).
// * Slurs are blocked in everything strangers can see: usernames, display names, bios, captions, comments, hit ups,
//   dare ideas, group names. Private chats between friends aren't filtered at all (the owner's choice).
// * Swearing is blocked in @usernames only (the owner's choice). Display names, bios, captions, comments and
//   chats allow it. So a username is checked with 'name', and everything else (display names too) with 'content'.
// People try to sneak words past filters with numbers and dots ("n1gg3r", "s.l.u.r"), so text is tidied first.
// ---------------------------------------------------------------------------

// Slurs and the like. Checked as whole words, and also with all gaps removed for the ones that can't be
// part of an innocent word.
const HATEFUL = [
  'nigger', 'nigga', 'niggers', 'niggas', 'faggot', 'faggots', 'fag', 'fags', 'retard', 'retarded', 'retards',
  'tranny', 'trannies', 'chink', 'chinks', 'spic', 'spics', 'kike', 'kikes', 'wetback', 'wetbacks', 'beaner',
  'beaners', 'raghead', 'towelhead', 'dyke', 'dykes', 'coon', 'coons', 'gook', 'gooks', 'paki', 'pakis',
  'rapist', 'molester', 'pedo', 'pedophile', 'paedophile',
];
// Swearing that can't be in a username.
const CRUDE = [
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'bitches', 'whore', 'slut',
  'sluts', 'asshole', 'pussy', 'cock', 'cocksucker', 'dick', 'dildo', 'porn', 'porno', 'blowjob', 'handjob',
  'jerkoff', 'wanker', 'twat', 'nazi', 'hitler',
];
// Swear words that are also real first or last names (Dick, Cock). The 'name' check lets them through when
// written like a name, with a capital letter ("Moby Dick"), but not in lowercase ("big dick"). Usernames are
// always lowercase, so this rarely matters now; it stays so the app and the database stay exactly the same.
const REAL_NAMES = ['dick', 'cock'];
// Swear words that never turn up inside a real name, so they're caught inside longer names too ("fuckboy").
// Shorter ones like "shit", "porn" or "nazi" are only caught as whole words, because they hide inside real
// names (Ishita, Pornsak, Nazir, Scunthorpe).
const CRUDE_INSIDE = ['fuck', 'bitch', 'whore', 'dildo', 'asshole', 'cocksuck', 'blowjob', 'handjob', 'hitler'];

const HATEFUL_SQUASHED = ['nigger', 'nigga', 'faggot', 'retard', 'tranny', 'wetback', 'beaner', 'raghead', 'towelhead', 'pedophile', 'paedophile'];


// Fancy look-alike letters ("ｆｕｃｋ", "𝐟𝐮𝐜𝐤", "ⓕⓤⓒⓚ") become plain ones (Unicode NFKC).
// Accents are taken off ("fück" → "fuck", "José" → "Jose"): each letter is split into the plain letter plus its
// accent mark (Unicode NFD), and the accent marks are deleted (the five blocks of "combining" marks).
const ACCENT_MARKS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g;
// The "outlined" letters and digits (U+1CCD6–U+1CCF9) are only known to newer Unicode, so they're swapped by hand
// to match every phone and the database.
const OUTLINED = /[\u{1CCD6}-\u{1CCF9}]/gu;
const PLAIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Characters you can't see (zero-width space, soft hyphen, joiners, direction marks, variation selectors, tags…),
// so "cu<invisible>nt" can't pass as two harmless pieces. They're deleted (Unicode "default ignorable" characters).
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu;
// Cyrillic and Greek letters that look just like Latin ones ("сunt" with a Russian "с") become the Latin letter.
// The same two lists are in the database (private.word_filter_plain_letters); keep them in the same order.
const LOOK_ALIKE_FROM =
  '\u0430\u03B1\u0441\u0501\u0435\u03B5\u04BB\u0456\u03B9\u0458\u043A\u03BA\u04CF\u043E\u03BF\u0440\u03C1\u051B\u0455\u03C4\u03C5\u051D\u0445\u03C7\u0443' +
  '\u0410\u0391\u0412\u0392\u0421\u0415\u0395\u041D\u0397\u0406\u0399\u0408\u041A\u039A\u041C\u039C\u039D\u041E\u039F\u0420\u03A1\u0405\u0422\u03A4\u0425\u03A7\u03A5\u04AE\u0396';
const LOOK_ALIKE_TO =
  'aacdeehiijkklooppqstuwxxy' +
  'AABBCEEHHIIJKKMMNOOPPSTTXXYYZ';
const LOOK_ALIKE = new Map([...LOOK_ALIKE_FROM].map((letter, i) => [letter, LOOK_ALIKE_TO[i]]));
function plainLetters(text: string): string {
  let plain = text;
  try {
    plain = text.normalize('NFKC').normalize('NFD');
  } catch {
    // A phone without this built in still gets every other check.
  }
  // The same steps, in the same order, as private.word_filter_plain_letters in the database.
  return plain
    .replace(ACCENT_MARKS, '')
    .replace(OUTLINED, (letter) => PLAIN[letter.codePointAt(0)! - 0x1ccd6])
    .replace(INVISIBLE, '')
    .replace(/[\u0370-\u052F]/g, (letter) => LOOK_ALIKE.get(letter) ?? letter);
}

// "n1gg3r" → "nigger", "F.A.G" → "f a g" (then "fag" once the gaps go).
// Anything that isn't a plain a–z letter becomes a space (spaces only ever separate words).
function tidy(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]/g, ' ');
}

const wholeWord = (words: string[]) => new RegExp(`(^|\\s)(${words.join('|')})(?=\\s|$)`);
const HATEFUL_WORDS = wholeWord(HATEFUL);
const CRUDE_WORDS = wholeWord(CRUDE);
const HATEFUL_ANYWHERE = new RegExp(HATEFUL_SQUASHED.join('|'));

// "f u c k" → "fuck": single letters in a row are joined, so spaced-out words are caught as whole words.
function joinSingles(clean: string): string {
  const merged: string[] = [];
  let run = '';
  for (const token of clean.split(/\s+/)) {
    if (token.length === 1) {
      run += token;
      continue;
    }
    if (run) {
      merged.push(run);
      run = '';
    }
    if (token) merged.push(token);
  }
  if (run) merged.push(run);
  return merged.join(' ');
}

// Real names written like names ("Dick", but not "dick" or "DICK") are taken out before the swear check.
function withoutRealNames(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) =>
    REAL_NAMES.includes(word.toLowerCase()) && /^[A-Z][a-z]+$/.test(word) ? ' ' : word,
  );
}

// The offending word, or null if the text is fine.
// 'name' = a @username (no swearing); 'content' = everything else, display names too (only slurs are blocked).
// The database runs the very same check (private.blocked_word in the 20261214 migration), so people can't skip
// it by talking to the server directly. Change both together.
export function findBlockedWord(input: string, where: 'name' | 'content'): string | null {
  const text = plainLetters(input);
  const clean = tidy(text);
  const joined = joinSingles(clean);
  const squashed = clean.replace(/\s+/g, '');
  const hateful = clean.match(HATEFUL_WORDS)?.[2] ?? joined.match(HATEFUL_WORDS)?.[2] ?? squashed.match(HATEFUL_ANYWHERE)?.[0];
  if (hateful) return hateful;
  if (where === 'name') {
    const named = tidy(withoutRealNames(text));
    const namedJoined = joinSingles(named);
    const namedSquashed = named.replace(/\s+/g, '');
    const crude =
      named.match(CRUDE_WORDS)?.[2] ??
      namedJoined.match(CRUDE_WORDS)?.[2] ??
      (CRUDE_INSIDE.find((word) => namedSquashed.includes(word)) ?? null);
    if (crude) return crude;
  }
  return null;
}

// The friendly sentences people see. The database uses exactly the same words when it says no.
export const NAME_NOT_ALLOWED = "Let's keep it clean – that word can't be in a username or name.";
export const WORD_NOT_ALLOWED = "That word isn't allowed on Peekaboo.";

// A friendly error for the screen, or null if the text is fine.
export function checkClean(text: string, where: 'name' | 'content'): string | null {
  if (!findBlockedWord(text, where)) return null;
  return where === 'name' ? NAME_NOT_ALLOWED : WORD_NOT_ALLOWED;
}
