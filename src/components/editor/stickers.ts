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
  // How big and how turned (radians) it starts – set for the googly lens's eyes, which match the faces.
  startScale?: number;
  startRotation?: number;
  // The new text tool (all optional, so older text still works – see resolveText in TextLook.tsx).
  font?: TextFont;
  effect?: TextEffect;
  animation?: TextAnimation;
  align?: TextAlign;
  background?: TextBackground;
  // Letter size in points (34 when not set).
  size?: number;
  // Every "o" is drawn as a little googly eye.
  googly?: boolean;
};

// The 6 text styles (fonts), see TEXT_FONTS in TextLook.tsx.
export type TextFont = 'bubbly' | 'marker' | 'retro' | 'diary' | 'typed' | 'loud';
export type TextEffect = 'none' | 'glow' | 'neon' | 'outline' | 'shadow' | 'pop3d';
export type TextAnimation = 'none' | 'pop' | 'bounce' | 'wiggle' | 'typewriter' | 'peek';
export type TextAlign = 'left' | 'center' | 'right';
// 'pill' = soft round bubble, 'block' = solid box, 'clear' = see-through dark box.
export type TextBackground = 'none' | 'pill' | 'block' | 'clear';

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

// A few extra Peekaboo colours for the text tool's colour row.
export const BRAND_TEXT_COLORS = ['#FFD6EA', '#E2D2FF', '#FFB86B', '#1B1428'];

// Light colours get dark text on top of them.
const LIGHT_COLORS = ['#FFD6EA', '#E2D2FF', '#FFB86B'];

// Dark text on light bubbles, white text on dark bubbles.
export function textOn(background: string): string {
  return [colors.white, colors.yellow, colors.green, ...LIGHT_COLORS].includes(background as never) ? colors.black : colors.white;
}

export function randomOffset(range: number): number {
  return Math.round((Math.random() - 0.5) * range);
}
