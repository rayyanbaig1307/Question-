import { createRequire } from 'node:module';

import { expect, it } from 'vitest';

// The app is built with the React Compiler (app.json experiments.reactCompiler). It remembers a hook's answer
// for as long as the hook's visible inputs stay the same. These hooks answer from a shared value that changes
// behind the scenes (your Plus after buying, another person's Plus, a community dare arriving), so the compiler
// kept the old answer on screens that were already open: after buying Peekaboo+ the camera still said "not Plus"
// until the app was restarted. They opt out with 'use no memo'. This compiles them the way the app does and
// checks the compiler left them alone.

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

function compiled(file) {
  return babel.transformFileSync(file, {
    presets: [['babel-preset-expo', { 'react-compiler': {} }]],
    filename: file,
    babelrc: false,
    configFile: false,
    caller: { name: 'metro', platform: 'ios', bundler: 'metro', supportsReactCompiler: true },
  }).code;
}

function body(code, name) {
  const start = code.indexOf(`function ${name}(`);
  expect(start, `${name} is in the compiled code`).toBeGreaterThan(-1);
  // The compiled file is minified: the next top-level function starts right after this one ends.
  const next = code.slice(start + 1).search(/}\s*function \w+\(/);
  return code.slice(start, next === -1 ? undefined : start + 1 + next + 1);
}

it.each([
  ['src/lib/plus.ts', 'usePlus'],
  ['src/lib/plus.ts', 'usePersonPlus'],
  ['src/lib/dares.ts', 'useDare'],
])('%s %s is not memoised by the React Compiler (it must re-check after a change)', (file, name) => {
  const code = compiled(file);
  // The compiler's memo cache looks like `(0,_compilerRuntime.c)(n)`.
  expect(code).toContain('_compilerRuntime'); // the compiler really ran on this file
  expect(body(code, name)).not.toMatch(/_compilerRuntime\.c\)\(/);
});

// The general rule, for any hook added later: a hook that only *listens* to a shared value
// (`useSyncExternalStore(...)` as a statement, its result thrown away) and then works its answer out from
// somewhere else must opt out with 'use no memo' – otherwise the compiler hands back the old answer.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// Every function body (roughly) that calls useSyncExternalStore without keeping what it returns.
function listenOnlyHooks(file) {
  const text = readFileSync(file, 'utf8');
  const found = [];
  for (const match of text.matchAll(/\n\s*useSyncExternalStore\(/g)) {
    const before = text.slice(0, match.index);
    const start = before.lastIndexOf('\nexport function ') + 1 || before.lastIndexOf('\nfunction ') + 1;
    const name = /function (\w+)/.exec(text.slice(start))?.[1] ?? '?';
    const head = text.slice(start, match.index);
    // The real directive on its own line (not just the words in a comment).
    found.push({ name, optedOut: /^\s*['"]use no memo['"];?\s*$/m.test(head) });
  }
  return found;
}

it('every hook that only listens to a shared value opts out of the React Compiler', () => {
  const problems = sourceFiles('src').flatMap((file) =>
    listenOnlyHooks(file).filter((hook) => !hook.optedOut).map((hook) => `${file}: ${hook.name}`),
  );
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------
// Main Character Mode 🌆
// ---------------------------------------------------------------------------

// The same rule, compiled from text (used below to compile a file with its 'use no memo' taken out).
function compiledText(code, file) {
  return babel.transformSync(code, {
    presets: [['babel-preset-expo', { 'react-compiler': {} }]],
    filename: file,
    babelrc: false,
    configFile: false,
    caller: { name: 'metro', platform: 'ios', bundler: 'metro', supportsReactCompiler: true },
  }).code;
}

// The list of characters and scenes, and the decoded-picture cache, answer from module state that changes behind
// the scenes (a new online picture is ready, a picture finished decoding). With the compiler's memory the screen
// would keep the first answer for good. Often these hooks are the only thing in their file the compiler would
// touch, so this also checks that the compiler WOULD memoise them without the directive – otherwise "not
// memoised" would prove nothing.
it.each([
  ['src/lib/mainCharacter/library.ts', 'useMainCharacterLibrary'],
  ['src/components/mainCharacter/artCache.ts', 'useArtImages'],
])('%s %s is not memoised by the React Compiler', (file, name) => {
  expect(body(compiled(file), name)).not.toMatch(/_compilerRuntime\.c\)\(/);
  const source = readFileSync(file, 'utf8');
  expect(source, `${name} has the 'use no memo' line`).toMatch(/^\s*['"]use no memo['"];?\s*$/m);
  const withoutOptOut = source.replace(/^\s*['"]use no memo['"];?\s*$/m, '');
  expect(body(compiledText(withoutOptOut, file), name)).toMatch(/_compilerRuntime\.c\)\(/);
});

// SoftGlowCamera draws a custom look's Overlay and CameraWrap (section "custom" in SoftGlowCamera.tsx). Each must be
// made once, at the top of its file: a component made inside another component is a brand-new component on every
// redraw, so React would throw its drawing away and start again each time (and the compiler can't help).
const ts = require('typescript');

// The top-level names a file declares (function declarations and `const X = …`), and every component-like
// function (a name starting with a capital letter) that is made inside another function.
function componentShape(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const topLevel = new Set();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) topLevel.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) topLevel.add(d.name.text);
    }
  }
  const nested = [];
  const isFunction = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  const visit = (node, insideFunction) => {
    if (insideFunction) {
      const named = ts.isFunctionDeclaration(node) && node.name ? node.name.text
        : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFunction(node.initializer)
          ? node.name.text : null;
      if (named && /^[A-Z]/.test(named)) nested.push(`${named} (line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    }
    ts.forEachChild(node, (child) => visit(child, insideFunction || isFunction(node)));
  };
  visit(source, false);
  return { topLevel, nested };
}

it.each([
  ['src/components/mainCharacter/MainCharacterOverlay.tsx', 'MainCharacterOverlay'],
  ['src/components/mainCharacter/CameraFollow.tsx', 'CameraFollow'],
])('%s: %s is made at the top of its file, and no component is made inside another one', (file, name) => {
  const { topLevel, nested } = componentShape(file);
  expect(topLevel.has(name), `${name} is declared at the top level of ${file}`).toBe(true);
  expect(nested).toEqual([]);
});
