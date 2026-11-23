import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backend } from './outboxHarness.mjs';

// The outbox (src/lib/outbox.ts): every send goes out in the background, never twice, in the right order.
// The owner's 22 Nov drop: the peek's insert was saved (201 on the server) but the phone never got the answer,
// so the button spun forever and a second tap would have sent a second copy.

// Midday (on the phone's own clock), so a test that moves the clock on by a few hours stays on the same day (a drop
// or dare post is only ever posted on its own day).
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 22, 12, 0));
});
afterEach(() => vi.useRealTimers());

const photo = { kind: 'photo', uri: 'file:///photo.jpg' };
const settle = () => vi.advanceTimersByTimeAsync(0);

async function setup(options) {
  const b = backend(options);
  const outbox = b.load('outbox');
  await settle(); // the login is known
  return { b, outbox };
}

it('(a) a lost answer: the retry looks the peek up by id and finds it – one row, one upload, sent', async () => {
  const { b, outbox } = await setup();
  let inserts = 0;
  b.rules.insert = () => (++inserts === 1 ? 'lost' : 'ok');
  const key = outbox.sendLater('A', 'friend:B', { kind: 'peek', friendIds: ['B'] }, { capture: photo });
  const done = outbox.whenSent(key);
  await vi.advanceTimersByTimeAsync(1000);
  const job = await done;
  expect(job.state).toBe('sent');
  expect(b.db.messages).toHaveLength(1);
  expect(b.db.messages[0]).toMatchObject({ id: job.rowIds[0], sender_id: 'A', recipient_id: 'B', kind: 'snap' });
  expect(b.uploads()).toHaveLength(1);
  expect(b.inserts('messages')).toHaveLength(1);
  // The retry looked first.
  expect(b.log.some((entry) => entry[0] === 'select' && entry[1] === 'messages')).toBe(true);
});

it('(b) an unclear failure never deletes the files', async () => {
  const { b, outbox } = await setup();
  b.rules.insert = () => 'noanswer';
  const key = outbox.sendLater('A', 'friend:B', { kind: 'peek', friendIds: ['B'] }, { capture: photo });
  const done = outbox.whenSent(key);
  await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000);
  const job = await done;
  expect(job.state).toBe('failed');
  expect(job.final).toBe(false);
  expect(job.error).toBe('No connection – tap to try again');
  expect(b.inserts('messages')).toHaveLength(4);
  expect(b.log.filter((entry) => entry[0] === 'remove')).toEqual([]);
  expect(b.files.size).toBe(1);
});

it('(c) a clear refusal after an unclear try: it looks first, finds the row, and it counts as sent', async () => {
  const { b, outbox } = await setup();
  let inserts = 0;
  b.rules.insert = () => (++inserts === 1 ? 'lost' : { error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 });
  const key = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'hi' });
  const done = outbox.whenSent(key);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await done).state).toBe('sent');
  expect(b.db.messages).toHaveLength(1);
  expect(inserts).toBe(1);
});

it('(d) once the files are uploaded, trying again never uploads them again', async () => {
  const { b, outbox } = await setup();
  let fail = true;
  b.rules.insert = () => (fail ? 'noanswer' : 'ok');
  const key = outbox.sendLater('A', 'group:g1', { kind: 'groupMedia', groupId: 'g1', snap: false }, { capture: { kind: 'video', uri: 'file:///clip.mp4', overlayUri: 'file:///layer.png' } });
  const first = outbox.whenSent(key);
  await vi.advanceTimersByTimeAsync(12_000);
  expect((await first).state).toBe('failed');
  const uploadsBefore = b.uploads().length;
  fail = false;
  outbox.retry(key);
  const job = await outbox.whenSent(key);
  expect(job.state).toBe('sent');
  expect(b.uploads()).toHaveLength(uploadsBefore);
  expect(b.db.group_messages).toHaveLength(1);
  expect(b.db.group_messages[0]).toMatchObject({ group_id: 'g1', kind: 'video' });
});

it('(e) a drop and a friend: the post is saved first, then the copy to snaps/ and the peek', async () => {
  const { b, outbox } = await setup();
  b.files.set('A/posts/early.jpg', true);
  b.files.set('A/blurs/early.jpg', true);
  const fields = { media_path: 'A/posts/early.jpg', media_type: 'photo', poster_path: null, overlay_path: null };
  const prepared = {
    key: 'p1', owner: 'A', uri: 'file:///photo.jpg', folder: 'posts', capture: photo, ready: Promise.resolve(photo),
    paths: { media: 'A/posts/early.jpg', poster: null, overlay: null }, done: Promise.resolve(fields),
    blur: Promise.resolve('A/blurs/early.jpg'), blurPath: 'A/blurs/early.jpg', state: 'used',
  };
  const plan = { friendIds: ['B'], story: false, profile: false, guess: false, caption: 'now!', audience: 'everyone', post: { dare: false, drop: true, rewind: false } };
  const { postId, postJob } = outbox.queueShare('A', plan, prepared);
  const post = await outbox.whenSent(postJob);
  await vi.advanceTimersByTimeAsync(10);
  expect(post.state).toBe('sent');
  expect(post.result).toMatchObject({ postId, dropLate: 30 });
  expect(b.db.posts[0]).toMatchObject({ id: postId, media_path: 'A/posts/early.jpg', blur_path: 'A/blurs/early.jpg', caption: 'now!' });
  const order = b.log.map((entry) => `${entry[0]}:${entry[1]}`);
  const postInsert = order.indexOf('insert:posts');
  const copy = order.findIndex((entry) => entry.startsWith('copy:A/posts/early.jpg'));
  const peek = order.indexOf('insert:messages');
  expect(postInsert).toBeGreaterThanOrEqual(0);
  expect(copy).toBeGreaterThan(postInsert);
  expect(peek).toBeGreaterThan(copy);
  expect(b.db.messages[0].media_path).toMatch(/^A\/snaps\//);
  // Nothing was uploaded again: the early upload was used.
  expect(b.uploads()).toEqual([]);
});

it("(f) 23505 posts_one_drop_per_day with no row under our id: failed, final, 'already posted'", async () => {
  const { b, outbox } = await setup();
  b.rules.insert = (table) =>
    table === 'posts' ? { error: { code: '23505', message: 'duplicate key value violates unique constraint "posts_one_drop_per_day"' }, status: 409 } : 'ok';
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: '', audience: 'everyone', drop: true }, { capture: photo });
  const job = await outbox.whenSent(key);
  expect(job.state).toBe('failed');
  expect(job.final).toBe(true);
  expect(job.error).toMatch(/already posted today's Peekaboo drop/);
  expect(b.db.posts).toHaveLength(0);
});

it('(g) no login yet: the send waits (and is never refused)', async () => {
  const { b, outbox } = await setup({ user: null });
  const key = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'hi' });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(b.inserts()).toEqual([]);
  expect(outbox.outboxBusy()).toBe(true);
  // The login comes back: it goes out.
  b.signIn('A', 'TOKEN_REFRESHED');
  const job = await outbox.whenSent(key);
  expect(job.state).toBe('sent');
});

it('(h) sends from before the app was closed show as failed and wait for a tap', async () => {
  const { b, outbox } = await setup();
  const record = {
    key: 'old-1', owner: 'A', scope: 'friend:B', what: { kind: 'text', friendId: 'B', body: 'from before' },
    rowIds: ['row-old-1'], maybeSaved: false, state: 'sending', attempts: 1, createdAt: Date.now() - 60_000,
  };
  b.store.set('outbox.v1.A', JSON.stringify({ 'old-1': record }));
  await outbox.restoreOutbox('A');
  const busyBefore = outbox.outboxBusy();
  b.becomeActive();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(busyBefore).toBe(false);
  expect(b.inserts()).toEqual([]);
  outbox.retry('old-1');
  const job = await outbox.whenSent('old-1');
  expect(job.state).toBe('sent');
  expect(b.db.messages[0]).toMatchObject({ id: 'row-old-1', body: 'from before' });
  // Sent: its record is gone from the phone.
  await settle();
  expect(b.store.has('outbox.v1.A')).toBe(false);
});

it('(h2) a restored send that did get saved is simply dropped; one whose picture is gone says "tap to remove"', async () => {
  const { b, outbox } = await setup();
  b.db.messages.push({ id: 'row-saved', sender_id: 'A', recipient_id: 'B', kind: 'text', body: 'made it' });
  const base = { owner: 'A', scope: 'friend:B', maybeSaved: false, state: 'waiting', attempts: 0, createdAt: Date.now() - 60_000 };
  b.store.set('outbox.v1.A', JSON.stringify({
    saved: { ...base, key: 'saved', what: { kind: 'text', friendId: 'B', body: 'made it' }, rowIds: ['row-saved'] },
    gone: { ...base, key: 'gone', what: { kind: 'peek', friendIds: ['B'] }, rowIds: ['row-gone'], capture: { kind: 'photo', uri: 'file:///deleted.jpg' } },
    old: { ...base, key: 'old', what: { kind: 'text', friendId: 'B', body: 'ancient' }, rowIds: ['row-old'], createdAt: Date.now() - 25 * 60 * 60 * 1000 },
  }));
  await outbox.restoreOutbox('A');
  await settle();
  const records = JSON.parse(b.store.get('outbox.v1.A'));
  expect(Object.keys(records)).toEqual(['gone']);
  const gone = await outbox.whenSent('gone');
  expect(gone).toMatchObject({ state: 'failed', restored: true, error: 'Not sent – tap to remove' });
});

it("(i) a login change drops the old person's sends", async () => {
  const { b, outbox } = await setup({ user: null });
  outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'for A only' });
  expect(outbox.outboxBusy()).toBe(true);
  b.signIn('A', 'SIGNED_IN');
  b.signIn('C', 'SIGNED_IN');
  await vi.advanceTimersByTimeAsync(0);
  // A's text may have gone out while A was logged in; C never sends it.
  const sentAsC = b.db.messages.filter((m) => m.sender_id === 'C');
  expect(sentAsC).toEqual([]);
  expect(outbox.outboxBusy()).toBe(false);
});

it('(i2) a send made for someone who is not logged in is never sent as the person who is', async () => {
  const { b, outbox } = await setup({ user: 'C' });
  outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'for A only' });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(b.inserts()).toEqual([]);
});

it('(j) two texts in one chat go in tap order while a video is still uploading', async () => {
  const { b, outbox } = await setup();
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  b.rules.upload = (path) => (path.endsWith('.mp4') ? slow : 'ok');
  let first = true;
  b.rules.insert = (_table, rows) => {
    // The first text's answer comes back slowly: the second must still wait for it.
    if (first && rows[0].body === 'one') { first = false; return new Promise((resolve) => setTimeout(() => resolve('ok'), 500)); }
    return 'ok';
  };
  const video = outbox.sendLater('A', 'friend:B', { kind: 'peek', friendIds: ['B'] }, { capture: { kind: 'video', uri: 'file:///clip.mp4' } });
  const one = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'one' });
  const two = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'two' });
  await vi.advanceTimersByTimeAsync(600);
  expect((await outbox.whenSent(one)).state).toBe('sent');
  expect((await outbox.whenSent(two)).state).toBe('sent');
  expect(b.db.messages.map((m) => m.body)).toEqual(['one', 'two']);
  expect(outbox.outboxBusy()).toBe(true);
  release();
  expect((await outbox.whenSent(video)).state).toBe('sent');
});

it('(k) a peek to several friends refused as a whole goes friend by friend and names the ones refused', async () => {
  const { b, outbox } = await setup();
  b.rules.insert = (_table, rows) =>
    rows.some((row) => row.recipient_id === 'C') ? { error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 } : 'ok';
  const key = outbox.sendLater('A', 'me', { kind: 'peek', friendIds: ['B', 'C'], names: { B: 'Bo', C: 'Cy' } }, { capture: photo });
  const job = await outbox.whenSent(key);
  expect(job.state).toBe('sent');
  expect(b.db.messages.map((m) => m.recipient_id)).toEqual(['B']);
  expect(job.result.refused).toEqual(['C']);
});

it("(l2) a public chat photo whose answer was lost is looked up by its file first (the retry would hit slow mode)", async () => {
  const { b, outbox } = await setup();
  let tries = 0;
  b.rules.insert = (table) => {
    if (table !== 'public_photos') return 'ok';
    tries += 1;
    if (tries === 1) return 'lost';
    return { error: { code: '23514', message: 'Slow mode is on – you can post again in a few seconds 🐢' }, status: 400 };
  };
  const key = outbox.sendLater('A', 'public', { kind: 'publicPhoto' }, { capture: photo });
  await vi.advanceTimersByTimeAsync(1000);
  const job = await outbox.whenSent(key);
  expect(job.state).toBe('sent');
  expect(b.db.public_photos).toHaveLength(1);
  expect(tries).toBe(1);
});

it('(l) a public chat photo answered with 23505 counts as sent', async () => {
  const { b, outbox } = await setup();
  let tries = 0;
  b.rules.insert = (table) => (table === 'public_photos' && ++tries === 1 ? 'lost' : 'ok');
  // The first try's row only shows up after the look-up (saved a moment late): the second try then gets 23505.
  b.rules.select = (table) => (table === 'public_photos' ? 'empty' : null);
  const key = outbox.sendLater('A', 'public', { kind: 'publicPhoto' }, { capture: photo });
  await vi.advanceTimersByTimeAsync(1000);
  const job = await outbox.whenSent(key);
  expect(job.state).toBe('sent');
  expect(b.db.public_photos).toHaveLength(1);
  expect(b.inserts('public_photos')).toHaveLength(2);
});

it("(m) coming back to the app tries again only 'no answer' failures under 10 minutes old", async () => {
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = (_table, rows) => {
    if (rows[0].body === 'refused') return { error: { code: 'P0001', message: 'You need to be friends to chat' }, status: 400 };
    return online ? 'ok' : 'noanswer';
  };
  const old = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'old' });
  await vi.advanceTimersByTimeAsync(12_000);
  expect((await outbox.whenSent(old)).state).toBe('failed');
  await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
  const fresh = outbox.sendLater('A', 'friend:D', { kind: 'text', friendId: 'D', body: 'fresh' });
  const refused = outbox.sendLater('A', 'friend:E', { kind: 'text', friendId: 'E', body: 'refused' });
  await vi.advanceTimersByTimeAsync(12_000);
  expect((await outbox.whenSent(fresh)).state).toBe('failed');
  expect((await outbox.whenSent(refused))).toMatchObject({ state: 'failed', final: true, error: 'You need to be friends to chat' });
  online = true;
  const before = b.inserts().length;
  b.becomeActive();
  expect((await outbox.whenSent(fresh)).state).toBe('sent');
  await vi.advanceTimersByTimeAsync(10);
  const after = b.inserts().slice(before).map((entry) => entry[2][0]);
  expect(after).toHaveLength(1);
  expect(b.db.messages.map((m) => m.body)).toEqual(['fresh']);
  expect((await outbox.whenSent(old)).state).toBe('failed');
});

it('a chat dare proof: the dare is marked as done after the peek is saved; a gone dare still counts as sent', async () => {
  const { b, outbox } = await setup();
  b.rules.rpc.claim_chat_dare = () => ({ data: null, error: { message: 'This dare is gone', code: 'P0001' } });
  const key = outbox.sendLater('A', 'friend:B', { kind: 'peek', friendIds: ['B'], chatDare: 'dare-1' }, { capture: photo });
  const job = await outbox.whenSent(key);
  expect(job.state).toBe('sent');
  expect(job.result.dareProblem).toBe('gone');
  const order = b.log.map((entry) => entry[0] === 'rpc' ? `rpc:${entry[1]}` : `${entry[0]}:${entry[1]}`);
  expect(order.indexOf('rpc:claim_chat_dare')).toBeGreaterThan(order.indexOf('insert:messages'));
});

it('a refused send deletes its files when no try was ever unclear', async () => {
  const { b, outbox } = await setup();
  b.rules.insert = () => ({ error: { code: 'P0001', message: 'You need to be friends to chat' }, status: 400 });
  const key = outbox.sendLater('A', 'friend:B', { kind: 'peek', friendIds: ['B'] }, { capture: photo });
  const job = await outbox.whenSent(key);
  await settle();
  expect(job).toMatchObject({ state: 'failed', final: true });
  expect(b.files.size).toBe(0);
});

// Speed fix 2: the moment your drop is saved, every screen knows (lib/drop.ts), with the day the server gave it –
// so your friends' drops unlock at once instead of after Home has loaded everything again.
it('a saved drop is passed on at once with its day and time zone; useDropSending says it is on its way until then', async () => {
  const noted = [];
  const b = backend();
  const outbox = b.load('outbox', { './drop': { noteMyDropPosted: (...args) => noted.push(args), timeZoneOffsetMinutes: () => -300, localDay: () => '2026-11-22' } });
  await settle();
  let release;
  b.rules.insert = (table) => (table === 'posts' ? new Promise((resolve) => { release = () => resolve('ok'); }) : 'ok');
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: '', audience: 'everyone', drop: true }, { capture: photo });
  const done = outbox.whenSent(key);
  // (The hook reads the store directly here: the test's React stand-in has no real hooks.)
  const sending = () => outbox.dropSendingKey('A');
  await settle();
  expect(sending()).toBe(key);
  expect(outbox.dropSendingKey('B')).toBe(null);
  expect(noted).toEqual([]);
  await vi.waitFor(() => expect(typeof release).toBe('function'));
  release();
  const job = await done;
  expect(job.state).toBe('sent');
  expect(noted).toHaveLength(1);
  expect(noted[0][0]).toBe('A');
  expect(noted[0][1]).toMatchObject({ id: job.rowIds[0], drop_day: '2026-11-22' });
  expect(sending()).toBe(null);
});

// ---------------------------------------------------------------------------
// Review fixes (stuck, lost and late sends).
// ---------------------------------------------------------------------------
const noSession = (b) => { b.supabase.auth.getSession = async () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', message: 'Network request failed' } }); };
const sessionBack = (b, id = 'A') => { b.supabase.auth.getSession = async () => ({ data: { session: { user: { id } } }, error: null }); };
const ledgerOf = (b, owner = 'A') => JSON.parse(b.store.get(`preupload.v1.${owner}`) ?? '[]').map((entry) => entry.path);
const recordsOf = (b, owner = 'A') => JSON.parse(b.store.get(`outbox.v1.${owner}`) ?? '{}');

// R1: the login ran out and can't be renewed on a weak signal (getSession gives no session). The drop used to say
// "Posting your drop…" forever, and was then posted hours later by itself.
it('no login for an hour: "No connection" after the waits, not busy, and never sent by itself an hour later', async () => {
  const { b, outbox } = await setup();
  noSession(b);
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: '', audience: 'everyone', drop: true }, { capture: photo });
  let finished = null;
  outbox.whenSent(key).then((job) => { finished = job; });
  await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000);
  expect(finished).toMatchObject({ state: 'failed', final: false, noAnswer: true, error: 'No connection – tap to try again' });
  expect(outbox.outboxBusy()).toBe(false);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  // The signal (and the login) is back an hour later: it waits for a tap.
  sessionBack(b);
  b.signIn('A', 'TOKEN_REFRESHED');
  b.becomeActive();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(b.db.posts).toHaveLength(0);
  outbox.retry(key);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.posts).toHaveLength(1);
});

it('no login for a moment: it goes out by itself as soon as the login is renewed (within 10 minutes)', async () => {
  const { b, outbox } = await setup();
  noSession(b);
  const key = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'on my way' });
  await vi.advanceTimersByTimeAsync(12_000);
  expect((await outbox.whenSent(key)).state).toBe('failed');
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
  sessionBack(b);
  b.signIn('A', 'TOKEN_REFRESHED');
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.messages.map((m) => m.body)).toEqual(['on my way']);
});

it('a 401 while the login is gone counts as a try with no answer (never a "no", never forever)', async () => {
  const { b, outbox } = await setup();
  b.rules.insert = () => ({ error: { code: '42501', message: 'new row violates row-level security policy' }, status: 401 });
  const key = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'hi' });
  await vi.advanceTimersByTimeAsync(0);
  noSession(b);
  await vi.advanceTimersByTimeAsync(12_000);
  const job = await outbox.whenSent(key);
  expect(job).toMatchObject({ state: 'failed', final: false, error: 'No connection – tap to try again' });
  expect(outbox.outboxBusy()).toBe(false);
});

// SUSPEND-SEND-LATE: Send closes the screen at once, so people lock the phone while a send is still going. The
// phone stops sending while the app is closed; coming back hours later used to post the drop by itself, as Late.
it('back after hours away: a send that was waiting to try again now waits for a tap (no late drop by itself)', async () => {
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => (online ? 'ok' : 'noanswer');
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: '', audience: 'everyone', drop: true }, { capture: photo });
  await vi.advanceTimersByTimeAsync(10); // the first try got no answer: it waits 1 second
  b.goAway();
  // iOS stops the app: no timers run while it's closed, the clock just moves on.
  vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
  online = true;
  b.becomeActive();
  const job = await outbox.whenSent(key);
  expect(job).toMatchObject({ state: 'failed', restored: true, error: 'Not sent – tap to try again' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(b.db.posts).toHaveLength(0);
  outbox.retry(key);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.posts).toHaveLength(1);
});

it('back after hours away: a try that was still going finishes, but is not tried again by itself if it failed', async () => {
  const { b, outbox } = await setup();
  let release;
  b.rules.insert = () => new Promise((resolve) => { release = () => resolve('noanswer'); });
  const key = outbox.sendLater('A', 'friend:B', { kind: 'peek', friendIds: ['B'] }, { capture: photo });
  await vi.waitFor(() => expect(typeof release).toBe('function'));
  b.goAway();
  vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
  b.becomeActive();
  release();
  const job = await outbox.whenSent(key);
  expect(job).toMatchObject({ state: 'failed', restored: true, error: 'Not sent – tap to try again' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(b.inserts('messages')).toHaveLength(1);
});

it('back after a short trip away: a young send simply carries on', async () => {
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => (online ? 'ok' : 'noanswer');
  const key = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'brb' });
  await vi.advanceTimersByTimeAsync(10);
  b.goAway();
  vi.setSystemTime(Date.now() + 2 * 60 * 1000);
  online = true;
  b.becomeActive();
  await vi.advanceTimersByTimeAsync(1000);
  expect((await outbox.whenSent(key)).state).toBe('sent');
});

// R7 / F1: a login can end by itself on a weak signal ("refresh token already used"). That used to delete every
// unsent send (and its record) without a word.
it('a login that ends by itself keeps the unsent sends: they show as "Not sent – tap to try again" after logging back in', async () => {
  const { b, outbox } = await setup();
  b.rules.insert = () => 'noanswer';
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: '', audience: 'everyone', drop: true }, { capture: photo });
  await vi.advanceTimersByTimeAsync(10);
  b.signIn(null, 'SIGNED_OUT');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(outbox.outboxBusy()).toBe(false);
  expect(Object.keys(recordsOf(b))).toEqual([key]);
  // Back in (a minute later): it's there, waiting for a tap.
  b.rules.insert = () => 'ok';
  b.signIn('A', 'SIGNED_IN');
  await outbox.restoreOutbox('A');
  expect(await outbox.whenSent(key)).toMatchObject({ state: 'failed', restored: true, error: 'Not sent – tap to try again' });
  outbox.retry(key);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.posts).toHaveLength(1);
});

// F6: logging out yourself deletes your unsent sends, and a send still finishing never writes its record back or
// leaves its photo copy on the phone.
it('Log out deletes the unsent sends, their records and their photo copies – even one that is still uploading', async () => {
  const { b, outbox } = await setup();
  let release;
  b.rules.upload = () => new Promise((resolve) => { release = () => resolve('ok'); });
  const key = outbox.sendLater('A', 'group:g1', { kind: 'groupMedia', groupId: 'g1', snap: false }, { capture: photo });
  await vi.waitFor(() => expect(typeof release).toBe('function'));
  await settle();
  const copies = () => [...b.disk].filter((uri) => uri.includes('/outbox/'));
  expect(copies()).toHaveLength(1);
  expect(Object.keys(recordsOf(b))).toEqual([key]);
  b.logOut('A');
  release();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(b.store.has('outbox.v1.A')).toBe(false);
  expect(copies()).toEqual([]);
  expect(b.db.group_messages).toEqual([]);
  expect((await outbox.whenSent(key)).state).toBe('failed');
});

it('at sign-in, photo copies on the phone that no send needs any more are deleted', async () => {
  const { b, outbox } = await setup();
  b.disk.add('file:///doc/outbox/forgotten-key.jpg');
  b.disk.add('file:///doc/outbox/kept-key.jpg');
  b.disk.add('file:///doc/outbox/other-person-key.jpg');
  b.store.set('outbox.v1.A', JSON.stringify({
    'kept-key': { key: 'kept-key', owner: 'A', scope: 'friend:B', what: { kind: 'peek', friendIds: ['B'] }, rowIds: ['r1'], capture: { kind: 'photo', uri: 'file:///doc/outbox/kept-key.jpg' }, maybeSaved: false, state: 'failed', attempts: 1, createdAt: Date.now() - 60_000 },
  }));
  b.store.set('outbox.v1.C', JSON.stringify({
    'other-person-key': { key: 'other-person-key', owner: 'C', createdAt: Date.now() - 60_000 },
  }));
  await outbox.restoreOutbox('A');
  await settle();
  const left = [...b.disk].filter((uri) => uri.includes('/outbox/')).sort();
  expect(left).toEqual(['file:///doc/outbox/kept-key.jpg', 'file:///doc/outbox/other-person-key.jpg']);
});

// F3: the names the outbox picks for its own uploads used to be forgotten if the send was deleted before it was
// saved: a half-uploaded video stayed in storage for good.
it("a deleted send's half-done upload is deleted too, and its names are written down before uploading", async () => {
  const { b, outbox } = await setup();
  b.rules.upload = (path) => (path.endsWith('.mp4') ? 'noanswer' : 'ok');
  const key = outbox.sendLater('A', 'friend:B', { kind: 'peek', friendIds: ['B'] }, { capture: { kind: 'video', uri: 'file:///clip.mp4', overlayUri: 'file:///layer.png' } });
  await vi.advanceTimersByTimeAsync(10);
  const record = recordsOf(b)[key];
  const overlay = record.paths.overlay;
  expect(ledgerOf(b)).toEqual(expect.arrayContaining([record.paths.media, overlay]));
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await outbox.whenSent(key)).state).toBe('failed');
  expect(b.files.has(overlay)).toBe(true);
  await outbox.discard(key);
  await settle();
  expect(b.files.has(overlay)).toBe(false);
  expect(ledgerOf(b)).toEqual([]);
});

it("a send's names are crossed off the leftovers list once it's saved", async () => {
  const { b, outbox } = await setup();
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: '', audience: 'everyone', drop: true }, { capture: photo });
  const job = await outbox.whenSent(key);
  await settle();
  expect(job.state).toBe('sent');
  expect(b.db.posts[0].blur_path).toMatch(/^A\/blurs\//);
  expect(ledgerOf(b)).toEqual([]);
});

// F4: a send that did get saved, found at sign-in: its files are crossed off, so the leftovers clean-up never trips
// over them.
it('a restored send that was saved crosses its files off the leftovers list', async () => {
  const { b, outbox } = await setup();
  b.db.posts.push({ id: 'row-post', user_id: 'A', media_path: 'A/posts/saved.jpg' });
  b.store.set('preupload.v1.A', JSON.stringify([{ bucket: 'media', path: 'A/posts/saved.jpg', at: Date.now() - 60_000 }]));
  b.store.set('outbox.v1.A', JSON.stringify({
    k: { key: 'k', owner: 'A', scope: 'me', what: { kind: 'post', caption: '', audience: 'everyone', drop: true }, rowIds: ['row-post'], paths: { media: 'A/posts/saved.jpg', poster: null, overlay: null, blur: null }, maybeSaved: false, state: 'sending', attempts: 1, createdAt: Date.now() - 60_000 },
  }));
  await outbox.restoreOutbox('A');
  await settle();
  expect(ledgerOf(b)).toEqual([]);
  expect(b.store.has('outbox.v1.A')).toBe(false);
});

// F5: group texts didn't say who sent them, so a retry that ran into a login change could post A's words as C.
it('group rows always say who sent them, and a retry never goes out after the login changed', async () => {
  const { b, outbox } = await setup();
  const first = outbox.sendLater('A', 'group:g1', { kind: 'groupText', groupId: 'g1', body: 'hello' });
  expect((await outbox.whenSent(first)).state).toBe('sent');
  expect(b.db.group_messages[0]).toMatchObject({ sender_id: 'A', body: 'hello' });
  let tries = 0;
  b.rules.insert = () => (++tries === 1 ? 'noanswer' : 'ok');
  // The retry looks the row up first; while it does, the phone switches to C's account.
  b.rules.select = (table) => {
    if (table === 'group_messages') { b.rules.select = null; b.signIn('C', 'SIGNED_IN'); }
    return null;
  };
  outbox.sendLater('A', 'group:g1', { kind: 'groupText', groupId: 'g1', body: 'from A only' });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(tries).toBe(1);
  expect(b.db.group_messages.map((m) => m.body)).toEqual(['hello']);
});

// DARECHAIN-LEAVE: the stand-in for an unknown send says so in plain words.
it('whenSent for a send this phone does not know says so in plain words', async () => {
  const { outbox } = await setup();
  expect(await outbox.whenSent('nope')).toMatchObject({ state: 'failed', final: true, error: "We couldn't find this send any more" });
});

// ---------------------------------------------------------------------------
// Second review: late drops and dares, and sends that went out by themselves after hours away.
// ---------------------------------------------------------------------------
const drop = { kind: 'post', caption: '', audience: 'everyone', drop: true };

// DB-1: the server files a drop (or dare) under the day it's SAVED. A drop that failed at 21:50 and was tapped
// again the next afternoon was posted as the new day's drop ("2h late"), and then the real one was refused.
it('DB-1: a drop that failed on its day is never posted the next day – a tap says why, and it can only be deleted', async () => {
  vi.setSystemTime(new Date(2026, 10, 22, 21, 50));
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => (online ? 'ok' : 'noanswer');
  const key = outbox.sendLater('A', 'me', drop, { capture: photo });
  await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000);
  expect(await outbox.whenSent(key)).toMatchObject({ state: 'failed', error: 'No connection – tap to try again' });
  // The day it was made for is kept with the send.
  expect(recordsOf(b)[key].what.dropDay).toBe('2026-11-22');
  const tries = b.inserts('posts').length;
  // The next afternoon (after that day's drop): the signal is back and "Try again" is tapped.
  vi.setSystemTime(new Date(2026, 10, 23, 15, 0));
  online = true;
  outbox.retry(key);
  const job = await outbox.whenSent(key);
  expect(job).toMatchObject({ state: 'failed', final: true, restored: true, error: outbox.DROP_DAY_OVER });
  expect(outbox.DROP_DAY_OVER).toBe("This drop was for an earlier day – it can't be posted now");
  expect(b.db.posts).toHaveLength(0);
  expect(b.inserts('posts')).toHaveLength(tries);
});

it('DB-1: a drop that was saved on its day (only the answer got lost) still counts as sent when tapped the next day', async () => {
  vi.setSystemTime(new Date(2026, 10, 22, 21, 50));
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => 'lost';
  b.rules.select = () => (online ? null : 'noanswer');
  const key = outbox.sendLater('A', 'me', drop, { capture: photo });
  await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000);
  expect(await outbox.whenSent(key)).toMatchObject({ state: 'failed', error: 'No connection – tap to try again' });
  vi.setSystemTime(new Date(2026, 10, 23, 15, 0));
  online = true;
  outbox.retry(key);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.posts).toHaveLength(1);
  expect(b.inserts('posts')).toHaveLength(1);
});

it('DB-1: a dare post that missed its dare day is never filed under the next dare, even when it goes again by itself', async () => {
  // 09:59 UTC: one minute before the new dare (10:00 UTC).
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 22, 9, 59)));
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => (online ? 'ok' : 'noanswer');
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: '', audience: 'everyone', dare: true }, { capture: photo });
  await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000);
  expect(await outbox.whenSent(key)).toMatchObject({ state: 'failed', error: 'No connection – tap to try again' });
  expect(recordsOf(b)[key].what.dareDay).toBe('2026-11-21');
  // 10:05 UTC, a new dare: back in the app with signal, sends under 10 minutes old go again by themselves.
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 22, 10, 5)));
  online = true;
  b.becomeActive();
  const job = await outbox.whenSent(key);
  expect(job).toMatchObject({ state: 'failed', final: true, error: outbox.DARE_DAY_OVER });
  expect(b.db.posts).toHaveLength(0);
});

it("DB-1: at sign-in, a drop from an earlier day says why it can't go (no Try again); a forfeit still can go", async () => {
  vi.setSystemTime(new Date(2026, 10, 23, 15, 0));
  const { b, outbox } = await setup();
  const fields = { media_path: 'A/posts/x.jpg', media_type: 'photo', poster_path: null, overlay_path: null };
  const base = { owner: 'A', scope: 'me', maybeSaved: false, state: 'failed', attempts: 3, createdAt: new Date(2026, 10, 22, 21, 50).getTime(), fields };
  b.store.set('outbox.v1.A', JSON.stringify({
    drop: { ...base, key: 'drop', rowIds: ['row-drop'], what: { ...drop, dropDay: '2026-11-22' } },
    // Saved by an older version of the app (no day kept): the day the send was made counts.
    older: { ...base, key: 'older', rowIds: ['row-older'], what: drop },
    // Forfeits aren't tied to a day.
    forfeit: { ...base, key: 'forfeit', rowIds: ['row-forfeit'], what: { kind: 'post', caption: '', audience: 'everyone', forfeit: 'f1' } },
  }));
  await outbox.restoreOutbox('A');
  const over = { state: 'failed', restored: true, final: true, error: outbox.DROP_DAY_OVER };
  expect(await outbox.whenSent('drop')).toMatchObject(over);
  expect(await outbox.whenSent('older')).toMatchObject(over);
  expect(await outbox.whenSent('forfeit')).toMatchObject({ state: 'failed', restored: true, final: false, error: 'Not sent – tap to try again' });
  outbox.retry('forfeit');
  expect((await outbox.whenSent('forfeit')).state).toBe('sent');
  // Even a tap on the old drop never posts it.
  outbox.retry('drop');
  expect(await outbox.whenSent('drop')).toMatchObject({ state: 'failed', final: true, error: outbox.DROP_DAY_OVER });
  expect(b.db.posts.map((post) => post.id)).toEqual(['row-forfeit']);
});

it("DB-1: at sign-in with no signal (can't look it up), an old drop can still be tapped: it looks first, and is never posted late", async () => {
  vi.setSystemTime(new Date(2026, 10, 23, 15, 0));
  const { b, outbox } = await setup();
  const fields = { media_path: 'A/posts/x.jpg', media_type: 'photo', poster_path: null, overlay_path: null };
  const day1 = new Date(2026, 10, 22, 21, 50).getTime();
  b.store.set('outbox.v1.A', JSON.stringify({
    saved: { key: 'saved', owner: 'A', scope: 'me', what: { ...drop, dropDay: '2026-11-22' }, rowIds: ['row-saved'], maybeSaved: true, state: 'failed', attempts: 3, createdAt: day1, fields },
    lost: { key: 'lost', owner: 'A', scope: 'me', what: { ...drop, dropDay: '2026-11-22' }, rowIds: ['row-lost'], maybeSaved: true, state: 'failed', attempts: 3, createdAt: day1, fields },
  }));
  b.rules.select = () => 'noanswer';
  await outbox.restoreOutbox('A');
  expect(await outbox.whenSent('saved')).toMatchObject({ state: 'failed', final: false, error: 'Not sent – tap to try again' });
  // The signal is back: it was saved on its day after all (a tap finds it), the other one never goes.
  b.rules.select = null;
  b.db.posts.push({ id: 'row-saved', user_id: 'A', drop_day: '2026-11-22' });
  outbox.retry('saved');
  outbox.retry('lost');
  expect((await outbox.whenSent('saved')).state).toBe('sent');
  expect(await outbox.whenSent('lost')).toMatchObject({ state: 'failed', final: true, error: outbox.DROP_DAY_OVER });
  expect(b.inserts('posts')).toHaveLength(0);
});

it('a post that is not a drop or dare (your profile) still goes the next day', async () => {
  vi.setSystemTime(new Date(2026, 10, 22, 21, 50));
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => (online ? 'ok' : 'noanswer');
  const key = outbox.sendLater('A', 'me', { kind: 'post', caption: 'hi', audience: 'everyone' }, { capture: photo });
  await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000);
  vi.setSystemTime(new Date(2026, 10, 23, 15, 0));
  online = true;
  outbox.retry(key);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.posts).toHaveLength(1);
});

// LATE-AFTER-RETURN: on iPhones a retry timer that was due while the app was closed runs as soon as the app wakes,
// before the app hears it's back. It started a new try, and the drop was posted 3 hours late with no tap.
it('back after hours away (iPhone order): the overdue retry runs before the app hears it is back – it still waits for a tap', async () => {
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => (online ? 'ok' : 'noanswer');
  const key = outbox.sendLater('A', 'me', drop, { capture: photo });
  await vi.advanceTimersByTimeAsync(10); // the first try got no answer: it waits 1 second
  b.goAway();
  vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
  online = true;
  await vi.advanceTimersByTimeAsync(1000); // the overdue timer runs first…
  b.becomeActive(); // …then the app hears it's back
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await outbox.whenSent(key)).toMatchObject({ state: 'failed', restored: true, error: 'Not sent – tap to try again' });
  expect(b.inserts('posts')).toHaveLength(1);
  expect(b.db.posts).toHaveLength(0);
  outbox.retry(key);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.posts).toHaveLength(1);
});

it('back after hours away: a try whose upload only finishes after you are back stops before saving; a tap saves it without uploading again', async () => {
  const { b, outbox } = await setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  b.rules.upload = () => gate;
  const key = outbox.sendLater('A', 'me', drop, { capture: photo });
  await vi.waitFor(() => expect(b.uploads().length).toBeGreaterThan(0));
  b.goAway();
  vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
  b.becomeActive();
  release('ok');
  const job = await outbox.whenSent(key);
  expect(job).toMatchObject({ state: 'failed', restored: true, error: 'Not sent – tap to try again' });
  expect(b.inserts('posts')).toHaveLength(0);
  const uploads = b.uploads().length;
  outbox.retry(key);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  expect(b.db.posts).toHaveLength(1);
  expect(b.uploads()).toHaveLength(uploads);
});

it('back after a short trip away (iPhone order): the overdue retry of a young send simply goes', async () => {
  const { b, outbox } = await setup();
  let online = false;
  b.rules.insert = () => (online ? 'ok' : 'noanswer');
  const key = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'brb' });
  await vi.advanceTimersByTimeAsync(10);
  b.goAway();
  vi.setSystemTime(Date.now() + 3 * 60 * 1000);
  online = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect((await outbox.whenSent(key)).state).toBe('sent');
  b.becomeActive();
});

// LATE-AFTER-RETURN (second review): a text waiting behind an earlier one in the same chat. On iPhones the earlier
// text's answer can arrive as the app wakes, before it hears you're back: that one counts (it was already on its
// way), but the next one started right then and went out 30 minutes late with no tap.
it('back after a while away (iPhone order): a text that waited behind another one in the chat waits for a tap', async () => {
  const { b, outbox } = await setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inserts = 0;
  b.rules.insert = () => (++inserts === 1 ? gate : 'ok');
  const first = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'one' });
  const second = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'on my way' });
  await settle();
  b.goAway();
  vi.setSystemTime(Date.now() + 30 * 60 * 1000);
  release('ok'); // the first text's answer arrives as the phone wakes…
  await settle();
  b.becomeActive(); // …then the app hears it's back
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await outbox.whenSent(first)).state).toBe('sent');
  expect(await outbox.whenSent(second)).toMatchObject({ state: 'failed', restored: true, error: 'Not sent – tap to try again' });
  expect(b.db.messages.map((message) => message.body)).toEqual(['one']);
  // A tap sends it at once.
  outbox.retry(second);
  expect((await outbox.whenSent(second)).state).toBe('sent');
  expect(b.db.messages.map((message) => message.body)).toEqual(['one', 'on my way']);
});

it('away for a short while: a text that waited behind another one still goes by itself', async () => {
  const { b, outbox } = await setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inserts = 0;
  b.rules.insert = () => (++inserts === 1 ? gate : 'ok');
  const first = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'one' });
  const second = outbox.sendLater('A', 'friend:B', { kind: 'text', friendId: 'B', body: 'two' });
  await settle();
  b.goAway();
  vi.setSystemTime(Date.now() + 2 * 60 * 1000);
  release('ok');
  await settle();
  expect((await outbox.whenSent(first)).state).toBe('sent');
  expect((await outbox.whenSent(second)).state).toBe('sent');
  expect(b.db.messages.map((message) => message.body)).toEqual(['one', 'two']);
  b.becomeActive();
});
