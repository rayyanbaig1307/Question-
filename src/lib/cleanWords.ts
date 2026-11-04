// ---------------------------------------------------------------------------
// Keeps hateful slurs out of Peekaboo (the app stores require a filter like this).
// * Slurs are blocked everywhere: names, bios, captions, comments, chats, hit ups, dare ideas.
// * Swearing is allowed everywhere, including usernames, names and bios (the owner's choice).
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

// The offending word, or null if the text is fine. (`where` only changes the message: the same words are
// blocked everywhere.)
export function findBlockedWord(text: string, _where: 'identity' | 'content' = 'content'): string | null {
  const clean = tidy(text);
  const joined = joinSingles(clean);
  const squashed = clean.replace(/\s+/g, '');
  const hateful = clean.match(HATEFUL_WORDS)?.[2] ?? joined.match(HATEFUL_WORDS)?.[2] ?? squashed.match(HATEFUL_ANYWHERE)?.[0];
  if (hateful) return hateful;
  return null;
}

// A friendly error for the screen, or null if the text is fine.
export function checkClean(text: string, where: 'identity' | 'content'): string | null {
  if (!findBlockedWord(text, where)) return null;
  return where === 'identity' ? "That word can't be in a name or bio on Peekaboo." : "That word isn't allowed on Peekaboo.";
}
