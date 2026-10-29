// Peek Match helper (runs on Supabase, not on the phone):
// - the ID + selfie age check, done by Stripe Identity ("start-age-check" / "check-age");
// - leaving Peek Match, which deletes all your dating data and photos ("leave").
// Needs the secret STRIPE_SECRET_KEY (a Stripe key that's allowed to use Identity, including reading the
// date of birth). Until it's added, the age check answers "not_set_up".
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY');

const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function stripe(path: string, body?: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? `Stripe said ${response.status}`);
  return data;
}

// 18 or older on today's date?
function isAdult(dob: { year: number; month: number; day: number }): boolean {
  const today = new Date();
  const eighteenth = new Date(Date.UTC(dob.year + 18, dob.month - 1, dob.day));
  return eighteenth.getTime() <= Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
}

const pad = (n: number) => String(n).padStart(2, '0');

// Every file in a folder (and its sub-folders) of a storage bucket.
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return [];
  const paths: string[] = [];
  for (const item of data) {
    const path = `${prefix}/${item.name}`;
    if (item.id) paths.push(path);
    else paths.push(...(await listAll(bucket, path)));
  }
  return paths;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Where Stripe sends you when the check is finished.
  if (req.method === 'GET' && url.searchParams.has('done')) {
    return new Response('All done ✅\n\nYou can close this page and go back to Peekaboo 👀', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  // Who is asking? Everything here only ever touches the logged-in person's own data.
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Not logged in' }, 401);
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who.user) return json({ error: 'Not logged in' }, 401);
  const userId = who.user.id;

  const { action } = await req.json().catch(() => ({ action: null }));
  const { data: check } = await admin.from('age_checks').select('*').eq('user_id', userId).maybeSingle();

  try {
    if (action === 'start-age-check') {
      if (!check) return json({ error: 'Add your birthday first' }, 400);
      if (check.blocked) return json({ error: 'Peek Match is only for adults (18+)' }, 403);
      if (check.check_state === 'verified') return json({ state: 'verified' });
      if (!STRIPE_KEY) return json({ error: 'not_set_up' }, 503);
      const session = await stripe(
        'identity/verification_sessions',
        new URLSearchParams({
          type: 'document',
          'options[document][require_matching_selfie]': 'true',
          'options[document][require_live_capture]': 'true',
          'metadata[user_id]': userId,
          return_url: `${SUPABASE_URL}/functions/v1/peek-match?done=1`,
        }),
      );
      await admin
        .from('age_checks')
        .update({ check_session: session.id, check_state: 'pending', check_error: null })
        .eq('user_id', userId);
      return json({ url: session.url });
    }

    if (action === 'check-age') {
      if (!check) return json({ state: 'not_started', blocked: false });
      if (!check.check_session || check.check_state === 'verified') {
        return json({ state: check.check_state, blocked: check.blocked, error: check.check_error });
      }
      if (!STRIPE_KEY) return json({ error: 'not_set_up' }, 503);
      const session = await stripe(`identity/verification_sessions/${check.check_session}?expand[]=verified_outputs.dob`);

      if (session.status === 'verified') {
        const dob = session.verified_outputs?.dob;
        if (!dob?.year || !dob?.month || !dob?.day) {
          const error = "We couldn't read the date of birth from your ID";
          await admin.from('age_checks').update({ check_state: 'failed', check_error: error }).eq('user_id', userId);
          return json({ state: 'failed', blocked: check.blocked, error });
        }
        const adult = isAdult(dob);
        await admin
          .from('age_checks')
          .update({
            check_state: 'verified',
            verified_birthday: `${dob.year}-${pad(dob.month)}-${pad(dob.day)}`,
            verified_at: new Date().toISOString(),
            blocked: check.blocked || !adult,
            check_error: null,
          })
          .eq('user_id', userId);
        return json({ state: 'verified', blocked: check.blocked || !adult });
      }
      // Not finished yet (or Stripe is still looking at it).
      if (session.status === 'processing' || (session.status === 'requires_input' && !session.last_error)) {
        return json({ state: 'pending', blocked: check.blocked });
      }
      // It didn't work (blurry photo, selfie didn't match, cancelled…) – you can try again.
      const error =
        session.last_error?.reason ?? (session.status === 'canceled' ? 'The check was cancelled' : "The check didn't go through");
      await admin.from('age_checks').update({ check_state: 'failed', check_error: error }).eq('user_id', userId);
      return json({ state: 'failed', blocked: check.blocked, error });
    }

    if (action === 'leave') {
      const { data: member } = await admin.from('dating_members').select('dating_id').eq('user_id', userId).maybeSingle();
      if (member) {
        const paths = await listAll('media', `dating/${member.dating_id}`);
        for (let i = 0; i < paths.length; i += 100) {
          await admin.storage.from('media').remove(paths.slice(i, i + 100));
        }
        // Deleting your membership deletes your dating profile, likes, matches and chats with it.
        const { error } = await admin.from('dating_members').delete().eq('user_id', userId);
        if (error) throw error;
      }
      return json({ left: true });
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Something went wrong' }, 500);
  }
  return json({ error: 'Unknown action' }, 400);
});
