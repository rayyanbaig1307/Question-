import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { runBeforeLogOut } from './auth';
import { claimChatDare, findMessages, insertMessage, insertSnaps, setSnapSaved } from './chat';
import { noteMyDropPosted } from './drop';
import { friendlyError, isClearRefusal } from './errors';
import { findComment, insertComment } from './feed';
import { findGroupMessages, insertGroupMessage } from './groupChat';
import { GROUP_GUESS_HEIGHT, GROUP_GUESS_PHOTOS_ONLY, GROUP_GUESS_WIDTH } from './groupGuess';
import { findMystery, insertMystery } from './guess';
import {
  fixedSizePhoto,
  makeBlurPreview,
  makePoster,
  mediaPath,
  planCapturePaths,
  planVoicePath,
  resizePhoto,
  uploadCapture,
  uploadMedia,
  type Capture,
} from './media';
import { findPost, insertPost } from './posts';
import { deleteUnused, fieldsFor, markFilesSaved, noteFiles, type Prepared, type UploadFolder } from './preupload';
import { findPublicPhoto, insertPublicPhoto } from './publicChat';
import { findStory, insertStory } from './stories';
import { refreshStoryBadges } from './storyRings';
import { supabase } from './supabase';
import type { Audience, MediaFields, Post } from './types';
import { voiceLength } from './voice';

// ---------------------------------------------------------------------------
// The outbox 📤: everything you send goes out from here, in the background, so you never wait on a spinner.
//
// Tap Send and the screen closes (or the message shows) straight away. The outbox then uploads the picture (if
// it isn't uploaded already – see lib/preupload.ts) and saves the row, and the chat shows "Sending…" until it's
// in. If the signal is weak it tries again by itself (after 1, 3 and 8 seconds), then says
// "Couldn't send – tap to try again".
//
// Never a double send: each row gets its id on the phone BEFORE the first try, and each file its name. If an
// answer gets lost (the server may have saved it anyway), the next try first looks the rows up by id and only saves
// the missing ones. A second copy is impossible anyway: the server refuses a second row with the same id.
//
// Order and speed:
// - Texts, stickers and dares go one at a time per chat, in the order you tapped them. A text never waits for a
//   video to upload.
// - At most 2 photo/video sends upload at once; posts (your drop, dare or forfeit) always go first.
// - In "Send to…" the drop, dare or forfeit post is saved FIRST (the server stamps On time / Late when the post
//   is saved), and the rest waits for it.
//
// After the app was closed: each send's record (no pictures, just where they are on the phone, the chosen ids and
// file names) is kept on the phone until it's sent. At the next sign-in it shows as "Not sent – tap to try
// again". Nothing is ever sent much later by itself: only sends under 10 minutes old are tried again on their
// own (when you come back to the app, or when your login is back). A send that was still going when you left
// the app, and is 10 minutes old or more when you come back, waits for a tap too (the phone stops sending while
// the app is closed, so it could otherwise arrive hours late – a drop would be posted hours late as Late).
//
// No login for a moment (it's being renewed, maybe on a weak signal): that's never a "no". It counts as a try
// with no answer, so after the same waits it says "No connection – tap to try again" instead of spinning forever.
//
// Logging out yourself deletes your unsent sends (and their copies on the phone). A login that ends by itself
// (it ran out and couldn't be renewed) keeps them: they show as "Not sent – tap to try again" when you log back in.
// ---------------------------------------------------------------------------

export type Scope = `friend:${string}` | `group:${string}` | `post:${string}` | 'public' | 'me';

export type What =
  | { kind: 'peek'; friendIds: string[]; chatDare?: string; names?: Record<string, string> }
  | { kind: 'chatPhoto'; friendId: string }
  | { kind: 'text' | 'sticker' | 'dare'; friendId: string; body: string; sticker?: string; replyTo?: string | null }
  | { kind: 'voice'; friendId: string; uri: string; durationMs: number; waveform: number[] }
  | { kind: 'groupText' | 'groupSticker' | 'groupDare'; groupId: string; body: string; sticker?: string; replyTo?: string | null }
  | { kind: 'groupMedia'; groupId: string; snap: boolean; dareId?: string }
  | { kind: 'groupVoice'; groupId: string; uri: string; durationMs: number; waveform: number[] }
  | { kind: 'groupGuess'; groupId: string }
  | { kind: 'publicPhoto' }
  | { kind: 'story'; audience: Audience }
  | { kind: 'post'; caption: string; audience: Audience; dare?: boolean; drop?: boolean; rewind?: boolean; forfeit?: string }
  | { kind: 'guess'; caption: string }
  | { kind: 'comment'; postId: string; body: string; parentId: string | null };

export type JobFiles = { media: string; poster: string | null; overlay: string | null; blur?: string | null };

export type Job = {
  key: string;
  owner: string;
  scope: Scope;
  what: What;
  // Jobs from one "Send to…" share a group (one toast for all of them).
  group?: string;
  // This job waits until that one is sent (or has failed).
  after?: string;
  capture?: Capture;
  prepared?: Prepared;
  // The rows' ids, chosen once (one per row).
  rowIds: string[];
  // The file names, chosen once (before the first upload).
  paths?: JobFiles;
  // Once set, the files are never uploaded again.
  fields?: MediaFields & { blur_path?: string | null };
  // An earlier try got no clear answer (its row may be saved).
  maybeSaved: boolean;
  state: 'waiting' | 'sending' | 'sent' | 'failed';
  error?: string;
  // The server clearly said no (trying again won't help unless something changes).
  final?: boolean;
  attempts: number;
  createdAt: number;
  // Shown again after the app was closed: waits for a tap.
  restored?: boolean;
  rows?: unknown[];
  result?: {
    dropLate?: number | null;
    dropRewound?: boolean;
    postId?: string;
    // A peek to several friends: the ones the server refused (the others got it).
    refused?: string[];
    refusedWhy?: string;
    // A dare proof: the dare couldn't be marked as done (null = it was).
    dareProblem?: 'gone' | string | null;
  };
  // The last failure was "no answer" (not a clear "no").
  noAnswer?: boolean;
  // Some try got no clear answer, so files are never deleted without looking the rows up first.
  everUnclear?: boolean;
  // Early-upload files this job uses (so the leftovers clean-up keeps them).
  uses?: string[];
  // When the trying started (when it was made, or when you last tapped "Try again"). Only sends under 10 minutes
  // from this are tried again by themselves.
  triedAt?: number;
  // You left the app while this was being sent, long enough ago: if this try fails, it waits for a tap.
  holdAfterTry?: boolean;
};

export type SharePlan = {
  friendIds: string[];
  names?: Record<string, string>;
  story: boolean;
  profile: boolean;
  guess: boolean;
  caption: string;
  audience: Audience;
  post: null | { dare: boolean; drop: boolean; rewind: boolean; forfeit?: string };
};

// Waits before trying again after no answer. Then it says "No connection – tap to try again".
export const RETRY_WAITS_MS = [1000, 3000, 8000];
// Sends that failed for no answer are tried again by themselves when you come back to the app, if they're
// younger than this.
export const AUTO_RETRY_MAX_AGE_MS = 10 * 60 * 1000;
// Records older than this are thrown away at sign-in (with their files).
export const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MEDIA_AT_ONCE = 2;

export const NO_CONNECTION = 'No connection – tap to try again';
export const NOT_SENT = 'Not sent – tap to try again';
export const NOT_SENT_GONE = 'Not sent – tap to remove';
// whenSent for a send this phone doesn't know (any more).
export const SEND_NOT_FOUND = "We couldn't find this send any more";

const TEXT_KINDS = new Set<What['kind']>(['text', 'sticker', 'dare', 'groupText', 'groupSticker', 'groupDare', 'comment']);
const isText = (job: Job) => TEXT_KINDS.has(job.what.kind);
const isPost = (job: Job) => job.what.kind === 'post';

// ---------------------------------------------------------------------------
// The store (read by screens with useOutbox / useOutboxJob).
// ---------------------------------------------------------------------------
const jobs = new Map<string, Job>();
// Jobs that finished and were taken off the list (so whenSent still knows how they ended).
const finished = new Map<string, Job>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const waiters = new Map<string, ((job: Job) => void)[]>();
const doneListeners = new Set<(job: Job) => void>();
const listeners = new Set<() => void>();
let version = 0;
let currentOwner: string | null = null;
let visibleScope: Scope | null = null;

function changed() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Copies of the jobs for the screens (a new copy each time something changes, so React redraws).
let copiedAt = -1;
let copies: Job[] = [];
const scopeLists = new Map<string, Job[]>();
const keyCopies = new Map<string, Job>();
function snapshot(): Job[] {
  if (copiedAt !== version) {
    copies = [...jobs.values()].map((job) => ({ ...job }));
    scopeLists.clear();
    keyCopies.clear();
    for (const job of copies) keyCopies.set(job.key, job);
    copiedAt = version;
  }
  return copies;
}

// Does this job belong on the screen for `scope`? (A peek to several friends shows in each of their chats.)
export function inScope(job: Pick<Job, 'scope' | 'what'>, scope: Scope): boolean {
  if (job.scope === scope) return true;
  if (scope.startsWith('friend:') && job.what.kind === 'peek') return job.what.friendIds.includes(scope.slice('friend:'.length));
  return false;
}

export function useOutbox(owner: string, scope?: Scope): Job[] {
  return useSyncExternalStore(subscribe, () => {
    const all = snapshot();
    const cacheKey = `${owner}|${scope ?? '*'}`;
    let list = scopeLists.get(cacheKey);
    if (!list) {
      list = all.filter((job) => job.owner === owner && (!scope || inScope(job, scope)));
      scopeLists.set(cacheKey, list);
    }
    return list;
  });
}

export function useOutboxJob(key?: string): Job | null {
  return useSyncExternalStore(subscribe, () => {
    if (!key) return null;
    snapshot();
    return keyCopies.get(key) ?? finished.get(key) ?? null;
  });
}

// Is your drop still on its way (not saved yet, not failed)? Home waits a moment before loading again then, so its
// loading doesn't slow your drop down on a weak signal (src/components/home/HomePage.tsx).
// Gives that send's key (null when none is on its way).
const isDropSend = (job: Job) =>
  job.what.kind === 'post' && !!job.what.drop && (job.state === 'waiting' || job.state === 'sending');
export function dropSendingKey(owner: string): string | null {
  return [...jobs.values()].find((job) => job.owner === owner && isDropSend(job))?.key ?? null;
}
export function useDropSending(owner: string): string | null {
  return useSyncExternalStore(subscribe, () => dropSendingKey(owner));
}

// Is anything still on its way (not sent, not failed)? Then the app doesn't restart for an update.
export function outboxBusy(): boolean {
  return [...jobs.values()].some((job) => job.state === 'waiting' || job.state === 'sending');
}

// Called each time a send finishes: sent, or failed.
export function onOutboxDone(listener: (job: Job) => void): () => void {
  doneListeners.add(listener);
  return () => {
    doneListeners.delete(listener);
  };
}

// The chat on screen (its sends show as bubbles there, so the banner and toasts leave them out).
export function setVisibleScope(scope: Scope | null): void {
  const before = visibleScope;
  visibleScope = scope;
  // Leaving a chat: its finished sends don't need to wait for that screen any more.
  if (before && before !== scope) {
    for (const job of [...jobs.values()]) if (job.state === 'sent' && inScope(job, before)) takeOff(job);
  }
  changed();
}

export function getVisibleScope(): Scope | null {
  return visibleScope;
}

// Resolves once the job is sent or has failed (look at its `state`). Already finished: straight away.
export function whenSent(key: string): Promise<Job> {
  const job = jobs.get(key) ?? finished.get(key);
  if (!job) return Promise.resolve({ key, state: 'failed', final: true, error: SEND_NOT_FOUND } as Job);
  if (job.state === 'sent' || job.state === 'failed') return Promise.resolve({ ...job });
  return new Promise((resolve) => waiters.set(key, [...(waiters.get(key) ?? []), resolve]));
}

// The screen showed the sent message: take it off the list.
export function ackSent(key: string): void {
  const job = jobs.get(key);
  if (job && job.state === 'sent') takeOff(job);
}

function takeOff(job: Job) {
  jobs.delete(job.key);
  finished.set(job.key, { ...job });
  if (finished.size > 50) finished.delete(finished.keys().next().value as string);
  changed();
}

// ---------------------------------------------------------------------------
// Adding sends.
// ---------------------------------------------------------------------------
function rowCount(what: What): number {
  if (what.kind === 'peek') return what.friendIds.length;
  if (what.kind === 'publicPhoto') return 0;
  return 1;
}

function makeJob(owner: string, scope: Scope, what: What, extra: { capture?: Capture; prepared?: Prepared; group?: string; after?: string } = {}): Job {
  return {
    key: randomUUID(),
    owner,
    scope,
    what,
    ...(extra.group ? { group: extra.group } : {}),
    ...(extra.after ? { after: extra.after } : {}),
    ...(extra.capture ? { capture: extra.capture } : extra.prepared ? { capture: extra.prepared.capture } : {}),
    ...(extra.prepared ? { prepared: extra.prepared } : {}),
    rowIds: Array.from({ length: rowCount(what) }, () => randomUUID()),
    maybeSaved: false,
    state: 'waiting',
    attempts: 0,
    createdAt: Date.now(),
    triedAt: Date.now(),
  };
}

function add(job: Job) {
  jobs.set(job.key, job);
  void persist(job);
  changed();
  pump();
}

// How many sends one "Send to…" made (for one toast about all of them).
const groupSizes = new Map<string, number>();
export function groupSize(group: string): number {
  return groupSizes.get(group) ?? 1;
}

// Sends something in the background. Doesn't wait: gives back the send's key straight away.
export function sendLater(
  owner: string,
  scope: Scope,
  what: What,
  extra: { capture?: Capture; prepared?: Prepared; group?: string; after?: string } = {},
): string {
  const job = makeJob(owner, scope, what, extra);
  add(job);
  return job.key;
}

// Everything "Send to…" sends, from one early upload. A drop, dare or forfeit post goes first; the rest waits for
// it. Gives back the group, the post's id (for "dare your friends") and the post's send key.
export function queueShare(
  owner: string,
  plan: SharePlan,
  prepared: Prepared,
): { group: string; postId: string | null; postJob: string | null } {
  const group = randomUUID();
  const made: Job[] = [];
  let postJob: Job | null = null;
  if (plan.post) {
    postJob = makeJob(owner, 'me', { kind: 'post', caption: plan.caption, audience: plan.audience, ...plan.post }, { prepared, group });
    made.push(postJob);
  }
  const after = postJob?.key;
  if (plan.guess) made.push(makeJob(owner, 'me', { kind: 'guess', caption: plan.caption }, { prepared, group, after }));
  if (plan.friendIds.length > 0) {
    const scope: Scope = plan.friendIds.length === 1 ? `friend:${plan.friendIds[0]}` : 'me';
    made.push(makeJob(owner, scope, { kind: 'peek', friendIds: plan.friendIds, ...(plan.names ? { names: plan.names } : {}) }, { prepared, group, after }));
  }
  if (plan.story) made.push(makeJob(owner, 'me', { kind: 'story', audience: plan.audience }, { prepared, group, after }));
  if (plan.profile && !plan.post) {
    made.push(makeJob(owner, 'me', { kind: 'post', caption: plan.caption, audience: plan.audience }, { prepared, group, after }));
  }
  groupSizes.set(group, made.length);
  for (const job of made) jobs.set(job.key, job);
  made.forEach((job) => void persist(job));
  changed();
  pump();
  return { group, postId: postJob ? postJob.rowIds[0] : null, postJob: postJob?.key ?? null };
}

// ---------------------------------------------------------------------------
// Running the sends.
// ---------------------------------------------------------------------------
function waitingOn(job: Job): boolean {
  if (!job.after) return false;
  const first = jobs.get(job.after);
  return !!first && first.state !== 'sent' && first.state !== 'failed';
}

function pump() {
  if (!currentOwner) return;
  let media = [...jobs.values()].filter((job) => job.state === 'sending' && !isText(job)).length;
  const busyChats = new Set([...jobs.values()].filter((job) => job.state === 'sending' && isText(job)).map((job) => job.scope));
  const ready = (job: Job) => job.state === 'waiting' && job.owner === currentOwner && !timers.has(job.key) && !waitingOn(job);
  // Posts first: they jump the queue and never wait for other uploads.
  for (const job of jobs.values()) {
    if (isPost(job) && ready(job)) {
      media += 1;
      void run(job);
    }
  }
  for (const job of jobs.values()) {
    if (isPost(job)) continue;
    if (isText(job)) {
      if (job.state !== 'waiting' || job.owner !== currentOwner) continue;
      // One at a time per chat, in the order they were tapped: an earlier one still waiting holds the rest back.
      if (busyChats.has(job.scope)) continue;
      busyChats.add(job.scope);
      if (ready(job)) void run(job);
      continue;
    }
    if (!ready(job) || media >= MEDIA_AT_ONCE) continue;
    media += 1;
    void run(job);
  }
}

function later(job: Job, ms: number) {
  clearTimer(job.key);
  timers.set(
    job.key,
    setTimeout(() => {
      timers.delete(job.key);
      pump();
    }, ms),
  );
}

function clearTimer(key: string) {
  const timer = timers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(key);
}

async function signedInAs(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

type Stage = 'login' | 'files' | 'save' | 'extras';

async function run(job: Job) {
  job.state = 'sending';
  job.error = undefined;
  job.attempts += 1;
  changed();
  let stage: Stage = 'login';
  try {
    // Only ever sent as the person who made it.
    const who = await signedInAs();
    if (!jobs.has(job.key)) return;
    if (who === null) {
      // No login right now (it's being renewed, maybe on a weak signal). Never a "no", but it counts as a try
      // with no answer: after the waits it says "No connection – tap to try again" (and it goes by itself as soon
      // as the login is back, if that's within 10 minutes).
      job.noAnswer = true;
      await tryAgainLater(job);
      return;
    }
    if (who !== job.owner) {
      // Someone else is logged in: it waits (a login change takes it off this phone's list).
      job.state = 'waiting';
      job.attempts -= 1;
      changed();
      return;
    }
    void keepLocalCopy(job);
    stage = 'files';
    if (needsFiles(job) && !job.fields) {
      job.fields = await files(job);
      await persist(job);
    }
    stage = 'save';
    const rows = await save(job);
    stage = 'extras';
    await extras(job, rows);
    if (!jobs.has(job.key)) return;
    job.rows = rows;
    job.state = 'sent';
    job.noAnswer = false;
    void forget(job);
    void dropLocalCopy(job);
    finish(job);
  } catch (error) {
    if (!jobs.has(job.key)) return;
    await failed(job, error, stage);
  } finally {
    pump();
  }
}

function finish(job: Job) {
  changed();
  const copy = { ...job };
  doneListeners.forEach((listener) => {
    try {
      listener(copy);
    } catch (error) {
      console.warn('A send listener failed', error);
    }
  });
  const waiting = waiters.get(job.key) ?? [];
  waiters.delete(job.key);
  waiting.forEach((resolve) => resolve(copy));
  // Sent, and its chat isn't on screen: nothing needs to show it as a bubble any more.
  if (job.state === 'sent' && !(visibleScope && inScope(job, visibleScope))) takeOff(job);
}

// No answer at all (no signal, given up after its time limit, the connection dropped) or a gateway that gave
// up (a 5xx with no database code): the server may or may not have done it.
export function noAnswer(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { name?: unknown; message?: unknown; status?: unknown; code?: unknown };
  if (isClearRefusal(failure as { code?: string; status?: number })) return false;
  const status = Number(failure.status);
  if (Number.isFinite(status) && (status === 0 || status >= 500)) return true;
  const name = String(failure.name ?? '');
  if (['AbortError', 'TimeoutError', 'StorageUnknownError', 'AuthRetryableFetchError', 'TypeError'].includes(name)) return true;
  return /network request failed|failed to fetch|aborted|timed out|network error|load failed/i.test(String(failure.message ?? ''));
}

// The login ran out or isn't there (a renewal is on its way): not a "no" about the message itself.
function loginProblem(error: unknown): boolean {
  const failure = (error ?? {}) as { status?: unknown; code?: unknown };
  return Number(failure.status) === 401 || ['PGRST301', 'PGRST302', 'PGRST303'].includes(String(failure.code ?? ''));
}

// The file was thrown away on the server meanwhile: it has to be uploaded again under a new name.
function mediaExpired(error: unknown): boolean {
  return /media( path)? has expired/i.test(String((error as { message?: unknown } | null)?.message ?? ''));
}

// No clear answer (or no login): try again after 1, 3 and 8 seconds, then say "No connection – tap to try again".
async function tryAgainLater(job: Job) {
  const wait = RETRY_WAITS_MS[job.attempts - 1];
  if (job.holdAfterTry) {
    // You left the app while this was going, and it's old now: no more tries by itself.
    await holdForTap(job);
    return;
  }
  if (wait !== undefined) {
    job.state = 'waiting';
    await persist(job);
    changed();
    later(job, wait);
    return;
  }
  job.state = 'failed';
  job.final = false;
  job.noAnswer = true;
  job.error = NO_CONNECTION;
  await persist(job);
  finish(job);
}

// "Not sent – tap to try again": it's only tried again when you tap (never by itself).
async function holdForTap(job: Job) {
  clearTimer(job.key);
  job.state = 'failed';
  job.final = false;
  job.noAnswer = false;
  job.restored = true;
  job.holdAfterTry = false;
  job.error = NOT_SENT;
  await persist(job);
  finish(job);
}

async function failed(job: Job, error: unknown, stage: Stage) {
  const unclear = noAnswer(error) || loginProblem(error);
  if (stage === 'save' && noAnswer(error)) {
    job.maybeSaved = true;
    job.everUnclear = true;
  }
  if (mediaExpired(error) && !(job as { reuploaded?: boolean }).reuploaded) {
    if (job.holdAfterTry) {
      await holdForTap(job);
      return;
    }
    (job as { reuploaded?: boolean }).reuploaded = true;
    job.fields = undefined;
    job.paths = undefined;
    job.prepared = undefined;
    job.state = 'waiting';
    await persist(job);
    changed();
    return;
  }
  if (unclear) {
    job.noAnswer = true;
    await tryAgainLater(job);
    return;
  }
  // "Not allowed" while the login just ran out (the request went without it): that's no clear "no" either.
  const status = Number((error as { status?: unknown } | null)?.status);
  if (codeOf(error) === '42501' || status === 401 || status === 403) {
    const who = await signedInAs();
    if (!jobs.has(job.key)) return;
    if (who === null) {
      job.noAnswer = true;
      await tryAgainLater(job);
      return;
    }
    if (who !== job.owner) {
      // Someone else is logged in now: it waits (a login change takes it off this phone's list).
      job.state = 'waiting';
      await persist(job);
      changed();
      return;
    }
  }
  // A clear "no" (or something on the phone went wrong, like a video that's too big).
  job.state = 'failed';
  job.final = true;
  job.noAnswer = false;
  job.error = friendlyError(error);
  // Its own uploaded files go (also ones only partly uploaded), but only if no try ever got lost on the way
  // (otherwise a row may use them). An early upload other sends may share is left to the leftovers clean-up
  // (lib/preupload.ts). The next try picks new names.
  if (!job.everUnclear && (job.fields || job.paths)) {
    const files = ownFiles(job);
    job.fields = undefined;
    job.paths = undefined;
    job.prepared = undefined;
    job.uses = undefined;
    void deleteUnused(job.owner, 'media', files);
  }
  await persist(job);
  finish(job);
}

function jobFiles(job: Job): string[] {
  const list = [job.fields?.media_path, job.fields?.poster_path, job.fields?.overlay_path, job.fields?.blur_path];
  return [...new Set(list.filter((path): path is string => !!path))];
}

// Every file name this send picked for its own uploads (some may not be uploaded yet).
function chosenFiles(job: Job): string[] {
  const paths = job.paths;
  const list = [...jobFiles(job), paths?.media, paths?.poster, paths?.overlay, paths?.blur];
  return [...new Set(list.filter((path): path is string => !!path))];
}

// The files only this send uploaded (not an early upload from "Send to…" that other sends may share).
function ownFiles(job: Job): string[] {
  const shared = new Set(job.uses ?? []);
  return chosenFiles(job).filter((path) => !shared.has(path));
}

// The names this send picked are written down BEFORE anything is uploaded (lib/preupload.ts), so the leftovers
// clean-up finds them even if the send is deleted, the app is closed, or the login ends halfway.
function noteChosen(job: Job): Promise<void> {
  const shared = new Set(job.uses ?? []);
  return noteFiles(job.owner, 'media', chosenFiles(job).filter((path) => !shared.has(path)));
}

// ---------------------------------------------------------------------------
// Files.
// ---------------------------------------------------------------------------
function needsFiles(job: Job): boolean {
  return !isText(job);
}

function folderFor(what: What): UploadFolder {
  switch (what.kind) {
    case 'peek':
    case 'chatPhoto':
      return 'snaps';
    case 'story':
      return 'stories';
    case 'post':
      return 'posts';
    case 'guess':
    case 'groupGuess':
      return 'mystery';
    case 'groupMedia':
      return what.snap ? 'snaps' : 'group';
    case 'publicPhoto':
      return 'public';
    default:
      return 'snaps';
  }
}

async function files(job: Job): Promise<MediaFields & { blur_path?: string | null }> {
  const { what, owner } = job;
  // Voice notes: one recording.
  if (what.kind === 'voice' || what.kind === 'groupVoice') {
    if (!job.paths) {
      job.paths = { media: planVoicePath(owner), poster: null, overlay: null };
      await noteChosen(job);
      await persist(job);
    }
    const media_path = await uploadMedia(owner, 'voice', what.uri, 'audio', { path: job.paths.media });
    return { media_path, media_type: 'photo', poster_path: null, overlay_path: null };
  }
  const folder = folderFor(what);
  const drop = what.kind === 'post' && !!what.drop;
  const prepared = job.prepared && job.prepared.owner === owner && job.prepared.state !== 'discarded' ? job.prepared : null;
  if (prepared && what.kind !== 'groupGuess') {
    // The early upload from "Send to…" (or a copy of it in this folder).
    if (!job.paths) {
      // The same folder: the early upload's own files. Another folder: copies under new names, chosen once.
      job.paths =
        prepared.folder === folder
          ? { ...prepared.paths, blur: prepared.blurPath }
          : { ...planCapturePaths(owner, folder, prepared.capture), blur: null };
      job.uses = [prepared.paths.media, prepared.paths.poster, prepared.paths.overlay, prepared.blurPath].filter(
        (path): path is string => !!path,
      );
      await noteChosen(job);
      await persist(job);
    }
    // A drop's blurry preview: the early one, or (if there isn't one) one made now, while the files are copied.
    const blur = drop ? earlyBlurOrNew(job, prepared) : null;
    blur?.catch(() => {});
    const fields = await fieldsFor(prepared, folder, prepared.folder === folder ? undefined : job.paths);
    return blur ? { ...fields, blur_path: await blur } : fields;
  }
  if (!job.capture) throw new Error("This picture isn't on the phone any more");
  let capture = job.capture;
  // Photos are shrunk first so they upload quickly (a group Guess Who is always exactly 1080 × 1440).
  if (what.kind === 'groupGuess') {
    if (capture.kind !== 'photo') throw new Error(GROUP_GUESS_PHOTOS_ONLY);
    capture = { kind: 'photo', uri: await fixedSizePhoto(capture.uri, GROUP_GUESS_WIDTH, GROUP_GUESS_HEIGHT) };
  } else if (capture.kind === 'photo') {
    capture = { kind: 'photo', uri: await resizePhoto(capture.uri, 1080) };
  }
  if (what.kind === 'publicPhoto' && capture.kind !== 'photo') throw new Error('The public chat is photos only – no videos.');
  if (!job.paths) {
    // The names are written down before anything is uploaded.
    job.paths = { ...planCapturePaths(owner, folder, capture), blur: drop ? mediaPath(owner, 'blurs', 'jpg') : null };
    await noteChosen(job);
    await persist(job);
  }
  // A video's still picture is made once: it goes up with the video, and a drop's blurry preview is made from it
  // at the same time (so the drop is saved as soon as the video is up).
  const posterMade = capture.kind === 'video' ? makePoster(capture.uri) : null;
  const blur = drop ? dropBlur(job, capture.kind === 'photo' ? capture.uri : posterMade) : null;
  blur?.catch(() => {});
  const uploaded = await uploadCapture(owner, folder, capture, { paths: job.paths, ...(posterMade ? { poster: posterMade } : {}) });
  return blur ? { ...uploaded.fields, blur_path: await blur } : uploaded.fields;
}

// The early blurry preview from "Send to…", or a new one if there isn't one.
async function earlyBlurOrNew(job: Job, prepared: Prepared): Promise<string | null> {
  const early = prepared.blur ? await prepared.blur.catch(() => null) : null;
  if (early) return early;
  const ready = await prepared.ready;
  return dropBlur(job, ready.kind === 'photo' ? ready.uri : (prepared.poster ?? null));
}

// A drop's tiny blurry preview. If it can't be made, the drop still goes (friends just see no blurry preview);
// only no answer at all makes the whole send try again.
async function dropBlur(job: Job, still: string | null | Promise<string | null>): Promise<string | null> {
  try {
    const uri = await still;
    if (!uri) return null;
    if (!job.paths?.blur) {
      job.paths = { ...(job.paths as JobFiles), blur: mediaPath(job.owner, 'blurs', 'jpg') };
      await noteChosen(job);
      await persist(job);
    }
    return await uploadMedia(job.owner, 'blurs', await makeBlurPreview(uri), 'jpg', { path: job.paths?.blur ?? undefined });
  } catch (error) {
    if (noAnswer(error)) throw error;
    console.warn('Could not make the blurry drop preview', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Saving the rows (never twice).
// ---------------------------------------------------------------------------
function idFor(row: unknown): string | null {
  return row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : null;
}

async function lookUp(job: Job): Promise<unknown[]> {
  const ids = job.rowIds;
  const one = async (find: (id: string) => Promise<unknown | null>) => {
    const found = await find(ids[0]);
    return found ? [found] : [];
  };
  switch (job.what.kind) {
    case 'post':
      return one(findPost);
    case 'story':
      return one(findStory);
    case 'guess':
    case 'groupGuess':
      return one(findMystery);
    case 'comment':
      return one(findComment);
    case 'publicPhoto': {
      // No id from the phone here: the file name is the key.
      const found = job.fields?.media_path ? await findPublicPhoto(job.fields.media_path) : null;
      return found ? [found] : [];
    }
    case 'groupText':
    case 'groupSticker':
    case 'groupDare':
    case 'groupMedia':
    case 'groupVoice':
      return findGroupMessages(ids);
    default:
      return findMessages(ids);
  }
}

async function insertRows(job: Job, ids: string[]): Promise<unknown[]> {
  const { what, owner } = job;
  const fields = job.fields as MediaFields & { blur_path?: string | null };
  const id = ids[0];
  switch (what.kind) {
    case 'peek': {
      const friendOf = new Map(job.rowIds.map((rowId, index) => [rowId, what.friendIds[index]]));
      return insertSnaps(owner, ids.map((rowId) => ({ id: rowId, friendId: friendOf.get(rowId) as string })), fields);
    }
    case 'chatPhoto':
      return insertSnaps(owner, [{ id, friendId: what.friendId }], fields, { savedPhoto: true });
    case 'text':
    case 'sticker':
    case 'dare':
      return [
        await insertMessage(owner, {
          id,
          friendId: what.friendId,
          kind: what.kind,
          body: what.body,
          ...(what.sticker ? { sticker: what.sticker } : {}),
          ...(what.replyTo ? { replyTo: what.replyTo } : {}),
        }),
      ];
    case 'voice':
      return [
        await insertMessage(owner, {
          id,
          friendId: what.friendId,
          kind: 'voice',
          media_path: fields.media_path,
          audio_ms: voiceLength(what.durationMs),
          waveform: what.waveform,
        }),
      ];
    // Group rows say who sent them (sender_id), so the server refuses them under any other login.
    case 'groupText':
      return [
        await insertGroupMessage({
          id,
          sender_id: owner,
          group_id: what.groupId,
          body: what.body,
          ...(what.replyTo ? { reply_to: what.replyTo } : {}),
        }),
      ];
    case 'groupSticker':
      return [
        await insertGroupMessage({
          id,
          sender_id: owner,
          group_id: what.groupId,
          kind: 'sticker',
          sticker: what.sticker ?? null,
          body: what.body,
          ...(what.replyTo ? { reply_to: what.replyTo } : {}),
        }),
      ];
    case 'groupDare':
      return [await insertGroupMessage({ id, sender_id: owner, group_id: what.groupId, kind: 'dare', body: what.body })];
    case 'groupMedia':
      return [
        await insertGroupMessage(
          what.snap
            ? { id, sender_id: owner, group_id: what.groupId, kind: 'snap', ...plainFields(fields) }
            : {
                id,
                sender_id: owner,
                group_id: what.groupId,
                kind: what.dareId ? 'proof' : fields.media_type,
                dare_id: what.dareId ?? null,
                ...plainFields(fields),
              },
        ),
      ];
    case 'groupVoice':
      return [
        await insertGroupMessage({
          id,
          sender_id: owner,
          group_id: what.groupId,
          kind: 'voice',
          media_path: fields.media_path,
          audio_ms: Math.round(what.durationMs),
          waveform: what.waveform,
        }),
      ];
    case 'groupGuess':
      return [await insertMystery(owner, { id, fields: plainFields(fields), caption: '', groupId: what.groupId })];
    case 'guess':
      return [await insertMystery(owner, { id, fields: plainFields(fields), caption: what.caption })];
    case 'publicPhoto':
      await insertPublicPhoto(fields.media_path);
      return [];
    case 'story':
      return [await insertStory(owner, { id, fields: plainFields(fields), audience: what.audience })];
    case 'post':
      return [
        await insertPost(owner, {
          id,
          fields: plainFields(fields),
          blurPath: fields.blur_path ?? null,
          caption: what.caption,
          audience: what.audience,
          dare: what.dare,
          drop: what.drop,
          rewind: what.rewind,
          forfeit: what.forfeit,
        }),
      ];
    case 'comment':
      return [await insertComment(owner, { id, postId: what.postId, body: what.body, parentId: what.parentId })];
  }
}

function plainFields(fields: MediaFields & { blur_path?: string | null }): MediaFields {
  return { media_path: fields.media_path, media_type: fields.media_type, poster_path: fields.poster_path, overlay_path: fields.overlay_path };
}

const codeOf = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? '');

async function save(job: Job): Promise<unknown[]> {
  let found: unknown[] = [];
  let missing = job.rowIds;
  // An earlier try got no clear answer: look first. (A refused second try can hide a saved row: the server
  // checks who may write – and the public chat its slow mode – before it checks for a second copy.)
  if (job.maybeSaved && job.what.kind === 'publicPhoto') {
    found = await lookUp(job);
    if (found.length > 0) return found;
  } else if (job.maybeSaved && job.rowIds.length > 0) {
    found = await lookUp(job);
    const have = new Set(found.map(idFor));
    missing = job.rowIds.filter((rowId) => !have.has(rowId));
    if (missing.length === 0) return found;
  }
  // Still on the list (a login change takes the old person's sends off it), and still that person's send.
  if (!jobs.has(job.key) || job.owner !== currentOwner) throw new Error(NOT_SENT);
  try {
    return [...found, ...(await insertRows(job, missing))];
  } catch (error) {
    if (codeOf(error) === '23505') {
      // A second copy was refused: the first try did save it. (The public chat has no id from the phone: the
      // file name is what's unique there, and only this send uses it.)
      if (job.what.kind === 'publicPhoto') return [];
      const again = await lookUp(job);
      const have = new Set(again.map(idFor));
      if (job.rowIds.every((rowId) => have.has(rowId))) return again;
      throw error;
    }
    // A peek to several friends that was refused as a whole: try friend by friend, so the others still get it.
    if (job.what.kind === 'peek' && missing.length > 1 && isClearRefusal(error as { code?: string; status?: number })) {
      return [...found, ...(await peekOneByOne(job, missing, error))];
    }
    throw error;
  }
}

async function peekOneByOne(job: Job, ids: string[], wholeError: unknown): Promise<unknown[]> {
  const what = job.what as Extract<What, { kind: 'peek' }>;
  const friendOf = new Map(job.rowIds.map((rowId, index) => [rowId, what.friendIds[index]]));
  const saved: unknown[] = [];
  const refused: string[] = [];
  let why: string | null = null;
  for (const rowId of ids) {
    try {
      saved.push(...(await insertSnaps(job.owner, [{ id: rowId, friendId: friendOf.get(rowId) as string }], job.fields as MediaFields)));
    } catch (error) {
      if (codeOf(error) === '23505') continue;
      if (!isClearRefusal(error as { code?: string; status?: number })) throw error;
      refused.push(friendOf.get(rowId) as string);
      why = why ?? friendlyError(error);
    }
  }
  if (refused.length === ids.length) throw wholeError;
  job.result = { ...job.result, refused, refusedWhy: why ?? undefined };
  return saved;
}

// The things that come after a send is saved.
async function extras(job: Job, rows: unknown[]) {
  const { what, owner } = job;
  // A saved row uses these files now: they're no longer leftovers (lib/preupload.ts).
  await markFilesSaved(owner, jobFiles(job)).catch(() => {});
  if (what.kind === 'peek' && what.chatDare) {
    // The proof for a friend's dare: tell them you did it. The peek is sent either way.
    try {
      await claimChatDare(what.chatDare);
      job.result = { ...job.result, dareProblem: null };
    } catch (error) {
      const gone = /This dare is gone/i.test(String((error as { message?: unknown } | null)?.message ?? ''));
      job.result = { ...job.result, dareProblem: gone ? 'gone' : friendlyError(error) };
    }
  }
  if (what.kind === 'chatPhoto') {
    // An older server doesn't mark it as saved by itself: save it the normal way. Never sent twice.
    const row = rows[0] as { id?: string; saved_at?: string | null } | undefined;
    if (row?.id && !row.saved_at) await setSnapSaved(row.id, true).catch((error) => console.warn('Could not save the photo in the chat', error));
  }
  if (what.kind === 'story') void refreshStoryBadges(owner, true);
  if (what.kind === 'post') {
    const post = rows[0] as Post | undefined;
    job.result = {
      ...job.result,
      postId: job.rowIds[0],
      ...(what.drop ? { dropLate: post?.drop_late_seconds ?? null, dropRewound: post?.drop_rewound === true } : {}),
    };
    // Your friends' drops unlock now (every screen knows straight away, without loading your drops again).
    if (what.drop) noteMyDropPosted(owner, post);
  }
}

// ---------------------------------------------------------------------------
// Try again, delete.
// ---------------------------------------------------------------------------
// "Try again" (a tap): a fresh round of tries, with its own 10 minutes.
export function retry(key: string): void {
  const job = jobs.get(key);
  if (!job) return;
  job.triedAt = Date.now();
  again(job);
}

// Tries a failed send again (by a tap, or by itself when you come back within 10 minutes).
function again(job: Job) {
  if (job.state === 'sent' || job.state === 'sending') return;
  clearTimer(job.key);
  job.state = 'waiting';
  job.attempts = 0;
  job.final = false;
  job.restored = false;
  job.holdAfterTry = false;
  job.error = undefined;
  changed();
  pump();
}

// Sends that failed for no answer (or no login) in the last 10 minutes go again by themselves: when you come back
// to the app, or when your login is back. Never older ones, and never ones that wait for a tap.
function tryRecentAgain() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    if (job.state !== 'failed' || !job.noAnswer || job.restored || job.owner !== currentOwner) continue;
    if (now - (job.triedAt ?? job.createdAt) < AUTO_RETRY_MAX_AGE_MS) again(job);
  }
}

// Takes a send off the list for good. Its uploaded files are deleted, but only once it's sure no row uses them.
export async function discard(key: string): Promise<void> {
  const job = jobs.get(key);
  if (!job) return;
  if (job.state === 'sending') return;
  clearTimer(key);
  jobs.delete(key);
  changed();
  void dropLocalCopy(job);
  if (job.maybeSaved || job.everUnclear) {
    // It may have been saved after all: look first, and keep the files if it was (or if we can't tell: then the
    // leftovers clean-up deals with them later, and the server never deletes a file a saved row uses).
    try {
      const found = await lookUp(job);
      if (found.length > 0) {
        await markFilesSaved(job.owner, [...chosenFiles(job), ...(job.uses ?? [])]);
        await forget(job);
        return;
      }
    } catch {
      await forget(job);
      return;
    }
  }
  // Every file it picked a name for (also ones only partly uploaded), one at a time.
  await deleteUnused(job.owner, 'media', ownFiles(job));
  await forget(job);
}

// ---------------------------------------------------------------------------
// The records on the phone (outbox.v1.<user>): no pictures, only where they are, the chosen ids and file names.
// ---------------------------------------------------------------------------
const recordKey = (owner: string) => `outbox.v1.${owner}`;
const writes = new Map<string, Promise<void>>();

type SavedRecord = Omit<Job, 'prepared' | 'rows'>;

function toRecord(job: Job): SavedRecord {
  const { prepared: _prepared, rows: _rows, ...record } = job;
  return record;
}

function changeRecords(owner: string, change: (records: Record<string, SavedRecord>) => void): Promise<void> {
  const before = writes.get(owner) ?? Promise.resolve();
  const next = before
    .then(async () => {
      const records = await readRecords(owner);
      change(records);
      if (Object.keys(records).length === 0) await AsyncStorage.removeItem(recordKey(owner));
      else await AsyncStorage.setItem(recordKey(owner), JSON.stringify(records));
    })
    .catch((error) => console.warn('Could not keep a send on this phone', error));
  writes.set(owner, next);
  return next;
}

async function readRecords(owner: string): Promise<Record<string, SavedRecord>> {
  try {
    const saved = JSON.parse((await AsyncStorage.getItem(recordKey(owner))) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function persist(job: Job): Promise<void> {
  // Taken off the list (deleted, or the login changed): a send still finishing never writes its record back.
  if (!jobs.has(job.key)) return Promise.resolve();
  if (job.state === 'sent') return forget(job);
  return changeRecords(job.owner, (records) => {
    records[job.key] = toRecord(job);
  });
}

function forget(job: Job): Promise<void> {
  return changeRecords(job.owner, (records) => {
    delete records[job.key];
  });
}

// A copy of the picture (or voice note) in the app's own folder, so it's still there to send after a restart.
function outboxFolder(): Directory {
  const folder = new Directory(Paths.document, 'outbox');
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  return folder;
}

async function copyIn(job: Job, uri: string, name: string): Promise<string> {
  if (uri.includes('/outbox/')) return uri;
  const ending = uri.match(/\.[a-z0-9]+$/i)?.[0] ?? '';
  const target = new File(outboxFolder(), `${job.key}${name}${ending}`);
  if (!target.exists) await new File(uri).copy(target);
  return target.uri;
}

async function keepLocalCopy(job: Job) {
  try {
    if (job.capture) {
      const capture = job.capture;
      const uri = await copyIn(job, capture.uri, '');
      const overlayUri = capture.kind === 'video' && capture.overlayUri ? await copyIn(job, capture.overlayUri, '-layer') : null;
      job.capture = capture.kind === 'video' ? { kind: 'video', uri, overlayUri } : { kind: 'photo', uri };
    }
    if (job.what.kind === 'voice' || job.what.kind === 'groupVoice') {
      job.what = { ...job.what, uri: await copyIn(job, job.what.uri, '') };
    }
    if (!jobs.has(job.key) || job.state === 'sent') await dropLocalCopy(job);
    else await persist(job);
  } catch (error) {
    // Kept where it is: it can still be sent now, just maybe not after a restart.
    console.warn('Could not keep a copy of the picture for sending', error);
  }
}

async function dropLocalCopy(job: Job) {
  try {
    for (const uri of [job.capture?.uri, job.capture?.kind === 'video' ? job.capture.overlayUri : null, 'uri' in job.what ? job.what.uri : null]) {
      if (!uri || !uri.includes('/outbox/')) continue;
      const file = new File(uri);
      if (file.exists) file.delete();
    }
  } catch {
    // Only a leftover copy on the phone.
  }
}

function localFileThere(uri: string | null | undefined): boolean {
  if (!uri) return false;
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

// At sign-in: sends that were waiting when the app was closed show as "Not sent – tap to try again" (or are
// dropped if they did get sent). Nothing here is sent by itself.
export async function restoreOutbox(owner: string): Promise<void> {
  const records = await readRecords(owner);
  const now = Date.now();
  for (const record of Object.values(records)) {
    if (!record || typeof record !== 'object' || !record.key || jobs.has(record.key)) continue;
    const job: Job = { ...record, owner, rowIds: record.rowIds ?? [] };
    if (now - (record.createdAt ?? 0) >= RECORD_MAX_AGE_MS) {
      // Too old: thrown away, with every file it picked a name for (one at a time; the server refuses to delete a
      // photo or video a saved row uses).
      await forget(job);
      void dropLocalCopy(job);
      void deleteUnused(owner, 'media', ownFiles(job));
      continue;
    }
    // Closed in the middle of saving: it may be saved.
    if (record.state === 'sending') job.maybeSaved = true;
    try {
      const found = job.rowIds.length > 0 ? await lookUp(job) : [];
      if (found.length > 0 && found.length >= job.rowIds.length) {
        // It did get saved: its files are in use now, so they're crossed off the leftovers list.
        await markFilesSaved(owner, [...chosenFiles(job), ...(job.uses ?? [])]);
        await forget(job);
        void dropLocalCopy(job);
        continue;
      }
    } catch {
      // Can't tell right now: shown as not sent, and a tap looks it up first.
      job.maybeSaved = true;
    }
    const canSend =
      !!job.fields ||
      (job.what.kind === 'voice' || job.what.kind === 'groupVoice' ? localFileThere(job.what.uri) : !job.capture || localFileThere(job.capture.uri));
    jobs.set(job.key, {
      ...job,
      state: 'failed',
      restored: true,
      final: !canSend,
      noAnswer: false,
      holdAfterTry: false,
      error: canSend ? NOT_SENT : NOT_SENT_GONE,
      attempts: 0,
    });
  }
  changed();
  void tidyLocalCopies();
}

// Copies on the phone that no send needs any more (a send that was deleted, a login that ended, or a record over
// a day old) are deleted, so a photo meant to disappear never stays on the phone or in its backups.
async function tidyLocalCopies(): Promise<void> {
  try {
    const folder = new Directory(Paths.document, 'outbox');
    if (!folder.exists) return;
    // Every send on this phone's list, and every saved record (of anyone who used this phone) under a day old.
    const keep = new Set(jobs.keys());
    const now = Date.now();
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith('outbox.v1.'));
    for (const key of keys) {
      const records = JSON.parse((await AsyncStorage.getItem(key)) ?? '{}') as Record<string, Partial<Job> | null>;
      for (const record of Object.values(records ?? {})) {
        if (record?.key && now - (record.createdAt ?? 0) < RECORD_MAX_AGE_MS) keep.add(record.key);
      }
    }
    // A copy's name starts with its send's key.
    for (const item of folder.list()) {
      if (!(item instanceof File)) continue;
      const name = item.uri.split('/').pop() ?? '';
      if (![...keep].some((key) => name.startsWith(key))) item.delete();
    }
  } catch (error) {
    console.warn('Could not tidy the copies of unsent pictures', error);
  }
}

// ---------------------------------------------------------------------------
// Who is logged in, and coming back to the app.
// ---------------------------------------------------------------------------
// Takes a send off this phone's list without sending it (a login change). Anything waiting for it hears it
// didn't go.
function takeOffUnsent(job: Job) {
  clearTimer(job.key);
  jobs.delete(job.key);
  const copy: Job = { ...job, state: 'failed', final: false, error: NOT_SENT };
  const waiting = waiters.get(job.key) ?? [];
  waiters.delete(job.key);
  waiting.forEach((resolve) => resolve(copy));
}

supabase.auth.onAuthStateChange((event, session) => {
  const next = session?.user.id ?? null;
  const before = currentOwner;
  currentOwner = next;
  if (before && before !== next) {
    // Someone else (or nobody) now: the old person's sends leave this phone's list. Their records (and the copies
    // of their pictures) stay, so they show as "Not sent – tap to try again" when that person logs in again –
    // a login can end by itself (it ran out and couldn't be renewed on a weak signal). Logging out yourself
    // deletes them (clearOutbox below).
    for (const job of [...jobs.values()]) if (job.owner === before) takeOffUnsent(job);
    changed();
  }
  // Your login is back (it was renewed): sends that failed for no answer in the last 10 minutes go again.
  if (next && before === next && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) tryRecentAgain();
  if (next) pump();
});

// You logged out yourself (Log out, or deleting your account): your unsent sends are thrown away, with their
// records and the copies of their pictures on this phone. Their uploaded files are on the leftovers list
// (lib/preupload.ts), so they're deleted the next time you log in here.
export function clearOutbox(owner: string): Promise<void> {
  for (const job of [...jobs.values()]) {
    if (job.owner !== owner) continue;
    takeOffUnsent(job);
    void dropLocalCopy(job);
  }
  changed();
  return changeRecords(owner, (records) => {
    for (const [key, record] of Object.entries(records)) {
      void dropLocalCopy(record as Job);
      delete records[key];
    }
  });
}
runBeforeLogOut((owner) => void clearOutbox(owner));

// Coming back to the app (after it was really closed, not just the Control Center pulled down).
let wentAway = false;
AppState.addEventListener('change', (state) => {
  if (state === 'background') {
    wentAway = true;
    return;
  }
  if (state !== 'active') return;
  const wasAway = wentAway;
  wentAway = false;
  if (wasAway) holdOldSends();
  tryRecentAgain();
  pump();
});

// Back after being away: the phone stops sending while the app is closed. A send that was still going and is 10
// minutes old or more now doesn't carry on by itself (it could arrive hours late: a drop would be posted hours
// late as Late). It waits for a tap: "Not sent – tap to try again". Younger ones simply carry on.
function holdOldSends() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    if (job.state !== 'waiting' && job.state !== 'sending') continue;
    if (now - (job.triedAt ?? job.createdAt) < AUTO_RETRY_MAX_AGE_MS) continue;
    // The try that's running now can still finish; if it fails, it isn't tried again by itself.
    if (job.state === 'sending') job.holdAfterTry = true;
    else void holdForTap(job);
  }
}
