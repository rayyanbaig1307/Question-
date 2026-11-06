// Peekaboo+ webhook (supabase/functions/revenuecat-webhook). Runs the real handler. Its reads and writes run
// as real SQL, as the server role, in a local in-memory PostgreSQL (PGlite) with every migration loaded, so
// public.plus_members, the profiles check and log_plus_event behave like the live tables. The Supabase client
// is a small stand-in that turns the handler's supabase-js calls into that SQL. Invented users only; nothing
// here talks to RevenueCat or a live project.
//
// RevenueCat retries a failed message after 5, 10, 20, 40 and 80 minutes and doesn't promise the order, so
// most checks here send messages late, twice, at the same moment or in every possible order.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEdge } from './edgeHarness.mjs';
import { asUser, createLocalDatabase, seedUsers } from '../database/local-db.mjs';

const PASSWORD = 'Bearer test-webhook-password';
const DAY = 86_400_000;
const PRODUCT = 'peekaboo_plus_monthly';
const ANONYMOUS = '$RCAnonymousID:8b1d0e5c4f2a4d3e9c6b7a5f4e3d2c1b';
const NO_PROFILE = '00000000-0000-4000-8000-0000000000ff';

let db;
let users;
let counter = 0;
let logSpy;

beforeAll(async () => { db = await createLocalDatabase(); }, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate private.plus_events restart identity;');
  users = await seedUsers(db, 4);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------------------
// A stand-in for the service-role Supabase client: each supabase-js call becomes one SQL statement in its own
// transaction (like one PostgREST request), run as service_role. `fail` can make a call return an error.
// ---------------------------------------------------------------------------------------------------------
const PRIMARY_KEY = { profiles: 'id', plus_members: 'user_id' };

function plusService({ fail } = {}) {
  const calls = [];
  const run = (sql, params) => asUser(db, null, (tx) => tx.query(sql, params), 'service_role');
  const name = (value) => {
    if (!/^[a-z_]+$/.test(value)) throw new Error(`Unexpected column ${value}`);
    return value;
  };
  const columns = (spec) => (spec.trim() === '*' ? '*' : spec.split(',').map((c) => name(c.trim())).join(', '));

  function from(table) {
    if (!PRIMARY_KEY[table]) throw new Error(`Unexpected table ${table}`);
    const state = { op: 'select', columns: '*', returning: null, filters: [], order: null, limit: null, values: null, options: {} };
    const filter = (op) => (column, value) => { state.filters.push({ column: name(column), op, value }); return builder; };
    const builder = {
      select(spec = '*') { if (state.op === 'select') state.columns = spec; else state.returning = spec; return builder; },
      insert(values) { state.op = 'insert'; state.values = values; return builder; },
      upsert(values, options = {}) { state.op = 'upsert'; state.values = values; state.options = options; return builder; },
      update(values) { state.op = 'update'; state.values = values; return builder; },
      delete() { state.op = 'delete'; return builder; },
      eq: filter('='), lt: filter('<'), lte: filter('<='), gt: filter('>'), gte: filter('>='), in: filter('in'),
      order(column, { ascending = true } = {}) { state.order = `${name(column)} ${ascending ? 'asc' : 'desc'}`; return builder; },
      limit(count) { state.limit = Number(count); return builder; },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };

    async function execute() {
      const call = { table, op: state.op, values: state.values, options: state.options, filters: state.filters.map((f) => [f.column, f.op, f.value]) };
      calls.push(call);
      const injected = fail?.(call);
      if (injected) return { data: null, error: { message: injected } };
      const params = [];
      const param = (value) => { params.push(value); return `$${params.length}`; };
      const where = state.filters.length === 0 ? '' : ` where ${state.filters.map((f) => (f.op === 'in'
        ? `${f.column}::text = any(${param(f.value.map(String))}::text[])`
        : `${f.column} ${f.op} ${param(f.value)}`)).join(' and ')}`;
      let sql;
      if (state.op === 'select') {
        sql = `select ${columns(state.columns)} from public.${table}${where}${state.order ? ` order by ${state.order}` : ''}${state.limit !== null ? ` limit ${state.limit}` : ''}`;
      } else if (state.op === 'update') {
        sql = `update public.${table} set ${Object.entries(state.values).map(([k, v]) => `${name(k)} = ${param(v)}`).join(', ')}${where}`;
      } else if (state.op === 'delete') {
        sql = `delete from public.${table}${where}`;
      } else {
        const rows = Array.isArray(state.values) ? state.values : [state.values];
        const keys = Object.keys(rows[0]).map(name);
        sql = `insert into public.${table} (${keys.join(', ')}) values ${rows.map((row) => `(${keys.map((k) => param(row[k] ?? null)).join(', ')})`).join(', ')}`;
        if (state.op === 'upsert') {
          // Without onConflict, PostgREST uses the table's primary key.
          const target = name(state.options.onConflict ?? PRIMARY_KEY[table]);
          sql += state.options.ignoreDuplicates
            ? ` on conflict (${target}) do nothing`
            : ` on conflict (${target}) do update set ${keys.filter((k) => k !== target).map((k) => `${k} = excluded.${k}`).join(', ')}`;
        }
      }
      const wantRows = state.op === 'select' || state.returning !== null;
      if (state.op !== 'select' && wantRows) sql += ` returning ${columns(state.returning)}`;
      // Rows come back as JSON, the way PostgREST sends them (dates as text, not Date objects).
      const wrapped = !wantRows ? sql
        : state.op === 'select' ? `select coalesce(json_agg(row_to_json(r)), '[]'::json) as rows from (${sql}) r`
          : `with r as (${sql}) select coalesce(json_agg(row_to_json(r)), '[]'::json) as rows from r`;
      try {
        const result = await run(wrapped, params);
        return { data: wantRows ? result.rows[0].rows : null, error: null };
      } catch (error) {
        return { data: null, error: { message: error.message } };
      }
    }
    return builder;
  }

  const rpc = vi.fn(async (fn, args) => {
    const call = { rpc: fn, args };
    calls.push(call);
    if (fn !== 'log_plus_event') throw new Error(`Unexpected function ${fn}`);
    const injected = fail?.(call);
    if (injected) return { data: null, error: { message: injected } };
    try {
      await run('select public.log_plus_event(p_event_id => $1, p_event_type => $2, p_app_user_id => $3, p_body => $4::jsonb)',
        [args.p_event_id, args.p_event_type, args.p_app_user_id, JSON.stringify(args.p_body)]);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: { message: error.message } };
    }
  });
  return { admin: { from: vi.fn(from), rpc }, calls };
}

function webhook({ fail, password = PASSWORD } = {}) {
  const service = plusService({ fail });
  const handler = loadEdge('revenuecat-webhook', service.admin, undefined, { env: { REVENUECAT_WEBHOOK_AUTH: password } });
  const send = async (body, { auth = PASSWORD, method = 'POST' } = {}) => {
    const response = await handler(new Request('http://127.0.0.1/functions/v1/revenuecat-webhook', {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth === null ? {} : { Authorization: auth }) },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { ...service, send };
}

// A RevenueCat message the way its docs show it. `who` is the Peekaboo user id (the RevenueCat app user id).
function message(type, who, fields = {}) {
  counter += 1;
  return {
    api_version: '1.0',
    event: {
      id: `evt_qa_${counter}`, type, app_user_id: who, original_app_user_id: who, aliases: who ? [who] : [],
      product_id: PRODUCT, entitlement_ids: ['plus'], period_type: 'NORMAL', store: 'APP_STORE', environment: 'SANDBOX',
      purchased_at_ms: Date.now(), event_timestamp_ms: Date.now(), ...fields,
    },
  };
}
const transferMessage = (from, to) => {
  counter += 1;
  // RevenueCat's TRANSFER has no app_user_id, product or entitlement: only who it moved from and to.
  return { api_version: '1.0', event: { id: `evt_qa_${counter}`, type: 'TRANSFER', transferred_from: from, transferred_to: to, store: 'APP_STORE', environment: 'SANDBOX', event_timestamp_ms: Date.now() } };
};
const at = (days) => Date.now() + Math.round(days * DAY);

const row = async (who) => (await db.query('select expires_at, product_id from public.plus_members where user_id = $1', [who])).rows[0] ?? null;
const until = async (who) => { const found = await row(who); return found ? new Date(found.expires_at).getTime() : null; };
// The server's own rule (the one Plus features check).
const hasPlus = async (who) => (await db.query('select private.is_plus($1) as plus', [who])).rows[0].plus;
const give = (who, ms, product = PRODUCT) =>
  db.query('insert into public.plus_members (user_id, expires_at, product_id) values ($1, $2, $3)', [who, new Date(ms).toISOString(), product]);
const logged = async () => (await db.query('select event_id, event_type, app_user_id from private.plus_events order by id')).rows;
const plusRows = async () => Number((await db.query('select count(*)::int as n from public.plus_members')).rows[0].n);
const endedJustNow = async (who, before) => {
  const ended = await until(who);
  expect(ended).toBeGreaterThanOrEqual(before - 1);
  expect(ended).toBeLessThanOrEqual(Date.now());
  expect(await hasPlus(who)).toBe(false);
};

// =========================================================================================================

describe('who may call it', () => {
  it.each([
    ['no Authorization header', null],
    ['an empty one', ''],
    ['the password without "Bearer"', 'test-webhook-password'],
    ['a wrong password', 'Bearer test-webhook-passwore'],
    ['a longer guess', `${PASSWORD}x`],
    ['another login token', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x'],
  ])('%s is refused before anything is read, logged or changed', async (_label, auth) => {
    const hook = webhook();
    const response = await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: at(30) }), { auth });
    expect(response).toEqual({ status: 401, body: { error: 'Not allowed' } });
    expect(hook.calls).toEqual([]);
    expect(await logged()).toEqual([]);
    expect(await row(users[0])).toBeNull();
  });

  it('nothing is accepted while the password secret is not set up on the server', async () => {
    const hook = webhook({ password: '' });
    for (const auth of [null, '', PASSWORD]) {
      const response = await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: at(30) }), { auth });
      expect(response).toEqual({ status: 500, body: { error: 'Not set up yet' } });
    }
    expect(hook.calls).toEqual([]);
    expect(await row(users[0])).toBeNull();
  });

  it('only POST is allowed', async () => {
    const hook = webhook();
    expect((await hook.send(undefined, { method: 'GET' })).status).toBe(405);
    expect(hook.calls).toEqual([]);
  });

  it.each([
    ['not JSON', '{"event": '],
    ['JSON null', 'null'],
    ['a list', '[]'],
    ['no event', '{}'],
    ['an event without a type', '{"event": {"id": "evt_x"}}'],
    ['an event that is text', '{"event": "RENEWAL"}'],
  ])('%s is answered with 400 and nothing is logged', async (_label, body) => {
    const hook = webhook();
    expect((await hook.send(body)).status).toBe(400);
    expect(hook.calls).toEqual([]);
    expect(await logged()).toEqual([]);
  });
});

describe('buying and renewing', () => {
  it('a purchase gives Plus until its end date, and the message is logged', async () => {
    const hook = webhook();
    const end = at(30);
    const sent = message('INITIAL_PURCHASE', users[0], { expiration_at_ms: end });
    expect(await hook.send(sent)).toEqual({ status: 200, body: { ok: true } });
    expect(await until(users[0])).toBe(end);
    expect((await row(users[0])).product_id).toBe(PRODUCT);
    expect(await hasPlus(users[0])).toBe(true);
    expect(await logged()).toEqual([{ event_id: sent.event.id, event_type: 'INITIAL_PURCHASE', app_user_id: users[0] }]);
    // Nobody else got anything.
    expect(await plusRows()).toBe(1);
  });

  it.each([
    'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE',
    'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT', 'REFUND_REVERSED',
  ])('%s gives Plus until its end date, and makes an earlier end date later', async (type) => {
    const hook = webhook();
    const end = at(20);
    expect((await hook.send(message(type, users[0], { expiration_at_ms: end }))).status).toBe(200);
    expect(await until(users[0])).toBe(end);
    await give(users[1], at(5));
    expect((await hook.send(message(type, users[1], { expiration_at_ms: end }))).status).toBe(200);
    expect(await until(users[1])).toBe(end);
  });

  it.each([
    'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE',
    'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT', 'REFUND_REVERSED',
  ])('%s never makes Plus shorter (an old message that arrives late changes nothing)', async (type) => {
    const hook = webhook();
    const later = at(60);
    await give(users[0], later, 'newer_product');
    expect((await hook.send(message(type, users[0], { expiration_at_ms: at(10), new_product_id: 'older_product' }))).status).toBe(200);
    expect(await until(users[0])).toBe(later);
    expect((await row(users[0])).product_id).toBe('newer_product');
  });

  it('renewals keep moving the end date later', async () => {
    const hook = webhook();
    const ends = [at(1), at(31), at(61)];
    await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: ends[0] }));
    for (const end of ends.slice(1)) {
      await hook.send(message('RENEWAL', users[0], { expiration_at_ms: end }));
      expect(await until(users[0])).toBe(end);
    }
  });

  it('a plan change saves the new product', async () => {
    const hook = webhook();
    await give(users[0], at(5), PRODUCT);
    await hook.send(message('PRODUCT_CHANGE', users[0], { expiration_at_ms: at(30), new_product_id: 'peekaboo_plus_yearly' }));
    expect((await row(users[0])).product_id).toBe('peekaboo_plus_yearly');
  });

  it('a one-off purchase or gift with no end date is Plus that never runs out, and a refund still ends it', async () => {
    const hook = webhook();
    expect((await hook.send(message('NON_RENEWING_PURCHASE', users[0], { expiration_at_ms: null, store: 'PROMOTIONAL', product_id: 'rc_promo_plus_lifetime' }))).status).toBe(200);
    expect(new Date(await until(users[0])).toISOString()).toBe('9999-12-31T23:59:59.000Z');
    expect(await hasPlus(users[0])).toBe(true);
    // Renewals of something else never shorten it.
    await hook.send(message('RENEWAL', users[0], { expiration_at_ms: at(30) }));
    expect(new Date(await until(users[0])).getUTCFullYear()).toBe(9999);
    const before = Date.now();
    await hook.send(message('CANCELLATION', users[0], { cancel_reason: 'CUSTOMER_SUPPORT', store: 'PROMOTIONAL', expiration_at_ms: Date.now() }));
    await endedJustNow(users[0], before);
  });

  it('a subscription message with no end date changes nothing', async () => {
    const hook = webhook();
    for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'SUBSCRIPTION_EXTENDED']) {
      expect(await hook.send(message(type, users[0], { expiration_at_ms: null }))).toEqual({ status: 200, body: { ok: true, ignored: 'no end date' } });
    }
    expect(await row(users[0])).toBeNull();
  });

  it('RevenueCat\'s usual stand-in grant (no entitlement, no end date) changes nothing; the real purchase follows', async () => {
    const hook = webhook();
    const standIn = { api_version: '1.0', event: { id: 'evt_qa_temp', type: 'TEMPORARY_ENTITLEMENT_GRANT', app_user_id: users[0], store: 'APP_STORE' } };
    expect((await hook.send(standIn)).status).toBe(200);
    expect(await row(users[0])).toBeNull();
    const end = at(30);
    await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: end }));
    expect(await until(users[0])).toBe(end);
  });

  it.each([
    ['text', '1702592000000'],
    ['not a number', 'soon'],
    ['too far away to be a date', 1e20],
    ['a list', [1]],
  ])('an end date that is %s is ignored (200, so RevenueCat does not keep retrying)', async (_label, value) => {
    const hook = webhook();
    const response = await hook.send(message('RENEWAL', users[0], { expiration_at_ms: value }));
    expect(response).toEqual({ status: 200, body: { ok: true, ignored: 'no end date' } });
    expect(await row(users[0])).toBeNull();
  });
});

describe('running out (EXPIRATION)', () => {
  it('ends Plus now when it is about the end date we have', async () => {
    const hook = webhook();
    const end = at(3);
    await give(users[0], end);
    const before = Date.now();
    expect((await hook.send(message('EXPIRATION', users[0], { expiration_at_ms: end, expiration_reason: 'CUSTOMER_SUPPORT' }))).status).toBe(200);
    await endedJustNow(users[0], before);
  });

  it('an old EXPIRATION that arrives after a newer RENEWAL changes nothing', async () => {
    const hook = webhook();
    const first = at(-1);
    const renewed = at(29);
    await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: first }));
    await hook.send(message('RENEWAL', users[0], { expiration_at_ms: renewed }));
    expect((await hook.send(message('EXPIRATION', users[0], { expiration_at_ms: first }))).status).toBe(200);
    expect(await until(users[0])).toBe(renewed);
    expect(await hasPlus(users[0])).toBe(true);
  });

  it('a RENEWAL that arrives after the EXPIRATION brings Plus back', async () => {
    const hook = webhook();
    const end = at(2);
    await give(users[0], end);
    await hook.send(message('EXPIRATION', users[0], { expiration_at_ms: end }));
    expect(await hasPlus(users[0])).toBe(false);
    const renewed = at(32);
    await hook.send(message('RENEWAL', users[0], { expiration_at_ms: renewed }));
    expect(await until(users[0])).toBe(renewed);
    expect(await hasPlus(users[0])).toBe(true);
  });

  it('an end date that has already passed is left as it is (not moved to now)', async () => {
    const hook = webhook();
    const end = at(-3);
    await give(users[0], end);
    await hook.send(message('EXPIRATION', users[0], { expiration_at_ms: end }));
    expect(await until(users[0])).toBe(end);
  });

  it('without its date it changes nothing (Plus still stops by itself at the end date we have)', async () => {
    const hook = webhook();
    const end = at(3);
    await give(users[0], end);
    expect(await hook.send(message('EXPIRATION', users[0], { expiration_at_ms: null }))).toEqual({ status: 200, body: { ok: true, ignored: 'no end date' } });
    expect(await until(users[0])).toBe(end);
  });

  it('only touches the people in the message', async () => {
    const hook = webhook();
    const end = at(3);
    await give(users[0], end);
    await give(users[1], end);
    await hook.send(message('EXPIRATION', users[0], { expiration_at_ms: end }));
    expect(await hasPlus(users[0])).toBe(false);
    expect(await until(users[1])).toBe(end);
  });
});

describe('cancelling, refunds and payment problems', () => {
  it.each(['UNSUBSCRIBE', 'BILLING_ERROR', 'PRICE_INCREASE', 'DEVELOPER_INITIATED', 'UNKNOWN', undefined])(
    'a CANCELLATION with reason %s (auto-renew off) keeps Plus to the end of the month', async (reason) => {
      const hook = webhook();
      const end = at(12);
      await give(users[0], end);
      expect((await hook.send(message('CANCELLATION', users[0], { cancel_reason: reason, expiration_at_ms: end }))).status).toBe(200);
      expect(await until(users[0])).toBe(end);
      expect(await hasPlus(users[0])).toBe(true);
    });

  it('a refund (CUSTOMER_SUPPORT) ends Plus now, whatever end date the message has', async () => {
    const hook = webhook();
    await give(users[0], at(25));
    await give(users[1], at(25));
    const before = Date.now();
    await hook.send(message('CANCELLATION', users[0], { cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: Date.now() }));
    await hook.send(message('CANCELLATION', users[1], { cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: at(25) }));
    await endedJustNow(users[0], before);
    await endedJustNow(users[1], before);
  });

  it('a refund for someone without Plus adds nothing, and an old end date stays where it was', async () => {
    const hook = webhook();
    const old = at(-10);
    await give(users[1], old);
    await hook.send(message('CANCELLATION', users[0], { cancel_reason: 'CUSTOMER_SUPPORT' }));
    await hook.send(message('CANCELLATION', users[1], { cancel_reason: 'CUSTOMER_SUPPORT' }));
    expect(await row(users[0])).toBeNull();
    expect(await until(users[1])).toBe(old);
  });

  it('a gift taken back in the RevenueCat dashboard ends Plus now', async () => {
    const hook = webhook();
    await give(users[0], at(300), 'rc_promo_plus_yearly');
    const before = Date.now();
    await hook.send(message('CANCELLATION', users[0], { cancel_reason: 'DEVELOPER_INITIATED', store: 'PROMOTIONAL', product_id: 'rc_promo_plus_yearly' }));
    await endedJustNow(users[0], before);
  });

  it('a payment problem changes nothing without a grace period', async () => {
    const hook = webhook();
    const end = at(1);
    await give(users[0], end);
    expect((await hook.send(message('BILLING_ISSUE', users[0], { expiration_at_ms: end, grace_period_expiration_at_ms: null }))).status).toBe(200);
    expect(await until(users[0])).toBe(end);
    expect(await hasPlus(users[0])).toBe(true);
  });

  it('a payment problem with a grace period keeps Plus until the grace period ends, never shorter', async () => {
    const hook = webhook();
    const end = at(1);
    const grace = at(16);
    await give(users[0], end);
    await hook.send(message('BILLING_ISSUE', users[0], { expiration_at_ms: end, grace_period_expiration_at_ms: grace }));
    expect(await until(users[0])).toBe(grace);
    // A grace period that ends before the date we have takes nothing away.
    const longer = at(40);
    await give(users[1], longer);
    await hook.send(message('BILLING_ISSUE', users[1], { expiration_at_ms: end, grace_period_expiration_at_ms: grace }));
    expect(await until(users[1])).toBe(longer);
    // The payment works after all: the renewal moves it on as usual.
    const renewed = at(31);
    await hook.send(message('RENEWAL', users[0], { expiration_at_ms: renewed }));
    expect(await until(users[0])).toBe(renewed);
  });
});

describe('the same message twice, and messages in the wrong order', () => {
  it('the same RENEWAL twice is logged once and gives the same result', async () => {
    const hook = webhook();
    const end = at(30);
    const sent = message('RENEWAL', users[0], { expiration_at_ms: end });
    expect((await hook.send(sent)).status).toBe(200);
    expect((await hook.send(sent)).status).toBe(200);
    expect(await until(users[0])).toBe(end);
    expect((await logged()).map((r) => r.event_id)).toEqual([sent.event.id]);
  });

  it('the same EXPIRATION or refund twice gives the same result', async () => {
    const hook = webhook();
    const end = at(3);
    await give(users[0], end);
    await give(users[1], at(20));
    const expiration = message('EXPIRATION', users[0], { expiration_at_ms: end });
    const refund = message('CANCELLATION', users[1], { cancel_reason: 'CUSTOMER_SUPPORT' });
    await hook.send(expiration);
    await hook.send(refund);
    const ended = [await until(users[0]), await until(users[1])];
    await hook.send(expiration);
    await hook.send(refund);
    expect([await until(users[0]), await until(users[1])]).toEqual(ended);
    expect(await logged()).toHaveLength(2);
  });

  it('a whole month of sandbox messages ends the same way in every order', async () => {
    // Apple's test renewals come every few minutes; the last renewal is still running.
    const ends = [at(-0.02), at(0.5), at(1)];
    const sent = [
      message('INITIAL_PURCHASE', users[0], { expiration_at_ms: ends[0] }),
      message('RENEWAL', users[0], { expiration_at_ms: ends[1] }),
      message('RENEWAL', users[0], { expiration_at_ms: ends[2] }),
      message('EXPIRATION', users[0], { expiration_at_ms: ends[0] }),
      message('CANCELLATION', users[0], { cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: ends[2] }),
    ];
    const orders = (items) => (items.length <= 1 ? [items] : items.flatMap((item, i) => orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));
    const all = orders(sent);
    expect(all).toHaveLength(120);
    for (const order of all) {
      await db.query('delete from public.plus_members');
      const hook = webhook();
      for (const one of order) expect((await hook.send(one)).status).toBe(200);
      expect(await until(users[0])).toBe(ends[2]);
      expect(await hasPlus(users[0])).toBe(true);
    }
  });

  it('a renewal and an old expiration of a past month, in either order, leave Plus off only if nothing newer is known', async () => {
    // Plus ran out for real (the last end date has passed): any order leaves it off.
    const ended = at(-2);
    const old = [message('RENEWAL', users[0], { expiration_at_ms: ended }), message('EXPIRATION', users[0], { expiration_at_ms: ended })];
    for (const order of [old, [...old].reverse()]) {
      await db.query('delete from public.plus_members');
      const hook = webhook();
      for (const one of order) await hook.send(one);
      expect(await hasPlus(users[0])).toBe(false);
    }
  });

  it('messages at the very same moment still end with the latest end date', async () => {
    const ends = [at(10), at(40), at(25), at(5)];
    for (let round = 0; round < 5; round++) {
      await db.query('delete from public.plus_members');
      const hook = webhook();
      const responses = await Promise.all([
        hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: ends[0] })),
        hook.send(message('RENEWAL', users[0], { expiration_at_ms: ends[1] })),
        hook.send(message('RENEWAL', users[0], { expiration_at_ms: ends[2] })),
        hook.send(message('EXPIRATION', users[0], { expiration_at_ms: ends[3] })),
        hook.send(message('BILLING_ISSUE', users[0], { expiration_at_ms: ends[3] })),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await until(users[0])).toBe(ends[1]);
    }
  });

  it('a save that fails is answered with 500, and RevenueCat\'s retry of the same message then works', async () => {
    let failing = true;
    const hook = webhook({ fail: (call) => (failing && call.table === 'plus_members' && call.op !== 'select' ? 'database is busy' : null) });
    const end = at(30);
    const sent = message('INITIAL_PURCHASE', users[0], { expiration_at_ms: end });
    expect(await hook.send(sent)).toEqual({ status: 500, body: { error: 'database is busy' } });
    expect(await row(users[0])).toBeNull();
    failing = false;
    expect((await hook.send(sent)).status).toBe(200);
    expect(await until(users[0])).toBe(end);
    expect(await logged()).toHaveLength(1);
  });

  it('if the message cannot be logged, nothing changes and RevenueCat is asked to try again', async () => {
    const hook = webhook({ fail: (call) => (call.rpc ? 'log is offline' : null) });
    const response = await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: at(30) }));
    expect(response).toEqual({ status: 500, body: { error: 'log is offline' } });
    expect(hook.calls.filter((c) => c.table)).toEqual([]);
    expect(await row(users[0])).toBeNull();
  });
});

describe('moving a subscription to another account (TRANSFER)', () => {
  it('moves Plus to the new account and ends it on the old one', async () => {
    const hook = webhook();
    const end = at(20);
    await give(users[0], end, 'peekaboo_plus_monthly');
    const before = Date.now();
    expect(await hook.send(transferMessage([users[0]], [users[1]]))).toEqual({ status: 200, body: { ok: true } });
    expect(await until(users[1])).toBe(end);
    expect((await row(users[1])).product_id).toBe('peekaboo_plus_monthly');
    expect(await hasPlus(users[1])).toBe(true);
    await endedJustNow(users[0], before);
  });

  it('never cuts the new account\'s own later Plus short, and raises an earlier one', async () => {
    const hook = webhook();
    const moved = at(20);
    const longer = at(200);
    await give(users[0], moved);
    await give(users[1], longer);
    await hook.send(transferMessage([users[0]], [users[1]]));
    expect(await until(users[1])).toBe(longer);
    expect(await hasPlus(users[0])).toBe(false);

    await give(users[2], moved);
    await give(users[3], at(2));
    await hook.send(transferMessage([users[2]], [users[3]]));
    expect(await until(users[3])).toBe(moved);
    expect(await hasPlus(users[2])).toBe(false);
  });

  it('if the move stops half way, nobody loses Plus, and RevenueCat\'s retry finishes it', async () => {
    let failing = true;
    // The new account's save fails the first time.
    const hook = webhook({ fail: (call) => (failing && call.table === 'plus_members' && call.op !== 'select' && JSON.stringify(call).includes(users[1]) ? 'database is busy' : null) });
    const end = at(20);
    await give(users[0], end);
    const sent = transferMessage([users[0]], [users[1]]);
    expect((await hook.send(sent)).status).toBe(500);
    expect(await until(users[0])).toBe(end);
    expect(await hasPlus(users[0])).toBe(true);
    failing = false;
    expect((await hook.send(sent)).status).toBe(200);
    expect(await until(users[1])).toBe(end);
    expect(await hasPlus(users[0])).toBe(false);
  });

  it('the same TRANSFER twice changes nothing more', async () => {
    const hook = webhook();
    const end = at(20);
    await give(users[0], end);
    const sent = transferMessage([users[0]], [users[1]]);
    await hook.send(sent);
    const afterFirst = [await until(users[0]), await until(users[1])];
    expect((await hook.send(sent)).status).toBe(200);
    expect([await until(users[0]), await until(users[1])]).toEqual(afterFirst);
    expect(await until(users[1])).toBe(end);
  });

  it('works with RevenueCat\'s extra ids on both sides (anonymous ids, capital letters)', async () => {
    const hook = webhook();
    const end = at(20);
    await give(users[0], end);
    await hook.send(transferMessage([ANONYMOUS, users[0].toUpperCase()], [`$RCAnonymousID:${'a'.repeat(32)}`, users[1].toUpperCase()]));
    expect(await until(users[1])).toBe(end);
    expect(await hasPlus(users[0])).toBe(false);
  });

  it('changes nothing when one side is not a Peekaboo account', async () => {
    const hook = webhook();
    const end = at(20);
    await give(users[0], end);
    for (const [from, to] of [[[users[0]], [ANONYMOUS]], [[users[0]], [NO_PROFILE]], [[ANONYMOUS], [users[1]]], [[users[0]], []], [[], [users[1]]], [[users[0]], [users[0]]]]) {
      expect(await hook.send(transferMessage(from, to))).toEqual({ status: 200, body: { ok: true, ignored: 'unknown person' } });
    }
    expect(await until(users[0])).toBe(end);
    expect(await row(users[1])).toBeNull();
  });

  it('an old account without running Plus gives nothing (and loses nothing it still had)', async () => {
    const hook = webhook();
    const old = at(-5);
    await give(users[0], old);
    await hook.send(transferMessage([users[0]], [users[1]]));
    expect(await row(users[1])).toBeNull();
    expect(await until(users[0])).toBe(old);
  });

  it('after a move, the new account\'s renewals keep working', async () => {
    const hook = webhook();
    await give(users[0], at(3));
    await hook.send(transferMessage([users[0]], [users[1]]));
    const renewed = at(33);
    await hook.send(message('RENEWAL', users[1], { expiration_at_ms: renewed }));
    expect(await until(users[1])).toBe(renewed);
    expect(await hasPlus(users[0])).toBe(false);
  });
});

describe('only real Peekaboo accounts, and only Peekaboo+', () => {
  it('messages about another entitlement, or a product not linked to Plus, change nothing', async () => {
    const hook = webhook();
    const end = at(5);
    await give(users[1], end);
    for (const fields of [{ entitlement_ids: ['gold'] }, { entitlement_ids: [] }, { entitlement_ids: null }, { entitlement_ids: undefined }]) {
      expect(await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: at(30), ...fields })))
        .toEqual({ status: 200, body: { ok: true, ignored: 'other entitlement' } });
      await hook.send(message('CANCELLATION', users[1], { cancel_reason: 'CUSTOMER_SUPPORT', ...fields }));
      await hook.send(message('EXPIRATION', users[1], { expiration_at_ms: end, ...fields }));
    }
    expect(await row(users[0])).toBeNull();
    expect(await until(users[1])).toBe(end);
    // Still logged, for the "I paid but…" questions.
    expect(await logged()).toHaveLength(12);
  });

  it('RevenueCat\'s older one-entitlement field still counts', async () => {
    const hook = webhook();
    const end = at(30);
    await hook.send(message('INITIAL_PURCHASE', users[0], { expiration_at_ms: end, entitlement_ids: undefined, entitlement_id: 'plus' }));
    expect(await until(users[0])).toBe(end);
  });

  it('a purchase seen under an anonymous id goes to the Peekaboo account in its other names', async () => {
    const hook = webhook();
    const end = at(30);
    await hook.send(message('INITIAL_PURCHASE', ANONYMOUS, { original_app_user_id: ANONYMOUS, aliases: [ANONYMOUS, users[2]], expiration_at_ms: end }));
    expect(await until(users[2])).toBe(end);
    expect(await plusRows()).toBe(1);
  });

  it('a user id written in capital letters is the same account', async () => {
    const hook = webhook();
    const end = at(30);
    await hook.send(message('INITIAL_PURCHASE', users[0].toUpperCase(), { expiration_at_ms: end }));
    expect(await until(users[0])).toBe(end);
  });

  it.each([
    ['an id with no Peekaboo profile', NO_PROFILE],
    ['an anonymous RevenueCat id', ANONYMOUS],
    ['something made up', "x'); drop table plus_members; --"],
  ])('%s gets nothing', async (_label, who) => {
    const hook = webhook();
    expect(await hook.send(message('INITIAL_PURCHASE', who, { expiration_at_ms: at(30) })))
      .toEqual({ status: 200, body: { ok: true, ignored: 'unknown person' } });
    expect(await hook.send(message('BILLING_ISSUE', who, { grace_period_expiration_at_ms: at(16) })))
      .toEqual({ status: 200, body: { ok: true, ignored: 'unknown person' } });
    expect(await plusRows()).toBe(0);
    expect(await logged()).toHaveLength(2);
  });

  it('TEST and messages that are not about Plus starting or stopping change nothing', async () => {
    const hook = webhook();
    const end = at(9);
    await give(users[0], end);
    for (const type of ['TEST', 'SUBSCRIPTION_PAUSED', 'PRICE_INCREASE_CONSENT_REQUIRED', 'EXPERIMENT_ENROLLMENT', 'SUBSCRIBER_ALIAS', 'SOMETHING_NEW']) {
      // TEST carries a sample purchase; it must still not give anyone Plus.
      expect(await hook.send(message(type, users[1], { expiration_at_ms: at(30) }))).toEqual({ status: 200, body: { ok: true } });
      await hook.send(message(type, users[0], { expiration_at_ms: at(-1) }));
    }
    expect(await row(users[1])).toBeNull();
    expect(await until(users[0])).toBe(end);
    // The owner's setup check: the log says TEST.
    expect(logSpy.mock.calls.some((args) => String(args[0]).startsWith('TEST'))).toBe(true);
  });
});
