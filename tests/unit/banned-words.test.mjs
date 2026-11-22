// The owner's list of banned words (the name of a famous game and its short name, the company that makes it, a
// place in it and two people in it) must never be anywhere in Peekaboo: not in code, comments, copy, docs, tests,
// file names, the text inside pictures or commit messages. A legal rule (docs/MAIN_CHARACTER.md).
//
// The words are not written here or anywhere else in the repo: src/lib/mainCharacter/blockedWords.ts keeps only
// their SHA-256 fingerprints. This test cuts everything into words (the app's own wordForms rules: spaces, dashes,
// underscores, dots, digits and capital letters inside a word all split words, and runs of 2 and 3 words are also
// checked joined up), fingerprints every word and run, and compares. A failure names only the file and the line –
// never the word.
//
// What is checked: every file git knows or would add (tracked files and new files that aren't ignored), every
// file and folder name, the text kept inside PNG, WebP and JPEG pictures (only their text parts – the picture data
// itself is packed bytes, where any 3 letters turn up by chance), and every commit message on this branch.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BLOCKED_HASHES, formsAt, wordForms, wordsIn } from '../../src/lib/mainCharacter/blockedWords.ts';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A check "is this form on the list?" for a list of fingerprints (remembers each answer: big files repeat words).
function checker(hashes) {
  const list = new Set(hashes);
  const known = new Map();
  return (form) => {
    let found = known.get(form);
    if (found === undefined) {
      found = list.has(sha256(form));
      known.set(form, found);
    }
    return found;
  };
}

// Long codes that are packed bytes written as letters, not words: package fingerprints ("sha512-…") in
// package-lock.json and base64 file data ("data:…;base64,…"). Their random letters can spell anything.
function withoutPackedData(text) {
  return text
    .replace(/\bsha(?:1|256|384|512)-[A-Za-z0-9+/]+=*/g, ' ')
    .replace(/;base64,[A-Za-z0-9+/]+=*/g, ' ');
}

// The line numbers (from 1) where a word or phrase on the list starts. A phrase that runs on to the next line
// still counts (it is reported at the line it starts on).
function linesWithBlocked(text, isBlocked) {
  const words = [];
  const lineOf = [];
  withoutPackedData(text).split('\n').forEach((line, index) => {
    for (const word of wordsIn(line)) {
      words.push(word);
      lineOf.push(index + 1);
    }
  });
  const lines = new Set();
  for (let at = 0; at < words.length; at++) {
    if (formsAt(words, at).some(isBlocked)) lines.add(lineOf[at]);
  }
  return [...lines];
}

// ---------------------------------------------------------------------------
// The text kept inside pictures (and only that)
// ---------------------------------------------------------------------------

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');

// Readable runs inside a block of mixed bytes (EXIF): plain letters, and the two-bytes-a-letter kind Windows uses.
function readableRuns(bytes) {
  const buf = Buffer.from(bytes);
  const plain = buf.toString('latin1').match(/[\x20-\x7e]{3,}/g) ?? [];
  const wide = buf.toString('latin1').match(/(?:[\x20-\x7e]\x00){3,}/g)?.map((run) => run.replace(/\x00/g, '')) ?? [];
  return [...plain, ...wide].join('\n');
}

// Every piece of text inside a PNG, WebP or JPEG file's text and metadata parts. Never the picture data.
function pictureTexts(buf) {
  const texts = [];
  try {
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
      // PNG: chunks of [length][type][data][check].
      for (let at = 8; at + 12 <= buf.length;) {
        const size = buf.readUInt32BE(at);
        const type = latin1(buf.subarray(at + 4, at + 8));
        const data = buf.subarray(at + 8, at + 8 + size);
        if (type === 'tEXt') texts.push(latin1(data).replace(/\0/g, '\n'));
        if (type === 'zTXt') {
          const end = data.indexOf(0);
          texts.push(latin1(data.subarray(0, end)), latin1(inflateSync(data.subarray(end + 2))));
        }
        if (type === 'iTXt') {
          const keyEnd = data.indexOf(0);
          const packed = data[keyEnd + 1] === 1;
          const languageEnd = data.indexOf(0, keyEnd + 3);
          const translatedEnd = data.indexOf(0, languageEnd + 1);
          const body = data.subarray(translatedEnd + 1);
          texts.push(utf8(data.subarray(0, translatedEnd)).replace(/\0/g, '\n'), utf8(packed ? inflateSync(body) : body));
        }
        if (type === 'eXIf') texts.push(readableRuns(data));
        if (type === 'IEND') break;
        at += 12 + size;
      }
    } else if (buf.length > 12 && latin1(buf.subarray(0, 4)) === 'RIFF' && latin1(buf.subarray(8, 12)) === 'WEBP') {
      // WebP: chunks of [name][length][data] (padded to an even length).
      for (let at = 12; at + 8 <= buf.length;) {
        const type = latin1(buf.subarray(at, at + 4));
        const size = buf.readUInt32LE(at + 4);
        const data = buf.subarray(at + 8, at + 8 + size);
        if (type === 'EXIF') texts.push(readableRuns(data));
        if (type === 'XMP ') texts.push(utf8(data));
        at += 8 + size + (size % 2);
      }
    } else if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG: blocks of [FF][kind][length][data], until the picture data starts.
      for (let at = 2; at + 4 <= buf.length;) {
        if (buf[at] !== 0xff) break;
        const kind = buf[at + 1];
        if (kind === 0xda || kind === 0xd9) break;
        if (kind === 0xff || kind === 0x01 || (kind >= 0xd0 && kind <= 0xd8)) { at += kind === 0xff ? 1 : 2; continue; }
        const size = buf.readUInt16BE(at + 2);
        const data = buf.subarray(at + 4, at + 2 + size);
        if (kind === 0xfe) texts.push(utf8(data));                  // a comment
        if (kind === 0xe1) {                                        // EXIF or XMP
          texts.push(latin1(data.subarray(0, 6)) === 'Exif\0\0' ? readableRuns(data.subarray(6)) : utf8(data));
        }
        at += 2 + size;
      }
    }
  } catch {
    texts.push('(a broken text part: it could not be read)');
  }
  return texts;
}

const PICTURE = /\.(png|webp|jpe?g)$/i;

// ---------------------------------------------------------------------------
// Checks of the checker itself, with made-up words (never the real ones)
// ---------------------------------------------------------------------------

describe('the word rules', () => {
  it('keeps only fingerprints: 64 hex letters each, no two alike', () => {
    expect(BLOCKED_HASHES.length).toBeGreaterThan(0);
    for (const hash of BLOCKED_HASHES) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(BLOCKED_HASHES).size).toBe(BLOCKED_HASHES.length);
  });

  it('splits on everything that is not a letter and on capitals inside a word', () => {
    expect(wordsIn('bigBoss_2024-new.file')).toEqual(['big', 'boss', 'new', 'file']);
    expect(wordsIn('ABCWord XMLHttp')).toEqual(['abc', 'word', 'xml', 'http']);
    expect(wordsIn('Z.E.B 3dRiver')).toEqual(['z', 'e', 'b', 'd', 'river']);
    expect(wordsIn('Café ｆｕｎ  ')).toEqual(['cafe', 'fun']);
    expect(wordsIn('')).toEqual([]);
  });

  it('checks each word and each run of 2 and 3 words, with spaces and joined up', () => {
    const forms = wordForms('Big Boss Man now');
    for (const form of ['big', 'boss', 'man', 'now', 'big boss', 'bigboss', 'big boss man', 'bigbossman', 'boss man now', 'bossmannow']) {
      expect(forms).toContain(form);
    }
    expect(forms).not.toContain('big boss man now');   // no runs of 4
    expect(forms).not.toContain('bigbossmannow');
    expect(new Set(forms).size).toBe(forms.length);
  });

  it('finds a word or phrase in every spelling, names only the line, and leaves look-alike longer words alone', () => {
    const isBlocked = checker([sha256('zebra'), sha256('blue whale'), sha256('bluewhale'), sha256('zeb')]);
    const text = [
      'nothing here',            // 1
      'a ZEBRA crossing',        // 2
      'const blueWhale = 1;',    // 3
      'the blue',                // 4: "blue" + "whale" on the next line
      'whale song',              // 5
      'Z.E.B and zebras',        // 6: the 3 letters spelled out; "zebras" is a different word
      'zebrafish swims',         // 7: a longer word: not on the list
      'icon-sha512-ZEBRAxZEBRA==', // 8: a package fingerprint (packed data), not words
    ].join('\n');
    expect(linesWithBlocked(text, isBlocked)).toEqual([2, 3, 4, 6]);
    expect(linesWithBlocked('nothing to see\nat all', isBlocked)).toEqual([]);
  });

  it('reads the text parts of PNG, WebP and JPEG files, and never the picture data', () => {
    const chunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', Buffer.alloc(13)),
      chunk('tEXt', Buffer.from('Comment\0painted by a zebra', 'latin1')),
      chunk('zTXt', Buffer.concat([Buffer.from('Note\0\0', 'latin1'), deflateSync(Buffer.from('packed zebra note'))])),
      chunk('iTXt', Buffer.concat([Buffer.from('Title\0\0\0en\0Title\0', 'latin1'), Buffer.from('a zebra title')])),
      chunk('IDAT', Buffer.from('zebra zebra zebra in the picture data')),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const pngTexts = pictureTexts(png).join('\n');
    expect(pngTexts).toContain('painted by a zebra');
    expect(pngTexts).toContain('packed zebra note');
    expect(pngTexts).toContain('a zebra title');
    expect(pngTexts).not.toContain('in the picture data');

    const webpChunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, 'latin1');
      head.writeUInt32LE(data.length, 4);
      return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
    };
    const webpBody = Buffer.concat([
      Buffer.from('WEBP', 'latin1'),
      webpChunk('VP8 ', Buffer.from('zebra in the picture data')),
      webpChunk('XMP ', Buffer.from('<x>zebra metadata</x>')),
      webpChunk('EXIF', Buffer.from('II*\0\0\0exif zebra\0\x01\x02')),
    ]);
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), webpBody]);
    const webpTexts = pictureTexts(webp).join('\n');
    expect(webpTexts).toContain('zebra metadata');
    expect(webpTexts).toContain('exif zebra');
    expect(webpTexts).not.toContain('in the picture data');

    const block = (kind, data) => {
      const head = Buffer.from([0xff, kind, 0, 0]);
      head.writeUInt16BE(data.length + 2, 2);
      return Buffer.concat([head, data]);
    };
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      block(0xe0, Buffer.from('JFIF\0')),
      block(0xfe, Buffer.from('a zebra comment')),
      block(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('II*\0camera zebra\0')])),
      block(0xda, Buffer.from('zebra in the picture data')),
      Buffer.from([0xff, 0xd9]),
    ]);
    const jpegTexts = pictureTexts(jpeg).join('\n');
    expect(jpegTexts).toContain('a zebra comment');
    expect(jpegTexts).toContain('camera zebra');
    expect(jpegTexts).not.toContain('in the picture data');
  });
});

// ---------------------------------------------------------------------------
// The repo
// ---------------------------------------------------------------------------

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const isBlocked = checker(BLOCKED_HASHES);

describe('none of the banned words is anywhere in the repo', () => {
  // Tracked files, and new files that aren't ignored (so nothing gets in before its first commit either).
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];

  it('in any file (and in the text inside pictures)', () => {
    const problems = [];
    for (const path of files) {
      if (!existsSync(path) || !statSync(path).isFile()) continue;   // removed in the working copy
      const buf = readFileSync(path);
      if (PICTURE.test(path)) {
        if (pictureTexts(buf).some((text) => linesWithBlocked(text, isBlocked).length > 0)) problems.push(`${path} (text inside the picture)`);
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue;   // another kind of packed file (fonts, the face model)
      for (const line of linesWithBlocked(buf.toString('utf8'), isBlocked)) problems.push(`${path}:${line}`);
    }
    expect(problems, 'a banned word is in these places (the word itself is never shown)').toEqual([]);
  }, 180_000);

  it('in any file or folder name', () => {
    const problems = files
      .map((path, index) => ({ path, index }))
      .filter(({ path }) => linesWithBlocked(path.split('/').join('\n'), isBlocked).length > 0)
      .map(({ index }) => `the name on line ${index + 1} of "git ls-files --cached --others --exclude-standard"`);
    expect(problems, 'a banned word is in these file names').toEqual([]);
  });

  it('in any commit message', () => {
    const log = git(['log', '--format=%H%x00%B%x01']);
    const problems = [];
    for (const entry of log.split('\x01')) {
      const [commit, message] = entry.replace(/^\n+/, '').split('\0');
      if (!commit || message === undefined) continue;
      for (const line of linesWithBlocked(message, isBlocked)) problems.push(`commit ${commit.slice(0, 10)}, message line ${line}`);
    }
    expect(problems, 'a banned word is in these commit messages').toEqual([]);
  }, 60_000);
});
