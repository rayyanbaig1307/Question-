// ---------------------------------------------------------------------------
// Keeps hateful slurs out of Peekaboo (the app stores require a filter like this).
// * Slurs are blocked in everything strangers can see: names, bios, captions, comments, hit ups, dare ideas,
//   group names. Private chats between friends aren't filtered at all (the owner's choice).
// * Swearing is blocked in usernames and display names only. Bios, chats, captions and comments allow it.
// * Real names are fine: "Moby Dick" or "Alex Cock" as a display name (written with a capital letter, like a name).
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
// Swearing that can't be in a username or display name.
const CRUDE = [
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'bitches', 'whore', 'slut',
  'sluts', 'asshole', 'pussy', 'cock', 'cocksucker', 'dick', 'dildo', 'porn', 'porno', 'blowjob', 'handjob',
  'jerkoff', 'wanker', 'twat', 'nazi', 'hitler',
];
// Swear words that are also real first or last names (Dick, Cock). In a display name they're allowed when
// written like a name, with a capital letter ("Moby Dick"), but not in lowercase ("big dick").
const REAL_NAMES = ['dick', 'cock'];
// Swear words that never turn up inside a real name, so they're caught inside longer names too ("fuckboy").
// Shorter ones like "shit", "porn" or "nazi" are only caught as whole words, because they hide inside real
// names (Ishita, Pornsak, Nazir, Scunthorpe).
const CRUDE_INSIDE = ['fuck', 'bitch', 'whore', 'dildo', 'asshole', 'cocksuck', 'blowjob', 'handjob', 'hitler'];

const HATEFUL_SQUASHED = ['nigger', 'nigga', 'faggot', 'retard', 'tranny', 'wetback', 'beaner', 'raghead', 'towelhead', 'pedophile', 'paedophile'];


// "n1gg3r" → "nigger", "F.A.G" → "f a g" (then "fag" once the gaps go).
function tidy(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z\s]/g, ' ');
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
// 'name' = a username or display name (no swearing); 'content' = everything else (only slurs are blocked).
export function findBlockedWord(text: string, where: 'name' | 'content'): string | null {
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

// A friendly error for the screen, or null if the text is fine.
export function checkClean(text: string, where: 'name' | 'content'): string | null {
  if (!findBlockedWord(text, where)) return null;
  return where === 'name' ? "Let's keep it clean – that word can't be in a username or name." : "That word isn't allowed on Peekaboo.";
}
