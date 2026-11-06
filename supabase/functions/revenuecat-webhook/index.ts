// RevenueCat webhook: RevenueCat calls this whenever someone buys, renews or stops Peekaboo+ ⭐, and it keeps
// public.plus_members up to date (that table decides who has Plus on the server, and who gets the ⭐ badge).
// Every message is also kept in private.plus_events, handy when someone says "I paid but I don't have Plus".
//
// ---------------------------------------------------------------------------------------------------------
// Owner's setup steps (once, in this order):
//  1. The migration supabase/migrations/20261215000000_peekaboo_plus.sql must be applied first (ask Claude:
//     it shows you an "Allow" pop-up).
//  2. Make up a long random password for the webhook (for example 40 letters and numbers). Keep it private.
//  3. Supabase → Edge Functions → Secrets: add REVENUECAT_WEBHOOK_AUTH with the value "Bearer <your password>".
//  4. Deploy this function (ask Claude) with "Verify JWT" switched OFF – RevenueCat doesn't log in to
//     Supabase, the password above protects it instead. (By hand: supabase functions deploy
//     revenuecat-webhook --no-verify-jwt)
//  5. RevenueCat → Project → Integrations → Webhooks → Add new webhook:
//       URL: https://vclexbnnykjpmxoyakcp.supabase.co/functions/v1/revenuecat-webhook
//       Authorization header value: "Bearer <your password>" (exactly the same as the secret in step 3)
//       Environment: both (so TestFlight test purchases work too); Events: all.
//  6. In RevenueCat press "Send test event". Supabase → Edge Functions → revenuecat-webhook → Logs should say
//     "TEST" with no error.
// ---------------------------------------------------------------------------------------------------------
//
// Late, doubled and mixed-up messages
// RevenueCat tries again when a message fails (after 5, 10, 20, 40 and 80 minutes, and the owner can resend
// any message from the dashboard), and it doesn't promise the order. So every rule below gives the right
// answer whatever order the messages come in, and the same message twice changes nothing the second time:
//  - "Plus until <date>" (bought, renewed, …) only ever moves the end date LATER, never earlier.
//  - "Ran out" only ends Plus if we don't already know a later end date (a newer renewal wins).
//  - Turning off auto-renew changes nothing: Plus keeps working to the end of the month. A refund ends it now.
//  - A payment problem changes nothing: Plus keeps working until it runs out (or until Apple's grace period
//    ends, if the owner ever switches that on).
//  - Moving a subscription to another account moves Plus too, and never cuts the new account's own Plus short.
// Field names follow RevenueCat's webhook docs ("Event types and fields").
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The RevenueCat entitlement for Peekaboo+. Messages about anything else change nothing.
const ENTITLEMENT = 'plus';

// Plus that never runs out (for example a "lifetime" gift from the RevenueCat dashboard). The table needs a
// date, so this is one far in the future.
const FOREVER = '9999-12-31T23:59:59.000Z';

// Messages that mean "has Plus until expiration_at_ms". They can only make Plus last longer.
const GIVES_PLUS = new Set([
  'INITIAL_PURCHASE', // bought
  'RENEWAL', // renewed (or bought again after it ran out)
  'UNCANCELLATION', // turned auto-renew back on
  'PRODUCT_CHANGE', // changed plan
  'NON_RENEWING_PURCHASE', // a one-off purchase, or a gift from the RevenueCat dashboard
  'SUBSCRIPTION_EXTENDED', // Apple gave extra time
  'TEMPORARY_ENTITLEMENT_GRANT', // short stand-in while the App Store is down (only if it's for Plus and has an end date)
  'REFUND_REVERSED', // Apple took a refund back, so it's paid again
]);

type RevenueCatEvent = {
  id?: string;
  type?: string;
  app_user_id?: string | null;
  original_app_user_id?: string | null;
  aliases?: string[] | null;
  product_id?: string | null;
  new_product_id?: string | null;
  entitlement_ids?: string[] | null;
  entitlement_id?: string | null; // the older one-entitlement field
  expiration_at_ms?: number | null;
  grace_period_expiration_at_ms?: number | null;
  cancel_reason?: string | null;
  store?: string | null;
  transferred_from?: string[] | null;
  transferred_to?: string[] | null;
};

type Outcome = { ignored?: string };

// Nothing to do for this message (said in the log, so the owner can see why).
function ignore(type: string, reason: string): Outcome {
  console.log(`${type}: no change (${reason})`);
  return { ignored: reason };
}

// Compares two passwords without giving away (by how long it takes) how much of the guess was right.
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Only real Peekaboo accounts count: the RevenueCat id must be a Supabase user id with a profile.
// (RevenueCat's own "anonymous" ids, or anything made up, are ignored.)
async function realPeople(ids: unknown[]): Promise<string[]> {
  const candidates = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase())),
  ];
  if (candidates.length === 0) return [];
  const { data, error } = await admin.from('profiles').select('id').in('id', candidates);
  if (error) throw error;
  const found = new Set((data ?? []).map((row: { id: string }) => row.id));
  // Keep RevenueCat's order (app_user_id first).
  return candidates.filter((id) => found.has(id));
}

// Everyone a message is about: the id RevenueCat saw last, the first one, and the other names it knows.
const peopleIn = (event: RevenueCatEvent) =>
  realPeople([event.app_user_id, event.original_app_user_id, ...list(event.aliases)]);

// A RevenueCat time (milliseconds) as a date for the database, or null if it's missing or not a real time.
function timeOf(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Is this message about Peekaboo+? (A product that isn't linked to the "plus" entitlement doesn't count.)
function aboutPlus(event: RevenueCatEvent): boolean {
  const ids = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids
    : event.entitlement_id
      ? [event.entitlement_id]
      : [];
  return ids.includes(ENTITLEMENT);
}

// Plus until `until`, but never shorter than what this person already has. Two small steps that are each
// safe on their own, so two messages at the very same moment still end with the later date:
//   1. no row yet → add one;
//   2. a row with an earlier end date → move it later (a row with a later end date is left alone).
// Gives back true if anything changed.
async function keepLater(person: string, until: string, product: string | null): Promise<boolean> {
  const now = new Date().toISOString();
  const { data: added, error: addError } = await admin
    .from('plus_members')
    .upsert(
      { user_id: person, expires_at: until, product_id: product, updated_at: now },
      { onConflict: 'user_id', ignoreDuplicates: true },
    )
    .select('user_id');
  if (addError) throw addError;
  if ((added ?? []).length > 0) return true;
  const { data: moved, error: moveError } = await admin
    .from('plus_members')
    .update({ expires_at: until, ...(product ? { product_id: product } : {}), updated_at: now })
    .eq('user_id', person)
    .lt('expires_at', until)
    .select('user_id');
  if (moveError) throw moveError;
  return (moved ?? []).length > 0;
}

// Ends Plus now for these people. Only rows that still have Plus change (an end date that's already gone
// is left as it is). With `notLaterThan`, a row whose end date is later than that is left alone too: a
// newer renewal must win over an older "ran out" message. Gives back whose Plus ended.
async function endNow(people: string[], notLaterThan?: string): Promise<string[]> {
  if (people.length === 0) return [];
  const now = new Date().toISOString();
  let change = admin
    .from('plus_members')
    .update({ expires_at: now, updated_at: now })
    .in('user_id', people)
    .gt('expires_at', now);
  if (notLaterThan) change = change.lte('expires_at', notLaterThan);
  const { data, error } = await change.select('user_id');
  if (error) throw error;
  return (data ?? []).map((row: { user_id: string }) => row.user_id);
}

// The subscription moved to another Peekaboo account (same Apple Account, someone pressed "Restore" while
// logged in to a different account). The new account gets the old one's Plus (unless it already has a later
// end date), then the old account's Plus ends. Doing it twice changes nothing more.
async function transfer(event: RevenueCatEvent): Promise<Outcome> {
  const [to] = await realPeople(list(event.transferred_to));
  const from = (await realPeople(list(event.transferred_from))).filter((id) => id !== to);
  if (!to || from.length === 0) {
    // We can't move Plus to an account we don't know (and the old account keeps what it has until it runs
    // out, so nobody who paid loses Plus because of a message we can't follow).
    return ignore('TRANSFER', 'unknown person');
  }
  const now = new Date().toISOString();
  const { data: rows, error: readError } = await admin
    .from('plus_members')
    .select('expires_at, product_id')
    .in('user_id', from)
    .gt('expires_at', now)
    .order('expires_at', { ascending: false })
    .limit(1);
  if (readError) throw readError;
  const row = rows?.[0] as { expires_at: string; product_id: string | null } | undefined;
  // First give the new account Plus, then take it from the old one: if this stops half way, RevenueCat sends
  // the message again and nobody has lost anything in between.
  if (row) await keepLater(to, new Date(row.expires_at).toISOString(), row.product_id ?? null);
  const ended = await endNow(from);
  console.log(
    row
      ? `TRANSFER: Plus moved from ${from.join(', ')} to ${to} (until ${new Date(row.expires_at).toISOString()} or later)`
      : `TRANSFER: ${from.join(', ')} had no Plus to move to ${to}`,
    ended.length ? `– ended for ${ended.join(', ')}` : '',
  );
  return {};
}

async function handle(event: RevenueCatEvent): Promise<Outcome> {
  const type = event.type!;

  // A move between accounts has no entitlement in it: it moves the whole subscription.
  if (type === 'TRANSFER') return transfer(event);

  const mayChangePlus =
    GIVES_PLUS.has(type) || type === 'EXPIRATION' || type === 'CANCELLATION' || type === 'BILLING_ISSUE';
  if (!mayChangePlus) {
    // TEST, price-change notices, Android-only pauses and anything new RevenueCat adds later.
    console.log(`${type}: no change`);
    return {};
  }

  // Messages about some other entitlement (if one is ever added), or a product that isn't linked to Plus.
  if (!aboutPlus(event)) return ignore(type, 'other entitlement');

  // 1. Bought, renewed, changed plan, turned renewing back on, got extra time: Plus until the new end date,
  //    or longer if we already know a later one (an older message that arrives late never takes time away).
  if (GIVES_PLUS.has(type)) {
    const [person] = await peopleIn(event);
    if (!person) return ignore(type, 'unknown person');
    const lifetime = type === 'NON_RENEWING_PURCHASE' && event.expiration_at_ms == null;
    const until = lifetime ? FOREVER : timeOf(event.expiration_at_ms);
    if (!until) return ignore(type, 'no end date');
    const product = (type === 'PRODUCT_CHANGE' ? event.new_product_id : null) ?? event.product_id ?? null;
    const changed = await keepLater(person, until, product);
    console.log(
      changed
        ? `${type}: Plus for ${person} until ${until}`
        : `${type}: ${person} already has Plus until ${until} or later, no change`,
    );
    return {};
  }

  // 2. Ran out: Plus stops now, unless we know a later end date (a renewal that arrived first).
  if (type === 'EXPIRATION') {
    const endedAt = timeOf(event.expiration_at_ms);
    // Without the date we can't tell old from new. Plus still stops by itself at the end date we have.
    if (!endedAt) return ignore(type, 'no end date');
    const people = await peopleIn(event);
    if (people.length === 0) return ignore(type, 'unknown person');
    const ended = await endNow(people, endedAt);
    console.log(
      ended.length
        ? `EXPIRATION: Plus ended for ${ended.join(', ')}`
        : `EXPIRATION: no change for ${people.join(', ')} (already ended, or a newer renewal is known)`,
    );
    return {};
  }

  // 3. Cancelled. Turning off auto-renew (or a price rise, or a payment problem) changes nothing: Plus keeps
  //    working until the end of the month. A refund (CUSTOMER_SUPPORT) ends Plus now, and so does the owner
  //    taking back a gift made in the RevenueCat dashboard.
  if (type === 'CANCELLATION') {
    const refund = event.cancel_reason === 'CUSTOMER_SUPPORT';
    const giftTakenBack = event.cancel_reason === 'DEVELOPER_INITIATED' && event.store === 'PROMOTIONAL';
    if (!refund && !giftTakenBack) {
      console.log(`CANCELLATION (${event.cancel_reason ?? 'no reason'}): Plus keeps working until it runs out`);
      return {};
    }
    const people = await peopleIn(event);
    if (people.length === 0) return ignore(type, 'unknown person');
    const ended = await endNow(people);
    console.log(
      `CANCELLATION (${refund ? 'refund' : 'gift taken back'}):`,
      ended.length ? `Plus ended for ${ended.join(', ')}` : `no Plus to end for ${people.join(', ')}`,
    );
    return {};
  }

  // 4. Payment problem: Plus keeps working. If Apple gives a grace period, Plus lasts until it ends.
  //    (If the payment never works, RevenueCat sends EXPIRATION later.)
  const graceUntil = timeOf(event.grace_period_expiration_at_ms);
  if (!graceUntil) {
    console.log('BILLING_ISSUE: no change, Plus keeps working until it runs out');
    return {};
  }
  const [person] = await peopleIn(event);
  if (!person) return ignore(type, 'unknown person');
  const changed = await keepLater(person, graceUntil, event.product_id ?? null);
  console.log(
    changed
      ? `BILLING_ISSUE: Plus for ${person} kept until the grace period ends (${graceUntil})`
      : `BILLING_ISSUE: no change for ${person}`,
  );
  return {};
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  // Only RevenueCat knows the password.
  const expected = Deno.env.get('REVENUECAT_WEBHOOK_AUTH') ?? '';
  if (!expected) {
    console.error('REVENUECAT_WEBHOOK_AUTH is not set');
    return json({ error: 'Not set up yet' }, 500);
  }
  if (!(await sameSecret(req.headers.get('Authorization') ?? '', expected))) {
    return json({ error: 'Not allowed' }, 401);
  }

  let body: { event?: RevenueCatEvent } | null;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Not JSON' }, 400);
  }
  const event = body && typeof body === 'object' ? body.event : undefined;
  if (!event || typeof event !== 'object' || typeof event.type !== 'string' || !event.type) {
    return json({ error: 'No event' }, 400);
  }

  // Keep a copy of every message (the same message sent twice is kept once). Everything below gives the same
  // result when it runs again, so a message that is sent twice, or retried after an error, is always safe.
  const { error: logError } = await admin.rpc('log_plus_event', {
    p_event_id: event.id ?? null,
    p_event_type: event.type,
    p_app_user_id: event.app_user_id ?? null,
    p_body: body,
  });
  if (logError) {
    console.error('Could not log the event', logError.message);
    return json({ error: logError.message }, 500); // RevenueCat tries again later
  }

  try {
    const outcome = await handle(event);
    return json({ ok: true, ...outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
    console.error(`Could not handle ${event.type}`, message);
    return json({ error: message }, 500); // RevenueCat tries again later
  }
});
