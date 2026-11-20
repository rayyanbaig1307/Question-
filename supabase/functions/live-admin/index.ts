// Live admin 🔴: does the LiveKit "clean-up" jobs the database asks for – taking people out of a live, taking a
// co-host off the stage, closing a room when its live ends, and a once-a-minute check of who is really in each
// room. Only the database calls it (private.live_poke in supabase/migrations/20261226000000_livestreams.sql,
// through pg_net), with the secret "x-live-key" from the Vault (live_admin_key). Phones never call it.
// The database decides WHAT each job does at the moment it hands the job out (public.live_jobs_claim); this
// function only carries it out and reports back (public.live_jobs_finish).
//
// ---------------------------------------------------------------------------------------------------------
// Owner's setup steps (once, after the live-token steps):
//  1. The migration supabase/migrations/20261226000000_livestreams.sql must be applied first. It makes the Vault
//     key live_admin_key by itself – nothing to copy.
//  2. The three secrets LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET (Supabase → Edge Functions →
//     Secrets) – the same three as live-token. Never paste them into a chat or a file.
//  3. Deploy this function with "Verify JWT" switched OFF – the database doesn't log in, the Vault key protects
//     it instead. (The deploy tool switches the check ON unless it is told otherwise.)
//  4. Quick check: a POST with no key answers 401, and a GET answers 405.
//  5. Check that LiveKit answers: in the SQL Editor run  select private.live_selftest();  wait 10 seconds, then
//       select done_at, last_error from private.live_jobs where room = 'live_selftest' order by id desc limit 1;
//     A time in done_at and an empty last_error = the address, key and secret all work. Anything in last_error
//     (for example "unauthenticated") = a secret is mistyped: fix it in Secrets and run it again.
// ---------------------------------------------------------------------------------------------------------
//
// One request: check the key → take up to 25 due jobs → run them, 5 at a time → report back → again, until there
// are no more jobs or 20 seconds have passed. A job that fails is tried again later by the database (up to 6
// times). "Not found" from LiveKit means the person or room is already gone, which counts as done – except for a
// removal the database wants re-checked a minute later (the person may be between connections).
// Tickets and secrets are never written to the logs.
import { createClient } from 'npm:@supabase/supabase-js@2';

// The server key: the older "service_role" key, or the newer secret key list if that is all there is.
function serviceKey(): string {
  const old = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (old) return old;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    return typeof keys?.default === 'string' ? keys.default : '';
  } catch {
    return '';
  }
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TIMEOUT_MS = 10_000; // each call to LiveKit
const CLAIM_WINDOW_MS = 20_000; // ask for more jobs only during the first 20 seconds
const START_BUDGET_MS = 40_000; // after this, jobs not started yet are handed back as "out of time"
const MAX_ROUNDS = 50; // a last safety stop for the loop
const BATCH = 25; // jobs per claim
const AT_ONCE = 5; // jobs (and removals inside one job) running at the same time

const NOT_SET_UP = { error: "Lives aren't set up yet.", reason: 'not_set_up' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------
// LiveKit settings (the three secrets). null = not set up yet.
// ---------------------------------------------------------------------------------------------------------
type LiveKit = { url: string; key: string; secret: string; base: string };

function liveKitSettings(): LiveKit | null {
  const url = (Deno.env.get('LIVEKIT_URL') ?? '').trim();
  const key = (Deno.env.get('LIVEKIT_API_KEY') ?? '').trim();
  const secret = (Deno.env.get('LIVEKIT_API_SECRET') ?? '').trim();
  if (!url || !key || !secret || !/^(wss?|https?):\/\/[^\s/]+/i.test(url)) return null;
  // The address for LiveKit's server calls: wss:// → https://. A plain text swap, because the Edge test sandbox
  // has no URL class.
  const base = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
  return { url, key, secret, base };
}

// ---------------------------------------------------------------------------------------------------------
// The ticket signer: a standard "HS256" JWT, the kind LiveKit's own tools make. No imports needed.
// (The same lines are in live-token/index.ts.)
// ---------------------------------------------------------------------------------------------------------
const enc = new TextEncoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// base64url without padding, written out by hand (there is no btoa or Buffer in the test sandbox).
function b64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length;
    const n = (bytes[i] << 16) | ((two ? bytes[i + 1] : 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (two ? B64[(n >> 6) & 63] : '');
  }
  return out;
}

async function signJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const input = `${b64url(enc.encode('{"alg":"HS256","typ":"JWT"}'))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(input))))}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------------------------------------
// LiveKit's server calls ("Twirp"): POST <base>/twirp/livekit.RoomService/<Method> with a 60-second server
// ticket for just this room. Every call gives up after 10 seconds.
// ---------------------------------------------------------------------------------------------------------
type Call =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; notFound: boolean; status: number; code: string };

async function twirp(lk: LiveKit, method: string, body: Record<string, unknown>, room: string): Promise<Call> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const now = nowSeconds();
    const ticket = await signJwt(
      { iss: lk.key, nbf: now, exp: now + 60, video: { room, roomAdmin: true, roomCreate: true } },
      lk.secret,
    );
    const response = await fetch(`${lk.base}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    if (response.ok) return { ok: true, data: isObject(parsed) ? parsed : {} };
    const code = isObject(parsed) && typeof parsed.code === 'string' ? parsed.code : '';
    // "Not found" only counts when LiveKit itself says so – a 404 from a wrong address is a failure.
    return { ok: false, notFound: code === 'not_found', status: response.status, code };
  } catch {
    return { ok: false, notFound: false, status: 0, code: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Short words for private.live_jobs.last_error – the method and LiveKit's code, never a ticket or a secret.
function problem(method: string, call: Call): string {
  if (call.ok) return '';
  return `${method}: ${[call.status || '', call.code].filter(Boolean).join(' ') || 'failed'}`.slice(0, 200);
}

// Takes one person out of the room. "soft" lets them come straight back with a new ticket (used for people who
// only have to wait while the co-host is on); otherwise LiveKit also cancels every ticket they already had.
async function removeParticipant(lk: LiveKit, room: string, identity: string, soft: boolean): Promise<Call> {
  if (soft) {
    const first = await twirp(lk, 'RemoveParticipant', { room, identity, revokeTokenTs: String(nowSeconds()) }, room);
    // An older LiveKit that doesn't know revokeTokenTs: once more without it (that is a normal removal).
    if (first.ok || first.code !== 'invalid_argument') return first;
  }
  return twirp(lk, 'RemoveParticipant', { room, identity }, room);
}

// Runs at most `limit` at the same time.
async function inPool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type Person = { identity: string; publisher: boolean };

function peopleIn(list: Call): Person[] {
  if (!list.ok || !Array.isArray(list.data.participants)) return [];
  const people = new Map<string, Person>();
  for (const p of list.data.participants) {
    if (!isObject(p) || typeof p.identity !== 'string' || !p.identity) continue;
    // Someone who sends video or sound (or is allowed to): LiveKit says isPublisher, or they have tracks.
    const publisher = p.isPublisher === true || (Array.isArray(p.tracks) && p.tracks.length > 0);
    people.set(p.identity, { identity: p.identity, publisher: publisher || !!people.get(p.identity)?.publisher });
  }
  return [...people.values()];
}

// ---------------------------------------------------------------------------------------------------------
// The jobs (shapes: DESIGN §9.2 live_jobs_claim)
// ---------------------------------------------------------------------------------------------------------
type Job = {
  id: number;
  action: 'end_room' | 'remove' | 'demote' | 'audit';
  room: string;
  identity: string | null;
  soft: boolean;
  recheck: boolean;
};
type Outcome = 'done' | 'recheck' | { error: string };

const ACTIONS = new Set(['end_room', 'remove', 'demote', 'audit']);
const ROOM = /^live_[A-Za-z0-9_-]{1,80}$/;

function readJob(raw: Record<string, unknown>): Job | null {
  const { job_id: id, action, room, identity } = raw;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  if (typeof room !== 'string' || !ROOM.test(room)) return null;
  const person = typeof identity === 'string' && identity && identity.length <= 200 ? identity : null;
  if ((action === 'remove' || action === 'demote') && !person) return null;
  return { id, action: action as Job['action'], room, identity: person, soft: raw.soft === true, recheck: raw.recheck === true };
}

// Closing a room: take everyone out for good (which also cancels the tickets they already had), then close it.
// The room is closed even if a removal failed, so nobody keeps watching; the job then counts as failed and the
// database tries it again.
async function endRoom(lk: LiveKit, room: string): Promise<Outcome> {
  const errors: string[] = [];
  const list = await twirp(lk, 'ListParticipants', { room }, room);
  if (!list.ok && !list.notFound) errors.push(problem('ListParticipants', list));
  await inPool(peopleIn(list), AT_ONCE, async ({ identity }) => {
    const gone = await twirp(lk, 'RemoveParticipant', { room, identity }, room);
    if (!gone.ok && !gone.notFound) errors.push(problem('RemoveParticipant', gone));
  });
  const closed = await twirp(lk, 'DeleteRoom', { room }, room);
  if (!closed.ok && !closed.notFound) errors.push(problem('DeleteRoom', closed));
  return errors.length ? { error: errors[0] } : 'done';
}

// One person out. "not found" = already gone (done), or – when the database asks – check again in a minute.
async function remove(lk: LiveKit, job: Job): Promise<Outcome> {
  const result = await removeParticipant(lk, job.room, job.identity!, job.soft);
  if (result.ok) return 'done';
  if (result.notFound) return job.recheck ? 'recheck' : 'done';
  return { error: problem('RemoveParticipant', result) };
}

// A co-host back to an ordinary viewer: hidden, no camera or microphone. LiveKit replaces the permissions as a
// whole, so all of them are sent. (Not RemoveParticipant: that would keep them out for about a minute.)
async function demote(lk: LiveKit, job: Job): Promise<Outcome> {
  const result = await twirp(lk, 'UpdateParticipant', {
    room: job.room,
    identity: job.identity,
    permission: {
      canSubscribe: true, canPublish: false, canPublishData: true, canPublishSources: [], hidden: true,
      canUpdateMetadata: false,
    },
  }, job.room);
  if (result.ok || result.notFound) return 'done';
  return { error: problem('UpdateParticipant', result) };
}

// The once-a-minute check: who is really in the room? The database says who must go (public.live_audit).
async function audit(lk: LiveKit, room: string): Promise<Outcome> {
  const list = await twirp(lk, 'ListParticipants', { room }, room);
  if (!list.ok && !list.notFound) return { error: problem('ListParticipants', list) };
  const people = peopleIn(list);
  let verdict: unknown;
  try {
    const { data, error } = await admin.rpc('live_audit', {
      room_name: room,
      identities: people.map((p) => p.identity),
      publishers: people.filter((p) => p.publisher).map((p) => p.identity),
    });
    if (error) return { error: 'live_audit failed' };
    verdict = data;
  } catch {
    return { error: 'live_audit failed' };
  }
  if (!isObject(verdict) || !Array.isArray(verdict.remove)) return { error: 'live_audit answer' };

  const errors: string[] = [];
  const removals: { identity: string; soft: boolean }[] = [];
  for (const entry of verdict.remove) {
    if (isObject(entry) && typeof entry.identity === 'string' && entry.identity) {
      removals.push({ identity: entry.identity, soft: entry.soft === true });
    } else {
      errors.push('live_audit answer');
    }
  }
  await inPool(removals, AT_ONCE, async ({ identity, soft }) => {
    const gone = await removeParticipant(lk, room, identity, soft);
    if (!gone.ok && !gone.notFound) errors.push(problem('RemoveParticipant', gone));
  });
  if (verdict.delete_room === true) {
    const closed = await twirp(lk, 'DeleteRoom', { room }, room);
    if (!closed.ok && !closed.notFound) errors.push(problem('DeleteRoom', closed));
  }
  return errors.length ? { error: errors[0] } : 'done';
}

async function runJob(lk: LiveKit, job: Job): Promise<Outcome> {
  try {
    if (job.action === 'end_room') return await endRoom(lk, job.room);
    if (job.action === 'remove') return await remove(lk, job);
    if (job.action === 'demote') return await demote(lk, job);
    return await audit(lk, job.room);
  } catch {
    return { error: `${job.action}: crashed` };
  }
}

// ---------------------------------------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST', reason: 'method' }, 405);

  // 1. Only the database's queue (it knows the Vault key) may call this.
  const given = req.headers.get('x-live-key') ?? '';
  if (!given || given.length > 512) return json({ error: 'Not allowed' }, 401);
  try {
    const { data: ok, error } = await admin.rpc('live_admin_key_ok', { given });
    if (error || ok !== true) return json({ error: 'Not allowed' }, 401);
  } catch {
    return json({ error: 'Not allowed' }, 401);
  }

  // 2. No LiveKit secrets yet: stop before taking any job, so no tries are used up.
  const lk = liveKitSettings();
  if (!lk) return json(NOT_SET_UP, 503);

  // 3. Take jobs and run them until there are none left or 20 seconds have passed.
  const started = Date.now();
  const totals = { done: 0, failed: 0, recheck: 0 };
  let trouble = false;
  for (let round = 0; round < MAX_ROUNDS && Date.now() - started < CLAIM_WINDOW_MS; round++) {
    let jobs: unknown[];
    try {
      const { data, error } = await admin.rpc('live_jobs_claim', { max_jobs: BATCH });
      if (error || (data !== null && !Array.isArray(data))) { trouble = true; break; }
      jobs = data ?? [];
    } catch {
      trouble = true;
      break;
    }
    if (jobs.length === 0) break;

    const done: number[] = [];
    const failed: { id: number; error: string }[] = [];
    const recheck: number[] = [];
    await inPool(jobs, AT_ONCE, async (raw) => {
      const job = isObject(raw) ? readJob(raw) : null;
      if (!job) {
        const id = isObject(raw) ? raw.job_id : undefined;
        if (typeof id === 'number' && Number.isSafeInteger(id)) failed.push({ id, error: 'bad job' });
        return;
      }
      if (Date.now() - started > START_BUDGET_MS) { failed.push({ id: job.id, error: 'out of time' }); return; }
      const outcome = await runJob(lk, job);
      if (outcome === 'done') done.push(job.id);
      else if (outcome === 'recheck') recheck.push(job.id);
      else failed.push({ id: job.id, error: outcome.error });
    });

    try {
      const { error } = await admin.rpc('live_jobs_finish', { done, failed, recheck });
      if (error) { trouble = true; break; }
    } catch {
      trouble = true;
      break;
    }
    totals.done += done.length;
    totals.failed += failed.length;
    totals.recheck += recheck.length;
  }

  if (totals.failed) console.warn(`live-admin: ${totals.failed} job(s) failed and will be tried again`);
  if (trouble) {
    console.warn('live-admin: the job queue could not be read or updated');
    return json({ error: "Lives aren't working right now – try again in a bit.", reason: 'unavailable', ...totals }, 503);
  }
  return json(totals);
});
