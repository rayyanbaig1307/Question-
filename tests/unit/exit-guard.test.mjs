import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Pictures and videos leave Peekaboo through ONE door: src/lib/shareOut.ts (the share sheet and Save to Photos).
// That is where photos get the small Peekaboo wordmark (lib/watermark.ts), so a new button somewhere else can't
// send a clean copy out by mistake – and the copies that stay inside Peekaboo (stories, posts, peeks, Keeps) are
// never marked. These checks read every file in src with TypeScript (comments don't count):
// - saveToPhotos (lib/keeps.ts) is used only by lib/shareOut.ts;
// - react-native's Share is used with a file (`url`, or anything that isn't plain words) only in lib/shareOut.ts.
//   Sharing plain words stays fine anywhere (the invite and dare messages in lib/invite.ts and lib/dareChain.ts);
// - the Photos library itself (expo-media-library, saveToLibraryAsync) only in lib/keeps.ts; createAssetAsync,
//   expo-sharing and the other share/camera-roll packages nowhere but lib/shareOut.ts;
// - watermarkPhoto only in lib/shareOut.ts (never on in-app copies).
// The check is first tried on a made-up file that does it wrong in every way, to prove it catches them.

const root = resolve(import.meta.dirname, '../..');

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) found.push(path);
  }
  return found;
}

const SHARE_OUT = 'src/lib/shareOut.ts';
const KEEPS = 'src/lib/keeps.ts';
const WATERMARK = 'src/lib/watermark.ts';
// Packages that can send a file out of the app (or into Photos) by themselves.
const EXIT_PACKAGES = ['expo-sharing', 'react-native-share', '@react-native-camera-roll/camera-roll', 'expo-media-library'];
// Words-only share sheet: these keys and nothing else.
const WORDS_ONLY = new Set(['message', 'title']);

const loads = (spec, name) => spec === name || spec.startsWith(`${name}/`);

// Everything in one file that sends a picture out other than through shareOut.ts, as `file:line what`.
// `name` is the file's path from the repo root (with / between folders).
function exitProblems(name, text) {
  const problems = new Set();
  const isShareOut = name === SHARE_OUT;
  const kind = /x$/.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const add = (node, what) => problems.add(`${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${what}`);

  // Packages that send files out: loaded only by shareOut.ts (and the Photos library only by keeps.ts).
  for (const { fileName, pos } of ts.preProcessFile(text, true, true).importedFiles) {
    const pkg = EXIT_PACKAGES.find((p) => loads(fileName, p));
    if (!pkg || isShareOut || (pkg === 'expo-media-library' && name === KEEPS)) continue;
    problems.add(`${name}:${file.getLineAndCharacterOfPosition(pos).line + 1} loads ${pkg}`);
  }

  // The names this file gives react-native's Share (import { Share }, import { Share as X }), and
  // `import * as RN from 'react-native'` names (RN.Share).
  const shareNames = new Set();
  const nativeNamespaces = new Set();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'react-native') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'Share') shareNames.add(element.name.text);
    }
    if (bindings && ts.isNamespaceImport(bindings)) nativeNamespaces.add(bindings.name.text);
    if (statement.importClause?.name) nativeNamespaces.add(statement.importClause.name.text);
  }

  // Is this use of Share fine anywhere? Only `Share.share({ message, title })` with plain keys, or reading its
  // two answer words.
  const wordsOnlyUse = (node) => {
    const access = node.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== node) return false;
    if (['sharedAction', 'dismissedAction'].includes(access.name.text)) return true;
    if (access.name.text !== 'share') return false;
    const call = access.parent;
    if (!ts.isCallExpression(call) || call.expression !== access) return false;
    const [content] = call.arguments;
    return !!content && ts.isObjectLiteralExpression(content) && content.properties.length > 0 && content.properties.every((property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) && WORDS_ONLY.has(property.name.text));
  };

  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const word = node.text;
      const inImport = !!ts.findAncestor(node, ts.isImportDeclaration);
      if (word === 'saveToPhotos' && !isShareOut && name !== KEEPS) add(node, 'saveToPhotos');
      if (word === 'watermarkPhoto' && !isShareOut && name !== WATERMARK) add(node, 'watermarkPhoto');
      if (word === 'saveToLibraryAsync' && name !== KEEPS && !isShareOut) add(node, 'saveToLibraryAsync');
      if (word === 'createAssetAsync' && !isShareOut) add(node, 'createAssetAsync');
      if (!inImport && !isShareOut && shareNames.has(word) && !wordsOnlyUse(node)) add(node, 'Share with a file');
      // RN.Share from a whole-package import: the same rule.
      if (!isShareOut && word === 'Share' && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        && ts.isIdentifier(node.parent.expression) && nativeNamespaces.has(node.parent.expression.text) && !wordsOnlyUse(node.parent)) {
        add(node, 'Share with a file');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...problems];
}

const files = sourceFiles(join(root, 'src')).map((path) => ({ name: relative(root, path).split('\\').join('/'), text: readFileSync(path, 'utf8') }));

// A made-up file (never written to disk) that sends pictures out in every way the check must catch.
const PROBE = 'src/__exit_guard_probe__.tsx';
const PROBE_TEXT = `import { Platform, Share as Sheet } from 'react-native';
import * as RN from 'react-native';
import { saveToPhotos } from '@/lib/keeps';
import * as Sharing from 'expo-sharing';
import { watermarkPhoto } from '@/lib/watermark';
const MediaLibrary = require('expo-media-library');
export async function leak(uri: string, content: { url: string }) {
  await Sheet.share({ url: uri });
  await Sheet.share({ message: 'hi', url: uri });
  await Sheet.share(content);
  await Sheet.share({ ...content, message: 'x' });
  await RN.Share.share({ url: uri });
  const sheet = Sheet;
  await saveToPhotos(uri);
  await MediaLibrary.createAssetAsync(uri);
  await MediaLibrary.saveToLibraryAsync(uri);
  await watermarkPhoto(uri);
  await Sharing.shareAsync(uri);
  // Fine: words only, and the answer words. (saveToPhotos in a comment is fine too.)
  await Sheet.share({ message: 'Come to Peekaboo', title: 'Peekaboo' });
  await RN.Share.share({ message: 'words' });
  return [Sheet.dismissedAction, Platform.OS, sheet];
}`;

it('the check catches every wrong way in a made-up file (so the checks below mean something)', () => {
  expect(exitProblems(PROBE, PROBE_TEXT).sort()).toEqual([
    `${PROBE}:3 saveToPhotos`,
    `${PROBE}:4 loads expo-sharing`,
    `${PROBE}:5 watermarkPhoto`,
    `${PROBE}:6 loads expo-media-library`,
    `${PROBE}:8 Share with a file`,
    `${PROBE}:9 Share with a file`,
    `${PROBE}:10 Share with a file`,
    `${PROBE}:11 Share with a file`,
    `${PROBE}:12 Share with a file`,
    `${PROBE}:13 Share with a file`,
    `${PROBE}:14 saveToPhotos`,
    `${PROBE}:15 createAssetAsync`,
    `${PROBE}:16 saveToLibraryAsync`,
    `${PROBE}:17 watermarkPhoto`,
  ].sort());
  // The same file is allowed to do all of it only if it is lib/shareOut.ts itself.
  expect(exitProblems(SHARE_OUT, PROBE_TEXT)).toEqual([]);
});

it('only lib/shareOut.ts sends pictures and videos out of the app', () => {
  expect(files.length).toBeGreaterThan(50);
  const problems = files.flatMap(({ name, text }) => exitProblems(name, text));
  expect(problems).toEqual([]);
});

it('lib/shareOut.ts really is the door: it saves to Photos, shares files and adds the wordmark', () => {
  const text = readFileSync(join(root, SHARE_OUT), 'utf8');
  const asIfElsewhere = exitProblems('src/lib/somewhereElse.ts', text);
  expect(asIfElsewhere.some((p) => p.endsWith('saveToPhotos'))).toBe(true);
  expect(asIfElsewhere.some((p) => p.endsWith('Share with a file'))).toBe(true);
  expect(asIfElsewhere.some((p) => p.endsWith('watermarkPhoto'))).toBe(true);
});

it('the words-only share sheets (invites, dare a friend) are still there and still allowed', () => {
  const wordsOnly = files.filter(({ name, text }) => name !== SHARE_OUT && /\bShare\.share\(/.test(text)).map(({ name }) => name).sort();
  expect(wordsOnly).toEqual(['src/lib/dareChain.ts', 'src/lib/invite.ts']);
  for (const name of wordsOnly) expect(exitProblems(name, readFileSync(join(root, name), 'utf8'))).toEqual([]);
});

it('the Photos library is only loaded by lib/keeps.ts, and only behind its safety check', () => {
  const users = files.filter(({ text }) => ts.preProcessFile(text, true, true).importedFiles.some(({ fileName }) => loads(fileName, 'expo-media-library')));
  expect(users.map(({ name }) => name)).toEqual([KEEPS]);
  expect(readFileSync(join(root, KEEPS), 'utf8')).toMatch(/requireOptionalNativeModule\('ExpoMediaLibrary'\)\s*\?/);
});

it('in-app copies stay clean: nothing that posts, sends or keeps a picture adds the wordmark', () => {
  // Only shareOut.ts (and watermark.ts itself) even mention it.
  const users = files.filter(({ text }) => /\bwatermarkPhoto\b/.test(text)).map(({ name }) => name).sort();
  expect(users).toEqual([SHARE_OUT, WATERMARK].sort());
  // The editor's Save gives Keeps the clean picture and sends the Photos copy through saveOut.
  const editor = readFileSync(join(root, 'src/app/(app)/editor.tsx'), 'utf8');
  expect(editor).toMatch(/await addKeep\(userId, capture\);/);
  expect(editor).toMatch(/saveOut\(capture\.uri, capture\.kind\)/);
  const keepViewer = readFileSync(join(root, 'src/app/(app)/keeps/[id].tsx'), 'utf8');
  expect(keepViewer).toMatch(/saveOut\(local, keep\.media_type === 'video' \? 'video' : 'photo'\)/);
});
