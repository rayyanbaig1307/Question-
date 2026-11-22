import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';
import { Platform, TurboModuleRegistry } from 'react-native';
import type { SkImage, SkSurface } from '@shopify/react-native-skia';

// ---------------------------------------------------------------------------
// The small white Peekaboo wordmark on pictures that LEAVE the app (the share sheet and Save to Photos, see
// lib/shareOut.ts). Pictures that stay inside Peekaboo (stories, posts, peeks, Keeps) stay clean.
//
// Nothing runs when this file loads. Skia is only loaded when a picture is marked, and only if this download has
// it (the same check as lib/media.ts): the editor uses this file too, and the editor runs on every download.
// ---------------------------------------------------------------------------

// Where the wordmark goes, as parts of the picture. One place to move it.
// Top left: Instagram, Snapchat and TikTok put their own bars in the top ~9 % and their buttons and captions at
// the bottom and bottom right, so this spot stays visible. On a Main Character poster it sits on the sky, never
// on the face.
export const WATERMARK = {
  // 20 % of the picture's width.
  width: 0.2,
  // 5 % of the width in from the left side.
  side: 0.05,
  // On tall pictures (9:16 and the like): its top 11.5 % down, under the other apps' top bars.
  tallTop: 0.115,
  // On other pictures: 5 % down.
  top: 0.05,
  // How see-through it is (1 = solid).
  opacity: 0.9,
};

// A picture this much taller than wide (or more) counts as tall. 9:16 is 1.78, 3:4 is 1.33.
const TALL = 1.6;
// The wordmark picture (assets/images/wordmark-white.png) is 1171 × 240.
const WORDMARK_ASPECT = 240 / 1171;
// The soft shadow under it, as drawn on a picture 1080 wide (bigger pictures get a bigger shadow).
const SHADOW = { dx: 0, dy: 2, blur: 3, color: 'rgba(0,0,0,0.35)' };
const JPEG_QUALITY = 92;

// Where the wordmark goes on a picture w × h (in the picture's own pixels). All zeros for a picture with no size.
export function watermarkRect(w: number, h: number): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const width = w * WATERMARK.width;
  return {
    x: w * WATERMARK.side,
    y: h * (h / w >= TALL ? WATERMARK.tallTop : WATERMARK.top),
    width,
    height: width * WORDMARK_ASPECT,
  };
}

type SkiaModule = typeof import('@shopify/react-native-skia');

// Skia, only if this app download has it. Asking first, because the library crashes if it's loaded without its
// native part (the same check as lib/media.ts).
function loadSkia(): SkiaModule | null {
  try {
    if (!TurboModuleRegistry.get('RNSkiaModule')) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@shopify/react-native-skia') as SkiaModule;
  } catch {
    return null;
  }
}

// Frees a Skia object now instead of waiting for the phone to tidy up (big pictures use a lot of memory).
function letGo(thing: unknown) {
  try {
    (thing as { dispose?: () => void } | null)?.dispose?.();
  } catch {
    // Already gone: nothing to do.
  }
}

async function readBytes(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

// The wordmark picture, read once and kept (only once it worked: a failure is tried again next time).
let wordmark: SkImage | null = null;

async function loadWordmark(skia: SkiaModule): Promise<SkImage | null> {
  if (wordmark) return wordmark;
  const asset = Asset.fromModule(require('../../assets/images/wordmark-white.png'));
  await asset.downloadAsync();
  if (!asset.localUri) return null;
  const image = skia.Skia.Image.MakeImageFromEncoded(skia.Skia.Data.fromBytes(await readBytes(asset.localUri)));
  if (image && image.width() > 0 && image.height() > 0) wordmark = image;
  return wordmark;
}

// Where the marked picture is drawn. On an iPhone: a surface in the Display P3 colours (the wide colours iPhone
// screens and photos use), so a photo's colours stay exactly as they were and the new JPEG says which colours it
// uses. A plain surface knows no colours: wide-colour photos came out duller in Photos and other apps. Anywhere
// else, or if the P3 surface can't be made: the plain surface in the phone's memory, like lib/media.ts.
function makeSurface(Skia: SkiaModule['Skia'], w: number, h: number): SkSurface | null {
  if (Platform.OS === 'ios') {
    try {
      const wide = Skia.Surface.MakeOffscreen(w, h, { colorSpace: 'display-p3' });
      if (wide) return wide;
    } catch {
      // No P3 surface on this phone: the plain one below.
    }
  }
  return Skia.Surface.Make(w, h);
}

// A new, unused file in the phone's cache: peekaboo-<time>.jpg (the name people see if they AirDrop it).
function newFile(notThis: string): File {
  const stamp = Date.now();
  for (let n = 0; n < 100; n++) {
    const file = new File(Paths.cache, n === 0 ? `peekaboo-${stamp}.jpg` : `peekaboo-${stamp}-${n}.jpg`);
    if (!file.exists && file.uri !== notThis) return file;
  }
  throw new Error('No free file name for the marked picture');
}

// A NEW JPEG in the phone's cache (quality 92) with the small white Peekaboo wordmark on it. The file it was given
// is never changed. Returns null when it can't (no Skia on this download, or anything goes wrong): the caller
// then uses the clean file, so Save and Share always work. Never throws.
export async function watermarkPhoto(uri: string): Promise<string | null> {
  const skia = loadSkia();
  if (!skia) return null;
  const { FilterMode, ImageFormat, MipmapMode, Skia } = skia;
  let photo: SkImage | null = null;
  let surface: SkSurface | null = null;
  let snapshot: SkImage | null = null;
  const trash: unknown[] = [];
  try {
    const mark = await loadWordmark(skia);
    if (!mark) return null;
    photo = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(await readBytes(uri)));
    if (!photo) return null;
    const w = photo.width();
    const h = photo.height();
    const place = watermarkRect(w, h);
    if (place.width <= 0) return null;
    // On an iPhone in the photo's own wide colours, elsewhere a plain picture in the phone's memory (makeSurface).
    surface = makeSurface(Skia, w, h);
    if (!surface) return null;
    const canvas = surface.getCanvas();
    canvas.drawImage(photo, 0, 0);

    const grow = Math.max(1, w / 1080);
    const shadow = Skia.ImageFilter.MakeDropShadow(SHADOW.dx * grow, SHADOW.dy * grow, SHADOW.blur * grow, SHADOW.blur * grow, Skia.Color(SHADOW.color), null);
    trash.push(shadow);
    const paint = Skia.Paint();
    trash.push(paint);
    paint.setAntiAlias(true);
    paint.setAlphaf(WATERMARK.opacity);
    paint.setImageFilter(shadow);
    canvas.drawImageRectOptions(
      mark,
      Skia.XYWHRect(0, 0, mark.width(), mark.height()),
      Skia.XYWHRect(place.x, place.y, place.width, place.height),
      FilterMode.Linear,
      MipmapMode.Linear,
      paint,
    );
    surface.flush();
    snapshot = surface.makeImageSnapshot();
    const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, JPEG_QUALITY);
    if (!bytes || bytes.length === 0) return null;
    const file = newFile(uri);
    await file.write(bytes);
    return file.uri;
  } catch (error) {
    console.warn('Could not put the Peekaboo wordmark on the picture, so the clean one is used', error);
    return null;
  } finally {
    trash.forEach(letGo);
    letGo(snapshot);
    letGo(surface);
    letGo(photo);
  }
}
