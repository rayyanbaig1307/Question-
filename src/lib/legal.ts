import { useCallback, useEffect, useState } from 'react';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// The legal documents (Terms, Privacy, Community Guidelines, Dare Safety Rules) and who has agreed to them.
// The text itself lives in legal/*.md and is copied into lib/legalDocs.ts by scripts/sync-legal.mjs.
// ---------------------------------------------------------------------------

// Bump a version when a change needs everyone to agree again – they're asked on their next open.
export const TERMS_VERSION = '2026-10-31';
export const DARE_RULES_VERSION = '2026-10-31';

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

type Document = 'terms' | 'dare_rules';

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

// Has this person agreed to the current Dare Safety Rules? `accepted` is null while checking.
// `accept()` records it.
export function useDareRulesAccepted(me: string) {
  const [accepted, setAccepted] = useState<boolean | null>(null);

  useEffect(() => {
    hasAccepted(me, 'dare_rules', DARE_RULES_VERSION)
      .then(setAccepted)
      .catch(() => setAccepted(false));
  }, [me]);

  const accept = useCallback(async () => {
    await acceptLegal('dare_rules', DARE_RULES_VERSION);
    setAccepted(true);
  }, []);

  return { accepted, accept };
}
