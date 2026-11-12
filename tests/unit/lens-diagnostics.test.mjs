import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The readout line for the 4 stretchy filters (src/lib/lensDiagnostics.ts): only on the `testing` update channel,
// and one short line that says how the camera picture is placed and what went wrong.

// `updates`: what require('expo-updates') gives (an Error: the require throws).
function load(updates = { channel: null }) {
  const code = ts.transpileModule(readFileSync(resolve(import.meta.dirname, '../../src/lib/lensDiagnostics.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const required = [];
  vm.runInNewContext(code, {
    module, exports: module.exports, Math,
    require: (id) => {
      required.push(id);
      if (id !== 'expo-updates') throw new Error(`lensDiagnostics.ts must not import ${id}`);
      if (updates instanceof Error) throw updates;
      return updates;
    },
  });
  return { ...module.exports, required };
}

it('the readout is switched off for now: it shows nowhere, not even on the testing channel', () => {
  expect(load().READOUT_SWITCHED_ON).toBe(false);
  for (const channel of ['testing', 'production', 'preview', null]) {
    expect(load({ channel }).lensDiagnosticsOn()).toBe(false);
  }
  expect(load({}).lensDiagnosticsOn()).toBe(false);
  expect(load(new Error('no expo-updates here')).lensDiagnosticsOn()).toBe(false);
});

it('switched on again, the readout is only on the testing channel (never in the App Store, on preview or in Expo Go)', () => {
  const on = (updates) => load(updates).lensDiagnosticsOn(undefined, true);
  expect(on({ channel: 'testing' })).toBe(true);
  expect(on({ channel: 'production' })).toBe(false);
  expect(on({ channel: 'preview' })).toBe(false);
  expect(on({ channel: null })).toBe(false);
  expect(on({})).toBe(false);
  expect(on(new Error('no expo-updates here'))).toBe(false);
  // The channel can be given straight away (the tests do).
  const { lensDiagnosticsOn } = load();
  expect(lensDiagnosticsOn('testing', true)).toBe(true);
  expect(lensDiagnosticsOn(null, true)).toBe(false);
  // Loading the file reads nothing yet (expo-updates is only asked when the readout is wanted).
  expect(load({ channel: 'testing' }).required).toEqual([]);
});

const healthy = {
  w: 1920, h: 1440, label: 90, turn: 270, mirror: true, how: 0, agree: 'same', fpsX10: 297, view: { width: 390, height: 844 },
  late: 0, gap: 0, drop: 0, oob: 0, err: 0, dark: 0, cfg: 1,
};

it('a healthy line, for the selfie and the back camera (what the owner\'s phone should show)', () => {
  const { formatWarpLine } = load();
  expect(formatWarpLine(healthy)).toBe('1920×1440 90→270m R✓ 30fps 390×844 ok');
  expect(formatWarpLine({ ...healthy, label: 270, mirror: false })).toBe('1920×1440 270→270 R✓ 30fps 390×844 ok');
  expect(formatWarpLine(healthy).length).toBeLessThanOrEqual(64);
  // Odd screen sizes are rounded.
  expect(formatWarpLine({ ...healthy, view: { width: 393.0001, height: 851.9999 } })).toContain(' 393×852 ');
});

it('problems show instead of "ok", always in the same order; one camera set-up is normal', () => {
  const { formatWarpLine } = load();
  const line = formatWarpLine({ ...healthy, cfg: 3, dark: 1, err: 4, oob: 2, drop: 5, gap: 1, late: 7 });
  expect(line).toBe('1920×1440 90→270m R✓ 30fps 390×844 late7 gap1 drop5 oob2 err4 dark1 cfg3');
  expect(formatWarpLine({ ...healthy, cfg: 2 })).toMatch(/ cfg2$/);
  expect(formatWarpLine({ ...healthy, cfg: 0 })).toMatch(/ ok$/);
});

it('how the turn was decided and whether the converter agrees', () => {
  const { formatWarpLine } = load();
  expect(formatWarpLine({ ...healthy, agree: null })).toContain(' R? ');
  expect(formatWarpLine({ ...healthy, agree: 'turn' })).toContain(' R≈ ');
  expect(formatWarpLine({ ...healthy, agree: 'differ' })).toContain(' R✗ ');
  expect(formatWarpLine({ ...healthy, how: 1 })).toContain(' C✓ ');
  expect(formatWarpLine({ ...healthy, how: 2, agree: null })).toContain(' F? ');
  // Before the first picture.
  expect(formatWarpLine({ ...healthy, w: 0, h: 0 })).toBe('no picture yet 390×844 ok');
});
