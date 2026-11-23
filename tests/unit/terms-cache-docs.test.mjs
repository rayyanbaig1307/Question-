import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// The phone remembers who agreed to which document and version (lib/termsCache.ts), so the drop's Send never has to
// wait for the server to ask "did you agree to the Dare Safety Rules?" again.
function cache() {
  const disk = new Map();
  class File {
    constructor(_dir, name) { this.name = name; }
    get exists() { return disk.has(this.name); }
    textSync() { return disk.get(this.name); }
    create() { disk.set(this.name, ''); }
    write(text) { disk.set(this.name, text); }
  }
  const load = () => loadLibrary('termsCache', { mocks: { 'expo-file-system': { File, Paths: { document: 'doc' } } } });
  return { load, disk };
}

it('rememberAgreedDoc / knownAgreedDoc work per user, document and version, and survive a restart', () => {
  const { load } = cache();
  const first = load();
  expect(first.knownAgreedDoc('ann', 'dare_rules', 'v1')).toBe(false);
  first.rememberAgreedDoc('ann', 'dare_rules', 'v1');
  expect(first.knownAgreedDoc('ann', 'dare_rules', 'v1')).toBe(true);
  expect(first.knownAgreedDoc('ann', 'dare_rules', 'v2')).toBe(false);
  expect(first.knownAgreedDoc('bob', 'dare_rules', 'v1')).toBe(false);
  // Agreeing to the dare rules is not agreeing to the Terms.
  expect(first.knownAgreed('ann', 'v1')).toBe(false);
  expect(first.knownAgreedAny('ann')).toBe(false);
  // A fresh start of the app reads it back from the phone.
  const again = load();
  expect(again.knownAgreedDoc('ann', 'dare_rules', 'v1')).toBe(true);
});

it('forgetAgreed clears the documents too, and the Terms stay as before', () => {
  const { load } = cache();
  const terms = load();
  terms.rememberAgreed('ann', 't1');
  terms.rememberAgreedDoc('ann', 'dare_rules', 'v1');
  terms.rememberAgreedDoc('bob', 'dare_rules', 'v1');
  expect(terms.knownAgreed('ann', 't1')).toBe(true);
  terms.forgetAgreed('ann');
  expect(terms.knownAgreed('ann', 't1')).toBe(false);
  expect(terms.knownAgreedDoc('ann', 'dare_rules', 'v1')).toBe(false);
  expect(terms.knownAgreedDoc('bob', 'dare_rules', 'v1')).toBe(true);
  expect(load().knownAgreedDoc('ann', 'dare_rules', 'v1')).toBe(false);
});
