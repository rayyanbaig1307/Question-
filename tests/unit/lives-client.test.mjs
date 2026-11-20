import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { loadLibrary } from './libHarness.mjs';

// The lives data layer (src/lib/lives.ts): each call reaches the right server function with the right
// argument names (they must match the migration exactly), answers are read safely, the comment check says the
// very same sentences as the server, the live ticket's "no" keeps its reason, the live updates use their own
// channel per screen, and the 🔴 bubble follows the server's answer (kept 60 s, unknown = hidden).

const LIVE = '0b8f2a5e-3c1d-4e6f-8a9b-1c2d3e4f5a6b';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MIGRATION = resolve('supabase/migrations/20261226000000_livestreams.sql');

function load({ rpc = {}, invoke, maybe = true } = {}) {
  const calls = [];
  const channels = [];
  const removed = [];
  const queries = [];
  const supabase = {
    rpc: async (name, args) => {
      calls.push(args === undefined ? [name] : [name, args]);
      const answer = rpc[name];
      if (typeof answer === 'function') return answer(args);
      return answer ?? { data: null, error: null };
    },
    from: (table) => {
      const q = { table, steps: [] };
      queries.push(q);
      const chain = {
        select: (...a) => (q.steps.push(['select', ...a]), chain),
        eq: (...a) => (q.steps.push(['eq', ...a]), chain),
        is: (...a) => (q.steps.push(['is', ...a]), chain),
        order: (...a) => (q.steps.push(['order', ...a]), chain),
        limit: async (...a) => (q.steps.push(['limit', ...a]), { data: [{ id: 'c2' }, { id: 'c1' }], error: null }),
      };
      return chain;
    },
    functions: { invoke: invoke ?? (async () => ({ data: null, error: null })) },
    channel: (name) => {
      const ch = { name, bindings: [], subscribed: false };
      ch.on = (kind, filter, handler) => (ch.bindings.push({ kind, filter, handler }), ch);
      ch.subscribe = () => ((ch.subscribed = true), ch);
      channels.push(ch);
      return ch;
    },
    removeChannel: (ch) => { removed.push(ch.name); },
  };
  let brokenListener = null;
  const lives = loadLibrary('lives', {
    supabase,
    mocks: {
      './liveAccess': {
        liveMaybeAvailable: () => maybe,
        subscribeLiveBroken: (fn) => { brokenListener = fn; return () => { brokenListener = null; }; },
      },
      react: { useEffect: (fn) => { fn(); }, useSyncExternalStore: (_subscribe, get) => get() },
    },
  });
  return { lives, calls, channels, removed, queries, brokenListener: () => brokenListener };
}

afterEach(() => {
  vi.useRealTimers();
});

it('every call reaches its server function with the argument names the migration uses', async () => {
  const { lives, calls } = load({
    rpc: {
      start_live: { data: LIVE, error: null },
      invite_cohost: { data: OTHER, error: null },
      answer_cohost_invite: { data: { role: 'cohost' }, error: null },
      friends_live_now: { data: [{ live_id: LIVE, host_id: OTHER }, { live_id: 'bad' }], error: null },
      live_viewers_list: { data: [{ user_id: OTHER, can_cohost: true }], error: null },
    },
  });
  expect(await lives.startLive(ME)).toBe(LIVE);
  await lives.liveOnAir(LIVE);
  await lives.endLive(LIVE, 12.7);
  await lives.liveStatus(LIVE);
  await lives.livePing(LIVE);
  await lives.leaveLive(LIVE);
  expect((await lives.fetchFriendsLiveNow()).map((r) => r.live_id)).toEqual([LIVE]);
  expect(await lives.fetchLiveViewers(LIVE)).toEqual([{ user_id: OTHER, can_cohost: true }]);
  expect(await lives.inviteCohost(LIVE, OTHER)).toBe(OTHER);
  await lives.cancelCohostInvite(LIVE);
  expect(await lives.answerCohostInvite(OTHER, true)).toEqual({ role: 'cohost' });
  await lives.endCohost(LIVE);
  await lives.removeLiveViewer(LIVE, OTHER, true);
  await lives.sendLiveComment(LIVE, '  hi   there  ');
  await lives.deleteLiveComment(OTHER);
  await lives.setLiveComments(LIVE, false);
  await lives.fetchLiveState();
  expect(JSON.parse(JSON.stringify(calls))).toEqual([
    ['start_live', { expected_user_id: ME }],
    ['live_on_air', { live: LIVE }],
    ['end_live', { live: LIVE, heart_count: 12 }],
    ['live_status', { live: LIVE }],
    ['live_ping', { live: LIVE }],
    ['leave_live', { live: LIVE }],
    ['friends_live_now'],
    ['live_viewers_list', { live: LIVE }],
    ['invite_cohost', { live: LIVE, guest: OTHER }],
    ['cancel_cohost_invite', { live: LIVE }],
    ['answer_cohost_invite', { invite: OTHER, accept: true }],
    ['end_cohost', { live: LIVE }],
    ['remove_live_viewer', { live: LIVE, viewer: OTHER, also_block: true }],
    ['send_live_comment', { live: LIVE, comment: 'hi there' }],
    ['delete_live_comment', { comment_id: OTHER }],
    ['set_live_comments', { live: LIVE, turn_on: false }],
    ['live_state'],
  ]);
  // Each one exists in the migration with exactly these argument names.
  if (existsSync(MIGRATION)) {
    const sql = readFileSync(MIGRATION, 'utf8');
    for (const [name, args] of calls) {
      const match = sql.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)`));
      expect(match, name).toBeTruthy();
      const params = match[1].split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
      for (const key of Object.keys(args ?? {})) expect(params, `${name}.${key}`).toContain(key);
    }
  }
});

it('hearts for the summary are a whole number from 0 to 1,000,000', async () => {
  const { lives, calls } = load({ rpc: { end_live: { data: { seconds: 61, viewers: 3, comments: 9, hearts: 5, ended_reason: 'host' }, error: null } } });
  expect(await lives.endLive(LIVE, 5)).toEqual({ seconds: 61, viewers: 3, comments: 9, hearts: 5, ended_reason: 'host' });
  await lives.endLive(LIVE, -4);
  await lives.endLive(LIVE, 5e9);
  await lives.endLive(LIVE, Number.NaN);
  expect(calls.map(([, a]) => a.heart_count)).toEqual([5, 0, 1_000_000, 0]);
});

it('a server "no" keeps its words and its reason code (hint)', async () => {
  const { lives } = load({ rpc: { start_live: { data: null, error: { message: "You've gone live 3 times today – try again tomorrow", hint: 'live_daily_limit', code: '23514' } } } });
  const error = await lives.startLive(ME).catch((e) => e);
  expect(error.message).toBe("You've gone live 3 times today – try again tomorrow");
  expect(error.hint).toBe('live_daily_limit');
  expect(error.code).toBe('23514');
  expect(lives.liveHint(error)).toBe('live_daily_limit');
  expect(lives.liveHint(new Error('x'))).toBe(null);
  // A start that doesn't answer with a live id is a failure too.
  const odd = load({ rpc: { start_live: { data: 'not-an-id', error: null } } });
  await expect(odd.lives.startLive(ME)).rejects.toThrow("Couldn't go live – try again.");
});

it('status answers are read safely; a paused or removed viewer never sees the co-host or the invite', async () => {
  const { lives } = load();
  const live = lives.readLiveStatus({
    status: 'live', role: 'viewer', live_id: LIVE,
    host: { id: OTHER, username: 'sam', display_name: 'Sam', avatar_path: null },
    cohost: { id: ME, username: 'ayaan', display_name: 'Ayaan', avatar_path: 'a.jpg' },
    started_at: 't0', on_air_at: 't1', ends_at: 't2', comments_on: false, viewers: 4,
    invite: { id: OTHER, expires_at: 't3' }, ended_reason: null, empty_ends_at: null,
  }, LIVE);
  expect(live).toMatchObject({ status: 'live', role: 'viewer', cohost: { id: ME }, viewers: 4, comments_on: false, invite: { id: OTHER } });
  for (const status of ['paused', 'removed', 'ended']) {
    const s = lives.readLiveStatus({ status, role: 'viewer', cohost: { id: ME }, viewers: 9, invite: { id: OTHER, expires_at: 'x' }, host: { id: OTHER } }, LIVE);
    expect(s, status).toMatchObject({ status, role: null, cohost: null, viewers: 0, invite: null, host: { id: OTHER } });
  }
  expect(lives.readLiveStatus(null, LIVE)).toMatchObject({ status: 'not_allowed', role: null, live_id: LIVE, host: null });
  expect(lives.readLiveStatus({ status: 'weird' }, LIVE).status).toBe('not_allowed');
  expect(lives.readLiveStatus({ status: 'ended', ended_reason: 'reports' }, LIVE).ended_reason).toBe('reports');
  expect(lives.readLiveStatus({ status: 'ended', ended_reason: 'made-up' }, LIVE).ended_reason).toBe(null);
});

it('the comment check says the very same sentences as the server, in the same order', () => {
  const { lives } = load();
  const words = lives.LIVE_COMMENT_WORDS;
  expect(lives.checkLiveComment('nice one 🔥')).toBe(null);
  expect(lives.checkLiveComment('   ')).toBe(words.size);
  expect(lives.checkLiveComment('a'.repeat(151))).toBe(words.size);
  const long = 'Peekaboo lives are fun to watch with my friends! '.repeat(4).slice(0, 150);
  expect(lives.checkLiveComment(`  ${long}  `)).toBe(null);
  expect(lives.checkLiveComment(`${long}x`)).toBe(words.size);
  // Emoji count as one character each (like the server's char_length).
  expect(lives.checkLiveComment('😀'.repeat(150))).toBe(null);
  expect(lives.checkLiveComment('go kill yourself')).toBe(words.harm);
  expect(lives.checkLiveComment('check out www.spam-site.com')).toBe(words.spam);
  expect(lives.tidyLiveComment('  hi \n\n  there ')).toBe('hi there');
  expect(words.word).toBe("That word isn't allowed on Peekaboo.");
  // The same words as the migration (character for character).
  const sql = readFileSync(MIGRATION, 'utf8');
  const server = {};
  for (const [, key, text] of sql.matchAll(/when 'live_comments?_(\w+)' then message := '((?:[^']|'')*)'/g)) server[key] = text.replace(/''/g, "'");
  expect(server.off).toBe(words.off);
  for (const key of ['size', 'harm', 'sexual', 'hate', 'spam', 'slow', 'same', 'limit', 'busy']) expect(words[key], key).toBe(server[key]);
  expect(sql).toMatch(/when 'live_comment_word' then message := private\.word_filter_message\('content'\)/);
});

it('the live ticket: the right request, and every kind of "no" keeps its reason', async () => {
  const sent = [];
  const reply = (status, body) => ({ data: null, error: { name: 'FunctionsHttpError', context: { status, json: async () => body } } });
  const answers = [
    { data: { url: 'wss://peekaboo.livekit.cloud', token: 'jwt', room: `live_${LIVE}`, role: 'viewer', identity: ME, expires_at: 'iso' }, error: null },
    reply(403, { error: 'This live is full right now – try again in a bit.', reason: 'full' }),
    reply(503, { error: 'Getting the stage ready…', reason: 'stage_wait' }),
    reply(401, 'not json'),
    reply(502, null),
    { data: null, error: { name: 'FunctionsFetchError', context: {} } },
    { data: { url: 'http://insecure', token: 'jwt', room: 'r', role: 'viewer', identity: ME }, error: null },
    { data: { url: 'wss://x', token: 'jwt', room: 'r', role: 'admin', identity: ME }, error: null },
  ];
  const { lives } = load({
    invoke: async (name, options) => {
      sent.push([name, JSON.parse(JSON.stringify(options))]);
      const next = answers.shift();
      if (!next) throw new Error('offline');
      return next;
    },
  });
  expect(await lives.getLiveToken(LIVE, ME)).toEqual({ ok: true, url: 'wss://peekaboo.livekit.cloud', token: 'jwt', room: `live_${LIVE}`, role: 'viewer', identity: ME, expires_at: 'iso' });
  expect(sent[0]).toEqual(['live-token', { method: 'POST', body: { live_id: LIVE, expected_user_id: ME }, timeout: 15000 }]);
  expect(await lives.getLiveToken(LIVE, ME)).toEqual({ ok: false, message: 'This live is full right now – try again in a bit.', reason: 'full', status: 403 });
  expect(await lives.getLiveToken(LIVE, ME)).toMatchObject({ ok: false, reason: 'stage_wait', status: 503 });
  expect(await lives.getLiveToken(LIVE, ME)).toEqual({ ok: false, message: 'Please log in again.', reason: 'login', status: 401 });
  expect(await lives.getLiveToken(LIVE, ME)).toEqual({ ok: false, message: "Lives aren't working right now – try again in a bit.", reason: 'unavailable', status: 502 });
  expect(await lives.getLiveToken(LIVE, ME)).toMatchObject({ ok: false, reason: 'network', status: null });
  expect(await lives.getLiveToken(LIVE, ME)).toMatchObject({ ok: false, reason: 'unavailable' }); // not a wss:// address
  expect(await lives.getLiveToken(LIVE, ME)).toMatchObject({ ok: false, reason: 'unavailable' }); // not a real role
  expect(await lives.getLiveToken(LIVE, null)).toMatchObject({ ok: false, reason: 'network' }); // the call itself threw
  expect(sent.at(-1)[1].body).toEqual({ live_id: LIVE });
  // A made-up live id (from a link) never reaches the server.
  const before = sent.length;
  expect(await lives.getLiveToken('../../etc', ME)).toMatchObject({ ok: false, reason: 'not_allowed' });
  expect(sent).toHaveLength(before);
});

it('comments: the newest 50, newest first, deleted ones left out', async () => {
  const { lives, queries } = load();
  expect((await lives.fetchLiveComments(LIVE)).map((c) => c.id)).toEqual(['c2', 'c1']);
  expect(JSON.parse(JSON.stringify(queries[0]))).toEqual({
    table: 'live_comments',
    steps: [['select', '*'], ['eq', 'live_id', LIVE], ['is', 'deleted_at', null], ['order', 'created_at', { ascending: false }], ['limit', 50]],
  });
  expect(await lives.fetchLiveComments('nope')).toEqual([]);
});

it('live updates: one channel per screen with its own name, the right filters, and only this live\'s invites', () => {
  const { lives, channels, removed } = load();
  const got = [];
  const stop = lives.listenToLive(LIVE, ME, {
    onComment: (c) => got.push(['comment', c.id]),
    onCommentGone: (id) => got.push(['gone', id]),
    onInvite: (i) => got.push(['invite', i.id]),
    onInviteChange: (i) => got.push(['change', i.id, i.answer]),
  });
  const again = lives.listenToLive(LIVE, ME, {});
  expect(channels.map((c) => c.name)).toEqual([`live-${LIVE}-1`, `live-${LIVE}-2`]);
  const ch = channels[0];
  expect(ch.subscribed).toBe(true);
  expect(ch.bindings.map((b) => [b.kind, b.filter.event, b.filter.table, b.filter.filter])).toEqual([
    ['postgres_changes', 'INSERT', 'live_comments', `live_id=eq.${LIVE}`],
    ['postgres_changes', 'UPDATE', 'live_comments', `live_id=eq.${LIVE}`],
    ['postgres_changes', 'UPDATE', 'live_invites', `live_id=eq.${LIVE}`],
    ['postgres_changes', 'INSERT', 'live_invites', `guest_id=eq.${ME}`],
  ]);
  const [newComment, changedComment, changedInvite, newInvite] = ch.bindings.map((b) => b.handler);
  newComment({ new: { id: 'c1', deleted_at: null } });
  changedComment({ new: { id: 'c1', deleted_at: 'now' } });
  changedComment({ new: { id: 'c2', deleted_at: null } }); // an edit that isn't a delete: nothing
  changedInvite({ new: { id: 'i1', answer: 'declined' } });
  newInvite({ new: { id: 'i2', live_id: LIVE, guest_id: ME } });
  newInvite({ new: { id: 'i3', live_id: OTHER, guest_id: ME } }); // another live's invite: not here
  expect(got).toEqual([['comment', 'c1'], ['gone', 'c1'], ['change', 'i1', 'declined'], ['invite', 'i2']]);
  stop();
  again();
  expect(removed).toEqual([`live-${LIVE}-1`, `live-${LIVE}-2`]);
  // A made-up id makes no channel at all.
  lives.listenToLive('x', ME, {})();
  expect(channels).toHaveLength(2);
});

it('the 🔴 bubble: hidden until the server answers, hidden for off/testers/banned/restricted, kept for 60 s', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
  let why = null;
  const { lives, calls } = load({ rpc: { live_state: () => ({ data: { can_go_live: why === null, why_not: why, max_minutes: 60, lives_left_today: 3, rules_accepted: true }, error: null }) } });
  expect(lives.liveBubbleShown()).toBe(false); // unknown = hidden
  expect(lives.useLiveBubble()).toBe(false); // asks the server
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([['live_state']]);
  expect(lives.liveBubbleShown()).toBe(true);
  // Asked again only after 60 s.
  lives.refreshLiveBubble();
  expect(calls).toHaveLength(1);
  for (const [reason, shown] of [['testers', false], ['off', false], ['banned', false], ['restricted', false], ['rules', true], ['birthday', true], ['daily_limit', true], ['busy', true], ['no_friends', true]]) {
    why = reason;
    await vi.advanceTimersByTimeAsync(60_001);
    lives.refreshLiveBubble();
    await vi.advanceTimersByTimeAsync(0);
    expect(lives.liveBubbleShown(), reason).toBe(shown);
  }
  // Fetching the state anywhere (the Go live sheet) updates the bubble at once.
  why = 'testers';
  await lives.fetchLiveState();
  expect(lives.liveBubbleShown()).toBe(false);
  why = null;
  await lives.fetchLiveState();
  expect(lives.liveBubbleShown()).toBe(true);
  lives.forgetLiveState();
  expect(lives.liveBubbleShown()).toBe(false);
});

it('the 🔴 bubble never shows (or asks the server) where lives can\'t run', async () => {
  const { lives, calls } = load({ maybe: false, rpc: { live_state: { data: { can_go_live: true, why_not: null }, error: null } } });
  expect(lives.useLiveBubble()).toBe(false);
  lives.refreshLiveBubble();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toEqual([]);
  await lives.fetchLiveState();
  expect(lives.liveBubbleShown()).toBe(false);
});

it('a server answer without a reason never counts as "you can go live"', async () => {
  const { lives } = load({ rpc: { live_state: { data: { can_go_live: false }, error: null } } });
  expect(await lives.fetchLiveState()).toMatchObject({ can_go_live: false, why_not: 'off' });
  const odd = load({ rpc: { live_state: { data: { can_go_live: true, why_not: 'busy' }, error: null } } });
  expect(await odd.lives.fetchLiveState()).toMatchObject({ can_go_live: false, why_not: 'busy' });
});

it('ending in the background: each try gives up after 8 s, two more tries, never throws', async () => {
  vi.useFakeTimers();
  let tries = 0;
  const { lives } = load({ rpc: { end_live: () => { tries++; return new Promise(() => {}); } } });
  let result = 'pending';
  lives.endLiveInBackground(LIVE, 3).then((r) => { result = r; });
  await vi.advanceTimersByTimeAsync(8000 * 3 + 10);
  expect(tries).toBe(3);
  expect(result).toBe(null);
  // A try that answers wins.
  let n = 0;
  const ok = load({ rpc: { end_live: async () => (++n === 1 ? { data: null, error: { message: 'boom' } } : { data: { seconds: 5, viewers: 0, comments: 0, hearts: 3, ended_reason: 'host' }, error: null }) } });
  const summary = ok.lives.endLiveInBackground(LIVE, 3);
  await vi.advanceTimersByTimeAsync(0);
  expect(await summary).toEqual({ seconds: 5, viewers: 0, comments: 0, hearts: 3, ended_reason: 'host' });
});
