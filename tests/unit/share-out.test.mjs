import { describe, expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// The only way pictures leave Peekaboo (src/lib/shareOut.ts):
// - shareOut: the phone's share sheet with the wordmarked photo, the file only (no text), one at a time,
//   iPhone only; it never throws, and a failed share sheet leaves the button working;
// - saveOut: the wordmarked photo into Photos, the clean one if the wordmark can't be added; videos as they are.

const PHOTO = 'file:///cache/poster.jpg';
const MARKED = 'file:///cache/peekaboo-1.jpg';

// `os`: Platform.OS. `share(content)`: what the share sheet does. `mark(uri)`: what watermarkPhoto does.
// `save(uri)`: what saveToPhotos does. `canSave`: CAN_SAVE_TO_PHOTOS.
function loadShareOut({ os = 'ios', share, mark, save, canSave = true } = {}) {
  const log = [];
  const required = [];
  const warnings = [];
  const mocks = {
    'react-native': {
      Platform: { OS: os },
      Share: {
        sharedAction: 'sharedAction',
        dismissedAction: 'dismissedAction',
        share: async (content, options) => {
          log.push(['share', content, options]);
          return share ? share(content) : { action: 'sharedAction' };
        },
      },
    },
    './keeps': {
      CAN_SAVE_TO_PHOTOS: canSave,
      saveToPhotos: async (uri) => {
        log.push(['save', uri]);
        return save ? save(uri) : true;
      },
    },
    './watermark': {
      watermarkPhoto: async (uri) => {
        log.push(['mark', uri]);
        return mark ? mark(uri) : MARKED;
      },
    },
  };
  const watched = new Proxy(mocks, {
    getOwnPropertyDescriptor: (target, id) => { required.push(id); return Object.getOwnPropertyDescriptor(target, id); },
  });
  const lib = loadLibrary('shareOut', { mocks: watched, globals: { console: { ...console, warn: (...args) => warnings.push(args) } } });
  return { lib, log, required, warnings };
}

it('loads only the share sheet, Keeps (for Photos) and the wordmark – nothing that could delete the file', () => {
  const { required, log } = loadShareOut();
  expect([...new Set(required)].sort()).toEqual(['./keeps', './watermark', 'react-native']);
  expect(log).toEqual([]);
});

describe('shareOut', () => {
  it('iPhone: shares the wordmarked photo, the file only (no message), and says "shared"', async () => {
    const { lib, log } = loadShareOut();
    expect(lib.CAN_SHARE_FILES).toBe(true);
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('shared');
    expect(log).toEqual([['mark', PHOTO], ['share', { url: MARKED }, undefined]]);
    // Exactly one thing in the share sheet: the picture. A text would make some apps leave the picture out.
    expect(Object.keys(log[1][1])).toEqual(['url']);
  });

  it('closing the share sheet without picking anything says "dismissed"', async () => {
    const { lib } = loadShareOut({ share: () => ({ action: 'dismissedAction' }) });
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('dismissed');
  });

  it('no wordmark possible (no Skia, or it failed): the clean photo is shared, so Share always works', async () => {
    for (const mark of [() => null, () => { throw new Error('Skia fell over'); }]) {
      const { lib, log } = loadShareOut({ mark });
      await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('shared');
      expect(log.at(-1)).toEqual(['share', { url: PHOTO }, undefined]);
    }
  });

  it('a video is shared as it is (no wordmark on videos yet)', async () => {
    const { lib, log } = loadShareOut();
    await expect(lib.shareOut('file:///cache/clip.mp4', 'video')).resolves.toBe('shared');
    expect(log).toEqual([['share', { url: 'file:///cache/clip.mp4' }, undefined]]);
  });

  it('one share sheet at a time: a second tap while it is open says "busy"; after it closes it works again', async () => {
    let close;
    const open = new Promise((resolve) => { close = resolve; });
    const { lib, log } = loadShareOut({ share: () => open });
    const first = lib.shareOut(PHOTO, 'photo');
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('busy');
    await expect(lib.shareOut('file:///cache/clip.mp4', 'video')).resolves.toBe('busy');
    // The file is still there while the share sheet is open (nothing deleted it).
    expect(log.filter(([what]) => what === 'share')).toHaveLength(1);
    close({ action: 'sharedAction' });
    await expect(first).resolves.toBe('shared');
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('shared');
    expect(log.filter(([what]) => what === 'share')).toHaveLength(2);
  });

  it('busy also covers the moment the wordmark is being added', async () => {
    let finish;
    const marking = new Promise((resolve) => { finish = resolve; });
    const { lib } = loadShareOut({ mark: () => marking });
    const first = lib.shareOut(PHOTO, 'photo');
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('busy');
    finish(MARKED);
    await expect(first).resolves.toBe('shared');
  });

  it('the share sheet fails: "not-possible", a warning, never a throw, and the button works again', async () => {
    let fail = true;
    const { lib, warnings } = loadShareOut({ share: () => { if (fail) throw new Error('no view controller'); return { action: 'sharedAction' }; } });
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('not-possible');
    expect(warnings).toHaveLength(1);
    fail = false;
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('shared');
  });

  it('Android (the share sheet ignores files there): "not-possible", no wordmark made, no share sheet', async () => {
    const { lib, log } = loadShareOut({ os: 'android' });
    expect(lib.CAN_SHARE_FILES).toBe(false);
    await expect(lib.shareOut(PHOTO, 'photo')).resolves.toBe('not-possible');
    expect(log).toEqual([]);
    expect(loadShareOut({ os: 'web' }).lib.CAN_SHARE_FILES).toBe(false);
  });
});

describe('saveOut', () => {
  it('saves the wordmarked copy of a photo into Photos', async () => {
    const { lib, log } = loadShareOut();
    await expect(lib.saveOut(PHOTO, 'photo')).resolves.toBe('saved');
    expect(log).toEqual([['mark', PHOTO], ['save', MARKED]]);
  });

  it('no wordmark possible: saves the clean photo (Save always works)', async () => {
    for (const mark of [() => null, () => { throw new Error('Skia fell over'); }]) {
      const { lib, log } = loadShareOut({ mark });
      await expect(lib.saveOut(PHOTO, 'photo')).resolves.toBe('saved');
      expect(log.at(-1)).toEqual(['save', PHOTO]);
    }
  });

  it('the marked copy won\'t save: the clean one is saved instead', async () => {
    const { lib, log, warnings } = loadShareOut({ save: (uri) => { if (uri === MARKED) throw new Error('bad file'); return true; } });
    await expect(lib.saveOut(PHOTO, 'photo')).resolves.toBe('saved');
    expect(log).toEqual([['mark', PHOTO], ['save', MARKED], ['save', PHOTO]]);
    expect(warnings).toHaveLength(1);
  });

  it('a video is saved as it is (no wordmark on videos yet)', async () => {
    const { lib, log } = loadShareOut();
    await expect(lib.saveOut('file:///cache/keep.mp4', 'video')).resolves.toBe('saved');
    expect(log).toEqual([['save', 'file:///cache/keep.mp4']]);
  });

  it('the phone says no to Photos: "no-permission" (asked once, not again with the clean file)', async () => {
    const { lib, log } = loadShareOut({ save: () => false });
    await expect(lib.saveOut(PHOTO, 'photo')).resolves.toBe('no-permission');
    expect(log.filter(([what]) => what === 'save')).toEqual([['save', MARKED]]);
  });

  it('this download can\'t save to Photos: "not-possible", nothing marked or saved', async () => {
    const { lib, log } = loadShareOut({ canSave: false });
    await expect(lib.saveOut(PHOTO, 'photo')).resolves.toBe('not-possible');
    expect(log).toEqual([]);
  });

  it('Photos fails for both files: "not-possible" and a warning, never a throw', async () => {
    const { lib, warnings } = loadShareOut({ save: () => { throw new Error('disk full'); } });
    await expect(lib.saveOut(PHOTO, 'photo')).resolves.toBe('not-possible');
    await expect(lib.saveOut('file:///cache/keep.mp4', 'video')).resolves.toBe('not-possible');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('works on Android too (only sharing files is iPhone-only)', async () => {
    const { lib } = loadShareOut({ os: 'android' });
    await expect(lib.saveOut(PHOTO, 'photo')).resolves.toBe('saved');
  });
});
