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
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The RevenueCat entitlement for Peekaboo+.
const ENTITLEMENT = 'plus';

// Events that mean "has Plus until expiration_at_ms".
const GIVES_PLUS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
]);

type RevenueCatEvent = {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  product_id?: string;
  entitlement_ids?: string[] | null;
  expiration_at_ms?: number | null;
  transferred_from?: string[];
  transferred_to?: string[];
};

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

// Only real Peekaboo accounts count: the RevenueCat id must be a Supabase user id with a profile.
// (RevenueCat's own "anonymous" ids, or anything made up, are ignored.)
async function realPeople(ids: (string | undefined | null)[]): Promise<string[]> {
  const candidates = [...new Set(ids.filter((id): id is string => !!id && UUID.test(id)).map((id) => id.toLowerCase()))];
  if (candidates.length === 0) return [];
  const { data, error } = await admin.from('profiles').select('id').in('id', candidates);
  if (error) throw error;
  const found = new Set((data ?? []).map((row: { id: string }) => row.id));
  // Keep RevenueCat's order (app_user_id first).
  return candidates.filter((id) => found.has(id));
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

  let body: { event?: RevenueCatEvent };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Not JSON' }, 400);
  }
  const event = body.event;
  if (!event?.type) return json({ error: 'No event' }, 400);

  // 1. Keep a copy of every message (the same event sent twice is kept once).
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

  // Events for some other entitlement (if one is ever added) don't change Peekaboo+.
  if (event.entitlement_ids && event.entitlement_ids.length > 0 && !event.entitlement_ids.includes(ENTITLEMENT)) {
    return json({ ok: true, ignored: 'other entitlement' });
  }

  try {
    // 2. Bought, renewed, changed plan, turned renewing back on, or got extra time: Plus until the new end date.
    if (GIVES_PLUS.has(event.type)) {
      const [person] = await realPeople([event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])]);
      if (!person) return json({ ok: true, ignored: 'unknown person' });
      if (!event.expiration_at_ms) return json({ ok: true, ignored: 'no end date' });
      const { error } = await admin.from('plus_members').upsert({
        user_id: person,
        expires_at: new Date(event.expiration_at_ms).toISOString(),
        product_id: event.product_id ?? null,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      console.log(`${event.type}: Plus for ${person} until ${new Date(event.expiration_at_ms).toISOString()}`);
      return json({ ok: true });
    }

    // 3. Ran out: Plus stops now.
    if (event.type === 'EXPIRATION') {
      const people = await realPeople([event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])]);
      if (people.length === 0) return json({ ok: true, ignored: 'unknown person' });
      const { error } = await admin
        .from('plus_members')
        .update({ expires_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in('user_id', people);
      if (error) throw error;
      console.log(`EXPIRATION: Plus ended for ${people.join(', ')}`);
      return json({ ok: true });
    }

    // 4. The subscription moved to another Peekaboo account (same Apple ID, someone "restored" on a different
    //    account): move the row from the old account to the new one.
    if (event.type === 'TRANSFER') {
      const from = await realPeople(event.transferred_from ?? []);
      const [to] = await realPeople(event.transferred_to ?? []);
      if (!to || from.length === 0) return json({ ok: true, ignored: 'unknown person' });
      const { data: rows, error: readError } = await admin
        .from('plus_members')
        .select('expires_at, product_id')
        .in('user_id', from)
        .order('expires_at', { ascending: false })
        .limit(1);
      if (readError) throw readError;
      const row = rows?.[0];
      if (row) {
        const { error: upsertError } = await admin.from('plus_members').upsert({
          user_id: to,
          expires_at: row.expires_at,
          product_id: row.product_id,
          updated_at: new Date().toISOString(),
        });
        if (upsertError) throw upsertError;
      }
      const { error: deleteError } = await admin
        .from('plus_members')
        .delete()
        .in('user_id', from.filter((id) => id !== to));
      if (deleteError) throw deleteError;
      console.log(`TRANSFER: Plus moved from ${from.join(', ')} to ${to}`);
      return json({ ok: true });
    }

    // CANCELLATION (renewing switched off – Plus still works until it runs out), BILLING_ISSUE (Apple is
    // still trying to charge), TEST and anything else: nothing to change.
    console.log(`${event.type}: no change`);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
    console.error(`Could not handle ${event.type}`, message);
    return json({ error: message }, 500); // RevenueCat tries again later
  }
});
