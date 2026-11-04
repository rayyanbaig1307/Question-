// OPEN-01: the app's word filter (src/lib/cleanWords.ts) and the database's copy (private.blocked_word in the
// 20261214 migration) must give the same answer for every text. Runs locally in PGlite; no live project.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../database/local-db.mjs';
import { loadLibrary } from './libHarness.mjs';

const source = readFileSync('src/lib/cleanWords.ts', 'utf8');
function listFromSource(name) {
  const found = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!found) throw new Error(`List ${name} not found in cleanWords.ts`);
  return [...found[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}
const LISTS = {
  hateful: listFromSource('HATEFUL'),
  crude: listFromSource('CRUDE'),
  real_names: listFromSource('REAL_NAMES'),
  crude_inside: listFromSource('CRUDE_INSIDE'),
  hateful_squashed: listFromSource('HATEFUL_SQUASHED'),
};

let db;
let findBlockedWord;
beforeAll(async () => {
  ({ findBlockedWord } = loadLibrary('cleanWords'));
  db = await createLocalDatabase();
});
afterAll(async () => { await db?.close(); });

// Runs the database check on many texts at once.
async function server(texts, place) {
  const { rows } = await db.query(
    'select n, private.blocked_word(t, $2) as word from unnest($1::text[]) with ordinality as x(t, n) order by n',
    [texts, place],
  );
  return rows.map((row) => row.word);
}
async function expectSame(texts) {
  for (const place of ['name', 'content']) {
    const fromServer = await server(texts, place);
    const differences = [];
    texts.forEach((text, i) => {
      const fromApp = findBlockedWord(text, place);
      if (fromApp !== fromServer[i]) differences.push({ text, place, app: fromApp, server: fromServer[i] });
    });
    expect(differences.slice(0, 20)).toEqual([]);
  }
}

// A small, seeded random number maker, so every run checks the same strings.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_WORDS = [...new Set(Object.values(LISTS).flat())];
const LEET = { o: '0', i: '1', e: '3', a: '4', s: '5', t: '7' };
const FULLWIDTH = (s) => [...s].map((c) => (/[!-~]/.test(c) ? String.fromCodePoint(c.codePointAt(0) + 0xfee0) : c)).join('');
const BOLD = (s) => [...s].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(0x1d41a + c.charCodeAt(0) - 97) : c)).join('');
const CIRCLED = (s) => [...s].map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(0x24d0 + c.charCodeAt(0) - 97) : c)).join('');
const capital = (s) => s[0].toUpperCase() + s.slice(1);
// Characters you can't see. The app and the database both delete them before checking.
const INVISIBLE_SAMPLES = [
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x200b, 0x200c, 0x200d, 0x200e,
  0x200f, 0x202a, 0x202e, 0x2060, 0x2061, 0x2064, 0x2065, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0x1bca0,
  0x1bca3, 0x1d173, 0x1d17a, 0xe0000, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef, 0xe0fff,
];
// Cyrillic and Greek letters that look like Latin ones (small and capital).
const LOOK_ALIKES = {
  a: ['\u0430', '\u03b1'], c: ['\u0441'], d: ['\u0501'], e: ['\u0435', '\u03b5'], h: ['\u04bb'], i: ['\u0456', '\u03b9'],
  j: ['\u0458'], k: ['\u043a', '\u03ba'], l: ['\u04cf'], o: ['\u043e', '\u03bf'], p: ['\u0440', '\u03c1'], q: ['\u051b'],
  s: ['\u0455'], t: ['\u03c4'], u: ['\u03c5'], w: ['\u051d'], x: ['\u0445', '\u03c7'], y: ['\u0443'],
  A: ['\u0410', '\u0391'], B: ['\u0412', '\u0392'], C: ['\u0421'], E: ['\u0415', '\u0395'], H: ['\u041d', '\u0397'],
  I: ['\u0406', '\u0399'], J: ['\u0408'], K: ['\u041a', '\u039a'], M: ['\u041c', '\u039c'], N: ['\u039d'], O: ['\u041e', '\u039f'],
  P: ['\u0420', '\u03a1'], S: ['\u0405'], T: ['\u0422', '\u03a4'], X: ['\u0425', '\u03a7'], Y: ['\u03a5', '\u04ae'], Z: ['\u0396'],
};
// Accent marks (the "combining" kind that sit on the letter before them), a few from every block the filter removes.
const COMBINING_SAMPLES = [
  0x0300, 0x0301, 0x0302, 0x0303, 0x0304, 0x0306, 0x0307, 0x0308, 0x030a, 0x030b, 0x030c, 0x0323, 0x0327, 0x0328, 0x0336,
  0x034f, 0x0363, 0x036f, 0x1ab0, 0x1abe, 0x1aff, 0x1dc0, 0x1dff, 0x20d0, 0x20dd, 0x20e3, 0x20ff, 0xfe20, 0xfe2f,
];
// Ready-made accented letters (Latin, plus Cyrillic and Greek look-alikes with accents on them).
const ACCENTED = {
  a: ['à', 'á', 'â', 'ã', 'ä', 'å', 'ā', 'ă', 'ą', 'ǎ', 'ạ', 'ả', 'ấ', 'ặ', '\u04d3', '\u03ac'],
  c: ['ç', 'ć', 'ĉ', 'ċ', 'č'], d: ['ď', 'ḍ'], e: ['è', 'é', 'ê', 'ë', 'ē', 'ė', 'ę', 'ě', 'ẹ', 'ể', '\u0451', '\u03ad'],
  f: ['ḟ'], g: ['ĝ', 'ğ', 'ġ', 'ģ', 'ǧ'], h: ['ĥ', 'ḥ'],
  i: ['ì', 'í', 'î', 'ï', 'ĩ', 'ī', 'į', 'ǐ', 'ị', 'ỉ', '\u0457', '\u03af', '\u03ca', '\u0390'],
  k: ['ķ', 'ǩ', 'ḱ', '\u045c'], n: ['ñ', 'ń', 'ņ', 'ň', 'ǹ'], o: ['ò', 'ó', 'ô', 'õ', 'ö', 'ō', 'ő', 'ơ', 'ọ', 'ộ', '\u04e7', '\u03cc'],
  p: ['ṕ', 'ṗ'], r: ['ŕ', 'ř', 'ŗ'], s: ['ś', 'ŝ', 'ş', 'š', 'ș', 'ṣ'], t: ['ţ', 'ť', 'ț', 'ṭ'],
  u: ['ù', 'ú', 'û', 'ü', 'ũ', 'ū', 'ů', 'ű', 'ų', 'ư', 'ụ', 'ừ', '\u03cd', '\u03cb'], w: ['ŵ', 'ẁ', 'ẃ', 'ẅ'], y: ['ý', 'ÿ', 'ŷ', 'ỳ', '\u04ef'],
  z: ['ź', 'ż', 'ž'],
};
// Real names with accents. They must stay allowed.
const ACCENTED_NAMES = [
  'José', 'Zoë', 'Björk', 'Renée', 'Łukasz', 'Ñandú', 'Ågot', 'François', 'Chloé', 'Søren', 'Ægir', 'Siân', 'Seán', 'Nuño',
  'Dvořák', 'Jiří', 'Gülşen', 'Çağrı', 'İlkay', 'Şükrü', 'Ödön', 'Đặng Thị Thu', 'Nguyễn Văn Phúc', 'Trần Đức', 'Małgorzata',
  'Wojciech Żółć', 'Bárbara', 'João', 'Conceição', 'Müller', 'Jürgen', 'Zoltán', 'Ştefan', 'Gerður', 'Þórr', 'Ólafur',
  'Алёна', 'Ёжиков', 'Йосиф', 'Їжак', 'Андрій', 'Ζωή', 'Ελένη', 'Νίκος', 'Χρήστος', 'Άρης', 'Ευτυχία', 'Δήμητρα',
  'Moby Dïck', 'Dïck Smith', 'Alex Cöck', 'Dick Börk', 'Dícken',
];
// Everyday accented words in Spanish, French, German, Portuguese, Turkish, Polish and Vietnamese.
const ACCENTED_WORDS = [
  'mañana', 'año', 'niño', 'canción', 'corazón', 'fútbol', 'pingüino', 'jalapeño', 'sí', 'también', 'café', 'adiós',
  'déjà vu', 'garçon', 'naïve', 'crème brûlée', 'être', 'forêt', 'élève', 'noël', 'où', 'çà', 'Über', 'schön', 'Mädchen',
  'Grüße', 'fünf', 'Käse', 'Fußball', 'Müsli', 'coração', 'pão', 'você', 'órgão', 'açúcar', 'informação', 'güzel',
  'çiçek', 'teşekkür', 'öğrenci', 'şeker', 'ığdır', 'gül', 'zażółć gęślą jaźń', 'cześć', 'dziękuję', 'źródło', 'łódź',
  'chặng', 'Việt Nam', 'phở', 'cảm ơn', 'xin chào', 'đẹp', 'người', 'trường', 'nước', 'Hà Nội', 'Phú Quốc', 'cà phê',
];
const LOOK_ALIKE = Object.fromEntries(Object.entries(LOOK_ALIKES).filter(([k]) => k === k.toLowerCase()).map(([k, v]) => [k, v[0]]));

function corpus() {
  const texts = [];
  for (const word of ALL_WORDS) {
    const leet = [...word].map((c) => LEET[c] ?? c).join('');
    texts.push(
      word, word.toUpperCase(), capital(word), ` ${word} `, `my ${word} friend`, `${word}s`, `x${word}`, `${word}y`,
      [...word].join(' '), [...word].join('.'), [...word].join('_'), [...word].join(' . '), leet, leet.toUpperCase(),
      FULLWIDTH(word), FULLWIDTH(capital(word)), BOLD(word), CIRCLED(word), `${word}😀`, `😀${[...word].join('😀')}`,
      `Big ${capital(word)}`, `${capital(word)} Smith`, `${word}\n${word}`, `${word}\t!`, `@${word}`, `#${word}2024`,
      `I${'İ'}${word}`, `${word.slice(0, 2)} ${word.slice(2)}`, `${word.slice(0, 1)} ${word.slice(1)}`,
    );
  }
  texts.push(
    '', ' ', 'hello', 'Moby Dick', 'Alex Cock', 'big dick', 'Big Dick', 'DICK', 'dick', 'Dick', 'DiCk', 'Dickens', 'Dick-Smith',
    'Mr.Dick', 'Dick.', '(Dick)', 'Dick😀', 'Dické', 'éDick', 'DickDick', 'Dick Dick', 'Cock Cock dick', 'cock', 'Cockburn',
    'Scunthorpe', 'Ishita', 'Pornsak', 'Nazir', 'Shitake', 'Arsenal', 'Dickinson', 'Hancock', 'Peacock', 'Babcock',
    'cocktail', 'class', 'assassin', 'bass', 'Matsushita', 'Penistone', 'cumbria', 'analysis', 'grape', 'therapist',
    'f.u.c.k', 'f u c k', 'F U C K', 'f  u  c  k', 'f\tu\nc k', 'f😀u😀c😀k', 'fu ck', 'fuuuck', 'phuck', 'n1gg3r', 'N!GG@',
    'nİgger', 'NİGGER', 'nİgger', 'ﬁﬂ', 'ｆｕｃｋ', '𝐟𝐮𝐜𝐤', 'ⓕⓤⓒⓚ', 'ᶠᵘᶜᵏ', 'f​u​c​k', 'f́uck',
    'фuck', 'ßhit', 'straße', 'İstanbul', 'ﬀ', '½', '①②③', '㎏', 'Å', 'Ω', 'K', '¹²³', '０１２３', 'ǅ', 'ǆ', 'Ⅻ', 'ⅻ',
    'hello　world', 'a b', 'a b', 'a﻿b', 'a b c', '1337', '$hit', '5hit', '@ss', 'b!tch', 'b|tch',
    'wh0re', 'wh0r3', 'sh!t', '7w47', 'p0rn', 'n4z1', 'h17l3r', '0000', '!!!!', '||||', '$$$$', 'a b c d e f g',
    'x x x x x', 'the cocksucker', 'cocksuckers', 'motherfuckers', 'Fuckface', 'Fuck Face', 'Alex Fuck', 'Shit Head',
    'retardation', 'spice', 'spicy', 'cooney', 'raccoon', 'pakistan', 'Paki stan', 'skyscraper', 'Dyke Road', 'Coon Rapids',
    'pedometer', 'gookie', 'kikes', 'kiker', 'beanery', 'faggoty', 'niggardly', 'snigger', 'Fagin', 'fagot',
    // Unicode 16 "outlined" letters and digits, which older databases don't know about.
    'sh\u{1CCDE}t', 'n\u{1CCF1}gger', 'f\u{1CCEA}ck', '\u{1CCDB}\u{1CCEA}\u{1CCD8}\u{1CCE0}', '\u{1CCD6}\u{1CCEF}\u{1CCF0}\u{1CCF9}',
    String.fromCodePoint(...Array.from({ length: 36 }, (_, i) => 0x1ccd6 + i)),
  );
  // Each outlined character inside a word.
  for (let cp = 0x1ccd6; cp <= 0x1ccf9; cp++) texts.push(`sh${String.fromCodePoint(cp)}t`, `n${String.fromCodePoint(cp)}gger`);
  // Invisible characters (zero-width space, soft hyphen, joiners, variation selectors, tags…) inside words.
  for (const cp of INVISIBLE_SAMPLES) {
    const c = String.fromCodePoint(cp);
    texts.push(`cu${c}nt`, `n${c}igger`, `${c}fuck${c}`, `Moby ${c}Dick`, `Moby Di${c}ck`, `a${c}${c}b`, `be an${c} errand`);
  }
  // Cyrillic and Greek look-alike letters swapped into every list word, one letter at a time and all at once.
  for (const word of ALL_WORDS) {
    const swapped = [...word].map((c) => LOOK_ALIKE[c] ?? c);
    texts.push(swapped.join(''), capital(swapped.join('')), swapped.join('').toUpperCase());
    swapped.forEach((c, i) => {
      if (c !== word[i]) texts.push(word.slice(0, i) + c + word.slice(i + 1));
    });
  }
  for (const [latin, list] of Object.entries(LOOK_ALIKES)) {
    for (const c of list) texts.push(c, `x${c}x`, `${c}${latin}`, `Moby ${c}ick`, `${c}ick Smith`);
  }
  texts.push(
    '\u0410\u043b\u0435\u043a\u0441\u0435\u0439', '\u0391\u03bb\u03ad\u03be\u03b1\u03bd\u03b4\u03c1\u03bf\u03c2', '\u041c\u043e\u0441\u043a\u0432\u0430',
    'Love \u2764\ufe0f', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u{1F3F3}\ufe0f\u200d\u{1F308}', 'D\u0456ck', '\u0421ock', 'Di\u0441k',
  );
  // Accented letters, both ready-made ("ü") and built from a letter plus an accent mark ("u" + "¨").
  for (const word of ALL_WORDS) {
    for (const mark of COMBINING_SAMPLES) {
      const c = String.fromCodePoint(mark);
      texts.push(`${word[0]}${c}${word.slice(1)}`, `${word}${c}`, [...word].map((l) => l + c).join(''));
    }
    [...word].forEach((letter, i) => {
      for (const accented of ACCENTED[letter] ?? []) {
        const swapped = word.slice(0, i) + accented + word.slice(i + 1);
        texts.push(swapped, capital(swapped), swapped.toUpperCase(), `my ${swapped} friend`);
      }
    });
  }
  texts.push(...ACCENTED_NAMES, ...ACCENTED_WORDS, ...ACCENTED_NAMES.map((n) => n.normalize('NFD')), ...ACCENTED_WORDS.map((w) => w.normalize('NFD')));
  return texts;
}

describe('word filter: app and database agree', () => {
  it('uses exactly the same word lists', async () => {
    const { rows } = await db.query('select private.word_filter_lists() as lists');
    expect(rows[0].lists).toEqual(LISTS);
  });

  it('gives the same answer on a fixed set of words, disguises, real names and Unicode', async () => {
    const texts = corpus();
    expect(texts.length).toBeGreaterThan(2000);
    await expectSame(texts);
    // A few answers spelled out, so the check can't pass by both sides being wrong in the same way.
    expect(findBlockedWord('f.u.c.k', 'name')).toBe('fuck');
    expect(findBlockedWord('ｆｕｃｋ', 'name')).toBe('fuck');
    expect(findBlockedWord('Moby Dick', 'name')).toBeNull();
    expect(findBlockedWord('big dick', 'name')).toBe('dick');
    expect(findBlockedWord('Scunthorpe', 'name')).toBeNull();
    expect(findBlockedWord('fuck', 'content')).toBeNull();
    expect(findBlockedWord('n1gg3r', 'content')).toBe('nigger');
  });

  it('sees through invisible characters and Cyrillic / Greek look-alike letters', async () => {
    // Each of these looked like the plain word on screen but used to get past both checks.
    const cases = [
      ['cu\u200bnt', 'name', 'cunt'], ['sh\u00adit', 'name', 'shit'], ['c\u2060unt', 'name', 'cunt'], ['fu\ufeffck', 'name', 'fuck'],
      ['fu\u{e0020}ck', 'name', 'fuck'], ['bi\u200dtch', 'name', 'bitch'], ['n\u200bigger', 'content', 'nigger'],
      ['\u0441unt', 'name', 'cunt'], ['\u0421UNT', 'name', 'cunt'], ['n\u0456gger', 'content', 'nigger'], ['f\u03c5ck', 'name', 'fuck'],
      ['\u0455hit', 'name', 'shit'], ['r\u00adetard', 'content', 'retard'],
    ];
    for (const [text, place, word] of cases) {
      expect([text, findBlockedWord(text, place)]).toEqual([text, word]);
      expect([text, (await server([text], place))[0]]).toEqual([text, word]);
    }
    // Real names and ordinary Russian / Greek / emoji text stay allowed.
    for (const text of ['Moby D\u0456ck', 'Alex \u0421ock', '\u0410\u043b\u0435\u043a\u0441\u0435\u0439', '\u0391\u03bb\u03ad\u03be\u03b1\u03bd\u03b4\u03c1\u03bf\u03c2', 'Love \u2764\ufe0f']) {
      expect([text, findBlockedWord(text, 'name')]).toEqual([text, null]);
      expect([text, (await server([text], 'name'))[0]]).toEqual([text, null]);
    }
  });

  it('sees through accents, and still allows real names and everyday words with accents', async () => {
    // Each of these got past both checks: the accent split the word in two ("f ck").
    const cases = [
      ['fück', 'name', 'fuck'], ['cünt', 'name', 'cunt'], ['nïgger', 'content', 'nigger'], ['shït', 'name', 'shit'],
      ['FÜCK', 'name', 'fuck'], ['f\u0308uck', 'name', 'fuck'], ['fu\u0308ck', 'name', 'fuck'], ['fu\u1ab0ck', 'name', 'fuck'],
      ['fu\u1dc0ck', 'name', 'fuck'], ['fu\u20ddck', 'name', 'fuck'], ['fu\ufe20ck', 'name', 'fuck'], ['ńïggér', 'content', 'nigger'],
      ['fággót', 'content', 'faggot'], ['rétárd', 'content', 'retard'], ['bïtçh', 'name', 'bitch'], ['wh\u00f6re', 'name', 'whore'],
      ['n\u0457gger', 'content', 'nigger'], ['big dïck', 'name', 'dick'], ['DÏCK', 'name', 'dick'], ['f ü c k', 'name', 'fuck'],
    ];
    for (const [text, place, word] of cases) {
      expect([text, findBlockedWord(text, place)]).toEqual([text, word]);
      expect([text, (await server([text], place))[0]]).toEqual([text, word]);
    }
    // Real names (also "Dick" written like a name, with an accent) and everyday accented words stay allowed.
    const fine = [...ACCENTED_NAMES, ...ACCENTED_WORDS, 'Dïck', 'Cöck'];
    const fromServer = await server(fine, 'name');
    const wrong = fine.filter((text, i) => findBlockedWord(text, 'name') !== null || fromServer[i] !== null);
    expect(wrong).toEqual([]);
  });

  it('agrees on every invisible character and every look-alike letter, one by one', async () => {
    // Every code point in the ranges the filter deletes or swaps, placed inside a word, in both places.
    const texts = [];
    const ranges = [[0x00a0, 0x0250], [0x0300, 0x0370], [0x1ab0, 0x1b00], [0x1dc0, 0x1e00], [0x1e00, 0x1f00], [0x1f00, 0x2000],
      [0x20d0, 0x2100], [0xfe20, 0xfe30], [0x0390, 0x0400], [0x0400, 0x0530], [0x1100, 0x1170], [0x17b0, 0x17c0],
      [0x1800, 0x1810], [0x2000, 0x2070], [0x3160, 0x3170], [0xfe00, 0xfe10], [0xfef0, 0xff00], [0xff9f, 0xffa1],
      [0x1bc9f, 0x1bca5], [0x1d170, 0x1d17c], [0xe0000, 0xe0080], [0xe00f0, 0xe0110], [0xe01e0, 0xe0200], [0xe0ff0, 0xe1000]];
    for (const [from, to] of ranges) {
      for (let cp = from; cp < to; cp++) {
        const c = String.fromCodePoint(cp);
        texts.push(`cu${c}nt`, `${c}unt`, `n${c}gger`, `Moby ${c}ick`, c);
      }
    }
    await expectSame(texts);
  });

  it('gives the same answer on 6000 seeded random strings, in both places', async () => {
    const random = seeded(20261214);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const pieces = [
      ...ALL_WORDS, ...ALL_WORDS.map(capital), 'Dick', 'Cock', 'dick', 'cock', 'DICK', 'Moby', 'Alex',
      ' ', ' ', ' ', '  ', '.', '_', '-', '\n', '\t', '0', '1', '3', '4', '5', '7', '8', '@', '!', '|', '$', '2', '9',
      'a', 'b', 'c', 'f', 'g', 'i', 'k', 'n', 'o', 'r', 's', 't', 'u', 'A', 'F', 'K', 'N', 'İ', 'ı', 'ß', 'é', 'É',
      '😀', '👀', '🏳️‍🌈', '​', ' ', '　', ' ', '́', '̇', 'ｆ', 'ｕ', 'ｃ', 'ｋ', 'Ｎ', '𝐟', '𝐮',
      'ⓒ', 'ⓚ', 'ﬁ', 'ﬀ', '①', '¹', 'Ω', 'K', 'Å', 'ǅ', 'Ⅻ', 'ᵏ', 'ф', 'а', 'о', 'е', '\u200b', '\u00ad', '\u2060', '\ufeff', '\u{e0020}', '\u0441', '\u0456', '\u03c5', '\u0421', '\u0405', '\u{1CCDB}', '\u{1CCEA}', '\u{1CCF1}',
    ];
    const randomCodePoint = () => {
      // Any character except NUL and the halves of emoji pairs (PostgreSQL can't store those on their own).
      for (;;) {
        const cp = random() < 0.7 ? 1 + Math.floor(random() * 0x2fff) : 1 + Math.floor(random() * 0x10ffff);
        if (cp < 0xd800 || cp > 0xdfff) return String.fromCodePoint(cp);
      }
    };
    const texts = [];
    while (texts.length < 6000) {
      const parts = [];
      const length = 1 + Math.floor(random() * 8);
      for (let i = 0; i < length; i++) {
        const roll = random();
        if (roll < 0.45) parts.push(pick(pieces));
        else if (roll < 0.6) parts.push(randomCodePoint());
        else if (roll < 0.75) {
          // A list word, split or disguised.
          const word = pick(ALL_WORDS);
          const join = pick(['', ' ', '.', '_', '  ', '😀', ' ']);
          parts.push([...word].map((c) => (random() < 0.3 ? (LEET[c] ?? c) : random() < 0.2 ? c.toUpperCase() : c)).join(join));
        } else if (roll < 0.85) parts.push(FULLWIDTH(pick(ALL_WORDS)));
        else parts.push(String.fromCharCode(32 + Math.floor(random() * 95)));
      }
      texts.push(parts.join(random() < 0.5 ? '' : ' '));
    }
    await expectSame(texts);
  });
});
