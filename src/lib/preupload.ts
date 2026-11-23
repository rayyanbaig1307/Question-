import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';

import { isClearRefusal } from './errors';
import {
  deleteAvatar,
  deleteMedia,
  makeBlurPreview,
  makePoster,
  mediaPath,
  planCapturePaths,
  resizePhoto,
  uploadAvatar,
  uploadCapture,
  uploadMedia,
  type Capture,
  type CapturePaths,
} from './media';
import { supabase } from './supabase';
import type { MediaFields } from './types';

// ---------------------------------------------------------------------------
// Early uploads: the photo starts uploading the moment "Send to…" opens, while you pick friends or type a
// caption. When you tap Send, the upload is usually done already, so Send only has to save the row. That matters
// most for the daily drop: the server decides On time / Late when the post is SAVED, so every second counts.
//
// Never the wrong place:
// - An early upload is only used by the screen that made it, for that screen's picture, and only while the same
//   person is logged in (a login change throws them all away).
// - Where it goes is decided at Send, from what's ticked. If that's another folder, the file is copied there on
//   the server (never to or from the Guess Who folder: a Guess Who always uploads its own file).
// - Going back to edit throws the early upload away; the next "Send to…" makes a new picture and a new upload, so
//   the picture that's sent is always the final one.
//
// Nothing is left behind by mistake: each file name is chosen and written down on the phone BEFORE its upload
// starts (`preupload.v1.<user>`; the outbox writes down the names it picks for its own uploads here too). A name
// is crossed off once a saved row uses the file, or once it's deleted. At sign-in, names older than 15 minutes
// that no waiting send uses are deleted (that also covers an app that was closed in the middle), one file at a
// time. Even if this list were wrong, the server keeps photos and videos safe: it refuses to delete a file a saved
// row uses, and a deleted file can never be attached to a new row. Profile pictures don't have that guard on the
// server, so before one is deleted the app checks it isn't your saved profile picture.
//
// An early upload that fails while "Send to…" is open (a dead spot) is tried again by itself after 1, 3 and 8
// seconds, and again when you come back to the app, so it's usually done by the time you tap Send.
// ---------------------------------------------------------------------------

export type UploadFolder = 'posts' | 'snaps' | 'stories' | 'mystery' | 'group' | 'public';

export type Prepared = {
  key: string;
  owner: string;
  // The picture the screen showed (the one that's being sent).
  uri: string;
  folder: UploadFolder;
  // What's uploaded: a photo is shrunk to 1080 wide first (until then this is the original).
  capture: Capture;
  // The same, once it's ready.
  ready: Promise<Capture>;
  paths: CapturePaths;
  done: Promise<MediaFields>;
  // A drop's tiny blurry preview (uploaded at the same time), or null.
  blur: Promise<string | null> | null;
  blurPath: string | null;
  // A video's still picture, made once (the blurry preview is made from it while the video uploads).
  poster?: Promise<string | null>;
  state: 'uploading' | 'ready' | 'failed' | 'used' | 'discarded';
  // The last upload try failed (also after a send took it over): the next fieldsFor tries once more.
  uploadFailed?: boolean;
  // How many times a failed upload was tried again by itself while "Send to…" was open.
  retries?: number;
};

type Noted = { bucket: 'media' | 'avatars'; path: string; at: number };

// Leftovers older than this are deleted at sign-in (unless a waiting send uses them).
export const LEFTOVER_AFTER_MS = 15 * 60 * 1000;
const ledgerKey = (owner: string) => `preupload.v1.${owner}`;
// The outbox's saved records (lib/outbox.ts writes them; read here to see which files a waiting send uses).
const outboxKey = (owner: string) => `outbox.v1.${owner}`;

// ---------------------------------------------------------------------------
// The written-down file names. One change at a time per person, so two changes never overwrite each other.
// ---------------------------------------------------------------------------
const queues = new Map<string, Promise<void>>();

function changeLedger(owner: string, change: (list: Noted[]) => Noted[]): Promise<void> {
  const before = queues.get(owner) ?? Promise.resolve();
  const next = before
    .then(async () => {
      const list = await readLedger(owner);
      const changed = change(list);
      if (changed.length === 0) await AsyncStorage.removeItem(ledgerKey(owner));
      else await AsyncStorage.setItem(ledgerKey(owner), JSON.stringify(changed));
    })
    .catch((error) => console.warn('Could not note an upload on this phone', error));
  queues.set(owner, next);
  return next;
}

async function readLedger(owner: string): Promise<Noted[]> {
  try {
    const saved = JSON.parse((await AsyncStorage.getItem(ledgerKey(owner))) ?? '[]');
    return Array.isArray(saved) ? saved.filter((entry) => entry && typeof entry.path === 'string') : [];
  } catch {
    return [];
  }
}

export function noteFiles(owner: string, bucket: Noted['bucket'], paths: (string | null | undefined)[]): Promise<void> {
  const list = paths.filter((path): path is string => !!path);
  if (list.length === 0) return Promise.resolve();
  const at = Date.now();
  return changeLedger(owner, (current) => [
    ...current.filter((entry) => !list.includes(entry.path)),
    ...list.map((path) => ({ bucket, path, at })),
  ]);
}

// A saved row uses these files now (or they're deleted): cross them off.
export function forgetFiles(owner: string, paths: (string | null | undefined)[]): Promise<void> {
  const list = paths.filter((path): path is string => !!path);
  if (list.length === 0) return Promise.resolve();
  return changeLedger(owner, (current) => current.filter((entry) => !list.includes(entry.path)));
}

// Your saved profile picture right now (null: none). Asked before an unsaved picture is deleted, because saving
// your profile may have gone through even though its answer got lost on a weak signal.
async function savedProfilePicture(owner: string): Promise<string | null> {
  const { data, error } = await supabase.from('profiles').select('avatar_path').eq('id', owner).maybeSingle();
  if (error) throw error;
  return (data as { avatar_path?: string | null } | null)?.avatar_path ?? null;
}

// Deletes files nobody saved a row with, ONE AT A TIME (so one file a row does use never stops the others from
// going). The server refuses (and keeps the file) if a saved row does use a photo or video: then it's crossed off
// too. Your saved profile picture is never deleted (it's just crossed off). Any other failure keeps the name for
// the next clean-up.
export async function deleteUnused(owner: string, bucket: Noted['bucket'], paths: string[]): Promise<void> {
  const list = [...new Set(paths.filter((path) => !!path))];
  if (list.length === 0) return;
  let profilePicture: string | null = null;
  if (bucket === 'avatars') {
    try {
      profilePicture = await savedProfilePicture(owner);
    } catch (error) {
      // Can't tell which picture your profile uses right now: nothing is deleted this time.
      console.warn('Could not check your profile picture (unused pictures are removed later)', error);
      return;
    }
  }
  for (const path of list) {
    try {
      if (bucket === 'avatars') {
        if (path !== profilePicture) await deleteAvatar(path);
      } else {
        await deleteMedia([path]);
      }
      await forgetFiles(owner, [path]);
    } catch (error) {
      if (/in use/i.test(String((error as { message?: unknown } | null)?.message ?? ''))) await forgetFiles(owner, [path]);
      else console.warn('Could not remove an unused upload (it is tried again later)', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Early uploads of photos and videos.
// ---------------------------------------------------------------------------
const active = new Map<string, Prepared>();

function allFiles(prepared: Prepared): string[] {
  const { media, poster, overlay } = prepared.paths;
  return [media, poster, overlay, prepared.blurPath].filter((path): path is string => !!path);
}

// Tries again by itself after a failed early upload, while "Send to…" is still open.
export const EARLY_RETRY_WAITS_MS = [1000, 3000, 8000];
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function startUpload(prepared: Prepared, noted: Promise<void>) {
  const { owner, folder, paths } = prepared;
  const timer = retryTimers.get(prepared.key);
  if (timer !== undefined) clearTimeout(timer);
  retryTimers.delete(prepared.key);
  const ready = noted.then(() => prepared.ready);
  // A video's still picture is made once, straight away: it goes up with the video, and a drop's blurry preview is
  // made from it at the same time (not after the whole video is up).
  if (prepared.capture.kind === 'video' && !prepared.poster) {
    prepared.poster = noted.then(() => makePoster(prepared.capture.uri)).catch(() => null);
  }
  const poster = prepared.poster;
  const uploaded = ready.then((capture) => uploadCapture(owner, folder, capture, { paths, ...(poster ? { poster } : {}) }));
  prepared.done = uploaded.then((result) => result.fields);
  if (prepared.blurPath) {
    const blurPath = prepared.blurPath;
    // A photo's blurry preview is made from the photo straight away; a video's from its still picture.
    const still = prepared.capture.kind === 'photo' ? ready.then((capture) => capture.uri) : (poster ?? Promise.resolve(null));
    prepared.blur = still.then(async (uri) => (uri ? uploadMedia(owner, 'blurs', await makeBlurPreview(uri), 'jpg', { path: blurPath }) : null));
    prepared.blur.catch(() => {});
  }
  if (prepared.state !== 'used') prepared.state = 'uploading';
  prepared.uploadFailed = false;
  prepared.done.then(
    () => {
      if (prepared.state === 'uploading') prepared.state = 'ready';
    },
    (error) => {
      prepared.uploadFailed = true;
      if (prepared.state !== 'uploading') return;
      prepared.state = 'failed';
      // A dead spot while you pick friends or type: tried again in a moment (a clear "no" from the server isn't).
      if (!isClearRefusal(error as { code?: string; status?: unknown })) tryAgainSoon(prepared);
    },
  );
}

function tryAgainSoon(prepared: Prepared) {
  const wait = EARLY_RETRY_WAITS_MS[prepared.retries ?? 0];
  if (wait === undefined) return;
  prepared.retries = (prepared.retries ?? 0) + 1;
  retryTimers.set(
    prepared.key,
    setTimeout(() => {
      retryTimers.delete(prepared.key);
      // Still on "Send to…" and still failed (Send takes it over and tries again by itself).
      if (prepared.state === 'failed' && active.has(prepared.key)) startUpload(prepared, Promise.resolve());
    }, wait),
  );
}

// Back in the app: early uploads that failed while you were away start again straight away.
AppState.addEventListener('change', (state) => {
  if (state !== 'active') return;
  for (const prepared of active.values()) {
    if (prepared.state !== 'failed') continue;
    prepared.retries = 0;
    startUpload(prepared, Promise.resolve());
  }
});

// Starts shrinking and uploading a picture straight away (and a drop's blurry preview at the same time).
// Doesn't wait: the upload goes on in the background.
export function prepareUpload(owner: string, capture: Capture, folder: UploadFolder, options: { blur?: boolean } = {}): Prepared {
  const prepared: Prepared = {
    key: randomUUID(),
    owner,
    uri: capture.uri,
    folder,
    capture,
    ready: Promise.resolve(capture),
    paths: planCapturePaths(owner, folder, capture),
    done: Promise.resolve(null as unknown as MediaFields),
    blur: null,
    blurPath: options.blur ? mediaPath(owner, 'blurs', 'jpg') : null,
    state: 'uploading',
  };
  prepared.ready =
    capture.kind === 'photo'
      ? resizePhoto(capture.uri, 1080)
          .then((uri) => ({ kind: 'photo' as const, uri }))
          .catch(() => capture)
      : Promise.resolve(capture);
  prepared.ready.then((ready) => {
    prepared.capture = ready;
  });
  active.set(prepared.key, prepared);
  // The names are written down before anything is uploaded.
  startUpload(prepared, noteFiles(owner, 'media', allFiles(prepared)));
  return prepared;
}

// The fields to save a row with, in `folder`. The same folder: the early upload itself (tried once more if it
// failed). Another folder: the files are copied there on the server, to `targets` (names chosen by the caller,
// so a repeated try copies to the same names). A Guess Who file is never copied: it's uploaded again instead.
export async function fieldsFor(prepared: Prepared, folder: UploadFolder, targets?: CapturePaths): Promise<MediaFields> {
  if (prepared.state === 'discarded') throw new Error('This upload was thrown away');
  if (prepared.state === 'failed' || prepared.uploadFailed) startUpload(prepared, Promise.resolve());
  if (prepared.folder === folder) return prepared.done;
  const paths = targets ?? planCapturePaths(prepared.owner, folder, prepared.capture);
  if (prepared.folder === 'mystery' || folder === 'mystery') {
    const result = await uploadCapture(prepared.owner, folder, await prepared.ready, { paths });
    return result.fields;
  }
  const source = await prepared.done;
  const copy = async (from: string | null, to: string | null) => {
    if (!from || !to) return null;
    const { error } = await supabase.storage.from('media').copy(from, to);
    // "Already exists": an earlier try of ours already copied it.
    if (error && !/already exists/i.test(String(error.message ?? '')) && String((error as { statusCode?: unknown }).statusCode ?? '') !== '409') {
      throw error;
    }
    return to;
  };
  const [media_path, poster_path, overlay_path] = await Promise.all([
    copy(source.media_path, paths.media),
    copy(source.poster_path, paths.poster),
    copy(source.overlay_path, paths.overlay),
  ]);
  return { media_path: media_path as string, media_type: source.media_type, poster_path, overlay_path };
}

// The early upload is going to be used by a send (lib/outbox.ts): leaving the screen no longer throws it away.
export function markUsed(prepared: Prepared): void {
  if (prepared.state === 'discarded') return;
  prepared.state = 'used';
  const timer = retryTimers.get(prepared.key);
  if (timer !== undefined) clearTimeout(timer);
  retryTimers.delete(prepared.key);
  // From now on the send's own saved record (lib/outbox.ts) keeps track of these files.
  active.delete(prepared.key);
}

// A saved row now uses these files: they're crossed off the leftovers list.
export function markFilesSaved(owner: string, paths: (string | null | undefined)[]): Promise<void> {
  return forgetFiles(owner, paths);
}

// Throws the early upload away (you went back, or left without sending). Its files are deleted once the upload
// has finished. Never for one a send is using.
export function discardUpload(prepared: Prepared): void {
  if (prepared.state === 'used' || prepared.state === 'discarded') return;
  prepared.state = 'discarded';
  active.delete(prepared.key);
  const timer = retryTimers.get(prepared.key);
  if (timer !== undefined) clearTimeout(timer);
  retryTimers.delete(prepared.key);
  const files = allFiles(prepared);
  Promise.allSettled([prepared.done, prepared.blur ?? Promise.resolve(null)]).then(() =>
    deleteUnused(prepared.owner, 'media', files),
  );
}

// Is this early upload still one a send may use (same person, same picture)?
export function usablePrepared(prepared: Prepared | null | undefined, owner: string, uri: string): prepared is Prepared {
  return !!prepared && prepared.owner === owner && prepared.uri === uri && prepared.state !== 'discarded';
}

// ---------------------------------------------------------------------------
// Profile pictures: uploaded as soon as you pick one, so Save only has to save your profile.
// ---------------------------------------------------------------------------
export type PreparedAvatar = {
  owner: string;
  uri: string;
  path: string;
  done: Promise<string>;
  state: 'uploading' | 'used' | 'discarded';
  // The upload failed (no signal when you picked it): Save tries it again (avatarReady).
  failed?: boolean;
};

function uploadAvatarNow(avatar: PreparedAvatar, noted: Promise<void>) {
  avatar.failed = false;
  // Always the same file name, so a second try never leaves a second copy ("already exists" counts as done).
  avatar.done = noted.then(() => resizePhoto(avatar.uri, 512)).then((small) => uploadAvatar(avatar.owner, small, { path: avatar.path }));
  avatar.done.catch(() => {
    avatar.failed = true;
  });
}

export function prepareAvatar(owner: string, uri: string): PreparedAvatar {
  const avatar: PreparedAvatar = { owner, uri, path: `${owner}/${randomUUID()}.jpg`, done: Promise.resolve(''), state: 'uploading' };
  uploadAvatarNow(avatar, noteFiles(owner, 'avatars', [avatar.path]));
  return avatar;
}

// The picture's upload, for Save. If the early upload failed (you picked it in a dead spot), it's tried again now
// – otherwise Save would fail straight away every time until you picked the picture again.
export function avatarReady(avatar: PreparedAvatar): Promise<string> {
  if (avatar.failed) uploadAvatarNow(avatar, Promise.resolve());
  return avatar.done;
}

// Your profile now uses this picture.
export function markAvatarUsed(avatar: PreparedAvatar): void {
  avatar.state = 'used';
  void forgetFiles(avatar.owner, [avatar.path]);
}

// A picture you picked but didn't save (you picked another one, or left): deleted once its upload has finished –
// unless your profile does use it after all (Save went through, but its answer got lost).
export function discardAvatar(avatar: PreparedAvatar | null | undefined): void {
  if (!avatar || avatar.state !== 'uploading') return;
  avatar.state = 'discarded';
  avatar.done.then(
    () => deleteUnused(avatar.owner, 'avatars', [avatar.path]),
    () => deleteUnused(avatar.owner, 'avatars', [avatar.path]),
  );
}

// ---------------------------------------------------------------------------
// Leftovers: at sign-in (or app start), delete written-down files older than 15 minutes that no waiting send
// uses. Covers an app that was closed in the middle of an upload.
// ---------------------------------------------------------------------------
async function filesWaitingSendsUse(owner: string): Promise<Set<string>> {
  const used = new Set<string>();
  try {
    const records = JSON.parse((await AsyncStorage.getItem(outboxKey(owner))) ?? '{}');
    const collect = (value: unknown) => {
      if (typeof value === 'string') used.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    for (const record of Object.values(records ?? {}) as Record<string, unknown>[]) {
      collect(record?.paths);
      collect(record?.fields);
      collect(record?.uses);
    }
  } catch {
    // Can't read them: then nothing that might be waiting is deleted this time.
    return new Set(['*']);
  }
  return used;
}

export async function cleanLeftoverUploads(owner: string, now = Date.now()): Promise<void> {
  const list = await readLedger(owner);
  const old = list.filter((entry) => now - entry.at >= LEFTOVER_AFTER_MS);
  if (old.length === 0) return;
  const used = await filesWaitingSendsUse(owner);
  if (used.has('*')) return;
  const inUseNow = new Set([...active.values()].filter((p) => p.owner === owner).flatMap(allFiles));
  const gone = old.filter((entry) => !used.has(entry.path) && !inUseNow.has(entry.path));
  await deleteUnused(owner, 'media', gone.filter((entry) => entry.bucket === 'media').map((entry) => entry.path));
  await deleteUnused(owner, 'avatars', gone.filter((entry) => entry.bucket === 'avatars').map((entry) => entry.path));
}

// A different person logged in (or nobody is): every early upload of the one before is thrown away. (One a send
// was already using goes with that send: the outbox drops the old person's sends.)
supabase.auth.onAuthStateChange((_event, session) => {
  const now = session?.user.id ?? null;
  for (const prepared of [...active.values()]) {
    if (prepared.owner !== now) discardUpload(prepared);
  }
});
