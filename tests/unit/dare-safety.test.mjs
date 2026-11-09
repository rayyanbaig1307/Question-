import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Dare safety in the app (src/lib/dareSafety.ts). The same cases run against the database in
// tests/database/dare-safety.test.mjs, so the app and the server always agree.
const { cases } = JSON.parse(readFileSync('tests/support/dare-safety-cases.json', 'utf8'));
const lib = loadLibrary('dareSafety');

it.each(cases)('%s → %s', (dare, problem) => {
  expect(lib.dareProblem(dare)).toBe(problem);
});

it('a blocked dare gets a friendly sentence, an allowed one gets nothing', () => {
  expect(lib.checkDare('Send nudes')).toMatch(/clothes stay on/);
  expect(lib.checkDare('Do 20 push-ups')).toBe(null);
});
