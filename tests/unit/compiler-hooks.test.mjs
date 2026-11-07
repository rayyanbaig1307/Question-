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
