// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the comic look on your face (docs/MAIN_CHARACTER.md).
//
// A small GPU program (SkSL, Skia's shader language) that makes the camera picture (or the photo) look painted,
// like a comic poster: a little smoother, more colour and contrast, soft "poster" bands of colour, a warm sunset
// tint and dark ink lines on the edges. It can also pull the skin a little towards the character's own skin
// colour (only on the skin, never the eyes, brows or lips: paintScene.ts draws that part on its own).
//
// Plain text and numbers only here, no imports on purpose: comicEffect.ts turns the text into a Skia effect,
// and tests/unit/main-character-shader.test.mjs compiles and runs it with Skia's web version.
// The numbers can be changed by an app update. Saved posters always use COMIC; the live screen uses COMIC_LIVE
// on top of it (when LIVE_COMIC_GENTLE in lib/mainCharacter/config.ts is on), so the moving camera picture
// doesn't shimmer.
// ---------------------------------------------------------------------------

export const COMIC = {
  edge: 2.0,                 // how far apart the ink's samples are, in poster pixels
  toneMix: 0.1,              // how much the skin is pulled towards the character's skin colour (0 = not at all)
  saturation: 1.3,           // more colour (1 = as it was)
  contrast: 1.15,            // more contrast (1 = as it was)
  levels: 6,                 // how many colour bands
  posterMix: 0.5,            // how much of the banded colour is used (0 = none, 1 = only bands)
  bandSoft: 0.25,            // how soft each band's step is (must be above 0: a short ramp, not a hard jump)
  warm: [1.05, 0.99, 0.93],  // the sunset tint: red, green and blue are multiplied by these
  inkAmount: 0.85,           // how dark the ink lines are (0 = no ink)
  inkEdge: [0.08, 0.22],     // edges softer than the first number get no ink, harder than the second get all of it
  soften: 0.65,              // how much smoother, like paint (0 = not at all)
};

// Live only (when LIVE_COMIC_GENTLE): softer bands and ink, so camera noise doesn't flicker.
export const COMIC_LIVE = { posterMix: 0.3, inkAmount: 0.6 };

// How many numbers the program takes (everything after `face` below, in order). comicEffect.ts checks it.
export const COMIC_UNIFORM_FLOATS = 17;

// `face` is the camera picture or the photo, already placed in poster pixels (paintScene.ts does that).
export const COMIC_SHADER = `
uniform shader face;
uniform float edge;
uniform float3 tone;
uniform float toneMix;
uniform float saturation;
uniform float contrast;
uniform float levels;
uniform float posterMix;
uniform float bandSoft;
uniform float3 warm;
uniform float inkAmount;
uniform float2 inkEdge;
uniform float soften;

half4 main(float2 p) {
  float2 dx = float2(edge, 0.0);
  float2 dy = float2(0.0, edge);
  half3 c  = face.eval(p).rgb;
  half3 n  = face.eval(p - dy).rgb;       half3 s  = face.eval(p + dy).rgb;
  half3 w  = face.eval(p - dx).rgb;       half3 e  = face.eval(p + dx).rgb;
  half3 nw = face.eval(p - dx - dy).rgb;  half3 ne = face.eval(p + dx - dy).rgb;
  half3 sw = face.eval(p - dx + dy).rgb;  half3 se = face.eval(p + dx + dy).rgb;
  half3 L = half3(0.299, 0.587, 0.114);
  // Ink: how strong the edge is here (Sobel on brightness).
  float gx = dot(ne + 2.0 * e + se - nw - 2.0 * w - sw, L);
  float gy = dot(sw + 2.0 * s + se - nw - 2.0 * n - ne, L);
  float ink = smoothstep(inkEdge.x, inkEdge.y, length(float2(gx, gy)));
  // A little smoother, like paint.
  half3 col = mix(c, (c * 4.0 + n + s + e + w + nw + ne + sw + se) / 12.0, soften);
  // Toward the character's skin colour, keeping this person's own light and shade (only on the skin draw).
  float y = dot(col, L);
  half3 skin = half3(tone) * (y / max(dot(half3(tone), L), 0.05));
  col = mix(col, skin, toneMix);
  // More colour and contrast.
  float y2 = dot(col, L);
  col = mix(half3(y2), col, saturation);
  col = (col - 0.5) * contrast + 0.5;
  // Poster banding: each step is a short smooth ramp (not a hard jump), so camera noise doesn't flicker.
  float3 x = float3(col) * levels;
  float3 f = floor(x);
  half3 banded = half3((f + smoothstep(0.5 - bandSoft, 0.5 + bandSoft, x - f)) / levels);
  col = mix(col, banded, posterMix);
  // A warm sunset tint, then the ink.
  col = col * half3(warm);
  col = col * (1.0 - inkAmount * ink);
  return half4(clamp(col, 0.0, 1.0), 1.0);
}`;

// A number from 0 to 1 (anything broken becomes 0).
function unit(x: number) {
  'worklet';
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

// The 17 numbers for the program, in the order above. `tone` is the character's skin colour (3 numbers, 0–1),
// `toneMix` how much to pull towards it (0 = not at all: the first face draw). `live` true = the softer live
// numbers (the caller passes `live && LIVE_COMIC_GENTLE`). Always 17 real numbers: a broken tone gives no pull.
export function comicUniforms(tone: number[], toneMix: number, live: boolean): number[] {
  'worklet';
  const toneOk = !!tone && tone.length >= 3 && Number.isFinite(tone[0]) && Number.isFinite(tone[1]) && Number.isFinite(tone[2]);
  const r = toneOk ? unit(tone[0]) : 0;
  const g = toneOk ? unit(tone[1]) : 0;
  const b = toneOk ? unit(tone[2]) : 0;
  const mix = toneOk ? unit(toneMix) : 0;
  const posterMix = live ? COMIC_LIVE.posterMix : COMIC.posterMix;
  const inkAmount = live ? COMIC_LIVE.inkAmount : COMIC.inkAmount;
  return [
    COMIC.edge,
    r, g, b,
    mix,
    COMIC.saturation,
    COMIC.contrast,
    COMIC.levels,
    posterMix,
    COMIC.bandSoft,
    COMIC.warm[0], COMIC.warm[1], COMIC.warm[2],
    inkAmount,
    COMIC.inkEdge[0], COMIC.inkEdge[1],
    COMIC.soften,
  ];
}
