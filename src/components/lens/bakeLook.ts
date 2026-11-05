import { ImageFormat, Skia } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

import { paintLook, type LensFace, type LensLook } from './lensPaint';

// ---------------------------------------------------------------------------
// Puts the face filter on the saved photo, so the photo looks like the live camera did.
//
// Why this way: the live look is drawn on top of the camera view, but the camera picture itself isn't
// something a screenshot of the screen can reliably catch (on iPhone it often comes out black), and a
// screenshot is only screen-sized. So instead we take the real photo and draw the same look on it with
// Skia, off screen, using the same drawing code (lensPaint.ts) and the face points from the moment you
// pressed the button.
//
// The camera view shows the photo "zoomed to fill" (cover): the photo is scaled until it fills the view and
// the overflow is cut off. We draw in the view's own coordinates and let Skia scale them onto the photo.
// ---------------------------------------------------------------------------

// Big photos are made smaller first (the app shrinks photos before sending anyway); saves memory and time.
const MAX_SIDE = 2400;

export async function bakeLook(
  photoUri: string,
  look: LensLook,
  faces: LensFace[],
  view: { width: number; height: number },
  time: number,
): Promise<string> {
  if (view.width <= 0 || view.height <= 0) throw new Error('No camera view size');
  const data = await Skia.Data.fromURI(photoUri);
  const photo = Skia.Image.MakeImageFromEncoded(data);
  if (!photo) throw new Error('Could not read the photo');
  const k = Math.min(1, MAX_SIDE / Math.max(photo.width(), photo.height()));
  const width = Math.round(photo.width() * k);
  const height = Math.round(photo.height() * k);

  const surface = Skia.Surface.MakeOffscreen(width, height) ?? Skia.Surface.Make(width, height);
  if (!surface) throw new Error('Could not make a drawing surface');
  const canvas = surface.getCanvas();
  const plain = Skia.Paint();
  plain.setAntiAlias(true);
  canvas.drawImageRect(photo, Skia.XYWHRect(0, 0, photo.width(), photo.height()), Skia.XYWHRect(0, 0, width, height), plain);

  // How many view points one photo pixel is (cover: the bigger of the two).
  const s = Math.max(view.width / width, view.height / height);
  canvas.save();
  canvas.translate(width / 2, height / 2);
  canvas.scale(1 / s, 1 / s);
  canvas.translate(-view.width / 2, -view.height / 2);
  // The whole photo, in view coordinates (bigger than the view where the view cut it off).
  const fill = Skia.XYWHRect(view.width / 2 - (width * s) / 2, view.height / 2 - (height * s) / 2, width * s, height * s);
  paintLook(canvas, look, faces, view.width, view.height, time, fill);
  canvas.restore();
  surface.flush();

  const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 90);
  if (!bytes || bytes.length === 0) throw new Error('Could not save the photo');
  const file = new File(Paths.cache, `lens-${Date.now()}.jpg`);
  await file.write(bytes);
  return file.uri;
}
