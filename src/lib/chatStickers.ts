import { PLUS_PACKS, isPlusSticker, plusStickerLabel } from '@/components/editor/PlusStickers';
import { SPECIAL_STICKERS } from '@/components/editor/SpecialSticker';
import { WORD_STICKERS } from '@/components/editor/stickers';

// ---------------------------------------------------------------------------
// Stickers in chat 🏷️. A sticker message saves the sticker's name (like 'googly-eyes', 'word-slay' or
// 'plus-slay') and a short text version of it ("Sticker: SLAY") for the chat list, notifications and older
// app versions. Peekaboo+ stickers ('plus-…') can only be sent with Peekaboo+: the picker locks them, and the
// server refuses them too (supabase/migrations/20261221000000_chat_stickers.sql).
// ---------------------------------------------------------------------------

// The word stickers ("LOL", "NO WAY") as sticker names: 'word-lol', 'word-no-way'.
export const wordStickerId = (word: string) => `word-${word.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const WORDS = new Map(WORD_STICKERS.map((word) => [wordStickerId(word), word]));

// The word on a word sticker, or null when it isn't one.
export function wordOfSticker(id: string): string | null {
  return WORDS.get(id) ?? null;
}

const ORIGINAL_NAMES: Record<string, string> = {
  'googly-eyes': 'Googly eyes 👀',
  'googly-eye': 'Googly eye',
  peekaboo: 'PEEKABOO 👀',
  'peek-bubble': 'Peek bubble',
  'i-see-you': 'I see you',
  caught: 'Caught',
};

// Is this a sticker this version of the app knows how to draw?
export function isKnownSticker(id: string): boolean {
  return (
    id in ORIGINAL_NAMES ||
    WORDS.has(id) ||
    PLUS_PACKS.some((pack) => pack.stickers.some((s) => s.id === id))
  );
}

// "SLAY", "Googly eyes 👀" … for the text version and screen readers.
export function stickerName(id: string): string {
  if (isPlusSticker(id)) return plusStickerLabel(id);
  return wordOfSticker(id) ?? ORIGINAL_NAMES[id] ?? 'Sticker';
}

// The text saved with a sticker message.
export function stickerText(id: string): string {
  return `Sticker: ${stickerName(id)}`.slice(0, 80);
}

// Can you send this sticker? Free ones always; Peekaboo+ ones only while you have Peekaboo+.
export function canSendSticker(id: string, plus: boolean): boolean {
  return isKnownSticker(id) && (plus || !isPlusSticker(id));
}

// Everything in the chat sticker picker, in order. The free ones come first.
export const FREE_CHAT_STICKERS: string[] = [...SPECIAL_STICKERS, ...WORD_STICKERS.map(wordStickerId)];

export { isPlusSticker };
