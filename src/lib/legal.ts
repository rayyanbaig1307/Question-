import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from './supabase';
import { knownAgreedDoc, rememberAgreedDoc } from './termsCache';

// ---------------------------------------------------------------------------
// The legal documents (Terms, Privacy, Community Guidelines, Dare Safety Rules) and who has agreed to them.
// The text itself lives in legal/*.md and is copied into lib/legalDocs.ts by scripts/sync-legal.mjs.
// ---------------------------------------------------------------------------

// Bump a version when a change needs everyone to agree again – they're asked on their next open.
export const TERMS_VERSION = '2026-11-06';
export const DARE_RULES_VERSION = '2026-10-31';
// The Live rules card 🔴 (components/live/LiveRulesSheet.tsx): agreed once before your first live or your first
// time on someone's live. Bump it when the card's rules change. (The Terms themselves didn't change for lives,
// so TERMS_VERSION stays as it is and older app downloads show nothing new.)
export const LIVE_RULES_VERSION = '2026-11-20';

// The documents you can open in the app (/legal/<key>).
export const LEGAL_PAGES = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  guidelines: 'Community Guidelines',
  'dare-rules': 'Dare Safety Rules',
} as const;
export type LegalPage = keyof typeof LEGAL_PAGES;

// Links inside the documents point at the .md files – these are the pages they open.
export const LEGAL_FILE_TO_PAGE: Record<string, LegalPage> = {
  'TERMS_OF_SERVICE.md': 'terms',
  'PRIVACY_POLICY.md': 'privacy',
  'COMMUNITY_GUIDELINES.md': 'guidelines',
  'DARE_SAFETY_RULES.md': 'dare-rules',
};

// The contact email from the documents, once it's been filled in (null while it's still a placeholder).
export function contactEmail(terms: string): string | null {
  const match = terms.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return match ? match[0] : null;
}

type Document = 'terms' | 'dare_rules' | 'live_rules';

// Records that you agreed (the database stamps the time).
export async function acceptLegal(document: Document, version: string): Promise<void> {
  const { error } = await supabase.rpc('accept_legal', { doc: document, ver: version });
  if (error) throw error;
}

export async function hasAccepted(me: string, document: Document, version: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('legal_acceptances')
    .select('version', { count: 'exact', head: true })
    .eq('user_id', me)
    .eq('document', document)
    .eq('version', version);
  if (error) throw error;
  return (count ?? 0) > 0;
}

// Has this person ever agreed to any version of the Terms? Accounts made with Apple or Google haven't until
// they finish the setup screen (components/ProfileSetup.tsx).
export async function hasAcceptedAnyTerms(me: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('legal_acceptances')
    .select('version', { count: 'exact', head: true })
    .eq('user_id', me)
    .eq('document', 'terms');
  if (error) throw error;
  return (count ?? 0) > 0;
}

// Has this person agreed to the current Dare Safety Rules? `accepted` is null while checking.
// - It starts as true straight away when this phone remembers they agreed (lib/termsCache.ts), so the drop's Send
//   never waits for the server. The server is still asked quietly every time, and its answer wins.
// - `ensure()`: for Send when the answer isn't known yet – waits for the check (it gives up after 20 seconds,
//   like every request) and says whether they agreed. If the check fails and the phone doesn't know, it says no
//   (then the "Before your first dare" sheet shows).
// - `accept()` records it on the server, then remembers it on this phone.
export function useDareRulesAccepted(me: string) {
  const knownHere = () => knownAgreedDoc(me, 'dare_rules', DARE_RULES_VERSION);
  const [answer, setAnswer] = useState<{ me: string; accepted: boolean | null }>(() => ({ me, accepted: knownHere() ? true : null }));
  const checking = useRef<{ me: string; request: Promise<boolean> } | null>(null);

  const check = useCallback((): Promise<boolean> => {
    if (checking.current?.me === me) return checking.current.request;
    const request = hasAccepted(me, 'dare_rules', DARE_RULES_VERSION).then(
      (yes) => {
        if (yes) rememberAgreedDoc(me, 'dare_rules', DARE_RULES_VERSION);
        setAnswer({ me, accepted: yes });
        return yes;
      },
      () => {
        // No answer (no internet?): someone this phone knows has agreed just carries on. Asked again next time.
        checking.current = null;
        const known = knownAgreedDoc(me, 'dare_rules', DARE_RULES_VERSION);
        setAnswer({ me, accepted: known });
        return known;
      },
    );
    checking.current = { me, request };
    return request;
  }, [me]);

  useEffect(() => {
    check();
  }, [check]);

  const accepted = answer.me === me ? answer.accepted : knownHere() ? true : null;

  const ensure = useCallback(async (): Promise<boolean> => {
    if (accepted === true) return true;
    return check();
  }, [accepted, check]);

  const accept = useCallback(async () => {
    await acceptLegal('dare_rules', DARE_RULES_VERSION);
    rememberAgreedDoc(me, 'dare_rules', DARE_RULES_VERSION);
    checking.current = { me, request: Promise.resolve(true) };
    setAnswer({ me, accepted: true });
  }, [me]);

  return { accepted, accept, ensure };
}
