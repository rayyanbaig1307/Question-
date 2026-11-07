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
