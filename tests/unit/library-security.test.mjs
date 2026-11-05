import { describe, expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

describe('shared peek media integrity during failures', () => {
  const expired = {
    sender_id: 'A', kind: 'snap', media_path: 'A/snaps/shared.jpg',
    poster_path: null, overlay_path: null, saved_at: null,
    opened_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
  };

  it('never deletes media if the database cannot check the other recipients', async () => {
    const remove = vi.fn();
    const chat = loadLibrary('chat', {
      supabase: { from: () => query({ data: null, error: { message: 'timeout' } }), rpc: async () => ({ data: null, error: { message: 'timeout' } }) },
      mocks: { './media': { deleteMedia: remove, mediaFiles: (p) => [p.media_path] } },
    });
    await chat.cleanUpOpenedSnaps('A', [expired]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps shared media if another recipient has not opened it', async () => {
    const remove = vi.fn();
    const chat = loadLibrary('chat', {
      supabase: { from: () => query({ data: [{ opened_at: null, saved_at: null }], error: null }), rpc: async () => ({ data: false, error: null }) },
      mocks: { './media': { deleteMedia: remove, mediaFiles: (p) => [p.media_path] } },
    });
    await chat.cleanUpOpenedSnaps('A', [expired]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps shared media if any recipient saved it', async () => {
    const remove = vi.fn();
    const chat = loadLibrary('chat', {
      supabase: { from: () => query({ data: [{ ...expired, saved_at: new Date().toISOString() }], error: null }), rpc: async () => ({ data: false, error: null }) },
      mocks: { './media': { deleteMedia: remove, mediaFiles: (p) => [p.media_path] } },
    });
    await chat.cleanUpOpenedSnaps('A', [expired]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('does remove media once every recipient is past the replay window', async () => {
    const remove = vi.fn();
    const chat = loadLibrary('chat', {
      supabase: { from: () => query({ data: [expired, expired], error: null }), rpc: async () => ({ data: true, error: null }) },
      mocks: { './media': { deleteMedia: remove, mediaFiles: (p) => [p.media_path] } },
    });
    await chat.cleanUpOpenedSnaps('A', [expired]);
    expect(remove).toHaveBeenCalledExactlyOnceWith(['A/snaps/shared.jpg']);
  });

  it('does not delete a poster used by a different live or saved message', async () => {
    const remove = vi.fn();
    const rpc = vi.fn(async (_name, { object_name }) => ({ data: object_name !== 'A/snaps/still-needed.jpg', error: null }));
    const peek = { ...expired, poster_path: 'A/snaps/still-needed.jpg', overlay_path: 'A/snaps/overlay.png' };
    const chat = loadLibrary('chat', {
      supabase: { rpc, from: () => query({ data: [expired], error: null }) },
      mocks: { './media': { deleteMedia: remove, mediaFiles: (p) => [p.media_path, p.poster_path, p.overlay_path].filter(Boolean) } },
    });
    await chat.cleanUpOpenedSnaps('A', [peek]);
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('can_cleanup_snap', { object_name: 'A/snaps/still-needed.jpg' });
  });

  it('does not delete any file if checking an overlay fails after the main file passed', async () => {
    const remove = vi.fn();
    const rpc = vi.fn(async (_name, { object_name }) => object_name.endsWith('.png')
      ? { data: null, error: { message: 'temporary outage' } } : { data: true, error: null });
    const chat = loadLibrary('chat', {
      supabase: { rpc, from: () => query({ data: [expired], error: null }) },
      mocks: { './media': { deleteMedia: remove, mediaFiles: (p) => [p.media_path, p.overlay_path].filter(Boolean) } },
    });
    await chat.cleanUpOpenedSnaps('A', [{ ...expired, overlay_path: 'A/snaps/overlay.png' }]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('signed media URL account isolation', () => {
  function service() {
    let authListener;
    let denied = false;
    const createSignedUrls = vi.fn(async (paths) => denied
      ? { data: [], error: { message: 'permission denied' } }
      : { data: paths.map((path) => ({ path, signedUrl: `test-only://${path}` })), error: null });
    const supabase = {
      auth: { onAuthStateChange: (callback) => { authListener = callback; return { data: { subscription: { unsubscribe() {} } } }; } },
      storage: { from: () => ({ createSignedUrls }) },
    };
    return {
      supabase, createSignedUrls,
      switchToB() { denied = true; authListener?.('SIGNED_IN', { user: { id: 'B' } }); },
      signInA() { authListener?.('SIGNED_IN', { user: { id: 'A' } }); },
      signOut() { denied = true; authListener?.('SIGNED_OUT', null); },
    };
  }

  it('rechecks permissions after the account changes', async () => {
    const s = service();
    const media = loadLibrary('media', { supabase: s.supabase });
    s.signInA();
    expect(await media.getMediaUrls(['A/keeps/private.jpg'])).toHaveProperty('A/keeps/private.jpg');
    s.switchToB();
    await expect(media.getMediaUrls(['A/keeps/private.jpg'])).rejects.toMatchObject({ message: 'permission denied' });
    expect(s.createSignedUrls).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a private URL after sign out', async () => {
    const s = service();
    const media = loadLibrary('media', { supabase: s.supabase });
    s.signInA();
    await media.getMediaUrls(['A/keeps/private.jpg']);
    s.signOut();
    await expect(media.getMediaUrls(['A/keeps/private.jpg'])).rejects.toMatchObject({ message: 'permission denied' });
  });

  it('discards a signing reply that arrives after switching accounts', async () => {
    const s = service();
    let finish;
    s.createSignedUrls.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const media = loadLibrary('media', { supabase: s.supabase });
    s.signInA();
    const pending = media.getMediaUrls(['A/keeps/private.jpg']);
    s.switchToB();
    finish({ data: [{ path: 'A/keeps/private.jpg', signedUrl: 'test-only://secret-A' }], error: null });
    expect(await pending).toEqual({});
    await expect(media.getMediaUrls(['A/keeps/private.jpg'])).rejects.toMatchObject({ message: 'permission denied' });
  });

  it('still deduplicates URL requests within the same login', async () => {
    const s = service();
    const media = loadLibrary('media', { supabase: s.supabase });
    s.signInA();
    await media.getMediaUrls(['A/keeps/private.jpg', 'A/keeps/private.jpg']);
    await media.getMediaUrls(['A/keeps/private.jpg']);
    expect(s.createSignedUrls).toHaveBeenCalledTimes(1);
  });
});

describe('password and username boundaries', () => {
  const password = loadLibrary('password');
  const profiles = loadLibrary('profiles');
  it.each(['', 'a1', 'abcdefgh', '12345678', 'a1'.repeat(500_000), '🔐🔐🔐🔐'])('rejects unsuitable passwords', (value) => {
    expect(password.checkPassword(value)).not.toBeNull();
  });
  it.each(['Test1234', 'a1!@#$%^&*()', 'A1' + '🙂'.repeat(20)])('accepts suitable passwords with special characters', (value) => {
    expect(password.checkPassword(value)).toBeNull();
  });
  it.each(['', 'ab', 'ABC', "a' OR 1=1--", '<img onerror=alert(1)>', '👀abc', 'a'.repeat(21)])('rejects invalid usernames', (value) => {
    expect(profiles.checkUsernameFormat(value)).not.toBeNull();
  });
  it.each(['abc', 'a_1', 'name.with.dots', 'a'.repeat(20)])('accepts allowed usernames', (value) => {
    expect(profiles.checkUsernameFormat(value)).toBeNull();
  });
  it('cleans pasted huge Unicode names into a bounded safe string', () => {
    expect(profiles.cleanUsername('💥A B!'.repeat(100_000))).toBe('ab'.repeat(10));
  });
});

describe('drop privacy and clock boundaries', () => {
  const drop = loadLibrary('drop');
  it('never loads full-resolution media for locked drops', () => {
    const post = { user_id: 'A', drop_day: '2026-11-04', media_path: 'secret', media_type: 'video', poster_path: 'poster', overlay_path: 'overlay', blur_path: 'blur' };
    expect(drop.postMedia(post, 'B', null)).toEqual({ locked: true, lock: 'drop', still: 'blur', video: null, overlay: null });
    expect(drop.postMedia({ ...post, group_hold: true }, 'B', new Set(['2026-11-04'])).lock).toBe('group');
    expect(drop.postMedia(post, 'B', new Set(['2026-11-04'])).video).toBe('secret');
  });
  it('keeps the generated drop time inside the advertised 10am–10pm window for 10,000 days', () => {
    const first = Date.parse('2020-01-01T00:00:00Z');
    for (let day = 0; day < 10_000; day++) {
      const time = drop.dropMinute(new Date(first + day * 86_400_000).toISOString().slice(0, 10));
      expect(time).toBeGreaterThanOrEqual(600);
      expect(time).toBeLessThan(1320);
    }
  });
  it('handles the exact two-minute drop boundary', () => {
    const at = drop.dropAt('2026-11-04');
    expect(drop.dropStatus(new Date(+at - 1)).kind).toBe('waiting');
    expect(drop.dropStatus(at).kind).toBe('live');
    expect(drop.dropStatus(new Date(+at + 119_999)).kind).toBe('live');
    expect(drop.dropStatus(new Date(+at + 120_000)).kind).toBe('late');
    expect(drop.formatClock(-1000)).toBe('0:00');
  });
});
