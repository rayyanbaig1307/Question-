// Live token 🔴: gives a phone a short "ticket" (a LiveKit token) to join ONE live – but only after the database
// says this person may be there right now (as the host, the co-host or a watching friend). The app calls it from
// src/lib/lives.ts (getLiveToken). The database decides everything (public.live_join in
// supabase/migrations/20261226000000_livestreams.sql); this function only signs the ticket.
//
// ---------------------------------------------------------------------------------------------------------
// Owner's setup steps (once, in this order):
//  1. The migration supabase/migrations/20261226000000_livestreams.sql must be applied first.
//  2. LiveKit Cloud (cloud.livekit.io): sign up → Create project "Peekaboo" → Settings → API Keys → Create key.
//     Copy the API key, the API secret (it is shown only once) and the project address (wss://….livekit.cloud).
//     Leave recording ("Egress") off. No webhook is needed.
//  3. Supabase → Edge Functions → Secrets: add these three (the live-admin function uses the same three):
//       LIVEKIT_URL         the project address, for example wss://peekaboo-abc123.livekit.cloud
//       LIVEKIT_API_KEY     the API key
//       LIVEKIT_API_SECRET  the API secret
//     Type them only on Supabase's own page – never paste them into a chat or a file.
//  4. Deploy this function with "Verify JWT" switched OFF. It checks the login itself (like delete-account),
//     and the deploy tool switches the check ON unless it is told otherwise.
//  5. Quick check: a POST with no login answers 401, and a GET answers 405.
// Until the three secrets are there, every request answers 503 "Lives aren't set up yet." and nothing happens.
// ---------------------------------------------------------------------------------------------------------
//
// What one request does:
//  1. Only POST. The login comes from the "Authorization: Bearer <session>" header (never from the body).
//  2. The body is {"live_id": "<uuid>", "expected_user_id"?: "<uuid>"} and at most 4 KB.
//  3. public.live_join asks the database: may this person join this live, and as what? (It also counts every
//     request, so one account can't ask for more than 30 tickets in 10 minutes.)
//  4. The host: the LiveKit room is made first, with its limits (how many people, how long it stays open).
//  5. A new co-host: everyone who isn't friends with the co-host too is taken out of the room first, so the
//     co-host's camera never reaches them ("Getting the stage ready…" until that is done).
//  6. The ticket: 10 minutes for the host and co-host, 1 minute for a viewer. Viewers are hidden and can't send
//     video or sound. The ticket carries no name or other details – only the account id.
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

const MAX_BODY = 4096; // bytes
const TIMEOUT_MS = 10_000; // each call to LiveKit
const HOST_TTL = 600; // seconds: the host and the co-host
const VIEWER_TTL = 60; // seconds: viewers
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The words the app shows, by reason (docs: DESIGN §9.4). They must stay friendly and never say more than this.
const WORDS: Record<string, string> = {
  method: 'Use POST',
  bad_request: 'Check the request and try again.',
  too_big: 'That request is too large.',
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
};
// The reasons the database may give for a "no".
const REFUSALS = new Set(['not_allowed', 'ended', 'removed', 'paused', 'full', 'busy']);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const fail = (status: number, reason: string) => json({ error: WORDS[reason] ?? WORDS.unavailable, reason }, status);

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
// (The same lines are in live-admin/index.ts.)
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

// Runs at most `limit` jobs at the same time.
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

function identitiesIn(list: Call): string[] {
  if (!list.ok || !Array.isArray(list.data.participants)) return [];
  const seen = new Set<string>();
  for (const person of list.data.participants) {
    if (isObject(person) && typeof person.identity === 'string' && person.identity) seen.add(person.identity);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------------------------------------
async function readBody(req: Request): Promise<Record<string, unknown> | 'too_big' | 'bad_request'> {
  const reader = req.body?.getReader();
  if (!reader) return 'bad_request';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) {
        await reader.cancel().catch(() => {});
        return 'too_big';
      }
      chunks.push(value);
    }
  } catch {
    return 'bad_request';
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isObject(body) ? body : 'bad_request';
  } catch {
    return 'bad_request';
  }
}

type Join = Record<string, unknown>;

async function liveJoin(account: string, live: string): Promise<Join | null> {
  try {
    const { data, error } = await admin.rpc('live_join', { account, live });
    if (error || !isObject(data)) return null;
    return data;
  } catch {
    return null;
  }
}

// A "no" from the database → 403 with its own words. Anything unexpected is a "no" too.
function refusal(join: Join): Response {
  const reason = typeof join.reason === 'string' && REFUSALS.has(join.reason) ? join.reason : 'not_allowed';
  return fail(403, reason);
}

// ---------------------------------------------------------------------------------------------------------
// A new co-host's first ticket: clear the stage first. Viewers who aren't friends with the co-host too (or are
// blocked with them) must be out of the room BEFORE the co-host's camera goes out.
//   'ok'      → the stage is clean, the ticket can be made
//   'wait'    → not yet (a removal failed, or someone could still join with a ticket from the last minute)
//   'changed' → the co-host changed meanwhile
// ---------------------------------------------------------------------------------------------------------
async function clearStage(lk: LiveKit, live: string, room: string, since: string): Promise<'ok' | 'wait' | 'changed'> {
  const list = await twirp(lk, 'ListParticipants', { room }, room);
  if (!list.ok && !list.notFound) return 'wait';
  const identities = identitiesIn(list);

  let check: unknown;
  try {
    const { data, error } = await admin.rpc('live_stage_check', { live, identities });
    if (error) return 'wait';
    check = data;
  } catch {
    return 'wait';
  }
  if (!isObject(check) || !Array.isArray(check.remove)) return 'wait';

  const removals: { identity: string; soft: boolean }[] = [];
  for (const entry of check.remove) {
    if (!isObject(entry) || typeof entry.identity !== 'string' || !entry.identity) return 'wait';
    removals.push({ identity: entry.identity, soft: entry.soft === true });
  }
  let allGone = true;
  await inPool(removals, 5, async ({ identity, soft }) => {
    const result = await removeParticipant(lk, room, identity, soft);
    if (!result.ok && !result.notFound) allGone = false; // "not found" = already gone
  });
  if (!allGone || check.wait !== false) return 'wait';

  try {
    const { data, error } = await admin.rpc('live_stage_clean', { live, since });
    if (error) return 'wait';
    return data === true ? 'ok' : 'changed';
  } catch {
    return 'wait';
  }
}

// ---------------------------------------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail(405, 'method');

  // 1. Who is asking? Only the login decides – an id in the body is never trusted.
  const session = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!session) return fail(401, 'login');
  let userId: string;
  try {
    const { data: who, error } = await admin.auth.getUser(session);
    // The login server being down is not a bad login: "try again", not "log in again".
    const status = typeof error?.status === 'number' ? error.status : 401;
    if (error && (status === 0 || status >= 500 || error.name === 'AuthRetryableFetchError')) return fail(503, 'unavailable');
    if (error || !who?.user?.id) return fail(401, 'login');
    userId = String(who.user.id).toLowerCase();
  } catch {
    return fail(503, 'unavailable');
  }

  // 2. The request: which live, and (optionally) which account the app thinks is logged in.
  const body = await readBody(req);
  if (body === 'too_big') return fail(413, 'too_big');
  if (body === 'bad_request') return fail(400, 'bad_request');
  if (typeof body.live_id !== 'string' || !UUID.test(body.live_id)) return fail(400, 'bad_request');
  const liveId = body.live_id.toLowerCase();
  const expected = body.expected_user_id;
  if (expected !== undefined && expected !== null) {
    if (typeof expected !== 'string' || !UUID.test(expected)) return fail(400, 'bad_request');
    if (expected.toLowerCase() !== userId) return fail(409, 'login_changed');
  }

  // 3. Lives need the three LiveKit secrets.
  const lk = liveKitSettings();
  if (!lk) return fail(503, 'not_set_up');

  // 4. The database decides: may this person join, and as what?
  const join = await liveJoin(userId, liveId);
  if (!join) return fail(503, 'unavailable');
  if (join.ok !== true) return join.ok === false ? refusal(join) : fail(503, 'unavailable');
  const role = join.role;
  const room = `live_${liveId}`;
  if ((role !== 'host' && role !== 'cohost' && role !== 'viewer') || join.room !== room) return fail(503, 'unavailable');

  try {
    // 5. The host: make the room first, with its limits. If LiveKit says no, the host gets no ticket – a host
    //    ticket must never make a room without limits. (If the room is already there, LiveKit just gives it back.)
    if (role === 'host' || join.create_room === true) {
      const most = join.max_participants;
      if (typeof most !== 'number' || !Number.isInteger(most) || most < 1 || most > 1000) return fail(503, 'unavailable');
      const made = await twirp(lk, 'CreateRoom', { name: room, emptyTimeout: 120, departureTimeout: 60, maxParticipants: most }, room);
      if (!made.ok) {
        console.warn('live-token: the room could not be made', made.status, made.code);
        return fail(503, 'unavailable');
      }
    }

    // 6. A new co-host: clear the stage before the first ticket of this turn. Later tickets in the same turn
    //    (reconnects) skip this – the database says which is which.
    if (role === 'cohost' && join.stage_check !== false) {
      if (typeof join.cohost_since !== 'string' || !join.cohost_since) return fail(503, 'unavailable');
      const stage = await clearStage(lk, liveId, room, join.cohost_since);
      if (stage === 'wait') return fail(503, 'stage_wait');
      if (stage === 'changed') {
        // The co-host changed meanwhile: ask the database again what this person is now.
        const again = await liveJoin(userId, liveId);
        if (again && again.ok === false) return refusal(again);
        return fail(503, 'stage_wait'); // still allowed in: the app simply asks again in 2 seconds
      }
    }

    // 7. The ticket. No name, metadata or attributes – only the account id.
    const most = role === 'viewer' ? VIEWER_TTL : HOST_TTL;
    const asked = join.ttl;
    const ttl = typeof asked === 'number' && Number.isInteger(asked) && asked > 0 ? Math.min(asked, most) : most;
    const video = role === 'viewer'
      ? {
        room, roomJoin: true, canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: true,
        canUpdateOwnMetadata: false, hidden: true,
      }
      : {
        room, roomJoin: true, canSubscribe: true, canPublish: true, canPublishSources: ['camera', 'microphone'],
        canPublishData: true, canUpdateOwnMetadata: false,
      };
    const now = nowSeconds();
    const exp = now + ttl;
    const token = await signJwt({ iss: lk.key, sub: userId, nbf: now, exp, video }, lk.secret);
    return json({ url: lk.url, token, room, role, identity: userId, expires_at: new Date(exp * 1000).toISOString() });
  } catch {
    console.warn('live-token: could not finish');
    return fail(503, 'unavailable');
  }
});
