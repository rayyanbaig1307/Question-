import { BlendMode, BlurStyle, ImageFormat, PaintStyle, Skia, StrokeCap, TileMode, type SkCanvas, type SkImage, type SkPath } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

import { blushSpot, linerPath, lipsPath, skinPath } from './facePaths';
import type { FaceLook, FaceShape, Pt } from './faceLens';

// ---------------------------------------------------------------------------
// Paints the Glam and Glow lenses onto the finished photo, blended into the real skin (not stuck on top):
// * Glam: lipstick in the exact shape of the lips (the lips' own texture shows through), soft blush that fades
//   into the cheeks, thin eyeliner with a little wing, and a light skin smoothing.
// * Glow: smoother skin (eyes, brows and lips stay sharp), a soft light bloom and a warm, bright tone.
// The face outlines come from the live camera (screen points); the photo is shown "cover" on that screen,
// so they're mapped onto the photo's own pixels. Only loaded where Skia exists (the app download).
// ---------------------------------------------------------------------------

// Bigger photos are shrunk to this many pixels on their long side (plenty for sharing, and quick).
const MAX_SIDE = 1600;

export async function paintLook(uri: string, shapes: FaceShape[], look: FaceLook, screen: { width: number; height: number }): Promise<string> {
  const data = await Skia.Data.fromURI(uri);
  const photo = Skia.Image.MakeImageFromEncoded(data);
  if (!photo) return uri;
  const k = Math.min(1, MAX_SIDE / Math.max(photo.width(), photo.height()));
  const w = Math.round(photo.width() * k);
  const h = Math.round(photo.height() * k);
  const surface = Skia.Surface.MakeOffscreen(w, h) ?? Skia.Surface.Make(w, h);
  if (!surface) return uri;
  const canvas = surface.getCanvas();
  const full = Skia.XYWHRect(0, 0, w, h);
  canvas.drawImageRect(photo, Skia.XYWHRect(0, 0, photo.width(), photo.height()), full, Skia.Paint());
  // Freeze the plain photo, to draw blurred copies of it.
  surface.flush();
  const base = surface.makeImageSnapshot();

  // Screen point → photo pixel (the preview showed the photo filling the screen, cropped to fit).
  const s = Math.max(screen.width / w, screen.height / h);
  const offsetX = (w * s - screen.width) / 2;
  const offsetY = (h * s - screen.height) / 2;
  const map = (p: Pt): Pt => ({ x: (p.x + offsetX) / s, y: (p.y + offsetY) / s });
  const faces = shapes.map((shape) => ({ shape, width: shape.width / s }));

  if (look === 'glow') {
    for (const { shape, width } of faces) smoothSkin(canvas, base, shape, width, map, 0.7);
    bloom(canvas, base, w, h);
    tone(canvas, full, 'rgba(255, 205, 185, 1)', 0.32);
  } else if (look === 'makeup') {
    for (const { shape, width } of faces) {
      smoothSkin(canvas, base, shape, width, map, 0.4);
      blush(canvas, shape, width, map);
      lipstick(canvas, shape, width, map);
      liner(canvas, shape, width, map);
    }
    tone(canvas, full, 'rgba(255, 215, 205, 1)', 0.14);
  }

  surface.flush();
  const done = surface.makeImageSnapshot().makeNonTextureImage() ?? surface.makeImageSnapshot();
  const bytes = done.encodeToBytes(ImageFormat.JPEG, 90);
  const file = new File(Paths.cache, `lens-${Date.now()}.jpg`);
  await file.write(bytes);
  return file.uri;
}

// Smooth skin: a blurred copy of the photo, only inside the face (not the eyes, brows or lips),
// faded in softly at the edges.
function smoothSkin(canvas: SkCanvas, base: SkImage, shape: FaceShape, width: number, map: (p: Pt) => Pt, strength: number) {
  const skin = skinPath(shape, map);
  if (!skin) return;
  const layer = Skia.Paint();
  layer.setAlphaf(strength);
  canvas.saveLayer(layer);
  const blurred = Skia.Paint();
  blurred.setImageFilter(Skia.ImageFilter.MakeBlur(width * 0.018, width * 0.018, TileMode.Clamp, null));
  canvas.drawImage(base, 0, 0, blurred);
  // Keep the blur only where the (softened) skin shape is.
  const mask = Skia.Paint();
  mask.setBlendMode(BlendMode.DstIn);
  mask.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, width * 0.03, true));
  canvas.drawPath(skin, mask);
  canvas.restore();
}

// A soft light bloom over the whole photo (a very blurred copy, added as light).
function bloom(canvas: SkCanvas, base: SkImage, w: number, h: number) {
  const layer = Skia.Paint();
  layer.setAlphaf(0.22);
  layer.setBlendMode(BlendMode.Screen);
  canvas.saveLayer(layer);
  const blurred = Skia.Paint();
  const sigma = Math.max(w, h) * 0.018;
  blurred.setImageFilter(Skia.ImageFilter.MakeBlur(sigma, sigma, TileMode.Clamp, null));
  canvas.drawImage(base, 0, 0, blurred);
  canvas.restore();
}

// A warm colour mixed in softly (soft light keeps the skin's own detail).
function tone(canvas: SkCanvas, rect: ReturnType<typeof Skia.XYWHRect>, color: string, amount: number) {
  const paint = Skia.Paint();
  paint.setColor(Skia.Color(color));
  paint.setAlphaf(amount);
  paint.setBlendMode(BlendMode.SoftLight);
  canvas.drawRect(rect, paint);
}

// Lipstick: the lips' colour changes but their light and texture stay (colour + a touch of multiply).
function lipstick(canvas: SkCanvas, shape: FaceShape, width: number, map: (p: Pt) => Pt) {
  const lips = lipsPath(shape, map);
  if (!lips) return;
  const soft = Skia.MaskFilter.MakeBlur(BlurStyle.Normal, width * 0.006, true);
  paintPath(canvas, lips, 'rgb(205, 30, 85)', 0.55, BlendMode.Color, soft);
  paintPath(canvas, lips, 'rgb(190, 40, 90)', 0.22, BlendMode.Multiply, soft);
  paintPath(canvas, lips, 'rgb(255, 170, 190)', 0.12, BlendMode.SoftLight, soft);
}

// Blush: a soft rosy glow on each cheek that fades to nothing.
function blush(canvas: SkCanvas, shape: FaceShape, width: number, map: (p: Pt) => Pt) {
  for (const side of ['left', 'right'] as const) {
    const spot = blushSpot(shape, side);
    if (!spot) continue;
    const c = map(spot);
    const r = width * 0.17;
    const paint = Skia.Paint();
    paint.setShader(
      Skia.Shader.MakeRadialGradient(
        { x: c.x, y: c.y },
        r,
        [Skia.Color('rgba(235, 70, 110, 0.55)'), Skia.Color('rgba(235, 70, 110, 0)')],
        [0, 1],
        TileMode.Clamp,
      ),
    );
    paint.setBlendMode(BlendMode.Multiply);
    paint.setAlphaf(0.55);
    canvas.drawCircle(c.x, c.y, r, paint);
  }
}

// Eyeliner: a thin dark line along each top lid with a small wing.
function liner(canvas: SkCanvas, shape: FaceShape, width: number, map: (p: Pt) => Pt) {
  const leftIsOuterLeft = (shape.leftEye[0]?.x ?? 0) < (shape.rightEye[0]?.x ?? 0);
  for (const [eye, outerIsLeft] of [
    [shape.leftEye, leftIsOuterLeft],
    [shape.rightEye, !leftIsOuterLeft],
  ] as const) {
    const path = linerPath(eye, outerIsLeft, width, map);
    if (!path) continue;
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(25, 12, 20)'));
    paint.setAlphaf(0.7);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(width * 0.009);
    paint.setStrokeCap(StrokeCap.Round);
    paint.setAntiAlias(true);
    paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, width * 0.002, true));
    canvas.drawPath(path, paint);
  }
}

function paintPath(canvas: SkCanvas, path: SkPath, color: string, alpha: number, blend: BlendMode, mask: ReturnType<typeof Skia.MaskFilter.MakeBlur>) {
  const paint = Skia.Paint();
  paint.setColor(Skia.Color(color));
  paint.setAlphaf(alpha);
  paint.setBlendMode(blend);
  paint.setMaskFilter(mask);
  paint.setAntiAlias(true);
  canvas.drawPath(path, paint);
}
