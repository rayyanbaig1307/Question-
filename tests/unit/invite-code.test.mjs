import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadLibrary } from './libHarness.mjs';

// src/lib/inviteCode.ts: cleaning up typed codes, finding the code in a link, and the invite saved on the phone.
const code = loadLibrary('inviteCode');
const DAY = 24 * 60 * 60 * 1000;

describe('invite codes', () => {
  it('has no imports at all (the start-up link handler and the website build use it)', () => {
    const source = readFileSync('src/lib/inviteCode.ts', 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('cleans up what people type: spaces, dashes and small letters are fine', () => {
    expect(code.normalizeInviteCode('BCDFGHJKLM')).toBe('BCDFGHJKLM');
    expect(code.normalizeInviteCode('  bcdfg-hjklm ')).toBe('BCDFGHJKLM');
    expect(code.normalizeInviteCode('bcd fgh jkl m')).toBe('BCDFGHJKLM');
    expect(code.normalizeInviteCode('BCDFG–HJKLM')).toBe('BCDFGHJKLM'); // a "smart" dash from the keyboard
    expect(code.normalizeInviteCode('23456789bc')).toBe('23456789BC');
  });

  it('refuses anything that cannot be a code (wrong length, vowels, look-alikes, other symbols)', () => {
    for (const bad of ['', 'BCDFGHJKL', 'BCDFGHJKLMN', 'ABCDFGHJKL', 'BCDFGHJKL0', 'BCDFGHJKL1', 'BCDFGHJKLO', 'BCDFG/HJKLM', 'BCDFG.HJKL', null, undefined, 42]) {
      expect(code.normalizeInviteCode(bad), String(bad)).toBeNull();
    }
  });

  it('every character of the alphabet is allowed, and it has no vowels or look-alikes', () => {
    expect(code.INVITE_CODE_ALPHABET).toBe('23456789BCDFGHJKLMNPQRSTVWXZ');
    expect(code.INVITE_CODE_ALPHABET).not.toMatch(/[AEIOU01]/);
    expect(code.INVITE_CODE_LENGTH).toBe(10);
  });

  it('makes the personal link and shows the code in two halves', () => {
    expect(code.inviteLink('BCDFGHJKLM')).toBe('https://peekaboo-4gz.pages.dev/invite?c=BCDFGHJKLM');
    expect(code.formatInviteCode('BCDFGHJKLM')).toBe('BCDFG-HJKLM');
  });
});

describe('finding the code in a link', () => {
  it('reads every kind of invite link', () => {
    const links = [
      'peekaboo://invite/BCDFGHJKLM',
      'peekaboo://invite/bcdfghjklm/',
      'peekaboo://invite/BCDFGHJKLM?utm=1#top',
      'peekaboo:///invite/BCDFGHJKLM',
      'exp://192.168.1.2:8081/--/invite/BCDFGHJKLM',
      'exp://192.168.1.2:8081/--/invite/BCDFGHJKLM?x=1',
      'exps://u.expo.dev/abc/--/invite/BCDFG-HJKLM',
      '/invite/BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev/invite?c=BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev/invite?utm=x&c=bcdfg-hjklm',
      'https://peekaboo-4gz.pages.dev/invite.html?c=BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev/invite#BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev/invite?c=BCDFG%2DHJKLM',
    ];
    for (const link of links) expect(code.inviteCodeFromUrl(link), link).toBe('BCDFGHJKLM');
  });

  it('leaves every other link alone (they are not invites)', () => {
    const others = [
      'peekaboo://settings',
      'peekaboo://invite',
      'peekaboo://invite/',
      'peekaboo://invite/not-a-code',
      'peekaboo://invite/BCDFGHJKLM/extra',
      'peekaboo://profile/BCDFGHJKLM',
      'exp://192.168.1.2:8081/--/friends',
      '/invite',
      '/chat/123',
      'https://peekaboo-4gz.pages.dev/privacy',
      'https://peekaboo-4gz.pages.dev/invite',
      'https://evil.example/invite?c=BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev.evil.example/invite?c=BCDFGHJKLM',
      'http://peekaboo-4gz.pages.dev/invite?c=BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev/invite?c=%E0%A4%A',
      '',
      null,
      undefined,
    ];
    for (const link of others) expect(code.inviteCodeFromUrl(link), String(link)).toBeNull();
  });
});

describe('the invite saved on the phone', () => {
  const now = Date.UTC(2026, 10, 9, 12);

  it('reads back what was saved, for up to 7 days', () => {
    const saved = code.pendingInviteToSave('BCDFGHJKLM', now);
    expect(JSON.parse(saved)).toEqual({ code: 'BCDFGHJKLM', savedAt: now });
    expect(code.pendingInviteCode(saved, now)).toBe('BCDFGHJKLM');
    expect(code.pendingInviteCode(saved, now + 6 * DAY)).toBe('BCDFGHJKLM');
    expect(code.pendingInviteCode(saved, now + 7 * DAY + 1)).toBeNull();
    // A phone clock that moved back a little is fine; one saved far "in the future" is not trusted.
    expect(code.pendingInviteCode(saved, now - 60_000)).toBe('BCDFGHJKLM');
    expect(code.pendingInviteCode(saved, now - 2 * DAY)).toBeNull();
  });

  it('ignores broken or strange saved values', () => {
    for (const saved of [null, '', 'nope', '{}', '[]', 'null', '{"code":"BCDFGHJKLM"}', '{"code":"bad","savedAt":1}', `{"code":"BCDFGHJKLM","savedAt":"${now}"}`]) {
      expect(code.pendingInviteCode(saved, now), String(saved)).toBeNull();
    }
    expect(code.PENDING_INVITE_KEY).toBe('peekaboo-pending-invite');
  });
});
