import { Skia, type SkPathBuilder } from '@shopify/react-native-skia';

// ---------------------------------------------------------------------------
// Words made of little squares, like an old computer screen (5 squares wide, 7 tall per letter). The camera's
// drawing thread has no fonts, so the stretchy filters' labels ("CHIN POWER 87%", "GIGACHIN", "ERROR") are
// drawn this way. It fits the glitchy look, and it looks exactly the same on iPhone, Android and the photo.
//
// Each row's lit squares that touch are joined into one rectangle, and a whole label goes into one shape,
// so it is drawn in one go. Only these characters are known: A C E G H I N O P R W 0–9 % and the space;
// anything else is left out (as a space).
// ---------------------------------------------------------------------------

const GLYPH_CHARS = 'ACEGHINOPRW0123456789%';
// 7 rows per character, top to bottom; each row is 5 bits, the left square is the biggest bit (16).
const GLYPH_ROWS = [
  14, 17, 17, 31, 17, 17, 17, // A
  14, 17, 16, 16, 16, 17, 14, // C
  31, 16, 16, 30, 16, 16, 31, // E
  14, 17, 16, 23, 17, 17, 15, // G
  17, 17, 17, 31, 17, 17, 17, // H
  14, 4, 4, 4, 4, 4, 14, // I
  17, 25, 21, 19, 17, 17, 17, // N
  14, 17, 17, 17, 17, 17, 14, // O
  30, 17, 17, 30, 16, 16, 16, // P
  30, 17, 17, 30, 20, 18, 17, // R
  17, 17, 17, 21, 21, 21, 10, // W
  14, 17, 19, 21, 25, 17, 14, // 0
  4, 12, 4, 4, 4, 4, 14, // 1
  14, 17, 1, 2, 4, 8, 31, // 2
  31, 2, 4, 2, 1, 17, 14, // 3
  2, 6, 10, 18, 31, 2, 2, // 4
  31, 16, 30, 1, 1, 17, 14, // 5
  6, 8, 16, 30, 17, 17, 14, // 6
  31, 1, 2, 4, 8, 8, 8, // 7
  14, 17, 17, 14, 17, 17, 14, // 8
  14, 17, 17, 15, 1, 2, 12, // 9
  24, 25, 2, 4, 8, 19, 3, // %
];
// Each character is 5 squares wide with 1 square of space after it.
const ADVANCE = 6;

// How wide a label is, in squares of size `cell` (no space after the last character).
export function pixelTextWidth(text: string, cell: number) {
  'worklet';
  if (!text || text.length === 0) return 0;
  return (text.length * ADVANCE - 1) * cell;
}

// Adds `text` to `builder`, with its middle at (cx, cy) and squares `cell` points wide (so it is 7·cell tall).
export function addPixelText(builder: SkPathBuilder, text: string, cx: number, cy: number, cell: number) {
  'worklet';
  if (!text || !(cell > 0.05) || !(Math.abs(cx) + Math.abs(cy) < 1e7)) return;
  const left = cx - pixelTextWidth(text, cell) / 2;
  const top = cy - (7 * cell) / 2;
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPH_CHARS.indexOf(text.charAt(i));
    if (glyph < 0) continue;
    const x0 = left + i * ADVANCE * cell;
    for (let row = 0; row < 7; row++) {
      const bits = GLYPH_ROWS[glyph * 7 + row];
      let col = 0;
      while (col < 5) {
        if (((bits >> (4 - col)) & 1) === 0) {
          col++;
          continue;
        }
        // A run of lit squares becomes one rectangle.
        let end = col;
        while (end < 5 && ((bits >> (4 - end)) & 1) === 1) end++;
        builder.addRect(Skia.XYWHRect(x0 + col * cell, top + row * cell, (end - col) * cell, cell));
        col = end;
      }
    }
  }
}
