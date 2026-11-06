// The legal documents: the copies in the app (src/lib/legalDocs.ts) and on the website (website/) must match
// legal/*.md, and the paid-app wording Apple checks (Peekaboo+ terms, RevenueCat in the Privacy Policy) must be
// there. If this fails after editing legal/, run `node scripts/sync-legal.mjs` and `node scripts/build-website.mjs`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const legal = (name) => file(`legal/${name}`).trim();

// The app's copy is plain JSON inside a TypeScript file.
const appCopy = () => {
  const text = file('src/lib/legalDocs.ts');
  const start = text.indexOf('= {') + 2;
  const end = text.lastIndexOf('} as const');
  return JSON.parse(text.slice(start, end + 1));
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "6 November 2026" → "2026-11-06"
const effectiveDate = (markdown) => {
  const match = markdown.match(/\*\*Effective date:\*\* (\d{1,2}) (\w+) (\d{4})/);
  if (!match) throw new Error('No effective date');
  const month = MONTHS.indexOf(match[2]) + 1;
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
};

const terms = legal('TERMS_OF_SERVICE.md');
const privacy = legal('PRIVACY_POLICY.md');
const guidelines = legal('COMMUNITY_GUIDELINES.md');

describe('legal documents', () => {
  it('the app shows the same text as legal/*.md', () => {
    const docs = appCopy();
    expect(docs.terms).toBe(terms);
    expect(docs.privacy).toBe(privacy);
    expect(docs.guidelines).toBe(guidelines);
  });

  it('the website was rebuilt after the last change', () => {
    for (const [page, markdown] of [['terms.html', terms], ['privacy.html', privacy]]) {
      const date = markdown.match(/\*\*Effective date:\*\* (\d{1,2} \w+ \d{4})/)[1];
      expect(file(`website/${page}`)).toContain(`<strong>Effective date:</strong> ${date}`);
    }
    expect(file('website/terms.html')).toContain('reportaproblem.apple.com');
    expect(file('website/privacy.html')).toContain('RevenueCat, Inc.');
  });

  it('people are asked to agree again when the Terms change', () => {
    const version = file('src/lib/legal.ts').match(/TERMS_VERSION = '(\d{4}-\d{2}-\d{2})'/)[1];
    // A newer effective date means new Terms: TERMS_VERSION must be bumped to at least that day.
    expect(version >= effectiveDate(terms)).toBe(true);
  });

  it('the Terms have the subscription wording Apple asks for', () => {
    expect(terms).not.toMatch(/Peekaboo is free\.|this is nil/);
    expect(terms).toContain('2865113 Ontario Inc.');
    expect(terms).toContain('## 9. Peekaboo+ (optional subscription)');
    expect(terms).toContain('Apple Account');
    expect(terms).toContain('renews **every month**');
    expect(terms).toContain('at least 24 hours before the end of the current month');
    expect(terms).toContain('Settings → your name → Subscriptions');
    expect(terms).toContain('reportaproblem.apple.com');
    expect(terms).toContain('does not cancel your subscription');
    expect(terms).toContain('Sign in with Apple');
  });

  it('the Privacy Policy names RevenueCat, the face filters and the Peekaboo+ insights', () => {
    expect(privacy).toContain('**RevenueCat, Inc.**');
    expect(privacy).toContain('ML Kit');
    expect(privacy).toContain('never store face points');
    expect(privacy).toContain('Show me in Profile views');
    expect(privacy).toContain('⭐ badge');
    expect(privacy).not.toMatch(/do \*\*not\*\* collect: contacts\/address book, health data, financial information/);
  });

  it('the Guidelines list the report reasons the app offers', () => {
    expect(guidelines).toMatch(/dangerous dare/);
    expect(guidelines).toMatch(/self-harm/);
  });
});
