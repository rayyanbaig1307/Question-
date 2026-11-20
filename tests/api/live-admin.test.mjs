// Live admin (supabase/functions/live-admin). Runs the real handler with a stand-in database (admin.rpc: the key
// check, live_jobs_claim, live_audit, live_jobs_finish) and a stand-in LiveKit (fetch). Each LiveKit call's
// server ticket is checked with node:crypto's own HMAC. Invented users and rooms only; nothing here talks to
// LiveKit or a live project.
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEdge, request } from './edgeHarness.mjs';

const VAULT_KEY = 'test-live-admin-key';
const KEY = 'APItestkey';
const SECRET = 'test-livekit-secret-that-is-long-enough-0123';
const ENV = { LIVEKIT_URL: 'wss://peekaboo-test.livekit.cloud', LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET };
const TWIRP = 'https://peekaboo-test.livekit.cloud/twirp/livekit.RoomService/';
const ROOM = 'live_6b1f0c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
const ROOM2 = 'live_7c2a1d2f-3b4c-4d5e-9f0a-1b2c3d4e5f60';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const PERMISSION = {
  canSubscribe: true, canPublish: false, canPublishData: true, canPublishSources: [], hidden: true, canUpdateMetadata: false,
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const job = (id, action, fields = {}) => ({ job_id: id, action, room: ROOM, identity: null, soft: false, recheck: false, ...fields });

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

const twirpError = (status, code) => new Response(JSON.stringify({ code, msg: 'stand-in' }), { status, headers: { 'Content-Type': 'application/json' } });

// The stand-in world. `batches` are what live_jobs_claim hands out, one per call (then nothing).
// `livekit[Method]` answers a LiveKit call: an object (200 with it as JSON), a Response, an Error (thrown), or a
// function of (body, call) returning one of those.
function world({ batches = [], audit = { remove: [], delete_room: false }, livekit = {}, rpc: override } = {}) {
  const events = [];
  const queue = [...batches];
  const rpc = vi.fn(async (name, args) => {
    events.push(`rpc:${name}`);
    if (override) {
      const answer = await override(name, args);
      if (answer !== undefined) return answer;
    }
    if (name === 'live_admin_key_ok') return { data: args.given === VAULT_KEY, error: null };
    if (name === 'live_jobs_claim') return { data: queue.shift() ?? [], error: null };
    if (name === 'live_audit') return { data: typeof audit === 'function' ? audit(args) : audit, error: null };
    if (name === 'live_jobs_finish') return { data: null, error: null };
    return { data: null, error: { message: `unexpected ${name}` } };
  });
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    const method = String(url).slice(TWIRP.length);
    const call = { url: String(url), method, body: JSON.parse(init.body), headers: init.headers, signal: init.signal };
    calls.push(call);
    events.push(`twirp:${method}:${call.body.identity ?? call.body.room}`);
    const route = livekit[method];
    const answer = typeof route === 'function' ? await route(call.body, call) : route;
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const handler = (env = ENV) => loadEdge('live-admin', { rpc }, undefined, { env, fetch });
  const finishes = () => rpc.mock.calls.filter(([name]) => name === 'live_jobs_finish').map(([, args]) => args);
  return { handler, rpc, fetch, calls, events, finishes };
}

const poke = (headers = { 'x-live-key': VAULT_KEY }) => request({}, { headers });

describe('live-admin: who may call it', () => {
  it('answers 405 to anything but POST, before the key check', async () => {
    const w = world();
    const response = await w.handler()(request(undefined, { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', {}],
    ['an empty key', { 'x-live-key': '' }],
    ['a wrong key', { 'x-live-key': 'guess' }],
    ['a login instead of the key', { Authorization: 'Bearer some-user-session' }],
    ['a very long key', { 'x-live-key': 'k'.repeat(600) }],
  ])('refuses %s with 401 and takes no job', async (_name, headers) => {
    const w = world({ batches: [[job(1, 'remove', { identity: A })]] });
    const response = await w.handler()(poke(headers));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Not allowed' });
    expect(w.rpc).not.toHaveBeenCalledWith('live_jobs_claim', expect.anything());
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('refuses with 401 when the key check itself fails', async () => {
    for (const failure of [
      async (name) => (name === 'live_admin_key_ok' ? { data: null, error: { message: 'vault offline' } } : undefined),
      async (name) => { if (name === 'live_admin_key_ok') throw new Error('socket closed'); },
      async (name) => (name === 'live_admin_key_ok' ? { data: 'true', error: null } : undefined),
    ]) {
      const w = world({ batches: [[job(1, 'remove', { identity: A })]], rpc: failure });
      const response = await w.handler()(poke());
      expect(response.status).toBe(401);
      expect(w.rpc).not.toHaveBeenCalledWith('live_jobs_claim', expect.anything());
    }
  });

  it.each(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])('answers 503 without %s and takes no job (no tries used up)', async (missing) => {
    const w = world({ batches: [[job(1, 'remove', { identity: A })]] });
    const response = await w.handler({ ...ENV, [missing]: '' })(poke());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Lives aren't set up yet.", reason: 'not_set_up' });
    expect(w.rpc).toHaveBeenCalledWith('live_admin_key_ok', { given: VAULT_KEY });
    expect(w.rpc).not.toHaveBeenCalledWith('live_jobs_claim', expect.anything());
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('answers 200 with zeros, and reports nothing, when there are no jobs', async () => {
    const w = world();
    const response = await w.handler()(poke());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: 0, failed: 0, recheck: 0 });
    expect(w.rpc).toHaveBeenCalledWith('live_jobs_claim', { max_jobs: 25 });
    expect(w.finishes()).toEqual([]);
  });
});

describe('live-admin: each job', () => {
  it('signs every LiveKit call with a 60-second server ticket for just that room', async () => {
    // Room names of different lengths move the ticket's length through every remainder of 3.
    const w = world({
      batches: [[
        job(1, 'remove', { identity: A }), job(2, 'demote', { identity: B, room: ROOM2 }),
        job(3, 'remove', { identity: C, room: 'live_x' }), job(4, 'remove', { identity: C, room: 'live_xy' }),
        job(5, 'remove', { identity: C, room: 'live_xyz' }),
      ]],
    });
    const before = Math.floor(Date.now() / 1000);
    expect((await w.handler()(poke())).status).toBe(200);
    expect(w.calls).toHaveLength(5);
    for (const call of w.calls) {
      expect(call.url.startsWith(TWIRP)).toBe(true);
      expect(call.headers['Content-Type']).toBe('application/json');
      const ticket = readTicket(call.headers.Authorization.replace(/^Bearer /, ''));
      expect(ticket.signed).toBe(true);
      expect(readTicket(call.headers.Authorization.replace(/^Bearer /, ''), 'wrong-secret').signed).toBe(false);
      expect(ticket.header).toEqual({ alg: 'HS256', typ: 'JWT' });
      expect(Object.keys(ticket.claims).sort()).toEqual(['exp', 'iss', 'nbf', 'video']);
      expect(ticket.claims.iss).toBe(KEY);
      expect(ticket.claims.nbf).toBeGreaterThanOrEqual(before);
      expect(ticket.claims.exp - ticket.claims.nbf).toBe(60);
      expect(ticket.claims.video).toEqual({ room: call.body.room, roomAdmin: true, roomCreate: true });
    }
  });

  it('a hard removal sends no revokeTokenTs (LiveKit then cancels every earlier ticket)', async () => {
    const w = world({ batches: [[job(1, 'remove', { identity: A })]] });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 1, failed: 0, recheck: 0 });
    expect(w.calls.map((call) => [call.url, call.body])).toEqual([[`${TWIRP}RemoveParticipant`, { room: ROOM, identity: A }]]);
    expect(w.finishes()).toEqual([{ done: [1], failed: [], recheck: [] }]);
  });

  it('a soft removal sends revokeTokenTs = now, in seconds, as text', async () => {
    const w = world({ batches: [[job(1, 'remove', { identity: A, soft: true })]] });
    const before = Math.floor(Date.now() / 1000);
    await w.handler()(poke());
    const [call] = w.calls;
    expect(Object.keys(call.body).sort()).toEqual(['identity', 'revokeTokenTs', 'room']);
    expect(call.body).toMatchObject({ room: ROOM, identity: A });
    expect(call.body.revokeTokenTs).toMatch(/^\d+$/);
    expect(Number(call.body.revokeTokenTs)).toBeGreaterThanOrEqual(before);
    expect(Number(call.body.revokeTokenTs)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(w.finishes()).toEqual([{ done: [1], failed: [], recheck: [] }]);
  });

  it('tries a soft removal once more without revokeTokenTs when LiveKit answers invalid_argument', async () => {
    let tries = 0;
    const w = world({
      batches: [[job(1, 'remove', { identity: A, soft: true })]],
      livekit: { RemoveParticipant: () => (++tries === 1 ? twirpError(400, 'invalid_argument') : {}) },
    });
    await w.handler()(poke());
    expect(w.calls.map((call) => call.body)).toEqual([
      expect.objectContaining({ revokeTokenTs: expect.any(String) }),
      { room: ROOM, identity: A },
    ]);
    expect(w.finishes()).toEqual([{ done: [1], failed: [], recheck: [] }]);
  });

  it('never retries a hard removal or another error', async () => {
    const w = world({
      batches: [[job(1, 'remove', { identity: A }), job(2, 'remove', { identity: B, soft: true })]],
      livekit: { RemoveParticipant: (body) => (body.identity === A ? twirpError(400, 'invalid_argument') : twirpError(500, 'internal')) },
    });
    const response = await w.handler()(poke());
    expect(w.calls).toHaveLength(2);
    expect(await response.json()).toEqual({ done: 0, failed: 2, recheck: 0 });
    expect(w.finishes()[0].failed).toEqual(expect.arrayContaining([
      { id: 1, error: 'RemoveParticipant: 400 invalid_argument' },
      { id: 2, error: 'RemoveParticipant: 500 internal' },
    ]));
  });

  it('demotes a co-host with UpdateParticipant and the full viewer permissions (never RemoveParticipant)', async () => {
    const w = world({ batches: [[job(5, 'demote', { identity: B })]] });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 1, failed: 0, recheck: 0 });
    expect(w.calls.map((call) => [call.url, call.body])).toEqual([
      [`${TWIRP}UpdateParticipant`, { room: ROOM, identity: B, permission: PERMISSION }],
    ]);
  });

  it('closes a room: list → take everyone out for good → DeleteRoom, in that order', async () => {
    const w = world({
      batches: [[job(7, 'end_room')]],
      livekit: { ListParticipants: { participants: [{ identity: A, isPublisher: true }, { identity: B }, { identity: C, tracks: [{}] }] } },
    });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 1, failed: 0, recheck: 0 });
    const order = w.events.filter((event) => event.startsWith('twirp:'));
    expect(order[0]).toBe(`twirp:ListParticipants:${ROOM}`);
    expect(order.slice(1, 4).sort()).toEqual([`twirp:RemoveParticipant:${A}`, `twirp:RemoveParticipant:${B}`, `twirp:RemoveParticipant:${C}`]);
    expect(order[4]).toBe(`twirp:DeleteRoom:${ROOM}`);
    expect(w.calls[0].body).toEqual({ room: ROOM });
    for (const call of w.calls.filter((c) => c.method === 'RemoveParticipant')) {
      expect(call.body).not.toHaveProperty('revokeTokenTs');
      expect(Object.keys(call.body).sort()).toEqual(['identity', 'room']);
    }
    expect(w.calls.at(-1).body).toEqual({ room: ROOM });
  });

  it('a room LiveKit no longer has counts as closed', async () => {
    const w = world({
      batches: [[job(7, 'end_room')]],
      livekit: { ListParticipants: () => twirpError(404, 'not_found'), DeleteRoom: () => twirpError(404, 'not_found') },
    });
    expect(await (await w.handler()(poke())).json()).toEqual({ done: 1, failed: 0, recheck: 0 });
    expect(w.calls.map((call) => call.method)).toEqual(['ListParticipants', 'DeleteRoom']);
  });

  it.each([
    ['the listing fails', { ListParticipants: () => twirpError(500, 'internal') }, 'ListParticipants: 500 internal'],
    ['one removal fails', { RemoveParticipant: (body) => (body.identity === B ? twirpError(503, 'unavailable') : {}) }, 'RemoveParticipant: 503 unavailable'],
    ['closing the room fails', { DeleteRoom: () => new TypeError('fetch failed') }, 'DeleteRoom: network'],
  ])('closing a room fails (to be tried again) when %s – but the room is still closed', async (_name, livekit, error) => {
    const w = world({
      batches: [[job(7, 'end_room')]],
      livekit: { ListParticipants: { participants: [{ identity: A }, { identity: B }] }, ...livekit },
    });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 0, failed: 1, recheck: 0 });
    expect(w.finishes()).toEqual([{ done: [], failed: [{ id: 7, error }], recheck: [] }]);
    expect(w.calls.map((call) => call.method)).toContain('DeleteRoom');
  });

  it('audits a room: everyone listed goes to live_audit, publishers are isPublisher or anyone with tracks', async () => {
    const w = world({
      batches: [[job(9, 'audit')]],
      livekit: {
        ListParticipants: {
          participants: [
            { identity: A, isPublisher: true, tracks: [{ sid: 'TR_1' }] },
            { identity: B, tracks: [{ sid: 'TR_2' }] },
            { identity: C, permission: { hidden: true } },
            { identity: 'not-a-uuid', isPublisher: false, tracks: [] },
            { sid: 'PA_no_identity' },
          ],
        },
      },
      audit: { remove: [{ identity: B, soft: true }, { identity: 'not-a-uuid', soft: false }], delete_room: false },
    });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 1, failed: 0, recheck: 0 });
    expect(w.rpc).toHaveBeenCalledWith('live_audit', { room_name: ROOM, identities: [A, B, C, 'not-a-uuid'], publishers: [A, B] });
    const removals = w.calls.filter((call) => call.method === 'RemoveParticipant').map((call) => call.body);
    expect(removals).toHaveLength(2);
    expect(removals.find((body) => body.identity === B)).toHaveProperty('revokeTokenTs');
    expect(removals.find((body) => body.identity === 'not-a-uuid')).toEqual({ room: ROOM, identity: 'not-a-uuid' });
    expect(w.calls.map((call) => call.method)).not.toContain('DeleteRoom');
    // The database is asked before anyone is removed.
    expect(w.events.indexOf('rpc:live_audit')).toBeLessThan(w.events.findIndex((event) => event.startsWith('twirp:RemoveParticipant')));
  });

  it('closes an audited room only when the database says delete_room', async () => {
    const w = world({
      batches: [[job(9, 'audit')]],
      livekit: { ListParticipants: { participants: [{ identity: A }] } },
      audit: { remove: [{ identity: A, soft: false }], delete_room: true },
    });
    expect(await (await w.handler()(poke())).json()).toEqual({ done: 1, failed: 0, recheck: 0 });
    expect(w.calls.map((call) => call.method)).toEqual(['ListParticipants', 'RemoveParticipant', 'DeleteRoom']);
    expect(w.calls[2].body).toEqual({ room: ROOM });
  });

  it('an audit of a room LiveKit no longer has sends an empty list to the database', async () => {
    const w = world({ batches: [[job(9, 'audit', { room: 'live_selftest' })]], livekit: { ListParticipants: () => twirpError(404, 'not_found') } });
    expect(await (await w.handler()(poke())).json()).toEqual({ done: 1, failed: 0, recheck: 0 });
    expect(w.rpc).toHaveBeenCalledWith('live_audit', { room_name: 'live_selftest', identities: [], publishers: [] });
  });

  it('an audit fails (to be tried again) when LiveKit or the database fails, with the reason in last_error', async () => {
    const cases = [
      [{ livekit: { ListParticipants: () => twirpError(401, 'unauthenticated') } }, 'ListParticipants: 401 unauthenticated'],
      [{ rpc: async (name) => (name === 'live_audit' ? { data: null, error: { message: 'boom' } } : undefined) }, 'live_audit failed'],
      [{ audit: { remove: 'all', delete_room: false } }, 'live_audit answer'],
      [{ audit: { remove: [{ identity: A, soft: true }], delete_room: false }, livekit: { RemoveParticipant: () => twirpError(500, 'internal') } }, 'RemoveParticipant: 500 internal'],
    ];
    for (const [setup, error] of cases) {
      const livekit = { ListParticipants: { participants: [{ identity: A }] }, ...setup.livekit };
      const w = world({ ...setup, batches: [[job(9, 'audit')]], livekit });
      expect(await (await w.handler()(poke())).json()).toEqual({ done: 0, failed: 1, recheck: 0 });
      expect(w.finishes()).toEqual([{ done: [], failed: [{ id: 9, error }], recheck: [] }]);
    }
  });
});

describe('live-admin: "not found", failures and reporting back', () => {
  it('"not found" is done – except a removal the database wants re-checked, which goes in the recheck list', async () => {
    const w = world({
      batches: [[
        job(1, 'remove', { identity: A }),
        job(2, 'remove', { identity: B, soft: true, recheck: true }),
        job(3, 'remove', { identity: C, recheck: true }),
        job(4, 'demote', { identity: A, recheck: true }),
      ]],
      livekit: { RemoveParticipant: () => twirpError(404, 'not_found'), UpdateParticipant: () => twirpError(404, 'not_found') },
    });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 2, failed: 0, recheck: 2 });
    const [finish] = w.finishes();
    expect(finish.done.sort()).toEqual([1, 4]);
    expect(finish.recheck.sort()).toEqual([2, 3]);
    expect(finish.failed).toEqual([]);
  });

  it('a removal that worked is done even when a re-check was asked for', async () => {
    const w = world({ batches: [[job(2, 'remove', { identity: B, recheck: true })]] });
    expect(await (await w.handler()(poke())).json()).toEqual({ done: 1, failed: 0, recheck: 0 });
  });

  it.each([
    ['a network error', () => new TypeError('fetch failed'), 'RemoveParticipant: network'],
    ['a LiveKit error', () => twirpError(500, 'internal'), 'RemoveParticipant: 500 internal'],
    ['a wrong key', () => twirpError(401, 'unauthenticated'), 'RemoveParticipant: 401 unauthenticated'],
    ['a 404 that is not LiveKit\'s own "not found" (a wrong address)', () => new Response('<html>404</html>', { status: 404 }), 'RemoveParticipant: 404'],
  ])('%s counts as failed, never as done', async (_name, answer, error) => {
    const w = world({ batches: [[job(1, 'remove', { identity: A, recheck: true })]], livekit: { RemoveParticipant: answer } });
    expect(await (await w.handler()(poke())).json()).toEqual({ done: 0, failed: 1, recheck: 0 });
    expect(w.finishes()).toEqual([{ done: [], failed: [{ id: 1, error }], recheck: [] }]);
  });

  it('a call LiveKit never answers fails after 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let reached;
    const calling = new Promise((resolve) => { reached = resolve; });
    const w = world({
      batches: [[job(1, 'remove', { identity: A })]],
      livekit: {
        RemoveParticipant: (_body, call) => {
          reached();
          return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        },
      },
    });
    let settled = false;
    const pending = w.handler()(poke()).then((response) => { settled = true; return response; });
    await calling;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).json()).toEqual({ done: 0, failed: 1, recheck: 0 });
    expect(w.finishes()).toEqual([{ done: [], failed: [{ id: 1, error: 'RemoveParticipant: timeout' }], recheck: [] }]);
  });

  it('a job it can\'t read is reported failed (so it is not lost), and a job without an id is skipped', async () => {
    const w = world({
      batches: [[
        job(1, 'explode', { identity: A }),
        job(2, 'remove'), // no identity
        job(3, 'demote', { identity: '' }),
        job(4, 'remove', { identity: A, room: 'someone-elses-room' }),
        job(5, 'audit', { room: 'live_../../twirp' }),
        { action: 'remove', room: ROOM, identity: A },
        'nonsense',
        job(6, 'remove', { identity: B }),
      ]],
    });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 1, failed: 5, recheck: 0 });
    const [finish] = w.finishes();
    expect(finish.done).toEqual([6]);
    expect(finish.failed.map((f) => f.id).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(finish.failed.every((f) => f.error === 'bad job')).toBe(true);
    expect(w.calls.map((call) => call.body.identity)).toEqual([B]);
  });

  it('keeps taking batches until one comes back empty, and reports each batch', async () => {
    const w = world({
      batches: [
        [job(1, 'remove', { identity: A }), job(2, 'remove', { identity: B })],
        [job(3, 'demote', { identity: C })],
      ],
    });
    const response = await w.handler()(poke());
    expect(await response.json()).toEqual({ done: 3, failed: 0, recheck: 0 });
    expect(w.rpc.mock.calls.filter(([name]) => name === 'live_jobs_claim')).toHaveLength(3);
    expect(w.finishes().map((f) => f.done.sort())).toEqual([[1, 2], [3]]);
  });

  it('runs at most 5 jobs at the same time', async () => {
    let running = 0;
    let most = 0;
    const w = world({
      batches: [Array.from({ length: 12 }, (_, i) => job(i + 1, 'remove', { identity: `${A.slice(0, -2)}${String(i).padStart(2, '0')}` }))],
      livekit: {
        RemoveParticipant: async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
          return {};
        },
      },
    });
    expect(await (await w.handler()(poke())).json()).toEqual({ done: 12, failed: 0, recheck: 0 });
    expect(most).toBe(5);
  });

  it('stops asking for more jobs once 20 seconds have passed', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const w = world({
      batches: Array.from({ length: 10 }, (_, i) => [job(i + 1, 'remove', { identity: A })]),
      rpc: async (name) => { if (name === 'live_jobs_claim') clock += 6_000; },
    });
    const response = await w.handler()(poke());
    // Claims at 0, 6, 12 and 18 seconds; at 24 seconds it stops.
    expect(w.rpc.mock.calls.filter(([name]) => name === 'live_jobs_claim')).toHaveLength(4);
    expect(await response.json()).toEqual({ done: 4, failed: 0, recheck: 0 });
  });

  it('hands back jobs it had no time to start, as failed "out of time"', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const w = world({
      batches: [Array.from({ length: 7 }, (_, i) => job(i + 1, 'remove', { identity: A }))],
      // The first LiveKit answer takes 45 seconds.
      livekit: { RemoveParticipant: async () => { if (!w.calls.some((call) => call.late)) { w.calls[0].late = true; clock += 45_000; } return {}; } },
    });
    const response = await w.handler()(poke());
    // The first 5 start at once (before any answer); by the time one of them is free it is 45 seconds later, so
    // the other 2 are handed back.
    expect(await response.json()).toEqual({ done: 5, failed: 2, recheck: 0 });
    const [finish] = w.finishes();
    expect(finish.failed).toEqual([{ id: 6, error: 'out of time' }, { id: 7, error: 'out of time' }]);
    expect(w.rpc.mock.calls.filter(([name]) => name === 'live_jobs_claim')).toHaveLength(1);
  });

  it('answers 503 when the queue can\'t be read, and reports nothing', async () => {
    for (const failure of [
      async (name) => (name === 'live_jobs_claim' ? { data: null, error: { message: 'relation does not exist' } } : undefined),
      async (name) => { if (name === 'live_jobs_claim') throw new Error('socket closed'); },
      async (name) => (name === 'live_jobs_claim' ? { data: { job_id: 1 }, error: null } : undefined),
    ]) {
      const w = world({ rpc: failure });
      const response = await w.handler()(poke());
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ reason: 'unavailable', done: 0, failed: 0, recheck: 0 });
      expect(text).not.toContain('relation');
      expect(w.finishes()).toEqual([]);
      expect(w.fetch).not.toHaveBeenCalled();
    }
  });

  it('treats an empty answer (null) from the queue as "no jobs"', async () => {
    const w = world({ rpc: async (name) => (name === 'live_jobs_claim' ? { data: null, error: null } : undefined) });
    const response = await w.handler()(poke());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: 0, failed: 0, recheck: 0 });
  });

  it('answers 503, and stops, when the results can\'t be saved', async () => {
    const w = world({
      batches: [[job(1, 'remove', { identity: A })], [job(2, 'remove', { identity: B })]],
      rpc: async (name) => (name === 'live_jobs_finish' ? { data: null, error: { message: 'deadlock' } } : undefined),
    });
    const response = await w.handler()(poke());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'unavailable', done: 0 });
    expect(w.rpc.mock.calls.filter(([name]) => name === 'live_jobs_claim')).toHaveLength(1);
  });

  it('never writes a ticket or the secret to the logs', async () => {
    const logs = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    }
    const w = world({
      batches: [[job(1, 'remove', { identity: A }), job(2, 'end_room')]],
      livekit: { RemoveParticipant: () => twirpError(401, 'unauthenticated'), ListParticipants: () => twirpError(401, 'unauthenticated') },
    });
    await w.handler()(poke());
    const text = logs.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(VAULT_KEY);
    for (const call of w.calls) expect(text).not.toContain(call.headers.Authorization.split('.')[2]);
  });
});
