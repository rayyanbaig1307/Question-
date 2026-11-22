// ---------------------------------------------------------------------------
// The owner's list of words that must never be anywhere in Peekaboo (the name of a famous game and its short
// name, the company that makes it, a place in it and two people in it). For legal reasons.
//
// Only their SHA-256 fingerprints are kept here, never the words themselves, so the words are nowhere in the app
// or in the repo. A fingerprint can't be turned back into the word; it can only tell us "this is one of them".
//
// Used by:
//   * tests/unit/banned-words.test.mjs – checks every file, file name, picture text and commit message in the repo;
//   * lib/mainCharacter/library.ts – checks the names of online Main Character pictures before the app shows them.
//
// No imports on purpose: the test loads this file on its own, and it never runs anything when it loads.
// ---------------------------------------------------------------------------

// SHA-256 (as 64 hex letters) of each word or phrase in lower case, and of each phrase joined up with no spaces.
export const BLOCKED_HASHES: readonly string[] = [
  '77f17d47f27689ddd99039090ef9005b1d164e0e1a6448609cc759921ab98a88',
  '4c7d8b9accb3d094fc1621797d114d21da58c580b47618119dfb4393d200dc5a',
  '6a27fe1e3d58fbbe9c3b599ea20dd3b95ef637b3f2f147d81b6d6905dd605c68',
  '0f47dd87cde8f88e26dc1933266d37efc303a84dc0445df2fff3cafe7b13a091',
  '45eccc900d55780e881dd060a27a0fa483e9208a3f9fb54813d10cce7119fede',
  '060305ba2bbd559367f1d9192c1c8d37e9e393eb6cec6e4f72f900879758e713',
  '6326e0e8cfdaab9af83026a0620bafd05179e3a0cd1b812222682d86285b30cc',
  '06b9a6eacd7a77b9361123fd19776455eb16b9c83426a1abbf514a414792b73f',
];

// The longest phrase on the list has 3 words, so runs of up to 3 words are checked.
const LONGEST_RUN = 3;
// Accent marks ("é" is "e" plus a mark once split up), taken off so "Café" reads as "cafe".
const ACCENT_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

// Text → its plain lower-case words. Anything that isn't a letter (spaces, dashes, underscores, dots, digits,
// emoji …) splits words, and so does a capital letter inside a word ("bigBoss" → big, boss; "ABCWord" → abc,
// word). Fancy look-alike letters become plain ones and accents are taken off first.
export function wordsIn(text: string): string[] {
  let plain = typeof text === 'string' ? text : String(text ?? '');
  try {
    plain = plain.normalize('NFKD');
  } catch {
    // A phone without this built in still gets every other step.
  }
  return plain
    .replace(ACCENT_MARKS, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

// The forms that start at word number `at`: the word itself, then the 2- and 3-word runs that start there, each
// once with spaces ("big boss") and once joined up ("bigboss"), so "B.I.G", "big-boss" and "BigBoss" are all seen.
export function formsAt(words: string[], at: number): string[] {
  const forms = [words[at]];
  for (let size = 2; size <= LONGEST_RUN && at + size <= words.length; size++) {
    const run = words.slice(at, at + size);
    forms.push(run.join(' '), run.join(''));
  }
  return forms;
}

// Every form of every word in the text (each one once).
export function wordForms(text: string): string[] {
  const words = wordsIn(text);
  const forms = new Set<string>();
  for (let at = 0; at < words.length; at++) for (const form of formsAt(words, at)) forms.add(form);
  return [...forms];
}
