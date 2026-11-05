import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

// The camera filters crashed the app on iPhone (TestFlight build 7) because of this: the app's Babel setup turns
// every 'worklet' function into a copy for the drawing thread, made in file order. A worklet that uses another
// worklet from the same file that comes LATER in the file gets "undefined" instead, and calling it on the
// drawing thread stops the whole app. These tests turn every file with worklets into the code the phone runs
// and check that no worklet uses a function of its own file before it is made.

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

function filesWithWorklets(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesWithWorklets(path));
    else if (/\.tsx?$/.test(name) && readFileSync(path, 'utf8').includes("'worklet'")) found.push(path);
  }
  return found;
}

// Problems in one file: "<worklet statement> uses <name>, made later".
export function usedBeforeMade(file) {
  const code = babel.transformFileSync(file, {
    presets: ['babel-preset-expo'],
    filename: file,
    babelrc: false,
    configFile: false,
    caller: { name: 'metro', platform: 'ios', bundler: 'metro' },
  }).code;
  const body = babel.parseSync(code, { sourceType: 'script', babelrc: false, configFile: false }).program.body;
  const madeAt = new Map();
  body.forEach((statement, index) => {
    if (statement.type === 'VariableDeclaration') for (const d of statement.declarations) if (d.id.name) madeAt.set(d.id.name, index);
  });
  const problems = [];
  body.forEach((statement, index) => {
    const text = code.slice(statement.start, statement.end);
    for (const match of text.matchAll(/const\[([^\]]*)\]=this\.__closure/g)) {
      for (const name of match[1].split(',').map((part) => part.trim().split(':').pop().trim())) {
        if (madeAt.has(name) && madeAt.get(name) > index) problems.push(`uses ${name} before it is made`);
      }
    }
  });
  return [...new Set(problems)];
}

const files = filesWithWorklets('src');

it('finds the files with worklets (the camera filters among them)', () => {
  expect(files.some((file) => file.endsWith('lensPaint.ts'))).toBe(true);
});

it.each(files)('%s: no worklet uses a function of its own file before it is made', (file) => {
  expect(usedBeforeMade(file)).toEqual([]);
});
