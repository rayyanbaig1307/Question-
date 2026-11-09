import { requireOptionalNativeModule } from 'expo';
import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { TurboModuleRegistry } from 'react-native';

import { supabase } from './supabase';
import type { MediaFields } from './types';
import { MAX_VIDEO_BYTES, TOO_BIG_VIDEO } from './videoLimits';

// 'mystery' is for Guess Who: those files go in a shared folder, so the file name doesn't give away who posted it.
type MediaFolder = 'posts' | 'stories' | 'snaps' | 'blurs' | 'mystery' | 'voice' | 'keeps' | 'group';

// What you're sending: a photo, or a video (with the text/stickers you added saved as a see-through picture).
export type Capture = { kind: 'photo'; uri: string } | { kind: 'video'; uri: string; overlayUri?: string | null };

// The still-picture maker is a native part of the app. Expo Go has it, but an app built before it was added
// doesn't – then videos simply go without a still picture.
const Thumbnails: typeof import('expo-video-thumbnails') | null = requireOptionalNativeModule('ExpoVideoThumbnails')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-video-thumbnails')
  : null;

// A still picture from the start of a video (shown in grids, previews and blurred drops).
export async function makePoster(videoUri: string): Promise<string | null> {
  if (!Thumbnails) return null;
  try {
    const { uri } = await Thumbnails.getThumbnailAsync(videoUri, { time: 0, quality: 0.8 });
    return resizePhoto(uri, 720);
  } catch {
    return null;
  }
}

// Uploads a photo or video (plus a video's still picture and text/sticker layer) into one of your folders.
// Also returns the local still picture, for making a blurry drop preview.
export async function uploadCapture(
  userId: string,
  folder: 'posts' | 'stories' | 'snaps' | 'mystery' | 'keeps' | 'group',
  capture: Capture,
): Promise<{ fields: MediaFields; stillUri: string | null }> {
  if (capture.kind === 'photo') {
    const media_path = await uploadMedia(userId, folder, capture.uri);
    return { fields: { media_path, media_type: 'photo', poster_path: null, overlay_path: null }, stillUri: capture.uri };
  }
  const posterUri = await makePoster(capture.uri);
  const uploaded: string[] = [];
  const save = async (uri: string, type: 'jpg' | 'png' | 'video' = 'jpg') => {
    const path = await uploadMedia(userId, folder, uri, type);
    uploaded.push(path);
    return path;
  };
  try {
    const media_path = await save(capture.uri, 'video');
    const poster_path = posterUri ? await save(posterUri) : null;
    const overlay_path = capture.overlayUri ? await save(capture.overlayUri, 'png') : null;
    return { fields: { media_path, media_type: 'video', poster_path, overlay_path }, stillUri: posterUri };
  } catch (error) {
    // A video has several files. If a later file fails, undo the files already saved.
    await deleteMedia(uploaded).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}

// All the files that belong to one photo or video (to delete them together).
export function mediaFiles(item: Partial<MediaFields> & { blur_path?: string | null }): string[] {
  return [item.media_path, item.poster_path, item.overlay_path, item.blur_path].filter((path): path is string => !!path);
}

// A tiny (24 px wide) copy of a photo, shown heavily blurred until a drop is unlocked.
export async function makeBlurPreview(uri: string): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri).resize({ width: 24 }).renderAsync();
  const saved = await rendered.saveAsync({ compress: 0.5, format: SaveFormat.JPEG });
  return saved.uri;
}

// Shrinks a photo so uploads are quick (and don't eat your data plan).
export async function resizePhoto(uri: string, maxWidth: number): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri).resize({ width: maxWidth }).renderAsync();
  const saved = await rendered.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return saved.uri;
}

// Cuts the middle of a photo to the shape width × height and saves it at exactly that size, as a fresh JPEG.
// Used for Guess Who in a group chat. What this promises:
// - Always: the file is a JPEG of exactly width × height, so its size and shape say nothing about the phone.
// - On app downloads that have Skia (a native part of the app): the JPEG is then saved again by Skia, at quality 80,
//   with no extra details in the file (no camera info, no colour profile). Skia is the same code on iPhone and
//   Android, so the same picture gives the same kind of file on both.
// - Without Skia (Expo Go, or an app built before it was added), or if Skia fails: the phone's own JPEG maker
//   saves it. That's our best effort: an iPhone file and an Android file can still look a bit different inside.
export async function fixedSizePhoto(uri: string, width: number, height: number): Promise<string> {
  const original = await ImageManipulator.manipulate(uri).renderAsync();
  const shape = width / height;
  // The biggest box with the right shape that fits inside the photo, right in the middle.
  const cropWidth = Math.min(original.width, Math.round(original.height * shape));
  const cropHeight = Math.min(original.height, Math.round(cropWidth / shape));
  const rendered = await ImageManipulator.manipulate(original)
    .crop({
      originX: Math.floor((original.width - cropWidth) / 2),
      originY: Math.floor((original.height - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
    })
    .resize({ width, height })
    .renderAsync();
  const saved = await rendered.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return (await sameJpegOnEveryPhone(saved.uri, width, height)) ?? saved.uri;
}

// Skia, only if this app download has it. Asking first, because the library crashes if it's loaded without its
// native part (the same check as components/ScratchRevealSafe.ts).
function loadSkia(): typeof import('@shopify/react-native-skia') | null {
  try {
    if (!TurboModuleRegistry.get('RNSkiaModule')) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@shopify/react-native-skia') as typeof import('@shopify/react-native-skia');
  } catch {
    return null;
  }
}

// Saves the photo again with Skia: drawn onto a plain width × height picture (no colour profile) and saved as a
// JPEG at quality 80 into a new file. Returns null when Skia isn't there or something goes wrong (then the caller
// keeps the file it has).
async function sameJpegOnEveryPhone(uri: string, width: number, height: number): Promise<string | null> {
  const skia = loadSkia();
  if (!skia) return null;
  try {
    const { ImageFormat, Skia } = skia;
    // Read the bytes ourselves: on Android, Skia's own file reader can wait forever if it can't read the file.
    const photo = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(new Uint8Array(await readBytes(uri))));
    // A picture in the phone's memory (not the graphics chip), so every phone draws it the same way.
    const surface = Skia.Surface.Make(width, height);
    if (!photo || !surface) return null;
    surface
      .getCanvas()
      .drawImageRect(photo, Skia.XYWHRect(0, 0, photo.width(), photo.height()), Skia.XYWHRect(0, 0, width, height), Skia.Paint());
    surface.flush();
    const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 80);
    if (!bytes || bytes.length === 0) return null;
    const file = new File(Paths.cache, `same-jpeg-${randomUUID()}.jpg`);
    await file.write(bytes);
    return file.uri;
  } catch (error) {
    console.warn('Could not save the photo with Skia, so the phone saved it instead', error);
    return null;
  }
}

async function readBytes(uri: string): Promise<ArrayBuffer> {
  return new File(uri).arrayBuffer();
}

// Uploads a photo (JPEG), see-through picture (PNG), video or voice recording to the private "media" bucket.
// Returns where it was saved.
export async function uploadMedia(
  userId: string,
  folder: MediaFolder,
  localUri: string,
  type: 'jpg' | 'png' | 'video' | 'audio' = 'jpg',
): Promise<string> {
  const isMov = /\.mov$/i.test(localUri);
  const [extension, contentType] =
    type === 'png'
      ? ['png', 'image/png']
      : type === 'audio'
        ? ['m4a', 'audio/mp4']
        : type === 'video'
          ? isMov
            ? ['mov', 'video/quicktime']
            : ['mp4', 'video/mp4']
          : ['jpg', 'image/jpeg'];
  const path = folder === 'mystery' ? `mystery/${randomUUID()}.${extension}` : `${userId}/${folder}/${randomUUID()}.${extension}`;
  const bytes = await readBytes(localUri);
  // The store takes files up to 30 MB. Say so kindly before uploading, instead of failing halfway.
  if (type === 'video' && bytes.byteLength > MAX_VIDEO_BYTES) throw new Error(TOO_BIG_VIDEO);
  const { error } = await supabase.storage.from('media').upload(path, bytes, { contentType });
  if (error) throw error;
  return path;
}

// Uploads a profile picture to the public "avatars" bucket.
export async function uploadAvatar(userId: string, localUri: string): Promise<string> {
  const path = `${userId}/${randomUUID()}.jpg`;
  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, await readBytes(localUri), { contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}

export async function deleteMedia(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from('media').remove(paths);
  if (error) throw error;
  paths.forEach((path) => cache.delete(path));
}

export async function deleteAvatar(path: string): Promise<void> {
  const { error } = await supabase.storage.from('avatars').remove([path]);
  if (error) throw error;
}

export function avatarUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

// ---------------------------------------------------------------------------
// Private photos are opened with short-lived links ("signed URLs").
// We remember links for a while so we don't ask for the same one twice.
// ---------------------------------------------------------------------------
const LINK_LIFETIME_SECONDS = 60 * 60;
const cache = new Map<string, { url: string; expiresAt: number }>();
const cacheListeners = new Set<() => void>();
let cacheOwner: string | null = null;
let cacheVersion = 0;

// A signed link carries permission with it. Never reuse one from a previous person's login.
supabase.auth.onAuthStateChange((_event, session) => {
  const owner = session?.user.id ?? null;
  if (owner === cacheOwner) return;
  cacheOwner = owner;
  cacheVersion += 1;
  cache.clear();
  cacheListeners.forEach((listener) => listener());
});

function cached(path: string): string | null {
  const hit = cache.get(path);
  // Treat links as stale 5 minutes early so they never expire mid-scroll.
  if (hit && hit.expiresAt - 5 * 60 * 1000 > Date.now()) return hit.url;
  return null;
}

export async function getMediaUrls(paths: string[]): Promise<Record<string, string>> {
  const version = cacheVersion;
  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of new Set(paths)) {
    const url = cached(path);
    if (url) result[path] = url;
    else missing.push(path);
  }
  if (missing.length > 0) {
    const { data, error } = await supabase.storage.from('media').createSignedUrls(missing, LINK_LIFETIME_SECONDS);
    // The request may have started for the person who just logged out.
    if (version !== cacheVersion) return {};
    if (error) throw error;
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) {
        cache.set(item.path, { url: item.signedUrl, expiresAt: Date.now() + LINK_LIFETIME_SECONDS * 1000 });
        result[item.path] = item.signedUrl;
      }
    }
  }
  return result;
}

// React helper: gives you { [path]: url } for a list of photo paths.
export function useMediaUrls(paths: string[]): Record<string, string> {
  const key = paths.join('|');
  const [loaded, setLoaded] = useState<{ version: number; urls: Record<string, string> } | null>(null);
  const version = useSyncExternalStore(
    (listener) => { cacheListeners.add(listener); return () => { cacheListeners.delete(listener); }; },
    () => cacheVersion,
  );

  useEffect(() => {
    const list = key ? key.split('|') : [];
    if (list.length === 0) return;
    let cancelled = false;
    getMediaUrls(list)
      .then((found) => {
        if (cancelled) return;
        // Keep the links we already have for photos still in the list, so photos on screen don't
        // blink out (and videos don't restart) each time a new photo arrives. Links from an older
        // login are never kept: a login change bumps the version.
        setLoaded((prev) => {
          const urls: Record<string, string> = {};
          if (prev && prev.version === version) {
            for (const path of list) if (prev.urls[path]) urls[path] = prev.urls[path];
          }
          return { version, urls: { ...urls, ...found } };
        });
      })
      .catch((error) => console.warn('Could not load photos', error));
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  // While a changed list is still loading, keep showing the links we already have (same login only).
  return loaded && loaded.version === version ? loaded.urls : {};
}

export function useMediaUrl(path: string | null | undefined): string | null {
  const urls = useMediaUrls(path ? [path] : []);
  return path ? (urls[path] ?? null) : null;
}
