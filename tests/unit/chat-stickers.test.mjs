import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Stickers in chat: which ones the app knows, their text version, and who can send the Peekaboo+ ones.
const lib = loadLibrary('chatStickers', {
  mocks: {
    '@/components/editor/PlusStickers': {
      PLUS_PACKS: [{ id: 'p', name: 'Pack', stickers: [{ id: 'plus-slay' }, { id: 'plus-main-character' }] }],
      isPlusSticker: (id) => id.startsWith('plus-'),
      plusStickerLabel: (id) => ({ 'plus-slay': 'SLAY', 'plus-main-character': 'MAIN CHARACTER' })[id] ?? id,
    },
    '@/components/editor/SpecialSticker': { SPECIAL_STICKERS: ['googly-eyes', 'caught'] },
    '@/components/editor/stickers': { WORD_STICKERS: ['LOL', 'NO WAY'] },
  },
});

it('word stickers get plain names, and back again', () => {
  expect(lib.wordStickerId('NO WAY')).toBe('word-no-way');
  expect(lib.wordOfSticker('word-no-way')).toBe('NO WAY');
  expect(lib.wordOfSticker('word-nope')).toBe(null);
  // Every name fits the server's rule (^[a-z0-9-]{1,40}$).
  for (const id of lib.FREE_CHAT_STICKERS) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
});

it('the text version says which sticker it is', () => {
  expect(lib.stickerText('plus-main-character')).toBe('Sticker: MAIN CHARACTER');
  expect(lib.stickerText('word-lol')).toBe('Sticker: LOL');
  expect(lib.stickerText('googly-eyes')).toBe('Sticker: Googly eyes 👀');
});

it('free stickers for everyone, Peekaboo+ ones only with Peekaboo+, unknown ones never', () => {
  expect(lib.canSendSticker('caught', false)).toBe(true);
  expect(lib.canSendSticker('word-lol', false)).toBe(true);
  expect(lib.canSendSticker('plus-slay', false)).toBe(false);
  expect(lib.canSendSticker('plus-slay', true)).toBe(true);
  expect(lib.canSendSticker('plus-made-up', true)).toBe(false);
  expect(lib.isKnownSticker('something-new')).toBe(false);
});
