// ---------------------------------------------------------------------------
// The 4 stretchy filters' little GPU programs (SkSL, Skia's shader language). Each one looks at the camera
// picture (`image`) and moves its pixels around: it works in screen points (the same units as the face
// points), and `image.eval(p)` means "the camera picture at screen point p". The camera picture comes in
// already placed on the screen (frameMatrix.ts), or the saved photo when baking (bakeLook.ts).
//
// Every warp is exactly the plain picture at its edge, so it can be drawn straight over the picture with no
// seam. And every warp is SEE-THROUGH wherever it changes nothing (it gives "nothing", half4(0), never the plain
// picture): its box is drawn over what is already on the screen, so with two faces close together the second
// face's box must not paint the plain picture back over the first face's warp.
// Plain text only here (no imports); warpEffects.ts turns them into Skia effects.
// tests/unit/warp-shaders.test.mjs compiles each one with Skia's web version and draws it on a test pattern.
// ---------------------------------------------------------------------------

// 😃 Big Mouth: a balloon. The middle is magnified `scale` times and it eases back to normal at the edge,
// so there is no seam and no double mouth. Outside the oval it draws nothing (the picture below shows).
export const BALLOON = `
uniform shader image;
uniform float2 center;
uniform float2 axis;
uniform float2 radii;
uniform float scale;

half4 main(float2 p) {
  float2 d = p - center;
  float2 across = float2(-axis.y, axis.x);
  float r = length(float2(dot(d, axis), dot(d, across)) / radii);
  if (r >= 1.0) { return half4(0); }
  return image.eval(center + d * mix(1.0 / max(scale, 1.0), 1.0, smoothstep(0.0, 1.0, r)));
}`;

// 🫥 Tiny Face: your face, made `scale` times smaller, put back with a soft edge in the middle of the
// blurred "egg" (the web version's warpRegion with `at`). Turned with the head.
export const SHRINK = `
uniform shader image;
uniform float2 from;
uniform float2 to;
uniform float2 axis;
uniform float2 radii;
uniform float scale;
uniform float feather;

half4 main(float2 p) {
  float2 across = float2(-axis.y, axis.x);
  float2 d = p - to;
  float2 l = float2(dot(d, axis), dot(d, across));
  float r = length(l / radii);
  float a = 1.0 - clamp((r - (1.0 - feather)) / max(feather, 0.0001), 0.0, 1.0);
  if (a <= 0.0) { return half4(0); }
  return image.eval(from + (axis * l.x + across * l.y) / max(scale, 0.05)) * half(a);
}`;

// 🗿 Gigachin: everything under the lower lip is stretched down (and a bit wider), then eases back to
// normal under the new chin and at the sides, so there is no seam anywhere. Outside (above the lip line,
// beside it, and below where it has eased back) it draws nothing.
// (The widening eases back under the new chin too, so the neck below is the plain picture again.)
export const STRETCH = `
uniform shader image;
uniform float2 top;
uniform float2 axis;
uniform float2 down;
uniform float halfWidth;
uniform float height;
uniform float sx;
uniform float sy;
uniform float release;

half4 main(float2 p) {
  float2 d = p - top;
  float u = dot(d, axis);
  float v = dot(d, down);
  float side = abs(u) / halfWidth;
  float stretched = height * sy;
  if (v <= 0.0 || side >= 1.0 || v >= stretched + release) { return half4(0); }
  float vs = v;
  if (v <= stretched) {
    vs = v / sy;
  } else if (v <= stretched + release) {
    vs = mix(height, stretched + release, (v - stretched) / release);
  }
  float widen = mix(1.0, sx, smoothstep(0.0, 0.3 * stretched, v) * (1.0 - smoothstep(stretched, stretched + release, v)));
  float w = 1.0 - smoothstep(0.7, 1.0, side);
  return image.eval(top + axis * mix(u, u / widen, w) + down * mix(v, vs, w));
}`;

// 👾 Pixel Panic: big pixels over the face in a soft oval, up to 7 torn slices of the picture shoved
// sideways, with magenta and cyan ghosts (mixed in here like a 'screen' blend, with the real camera
// colours, so no blend mode is needed). Outside all of that it draws nothing.
// The soft edge of the pixel oval is see-through in part (the big pixels at strength `a`, "premultiplied":
// the colour is already multiplied by `a`), so whatever is under it shows through the rest: the plain picture,
// or another face's pixels. On the picture this looks exactly like mixing the plain picture with the pixels.
// Each slice is 4 numbers: its top, its height, how far it is shoved and its colour (0 magenta, 1 cyan).
export const PIXEL = `
uniform shader image;
uniform float4 box;
uniform float block;
uniform float feather;
uniform float level;
uniform float count;
uniform float4 slices[7];

half4 main(float2 p) {
  half4 col = half4(0);
  float2 c = box.xy + box.zw * 0.5;
  float r = length((p - c) / (box.zw * 0.5));
  float a = 1.0 - clamp((r - (1.0 - feather)) / max(feather, 0.0001), 0.0, 1.0);
  if (a > 0.0 && block > 1.0) {
    float2 cell = (floor((p - box.xy) / block) + 0.5) * block + box.xy;
    float k = block * 0.25;
    half4 avg = (image.eval(cell + float2(-k, -k)) + image.eval(cell + float2(k, -k))
               + image.eval(cell + float2(-k, k)) + image.eval(cell + float2(k, k))) * 0.25;
    col = avg * half(a);
  }
  for (int i = 0; i < 7; i++) {
    if (float(i) >= count) { break; }
    float4 s = slices[i];
    if (p.y >= s.x && p.y < s.x + s.y) {
      if (p.x >= box.x + s.z && p.x < box.x + box.z + s.z) { col = image.eval(float2(p.x - s.z, p.y)); }
      if (p.y < s.x + s.y * 0.5 && p.x >= box.x + s.z * 1.4 && p.x < box.x + box.z + s.z * 1.4) {
        // What this spot shows so far (the pixels, or a slice, over the plain picture), then the ghost on it.
        half4 base = col + image.eval(p) * (1.0 - col.a);
        half3 ghost = s.w < 0.5 ? half3(1.0, 0.0, 0.784) : half3(0.0, 0.898, 1.0);
        col = half4(mix(base.rgb, 1.0 - (1.0 - base.rgb) * (1.0 - ghost), half(0.5 * level)), 1.0);
      }
    }
  }
  return col;
}`;

// How many numbers each one takes (its uniforms, in order). warpEffects.ts checks these against Skia.
export const UNIFORM_FLOATS = { BALLOON: 7, SHRINK: 10, STRETCH: 11, PIXEL: 36 } as const;

// Pixel Panic's most slices (the size of `slices` above).
export const MAX_SLICES = 7;

export const SHADERS = { BALLOON, SHRINK, STRETCH, PIXEL } as const;
