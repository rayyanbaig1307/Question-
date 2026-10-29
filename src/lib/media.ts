import { requireOptionalNativeModule } from 'expo';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useEffect, useState } from 'react';

import { supabase } from './supabase';
import type { MediaFields } from './types';

type MediaFolder = 'posts' | 'stories' | 'snaps' | 'blurs';

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
  folder: 'posts' | 'stories' | 'snaps',
  capture: Capture,
): Promise<{ fields: MediaFields; stillUri: string | null }> {
  if (capture.kind === 'photo') {
    const media_path = await uploadMedia(userId, folder, capture.uri);
    return { fields: { media_path, media_type: 'photo', poster_path: null, overlay_path: null }, stillUri: capture.uri };
  }
  const posterUri = await makePoster(capture.uri);
  const media_path = await uploadMedia(userId, folder, capture.uri, 'video');
  const poster_path = posterUri ? await uploadMedia(userId, folder, posterUri) : null;
  const overlay_path = capture.overlayUri ? await uploadMedia(userId, folder, capture.overlayUri, 'png') : null;
  return { fields: { media_path, media_type: 'video', poster_path, overlay_path }, stillUri: posterUri };
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

async function readBytes(uri: string): Promise<ArrayBuffer> {
  return new File(uri).arrayBuffer();
}

// Uploads a photo (JPEG), see-through picture (PNG) or video to the private "media" bucket.
// Returns where it was saved.
export async function uploadMedia(
  userId: string,
  folder: MediaFolder,
  localUri: string,
  type: 'jpg' | 'png' | 'video' = 'jpg',
): Promise<string> {
  const isMov = /\.mov$/i.test(localUri);
  const [extension, contentType] =
    type === 'png'
      ? ['png', 'image/png']
      : type === 'video'
        ? isMov
          ? ['mov', 'video/quicktime']
          : ['mp4', 'video/mp4']
        : ['jpg', 'image/jpeg'];
  const path = `${userId}/${folder}/${randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from('media').upload(path, await readBytes(localUri), { contentType });
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
  await supabase.storage.from('media').remove(paths);
}

export async function deleteAvatar(path: string): Promise<void> {
  await supabase.storage.from('avatars').remove([path]);
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

function cached(path: string): string | null {
  const hit = cache.get(path);
  // Treat links as stale 5 minutes early so they never expire mid-scroll.
  if (hit && hit.expiresAt - 5 * 60 * 1000 > Date.now()) return hit.url;
  return null;
}

export async function getMediaUrls(paths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of new Set(paths)) {
    const url = cached(path);
    if (url) result[path] = url;
    else missing.push(path);
  }
  if (missing.length > 0) {
    const { data, error } = await supabase.storage.from('media').createSignedUrls(missing, LINK_LIFETIME_SECONDS);
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
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const list = key ? key.split('|') : [];
    if (list.length === 0) return;
    let cancelled = false;
    getMediaUrls(list)
      .then((found) => {
        if (!cancelled) setUrls((previous) => ({ ...previous, ...found }));
      })
      .catch((error) => console.warn('Could not load photos', error));
    return () => {
      cancelled = true;
    };
  }, [key]);

  return urls;
}

export function useMediaUrl(path: string | null | undefined): string | null {
  const urls = useMediaUrls(path ? [path] : []);
  return path ? (urls[path] ?? null) : null;
}
