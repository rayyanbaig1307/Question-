import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useEffect, useState } from 'react';

import { supabase } from './supabase';

type MediaFolder = 'posts' | 'stories' | 'snaps';

// Shrinks a photo so uploads are quick (and don't eat your data plan).
export async function resizePhoto(uri: string, maxWidth: number): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri).resize({ width: maxWidth }).renderAsync();
  const saved = await rendered.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  return saved.uri;
}

async function readBytes(uri: string): Promise<ArrayBuffer> {
  return new File(uri).arrayBuffer();
}

// Uploads a photo to the private "media" bucket. Returns where it was saved.
export async function uploadMedia(userId: string, folder: MediaFolder, localUri: string): Promise<string> {
  const path = `${userId}/${folder}/${randomUUID()}.jpg`;
  const { error } = await supabase.storage
    .from('media')
    .upload(path, await readBytes(localUri), { contentType: 'image/jpeg' });
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
