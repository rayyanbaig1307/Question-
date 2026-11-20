// Live token (supabase/functions/live-token). Runs the real handler with a stand-in database (admin.rpc), a
// stand-in login check (admin.auth.getUser) and a stand-in LiveKit (fetch). Every ticket it makes is checked with
// node:crypto's own HMAC, the way LiveKit checks it. Invented users only; nothing here talks to LiveKit or a live
// project.
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEdge, request } from './edgeHarness.mjs';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAUSED = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const LIVE = '6b1f0c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
const ROOM = `live_${LIVE}`;
const SINCE = '2026-11-20T10:00:00.000Z';
const KEY = 'APItestkey';
const SECRET = 'test-livekit-secret-that-is-long-enough-0123';
const ENV = { LIVEKIT_URL: 'wss://peekaboo-test.livekit.cloud', LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET };
const TWIRP = 'https://peekaboo-test.livekit.cloud/twirp/livekit.RoomService/';

const WORDS = {
  not_allowed: "This live is only for the host's friends.",
  removed: 'You were removed from this live.',
  ended: 'This live has ended.',
  paused: "Your friend brought someone on – this part is just for their shared friends. We'll let you back in after.",
  full: 'This live is full right now – try again in a bit.',
  busy: 'Lives are busy right now – try again later.',
};

afterEach(() => vi.restoreAllMocks());

const joined = (fields) => ({
  ok: true, room: ROOM, max_participants: 22, create_room: false, ttl: 60, stage_check: false, cohost_since: null, ...fields,
});
const HOST = joined({ role: 'host', create_room: true, ttl: 600 });
const VIEWER = joined({ role: 'viewer' });
const COHOST = joined({ role: 'cohost', ttl: 600, cohost_since: SINCE });
const NEW_COHOST = { ...COHOST, stage_check: true };

// Reads a ticket and checks its signature with node:crypto (no shared code with the function).
function readTicket(token, secret = SECRET) {
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  // Strict base64url (no padding, no stray bits): LiveKit's decoder is stricter than Node's.
  for (const part of parts) expect(Buffer.from(part, 'base64url').toString('base64url')).toBe(part);
  const [header, payload, signature] = parts;
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    signed: createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url') === signature,
  };
}

// The stand-in world. `events` keeps the order of database and LiveKit calls.
function world({ join = HOST, rejoin, stageCheck = { remove: [], wait: false }, stageClean = true, livekit = {} } = {}) {
  const events = [];
  const getUser = vi.fn(async (token) => token === 'session-me'
    ? { data: { user: { id: ME } }, error: null }
    : { data: { user: null }, error: { message: 'invalid JWT', status: 403 } });
  let joins = 0;
  const rpc = vi.fn(async (name, args) => {
    events.push(`rpc:${name}`);
    const pick = (value) => (typeof value === 'function' ? value(args) : value);
    if (name === 'live_join') {
      joins += 1;
      return { data: pick(joins > 1 && rejoin !== undefined ? rejoin : join), error: null };
    }
    if (name === 'live_stage_check') return { data: pick(stageCheck), error: null };
    if (name === 'live_stage_clean') return { data: pick(stageClean), error: null };
    return { data: null, error: { message: `unexpected ${name}` } };
  });
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    const method = String(url).slice(TWIRP.length);
    const call = { url: String(url), method, body: JSON.parse(init.body), headers: init.headers, signal: init.signal };
    calls.push(call);
    events.push(`twirp:${method}`);
    const route = livekit[method];
    const answer = typeof route === 'function' ? await route(call.body, call) : route;
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const handler = (env = ENV) => loadEdge('live-token', { auth: { getUser }, rpc }, undefined, { env, fetch });
  return { handler, getUser, rpc, fetch, calls, events };
}

const twirpError = (status, code) => new Response(JSON.stringify({ code, msg: 'stand-in' }), { status, headers: { 'Content-Type': 'application/json' } });
const ask = (body = { live_id: LIVE }, options = {}) => request(body, { token: 'session-me', ...options });

describe('live-token: who may ask', () => {
  it('answers 405 to anything but POST, before any login check', async () => {
    const w = world();
    for (const method of ['GET', 'PUT', 'OPTIONS']) {
      const response = await w.handler()(request(undefined, { method }));
      expect(response.status).toBe(405);
    }
    expect(w.getUser).not.toHaveBeenCalled();
  });

  it.each([undefined, 'forged-session', 'expired-session'])('refuses a missing, forged or expired login: %s', async (token) => {
    const w = world();
    const response = await w.handler()(request({ live_id: LIVE }, { token }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Please log in again.', reason: 'login' });
    expect(w.rpc).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('refuses a login header that is not a Bearer session', async () => {
    const w = world();
    const response = await w.handler()(request({ live_id: LIVE }, { headers: { Authorization: 'Basic session-me' } }));
    expect(response.status).toBe(401);
    expect(w.getUser).not.toHaveBeenCalled();
  });

  it('says "try again", not "log in again", when the login server is down', async () => {
    const w = world();
    w.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 } });
    expect((await w.handler()(ask())).status).toBe(503);
    w.getUser.mockRejectedValueOnce(new Error('socket hang up'));
    const response = await w.handler()(ask());
    expect(response.status).toBe(503);
    expect((await response.json()).reason).toBe('unavailable');
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it('never trusts an account id from the body: the ticket is always for the logged-in person', async () => {
    const w = world({ join: VIEWER });
    const response = await w.handler()(ask({ live_id: LIVE, account: OTHER, user_id: OTHER, identity: OTHER, sub: OTHER }));
    expect(response.status).toBe(200);
    expect(w.rpc).toHaveBeenCalledWith('live_join', { account: ME, live: LIVE });
    const body = await response.json();
    expect(body.identity).toBe(ME);
    expect(readTicket(body.token).claims.sub).toBe(ME);
  });
});

describe('live-token: the request', () => {
  it('refuses a body over 4 KB with 413, before asking the database', async () => {
    const w = world();
    const response = await w.handler()(ask(JSON.stringify({ live_id: LIVE, padding: 'x'.repeat(5000) })));
    expect(response.status).toBe(413);
    expect((await response.json()).reason).toBe('too_big');
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{"live_id":'],
    ['a list', JSON.stringify([LIVE])],
    ['no live_id', JSON.stringify({})],
    ['a live_id that is not a uuid', JSON.stringify({ live_id: 'live_123' })],
    ['a numeric live_id', JSON.stringify({ live_id: 42 })],
    ['an expected_user_id that is not a uuid', JSON.stringify({ live_id: LIVE, expected_user_id: 'me' })],
    ['an expected_user_id that is a number', JSON.stringify({ live_id: LIVE, expected_user_id: 7 })],
    ['an empty body', ''],
  ])('refuses %s with 400', async (_name, body) => {
    const w = world();
    const response = await w.handler()(ask(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Check the request and try again.', reason: 'bad_request' });
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it('answers 409 when the app expected a different account', async () => {
    const w = world();
    const response = await w.handler()(ask({ live_id: LIVE, expected_user_id: OTHER }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Your login changed – please log in again.', reason: 'login_changed' });
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it('accepts the expected account in any letter case, and no expected account at all', async () => {
    const w = world({ join: VIEWER });
    expect((await w.handler()(ask({ live_id: LIVE.toUpperCase(), expected_user_id: ME.toUpperCase() }))).status).toBe(200);
    expect(w.rpc).toHaveBeenCalledWith('live_join', { account: ME, live: LIVE });
    expect((await w.handler()(ask({ live_id: LIVE, expected_user_id: null }))).status).toBe(200);
  });
});

describe('live-token: set-up and the database answer', () => {
  it.each(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])('answers 503 not_set_up without %s, and asks nothing', async (missing) => {
    for (const value of [undefined, '', '   ']) {
      const w = world();
      const response = await w.handler({ ...ENV, [missing]: value })(ask());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Lives aren't set up yet.", reason: 'not_set_up' });
      expect(w.rpc).not.toHaveBeenCalled();
      expect(w.fetch).not.toHaveBeenCalled();
    }
  });

  it('treats an address that is not a LiveKit address as not set up', async () => {
    const w = world();
    const response = await w.handler({ ...ENV, LIVEKIT_URL: 'peekaboo-test.livekit.cloud' })(ask());
    expect(response.status).toBe(503);
    expect((await response.json()).reason).toBe('not_set_up');
  });

  it.each(Object.entries(WORDS))('a database "no" (%s) is a 403 with its own words, and no ticket', async (reason, words) => {
    const w = world({ join: { ok: false, reason } });
    const response = await w.handler()(ask());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: words, reason });
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('an unknown "no" from the database is still a no', async () => {
    const w = world({ join: { ok: false, reason: 'something_new' } });
    const response = await w.handler()(ask());
    expect(response.status).toBe(403);
    expect((await response.json()).reason).toBe('not_allowed');
  });

  it('answers 503 unavailable, with no ticket, when the database fails or answers nonsense', async () => {
    for (const answer of [
      { data: null, error: { message: 'function live_join does not exist; secret detail' } },
      { data: null, error: null },
      { data: [], error: null },
      { data: { ok: 'yes', role: 'host' }, error: null },
      { data: { ...HOST, role: 'owner' }, error: null },
      { data: { ...HOST, room: 'live_00000000-0000-4000-8000-000000000000' }, error: null },
      { data: { ...HOST, max_participants: null }, error: null },
      { data: { ...COHOST, stage_check: true, cohost_since: null }, error: null },
    ]) {
      const w = world();
      w.rpc.mockResolvedValueOnce(answer);
      const response = await w.handler()(ask());
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text).reason).toBe('unavailable');
      expect(text).not.toContain('secret detail');
      expect(text).not.toContain('token');
    }
    const w = world();
    w.rpc.mockRejectedValueOnce(new Error('connection refused'));
    expect((await w.handler()(ask())).status).toBe(503);
  });
});

describe('live-token: the host', () => {
  it('makes the room first, with its limits and a room-only server ticket, then a 10-minute ticket', async () => {
    const w = world({ join: HOST });
    const before = Math.floor(Date.now() / 1000);
    const response = await w.handler()(ask());
    expect(response.status).toBe(200);
    expect(w.events).toEqual(['rpc:live_join', 'twirp:CreateRoom']);

    const [create] = w.calls;
    expect(create.url).toBe(`${TWIRP}CreateRoom`);
    expect(create.headers['Content-Type']).toBe('application/json');
    expect(create.body).toEqual({ name: ROOM, emptyTimeout: 120, departureTimeout: 60, maxParticipants: 22 });
    const server = readTicket(create.headers.Authorization.replace(/^Bearer /, ''));
    expect(server.signed).toBe(true);
    expect(server.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(server.claims.iss).toBe(KEY);
    expect(server.claims).not.toHaveProperty('sub');
    expect(server.claims.exp - server.claims.nbf).toBe(60);
    expect(server.claims.video).toEqual({ room: ROOM, roomAdmin: true, roomCreate: true });

    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'identity', 'role', 'room', 'token', 'url']);
    expect(body).toMatchObject({ url: ENV.LIVEKIT_URL, room: ROOM, role: 'host', identity: ME });
    const ticket = readTicket(body.token);
    expect(ticket.signed).toBe(true);
    expect(readTicket(body.token, 'a-different-secret').signed).toBe(false);
    expect(ticket.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(Object.keys(ticket.claims).sort()).toEqual(['exp', 'iss', 'nbf', 'sub', 'video']);
    expect(ticket.claims).toMatchObject({ iss: KEY, sub: ME });
    expect(ticket.claims.nbf).toBeGreaterThanOrEqual(before);
    expect(ticket.claims.exp - ticket.claims.nbf).toBe(600);
    expect(body.expires_at).toBe(new Date(ticket.claims.exp * 1000).toISOString());
    expect(ticket.claims.video).toEqual({
      room: ROOM, roomJoin: true, canSubscribe: true, canPublish: true, canPublishSources: ['camera', 'microphone'],
      canPublishData: true, canUpdateOwnMetadata: false,
    });
    for (const grant of ['roomCreate', 'roomAdmin', 'roomList', 'roomRecord', 'recorder', 'agent', 'hidden']) {
      expect(ticket.claims.video).not.toHaveProperty(grant);
    }
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('always makes the room for the host, even if the database forgot to ask for it', async () => {
    const w = world({ join: { ...HOST, create_room: false } });
    expect((await w.handler()(ask())).status).toBe(200);
    expect(w.events).toEqual(['rpc:live_join', 'twirp:CreateRoom']);
  });

  it.each([
    ['a LiveKit error', () => twirpError(500, 'internal')],
    ['a wrong key', () => twirpError(401, 'unauthenticated')],
    ['a 404 from a wrong address', () => new Response('nothing here', { status: 404 })],
    ['no answer', () => new TypeError('fetch failed')],
  ])('gives the host no ticket when the room cannot be made (%s)', async (_name, answer) => {
    const w = world({ join: HOST, livekit: { CreateRoom: answer } });
    const response = await w.handler()(ask());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: "Lives aren't working right now – try again in a bit.", reason: 'unavailable' });
  });

  it('gives up on LiveKit after 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reached;
      const calling = new Promise((resolve) => { reached = resolve; });
      const w = world({
        join: HOST,
        livekit: {
          // LiveKit never answers; only the function's own 10-second timer can end the wait.
          CreateRoom: (_body, call) => {
            reached();
            return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('aborted'))));
          },
        },
      });
      let settled = false;
      const pending = w.handler()(ask()).then((response) => { settled = true; return response; });
      await calling;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(503);
      expect((await response.json()).reason).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns ws:// and https:// addresses into the right server address', async () => {
    for (const [url, base] of [
      ['ws://127.0.0.1:7880', 'http://127.0.0.1:7880'],
      ['https://peekaboo-test.livekit.cloud/', 'https://peekaboo-test.livekit.cloud'],
      ['  wss://peekaboo-test.livekit.cloud  ', 'https://peekaboo-test.livekit.cloud'],
    ]) {
      const w = world({ join: HOST });
      const response = await w.handler({ ...ENV, LIVEKIT_URL: url })(ask());
      expect(response.status).toBe(200);
      expect(w.fetch.mock.calls[0][0]).toBe(`${base}/twirp/livekit.RoomService/CreateRoom`);
      expect((await response.json()).url).toBe(url.trim());
    }
  });
});

describe('live-token: viewers and co-hosts', () => {
  it('gives a viewer a hidden, 1-minute ticket that can watch and send hearts but not video or sound', async () => {
    const w = world({ join: VIEWER });
    const response = await w.handler()(ask());
    expect(response.status).toBe(200);
    expect(w.fetch).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toMatchObject({ role: 'viewer', room: ROOM, identity: ME });
    const ticket = readTicket(body.token);
    expect(ticket.signed).toBe(true);
    expect(ticket.claims.exp - ticket.claims.nbf).toBe(60);
    expect(ticket.claims).not.toHaveProperty('name');
    expect(ticket.claims).not.toHaveProperty('metadata');
    expect(ticket.claims).not.toHaveProperty('attributes');
    expect(ticket.claims.video).toEqual({
      room: ROOM, roomJoin: true, canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: true,
      canUpdateOwnMetadata: false, hidden: true,
    });
  });

  it('writes every ticket in strict base64url, whatever its length', async () => {
    // Ids of 1–6 extra letters move the ticket's length through every remainder of 3.
    for (let extra = 1; extra <= 6; extra++) {
      const w = world({ join: VIEWER });
      w.getUser.mockResolvedValueOnce({ data: { user: { id: `${ME}${'a'.repeat(extra)}` } }, error: null });
      const ticket = readTicket((await (await w.handler()(ask())).json()).token);
      expect(ticket.signed).toBe(true);
      expect(ticket.claims.sub).toBe(`${ME}${'a'.repeat(extra)}`);
    }
  });

  it('never makes a ticket longer than the role allows, whatever the database says', async () => {
    const w = world({ join: { ...VIEWER, ttl: 3600 } });
    const viewer = readTicket((await (await w.handler()(ask())).json()).token);
    expect(viewer.claims.exp - viewer.claims.nbf).toBe(60);
    const h = world({ join: { ...HOST, ttl: 86_400 } });
    const host = readTicket((await (await h.handler()(ask())).json()).token);
    expect(host.claims.exp - host.claims.nbf).toBe(600);
  });

  it('gives a co-host whose stage is already clean a 10-minute camera ticket with no LiveKit calls', async () => {
    const w = world({ join: COHOST });
    const response = await w.handler()(ask());
    expect(response.status).toBe(200);
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.events).toEqual(['rpc:live_join']);
    const ticket = readTicket((await response.json()).token);
    expect(ticket.claims.exp - ticket.claims.nbf).toBe(600);
    expect(ticket.claims.video).toMatchObject({ canPublish: true, canPublishSources: ['camera', 'microphone'] });
    expect(ticket.claims.video).not.toHaveProperty('hidden');
  });
});

describe('live-token: a new co-host clears the stage first', () => {
  const listed = { participants: [{ identity: OTHER }, { identity: PAUSED }, { identity: STRANGER }, { identity: OTHER }] };

  it('lists the room, asks the database, removes the paused (soft) and the not-allowed (hard), cleans, then makes the ticket', async () => {
    const before = Math.floor(Date.now() / 1000);
    const w = world({
      join: NEW_COHOST,
      livekit: { ListParticipants: listed },
      stageCheck: { remove: [{ identity: PAUSED, soft: true }, { identity: STRANGER, soft: false }], wait: false },
    });
    const response = await w.handler()(ask());
    expect(response.status).toBe(200);
    expect(w.events).toEqual([
      'rpc:live_join', 'twirp:ListParticipants', 'rpc:live_stage_check',
      'twirp:RemoveParticipant', 'twirp:RemoveParticipant', 'rpc:live_stage_clean',
    ]);
    expect(w.calls[0].body).toEqual({ room: ROOM });
    expect(w.rpc).toHaveBeenCalledWith('live_stage_check', { live: LIVE, identities: [OTHER, PAUSED, STRANGER] });
    const removals = w.calls.filter((call) => call.method === 'RemoveParticipant').map((call) => call.body);
    const soft = removals.find((body) => body.identity === PAUSED);
    expect(Object.keys(soft).sort()).toEqual(['identity', 'revokeTokenTs', 'room']);
    expect(typeof soft.revokeTokenTs).toBe('string');
    expect(Number(soft.revokeTokenTs)).toBeGreaterThanOrEqual(before);
    expect(Number(soft.revokeTokenTs)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(removals.find((body) => body.identity === STRANGER)).toEqual({ room: ROOM, identity: STRANGER });
    for (const call of w.calls) {
      const server = readTicket(call.headers.Authorization.replace(/^Bearer /, ''));
      expect(server.signed).toBe(true);
      expect(server.claims.video).toEqual({ room: ROOM, roomAdmin: true, roomCreate: true });
    }
    expect(w.rpc).toHaveBeenCalledWith('live_stage_clean', { live: LIVE, since: SINCE });
    const body = await response.json();
    expect(body.role).toBe('cohost');
    expect(readTicket(body.token).claims.video.canPublish).toBe(true);
  });

  it('counts a person LiveKit no longer has as already gone, and an empty room as clean', async () => {
    const w = world({
      join: NEW_COHOST,
      livekit: { ListParticipants: listed, RemoveParticipant: () => twirpError(404, 'not_found') },
      stageCheck: { remove: [{ identity: STRANGER, soft: false }], wait: false },
    });
    expect((await w.handler()(ask())).status).toBe(200);
    const empty = world({ join: NEW_COHOST, livekit: { ListParticipants: () => twirpError(404, 'not_found') } });
    expect((await empty.handler()(ask())).status).toBe(200);
    expect(empty.rpc).toHaveBeenCalledWith('live_stage_check', { live: LIVE, identities: [] });
  });

  it('tries a soft removal once more without revokeTokenTs if LiveKit doesn\'t know it', async () => {
    let tries = 0;
    const w = world({
      join: NEW_COHOST,
      livekit: { ListParticipants: listed, RemoveParticipant: () => (++tries === 1 ? twirpError(400, 'invalid_argument') : {}) },
      stageCheck: { remove: [{ identity: PAUSED, soft: true }], wait: false },
    });
    expect((await w.handler()(ask())).status).toBe(200);
    const bodies = w.calls.filter((call) => call.method === 'RemoveParticipant').map((call) => call.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('revokeTokenTs');
    expect(bodies[1]).toEqual({ room: ROOM, identity: PAUSED });
  });

  it.each([
    ['a removal fails', { RemoveParticipant: () => twirpError(500, 'internal') }, { remove: [{ identity: PAUSED, soft: true }], wait: false }],
    ['a removal times out', { RemoveParticipant: () => new Error('aborted') }, { remove: [{ identity: PAUSED, soft: true }], wait: false }],
    ['someone could still join with a fresh ticket', {}, { remove: [], wait: true }],
    ['the database answer is unclear', {}, { remove: [], wait: 'maybe' }],
    ['the database answer is broken', {}, { remove: 'everyone', wait: false }],
    ['a removal entry is broken', {}, { remove: [{ soft: true }], wait: false }],
    ['the room cannot be listed', { ListParticipants: () => twirpError(503, 'unavailable') }, { remove: [], wait: false }],
  ])('answers 503 stage_wait, with no ticket and no clean mark, when %s', async (_name, livekit, stageCheck) => {
    const w = world({ join: NEW_COHOST, livekit: { ListParticipants: listed, ...livekit }, stageCheck });
    const response = await w.handler()(ask());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: 'Getting the stage ready…', reason: 'stage_wait' });
    expect(w.rpc).not.toHaveBeenCalledWith('live_stage_clean', expect.anything());
  });

  it('still removes the listed people when it has to wait', async () => {
    const w = world({ join: NEW_COHOST, livekit: { ListParticipants: listed }, stageCheck: { remove: [{ identity: PAUSED, soft: true }], wait: true } });
    expect((await w.handler()(ask())).status).toBe(503);
    expect(w.calls.filter((call) => call.method === 'RemoveParticipant')).toHaveLength(1);
  });

  it('answers 503 stage_wait when the database check itself fails', async () => {
    const w = world({ join: NEW_COHOST, livekit: { ListParticipants: listed } });
    w.rpc.mockImplementation(async (name) => {
      if (name === 'live_join') return { data: NEW_COHOST, error: null };
      return { data: null, error: { message: 'deadlock detected' } };
    });
    const response = await w.handler()(ask());
    expect(response.status).toBe(503);
    expect((await response.json()).reason).toBe('stage_wait');
  });

  it('when the co-host changed meanwhile, answers with the reason a fresh check gives', async () => {
    const w = world({ join: NEW_COHOST, stageClean: false, rejoin: { ok: false, reason: 'ended' }, livekit: { ListParticipants: listed } });
    const response = await w.handler()(ask());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: WORDS.ended, reason: 'ended' });
    expect(w.rpc.mock.calls.filter(([name]) => name === 'live_join')).toHaveLength(2);
  });

  it('when the co-host changed meanwhile but the person may still be there, asks the app to try again', async () => {
    const w = world({ join: NEW_COHOST, stageClean: false, rejoin: VIEWER, livekit: { ListParticipants: listed } });
    const response = await w.handler()(ask());
    expect(response.status).toBe(503);
    expect((await response.json()).reason).toBe('stage_wait');
  });

  it('never holds up a viewer or the host with the stage check', async () => {
    for (const join of [{ ...VIEWER, stage_check: true }, { ...HOST, stage_check: true }]) {
      const w = world({ join });
      expect((await w.handler()(ask())).status).toBe(200);
      expect(w.calls.map((call) => call.method)).not.toContain('ListParticipants');
      expect(w.rpc).not.toHaveBeenCalledWith('live_stage_check', expect.anything());
    }
  });
});

describe('live-token: secrets stay secret', () => {
  it('never writes a ticket, the secret or the login to the logs', async () => {
    const logs = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    }
    const ok = world({ join: HOST });
    const token = (await (await ok.handler()(ask())).json()).token;
    const bad = world({ join: HOST, livekit: { CreateRoom: () => twirpError(401, 'unauthenticated') } });
    await bad.handler()(ask());
    const text = logs.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(token.split('.')[2]);
    expect(text).not.toContain('session-me');
  });
});
