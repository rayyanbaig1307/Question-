import { useEffect, useSyncExternalStore } from 'react';

import { runAfterSignOut } from './auth';
import { checkClean, WORD_NOT_ALLOWED } from './cleanWords';
import { dareProblem, type DareProblem } from './dareSafety';
import { liveMaybeAvailable, subscribeLiveBroken, type LiveRole } from './liveAccess';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Lives 🔴: the data layer. Every rule (who can go live, who can watch, limits, comments, co-hosts) lives on
// the server (supabase/migrations/20261226000000_livestreams.sql and the live-token Edge Function). This file
// only asks the server; it never loads LiveKit (that's components/live/LiveStage.tsx, through liveAccess.ts).
// ---------------------------------------------------------------------------

export type { LiveRole } from './liveAccess';

// Why you can't go live right now (null = you can). Checked by the server in this order.
export type LiveWhyNot =
  | 'off'
  | 'testers'
  | 'banned'
  | 'restricted'
  | 'birthday'
  | 'rules'
  | 'no_friends'
  | 'new_account'
  | 'daily_limit'
  | 'month_limit'
  | 'busy';

export type LiveState = {
  can_go_live: boolean;
  why_not: LiveWhyNot | null;
  my_live: string | null;
  max_minutes: number;
  lives_left_today: number;
  rules_accepted: boolean;
};

export type LivePerson = { id: string; username: string; display_name: string; avatar_path: string | null };

// 'live' = you can be in it · 'paused' = the host brought on someone you're not friends with (you'll be let
// back in after) · 'ended' · 'removed' = the host removed you · 'not_allowed' = not for you.
export type LiveStatusCode = 'live' | 'paused' | 'ended' | 'removed' | 'not_allowed';
// Only the host is ever told why a live ended.
export type LiveEndedReason = 'host' | 'time' | 'host_gone' | 'empty' | 'reports' | 'owner' | 'safety';

export type LiveStatus = {
  status: LiveStatusCode;
  role: LiveRole | null; // only set while status is 'live'
  live_id: string;
  host: LivePerson | null; // null only for 'not_allowed'
  cohost: LivePerson | null; // only set while status is 'live'
  started_at: string | null;
  on_air_at: string | null;
  ends_at: string | null;
  comments_on: boolean;
  viewers: number;
  invite: { id: string; expires_at: string } | null; // an open co-host invite to YOU
  ended_reason: LiveEndedReason | null; // host only
  empty_ends_at: string | null; // host only, while nobody is watching
};

export type LiveSummary = {
  seconds: number;
  viewers: number;
  comments: number;
  hearts: number;
  ended_reason: LiveEndedReason | null;
};

export type FriendLive = {
  live_id: string;
  host_id: string;
  host_username: string;
  host_name: string;
  host_avatar: string | null;
  cohost_id: string | null;
  cohost_username: string | null;
  cohost_avatar: string | null;
  started_at: string;
};

export type LiveViewer = {
  user_id: string;
  username: string;
  display_name: string;
  avatar_path: string | null;
  joined_at: string;
  is_cohost: boolean;
  // Whether "Bring on" works for them right now (the app never says why not).
  can_cohost: boolean;
};

export type LiveComment = {
  id: string;
  live_id: string;
  user_id: string;
  name: string;
  avatar_path: string | null;
  body: string;
  created_at: string;
  deleted_at: string | null;
};

export type LiveInvite = {
  id: string;
  live_id: string;
  host_id: string;
  guest_id: string;
  created_at: string;
  expires_at: string;
  answer: 'accepted' | 'declined' | 'expired' | 'cancelled' | null;
  answered_at: string | null;
};

// What the server said no with. `message` is always fit to show; `hint` is the reason code (like
// 'live_daily_limit', 'live_rules', 'live_invite_wait' – the list is in the migration).
export class LiveError extends Error {
  hint: string | null;
  code: string | null;
  constructor(message: string, hint: string | null = null, code: string | null = null) {
    super(message);
    this.name = 'LiveError';
    this.hint = hint;
    this.code = code;
  }
}

// The reason code of a server "no" (null for anything else, like no internet).
export function liveHint(error: unknown): string | null {
  const hint = (error as { hint?: unknown } | null)?.hint;
  return typeof hint === 'string' && hint ? hint : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isLiveId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function toLiveError(error: { message?: string; hint?: string | null; code?: string | null }): LiveError {
  const message = typeof error.message === 'string' && error.message ? error.message : 'Something went wrong. Please try again.';
  return new LiveError(message, error.hint ?? null, error.code ?? null);
}

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = args === undefined ? await supabase.rpc(name) : await supabase.rpc(name, args);
  if (error) throw toLiveError(error);
  return data as T;
}

const asNumber = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asString = (value: unknown) => (typeof value === 'string' ? value : null);
const ROLES: readonly LiveRole[] = ['host', 'cohost', 'viewer'];
const STATUSES: readonly LiveStatusCode[] = ['live', 'paused', 'ended', 'removed', 'not_allowed'];
const ENDED: readonly LiveEndedReason[] = ['host', 'time', 'host_gone', 'empty', 'reports', 'owner', 'safety'];
const WHY_NOT: readonly LiveWhyNot[] = [
  'off', 'testers', 'banned', 'restricted', 'birthday', 'rules', 'no_friends', 'new_account', 'daily_limit', 'month_limit', 'busy',
];

function person(value: unknown): LivePerson | null {
  const p = value as Partial<LivePerson> | null;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
  return { id: p.id, username: asString(p.username) ?? '', display_name: asString(p.display_name) ?? '', avatar_path: asString(p.avatar_path) };
}

function endedReason(value: unknown): LiveEndedReason | null {
  return ENDED.includes(value as LiveEndedReason) ? (value as LiveEndedReason) : null;
}

// The server's live_status / live_ping answer, with safe defaults for anything missing.
export function readLiveStatus(raw: unknown, id: string): LiveStatus {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = STATUSES.includes(r.status as LiveStatusCode) ? (r.status as LiveStatusCode) : 'not_allowed';
  const invite = r.invite as { id?: unknown; expires_at?: unknown } | null;
  return {
    status,
    role: status === 'live' && ROLES.includes(r.role as LiveRole) ? (r.role as LiveRole) : null,
    live_id: asString(r.live_id) ?? id,
    host: person(r.host),
    cohost: status === 'live' ? person(r.cohost) : null,
    started_at: asString(r.started_at),
    on_air_at: asString(r.on_air_at),
    ends_at: asString(r.ends_at),
    comments_on: r.comments_on !== false,
    viewers: status === 'live' ? Math.max(0, asNumber(r.viewers)) : 0,
    invite:
      status === 'live' && invite && typeof invite.id === 'string' && typeof invite.expires_at === 'string'
        ? { id: invite.id, expires_at: invite.expires_at }
        : null,
    ended_reason: endedReason(r.ended_reason),
    empty_ends_at: asString(r.empty_ends_at),
  };
}

function readLiveState(raw: unknown): LiveState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const whyNot = WHY_NOT.includes(r.why_not as LiveWhyNot) ? (r.why_not as LiveWhyNot) : null;
  return {
    can_go_live: r.can_go_live === true && whyNot === null,
    why_not: r.can_go_live === true ? whyNot : (whyNot ?? 'off'),
    my_live: asString(r.my_live),
    max_minutes: asNumber(r.max_minutes, 60),
    lives_left_today: asNumber(r.lives_left_today),
    rules_accepted: r.rules_accepted === true,
  };
}

function readSummary(raw: unknown): LiveSummary {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    seconds: Math.max(0, asNumber(r.seconds)),
    viewers: Math.max(0, asNumber(r.viewers)),
    comments: Math.max(0, asNumber(r.comments)),
    hearts: Math.max(0, asNumber(r.hearts)),
    ended_reason: endedReason(r.ended_reason),
  };
}

// ---------------------------------------------------------------------------
// Going live (host)
// ---------------------------------------------------------------------------

// Can you go live right now, and if not, why (also keeps the 🔴 bubble up to date).
export async function fetchLiveState(): Promise<LiveState> {
  const asked = generation;
  const state = readLiveState(await call<unknown>('live_state'));
  // (Not if you logged out meanwhile: that answer was for the old account.)
  if (asked === generation) rememberLiveState(state);
  return state;
}

// Makes your live (not on air yet: friends see it and get the notification only after liveOnAir).
// `expectedUserId` is the account you think you're logged in as; the server refuses if it changed.
export async function startLive(expectedUserId: string | null): Promise<string> {
  const id = await call<unknown>('start_live', { expected_user_id: expectedUserId });
  if (!isLiveId(id)) throw new LiveError("Couldn't go live – try again.");
  return id;
}

// Your camera is out: friends can see the live now (and get the notification).
export async function liveOnAir(id: string): Promise<void> {
  await call('live_on_air', { live: id });
}

// Ends your live. Safe to call again. `hearts` = the hearts your friends sent (for the summary).
export async function endLive(id: string, hearts: number): Promise<LiveSummary> {
  const count = Math.min(1_000_000, Math.max(0, Math.floor(Number.isFinite(hearts) ? hearts : 0)));
  return readSummary(await call<unknown>('end_live', { live: id, heart_count: count }));
}

// endLive for the moment after the camera has stopped: each try gives up after `timeoutMs`, it tries
// `retries` more times, and it never throws (null = the server never answered; it ends the live itself).
export async function endLiveInBackground(
  id: string,
  hearts: number,
  { timeoutMs = 8000, retries = 2 }: { timeoutMs?: number; retries?: number } = {},
): Promise<LiveSummary | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });
      return await Promise.race([endLive(id, hearts), timeout]);
    } catch {
      // Try again (or give up after the last try).
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

export async function liveStatus(id: string): Promise<LiveStatus> {
  return readLiveStatus(await call<unknown>('live_status', { live: id }), id);
}

// "I'm still here" (host every 15 s, everyone else every 30 s). Answers like liveStatus.
export async function livePing(id: string): Promise<LiveStatus> {
  return readLiveStatus(await call<unknown>('live_ping', { live: id }), id);
}

export async function leaveLive(id: string): Promise<void> {
  await call('leave_live', { live: id });
}

// Friends who are live right now (newest first).
export async function fetchFriendsLiveNow(): Promise<FriendLive[]> {
  const rows = await call<FriendLive[] | null>('friends_live_now');
  return (rows ?? []).filter((row) => isLiveId(row?.live_id));
}

// Host only: who's watching right now.
export async function fetchLiveViewers(id: string): Promise<LiveViewer[]> {
  return (await call<LiveViewer[] | null>('live_viewers_list', { live: id })) ?? [];
}

// ---------------------------------------------------------------------------
// Co-hosts ("Bring on")
// ---------------------------------------------------------------------------

// Host: asks a viewer to come on (they have 60 seconds to answer). Returns the invite's id.
export async function inviteCohost(id: string, guest: string): Promise<string> {
  const invite = await call<unknown>('invite_cohost', { live: id, guest });
  if (!isLiveId(invite)) throw new LiveError("Couldn't ask them – try again.");
  return invite;
}

export async function cancelCohostInvite(id: string): Promise<void> {
  await call('cancel_cohost_invite', { live: id });
}

// Guest: yes or no. Says which role you have now. If the Live rules aren't accepted yet, it throws with hint
// 'live_rules' and the invite stays open (show the rules card, then answer again).
export async function answerCohostInvite(invite: string, accept: boolean): Promise<{ role: 'cohost' | 'viewer' }> {
  const answer = await call<{ role?: unknown } | null>('answer_cohost_invite', { invite, accept });
  return { role: answer?.role === 'cohost' ? 'cohost' : 'viewer' };
}

// Host ("Back to watching") or co-host ("Leave stage").
export async function endCohost(id: string): Promise<void> {
  await call('end_cohost', { live: id });
}

// The person brought on: who may see and hear you right now (user ids: the host, you, and everyone watching who
// is friends with you both). Empty when you aren't on stage. LiveKit is given this list (StageHandle.setWatchers)
// so it never sends your camera to anyone else.
export async function fetchStageWatchers(id: string): Promise<string[]> {
  const list = await call<unknown>('live_stage_allowlist', { live: id });
  return Array.isArray(list) ? list.filter((item): item is string => isLiveId(item)) : [];
}

// Host: removes someone from the live (and blocks them too, if asked).
export async function removeLiveViewer(id: string, viewer: string, alsoBlock: boolean): Promise<void> {
  await call('remove_live_viewer', { live: id, viewer, also_block: alsoBlock });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

// The words people see when a comment isn't allowed. The server says exactly the same (§9.6 of the design);
// tests/unit/lives-client.test.mjs checks they match the migration.
export const LIVE_COMMENT_WORDS = {
  word: WORD_NOT_ALLOWED,
  harm: "That comment isn't allowed – no hurting anyone (or yourself), no violence and no abuse. 🙏",
  sexual: "That comment isn't allowed – nothing sexual. 🙏",
  hate: "That comment isn't allowed – no hate, bullying or slurs. 🙏",
  spam: 'That comment looks like spam – no links, phone numbers or the same thing over and over. 🙏',
  size: 'Comments can be 1 to 150 characters.',
  off: 'Comments are off for this live.',
  slow: 'Slow down a little – one comment every 3 seconds.',
  same: 'You just said that. 🙂',
  limit: "That's a lot of comments – let others have a turn.",
  busy: 'Lots of comments right now – try again in a moment.',
} as const;

export const LIVE_COMMENT_MAX = 150;

// Spaces at the ends taken off, runs of spaces made one (the server does the same before checking).
export function tidyLiveComment(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// A friendly sentence when a comment can't be sent, or null when it's fine. Same order as the server: length,
// then blocked words, then the dare-safety rules (hurting, sexual, hate, spam).
export function checkLiveComment(text: string): string | null {
  const tidy = tidyLiveComment(text);
  const length = Array.from(tidy).length;
  if (length < 1 || length > LIVE_COMMENT_MAX) return LIVE_COMMENT_WORDS.size;
  if (checkClean(tidy, 'content')) return LIVE_COMMENT_WORDS.word;
  const problem: DareProblem | null = dareProblem(tidy);
  return problem ? LIVE_COMMENT_WORDS[problem] : null;
}

export async function sendLiveComment(id: string, text: string): Promise<LiveComment> {
  return await call<LiveComment>('send_live_comment', { live: id, comment: tidyLiveComment(text) });
}

// Your own comment, or (host) anyone's.
export async function deleteLiveComment(commentId: string): Promise<void> {
  await call('delete_live_comment', { comment_id: commentId });
}

// Host: comments on or off.
export async function setLiveComments(id: string, on: boolean): Promise<void> {
  await call('set_live_comments', { live: id, turn_on: on });
}

// The newest 50 comments, newest first (for an upside-down list).
export async function fetchLiveComments(id: string): Promise<LiveComment[]> {
  if (!isLiveId(id)) return [];
  const { data, error } = await supabase
    .from('live_comments')
    .select('*')
    .eq('live_id', id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw toLiveError(error);
  return (data ?? []) as LiveComment[];
}

// ---------------------------------------------------------------------------
// The live's ticket (LiveKit token), from the live-token Edge Function. Never throws: on a "no" it says why
// (`reason` is the server's code, like 'full', 'paused', 'stage_wait'; 'network' = no internet or no answer).
// ---------------------------------------------------------------------------

export type LiveToken = {
  ok: true;
  url: string;
  token: string;
  room: string;
  role: LiveRole;
  identity: string;
  expires_at: string;
};
export type LiveTokenFailure = { ok: false; message: string; reason: string | null; status: number | null };

// The server's own words for each reason (used only if its answer has no words).
export const LIVE_TOKEN_WORDS: Record<string, string> = {
  login: 'Please log in again.',
  login_changed: 'Your login changed – please log in again.',
  not_set_up: "Lives aren't set up yet.",
  unavailable: "Lives aren't working right now – try again in a bit.",
  not_allowed: "This live is only for the host's friends.",
  removed: 'You were removed from this live.',
  ended: 'This live has ended.',
  paused: "Your friend brought someone on – this part is just for their shared friends. We'll let you back in after.",
  full: 'This live is full right now – try again in a bit.',
  busy: 'Lives are busy right now – try again later.',
  stage_wait: 'Getting the stage ready…',
  network: "Couldn't reach the server – check your internet.",
};

// Reads the reason out of an Edge Function error (the app can't see it otherwise: the supabase library only
// says "non-2xx status code"). The same shape as errors.ts functionError.
async function readFunctionError(error: unknown): Promise<LiveTokenFailure> {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'FunctionsFetchError') return { ok: false, message: LIVE_TOKEN_WORDS.network, reason: 'network', status: null };
  const reply = (error as { context?: unknown } | null)?.context as { status?: unknown; json?: () => Promise<unknown> } | undefined;
  const status = typeof reply?.status === 'number' ? reply.status : null;
  let reason: string | null = null;
  let message: string | null = null;
  if (typeof reply?.json === 'function') {
    try {
      const body = (await reply.json()) as { error?: unknown; reason?: unknown } | null;
      if (typeof body?.reason === 'string' && /^[a-z_]{1,40}$/.test(body.reason)) reason = body.reason;
      if (typeof body?.error === 'string' && body.error.trim() && body.error.length <= 300) message = body.error;
    } catch {
      // Not readable: use the words below.
    }
  }
  if (!reason) reason = status === 401 ? 'login' : status === null || status >= 500 ? 'unavailable' : null;
  return {
    ok: false,
    message: message ?? (reason && LIVE_TOKEN_WORDS[reason]) ?? LIVE_TOKEN_WORDS.unavailable,
    reason,
    status,
  };
}

export async function getLiveToken(id: string, expectedUserId: string | null): Promise<LiveToken | LiveTokenFailure> {
  if (!isLiveId(id)) return { ok: false, message: LIVE_TOKEN_WORDS.not_allowed, reason: 'not_allowed', status: null };
  try {
    const { data, error } = await supabase.functions.invoke('live-token', {
      method: 'POST',
      body: expectedUserId ? { live_id: id, expected_user_id: expectedUserId } : { live_id: id },
      timeout: 15_000,
    });
    if (error) return await readFunctionError(error);
    const d = (data ?? {}) as Record<string, unknown>;
    const url = asString(d.url);
    const token = asString(d.token);
    const room = asString(d.room);
    const identity = asString(d.identity);
    if (!url || !/^wss?:\/\//.test(url) || !token || !room || !identity || !ROLES.includes(d.role as LiveRole)) {
      return { ok: false, message: LIVE_TOKEN_WORDS.unavailable, reason: 'unavailable', status: null };
    }
    return { ok: true, url, token, room, role: d.role as LiveRole, identity, expires_at: asString(d.expires_at) ?? '' };
  } catch {
    return { ok: false, message: LIVE_TOKEN_WORDS.network, reason: 'network', status: null };
  }
}

// ---------------------------------------------------------------------------
// Live updates while a live screen is open: new and deleted comments, and co-host invites.
// One channel per screen, with its own name (the 4 Nov launch-crash lesson).
// ---------------------------------------------------------------------------

export type LiveHandlers = {
  onComment?: (comment: LiveComment) => void; // a new comment
  onCommentGone?: (commentId: string) => void; // a comment was deleted
  onInvite?: (invite: LiveInvite) => void; // the host of THIS live asked you to come on
  onInviteChange?: (invite: LiveInvite) => void; // an invite of this live was answered, cancelled or ran out
};

let channels = 0;
export function listenToLive(id: string, me: string, handlers: LiveHandlers): () => void {
  if (!isLiveId(id)) return () => {};
  let channel = supabase
    .channel(`live-${id}-${++channels}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_comments', filter: `live_id=eq.${id}` }, (payload) => {
      const row = payload.new as LiveComment;
      if (row && !row.deleted_at) handlers.onComment?.(row);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_comments', filter: `live_id=eq.${id}` }, (payload) => {
      const row = payload.new as LiveComment;
      if (row?.deleted_at) handlers.onCommentGone?.(row.id);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_invites', filter: `live_id=eq.${id}` }, (payload) => {
      const row = payload.new as LiveInvite;
      if (row) handlers.onInviteChange?.(row);
    });
  if (isLiveId(me)) {
    channel = channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'live_invites', filter: `guest_id=eq.${me}` },
      (payload) => {
        const row = payload.new as LiveInvite;
        if (row && row.live_id === id && row.guest_id === me) handlers.onInvite?.(row);
      },
    );
  }
  channel.subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// The 🔴 bubble on the camera: shown when this download can do lives and the server didn't say a "never for
// you" reason (off, testers only, banned, restricted). The answer is kept for 60 seconds; not known yet
// counts as hidden. It never runs the real native check (that waits for the Go live tap).
// ---------------------------------------------------------------------------

const BUBBLE_HIDDEN: readonly LiveWhyNot[] = ['off', 'testers', 'banned', 'restricted'];
export const LIVE_STATE_CACHE_MS = 60_000;

let cached: { state: LiveState; at: number } | null = null;
let lastAsked = 0;
let asking: Promise<unknown> | null = null;
// Goes up at every log-out: an answer that was still on its way for the old account is then thrown away.
let generation = 0;
const bubbleListeners = new Set<() => void>();

function tellBubbleListeners() {
  for (const listener of [...bubbleListeners]) {
    try {
      listener();
    } catch {
      // One listener failing must not stop the others.
    }
  }
}

function rememberLiveState(state: LiveState) {
  cached = { state, at: Date.now() };
  tellBubbleListeners();
}

// Forget the remembered answer (after logging out, or when another account takes over).
export function forgetLiveState(): void {
  generation += 1;
  cached = null;
  lastAsked = 0;
  asking = null;
  tellBubbleListeners();
}
runAfterSignOut(() => forgetLiveState());

function subscribeBubble(listener: () => void): () => void {
  bubbleListeners.add(listener);
  const stop = subscribeLiveBroken(listener);
  return () => {
    bubbleListeners.delete(listener);
    stop();
  };
}

export function liveBubbleShown(): boolean {
  if (!liveMaybeAvailable() || !cached) return false;
  return !(cached.state.why_not && BUBBLE_HIDDEN.includes(cached.state.why_not));
}

// Asks the server again if the remembered answer is older than 60 seconds.
export function refreshLiveBubble(): void {
  if (!liveMaybeAvailable() || asking) return;
  const now = Date.now();
  if (now - Math.max(cached?.at ?? 0, lastAsked) < LIVE_STATE_CACHE_MS) return;
  lastAsked = now;
  const request: Promise<unknown> = fetchLiveState()
    .catch(() => {})
    .finally(() => {
      if (asking === request) asking = null;
    });
  asking = request;
}

// For the camera: is the 🔴 bubble shown? `focused` (optional): pass the camera page's focus, so the answer
// is refreshed each time the camera comes into view.
export function useLiveBubble(focused = true): boolean {
  const shown = useSyncExternalStore(subscribeBubble, liveBubbleShown, liveBubbleShown);
  useEffect(() => {
    if (focused) refreshLiveBubble();
  }, [focused]);
  return shown;
}
