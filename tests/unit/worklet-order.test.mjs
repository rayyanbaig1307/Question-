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

// The live face filters (Soft Glow, Golden Hour) drew nothing on the camera, only on the photo, because of
// this: on the drawing thread a worklet gets the outside things it uses (like BlurStyle or Skia) from a line
// at the START of its body. A default value for a parameter (`style = BlurStyle.Normal`) is worked out BEFORE
// that line, so there the outside thing doesn't exist yet and the worklet throws. Work the default out
// inside the body instead (`style ?? BlurStyle.Normal`).
export function defaultsReadingOutside(file) {
  const code = babel.transformFileSync(file, {
    presets: ['babel-preset-expo'],
    filename: file,
    babelrc: false,
    configFile: false,
    caller: { name: 'metro', platform: 'ios', bundler: 'metro' },
  }).code;
  const problems = [];
  const workletCode = [];
  babel.traverse(babel.parseSync(code, { sourceType: 'script', babelrc: false, configFile: false }), {
    ObjectProperty(path) {
      const { key, value } = path.node;
      if (key.name === 'code' && value.type === 'StringLiteral' && value.value.startsWith('(function')) workletCode.push(value.value);
    },
  });
  for (const text of workletCode) {
    babel.traverse(babel.parseSync(text, { sourceType: 'script', babelrc: false, configFile: false }), {
      Function(path) {
        const outside = new Set();
        const body = path.node.body.type === 'BlockStatement' ? text.slice(path.node.body.start, path.node.body.end) : '';
        for (const match of body.matchAll(/const\[([^\]]*)\]=this\.__closure/g)) {
          for (const name of match[1].split(',')) outside.add(name.trim().split(':').pop().trim());
        }
        if (!outside.size) return;
        for (const param of path.get('params')) {
          if (!param.isAssignmentPattern()) continue;
          const right = param.get('right');
          const names = right.isIdentifier() ? [right.node.name] : [];
          right.traverse({ Identifier(id) { if (id.isReferencedIdentifier()) names.push(id.node.name); } });
          for (const name of names) {
            if (outside.has(name)) problems.push(`${path.node.id?.name ?? 'a worklet'}: default ${text.slice(param.node.start, param.node.end)} reads ${name}`);
          }
        }
      },
    });
  }
  return [...new Set(problems)];
}

it.each(files)('%s: no worklet parameter default reads something from outside the worklet', (file) => {
  expect(defaultsReadingOutside(file)).toEqual([]);
});
