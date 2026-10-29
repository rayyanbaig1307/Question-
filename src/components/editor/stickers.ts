import { colors } from '@/theme';

export type OverlayItem = {
  id: string;
  // 'special' = one of Peekaboo's own drawn stickers (content is its name, see SpecialSticker.tsx)
  kind: 'text' | 'sticker' | 'special';
  content: string;
  color: string;
  // 'shadow' = colored text, 'pill' = text on a colored bubble
  look: 'shadow' | 'pill';
  // Where it first appears, measured from the middle of the photo.
  startX: number;
  startY: number;
};

export const EMOJI_STICKERS = [
  '😂', '😍', '🥳', '😎', '🤪', '😭', '🥺', '😈', '🙈', '💀',
  '🔥', '✨', '💖', '💯', '👀', '🙌', '👑', '🌈', '⭐️', '🌸',
  '🍕', '🍦', '🎉', '🎈', '🐶', '🐱', '🦄', '🐸', '🌚', '☀️',
  '⚡️', '💅', '🤙', '✌️', '🫶', '💋', '🧢', '🕶️', '🎧', '📸',
];

export const WORD_STICKERS = ['LOL', 'OMG', 'BFF', 'SLAY', 'NO WAY', 'MOOD', 'IYKYK', 'WOW'];

export const TEXT_COLORS = [
  colors.white,
  colors.yellow,
  colors.pink,
  colors.purple,
  colors.blue,
  colors.green,
  colors.orange,
  colors.red,
  colors.black,
];

// Dark text on light bubbles, white text on dark bubbles.
export function textOn(background: string): string {
  return [colors.white, colors.yellow, colors.green].includes(background as never) ? colors.black : colors.white;
}

export function randomOffset(range: number): number {
  return Math.round((Math.random() - 0.5) * range);
}
