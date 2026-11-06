// The legal documents: the copies in the app (src/lib/legalDocs.ts) and on the website (website/) must match
// legal/*.md, and the paid-app wording Apple checks (Peekaboo+ terms, RevenueCat in the Privacy Policy) must be
// there. The documents must also say what the app and the database really do (who can add you as a friend, how
// to report, who approves community dares). If this fails after editing legal/, run
// `node scripts/sync-legal.mjs` and `node scripts/build-website.mjs`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
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

// Everything from `heading` onwards is for the operator, not users (same as the two scripts).
const cutFrom = (text, heading) => {
  const at = text.indexOf(heading);
  return at === -1 ? text : text.slice(0, at).trim();
};

// The newest version of a SQL function (migrations run in filename order, so the last one that makes it wins):
// that's the rule the database uses now. Returns just that function, up to its closing "$$;".
const newestFunction = (name) => {
  const dir = 'supabase/migrations';
  const made = new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`, 'gi');
  const names = readdirSync(join(root, dir)).filter((n) => n.endsWith('.sql')).sort();
  let found = null;
  for (const n of names) {
    const text = file(`${dir}/${n}`);
    for (const match of text.matchAll(made)) found = text.slice(match.index, text.indexOf('$$;', match.index));
  }
  if (!found) throw new Error(`No migration makes ${name}`);
  return found;
};

const terms = legal('TERMS_OF_SERVICE.md');
const privacy = legal('PRIVACY_POLICY.md');
const guidelines = legal('COMMUNITY_GUIDELINES.md');
const support = legal('SUPPORT.md');
const dareRulesFull = legal('DARE_SAFETY_RULES.md');
const dareRules = cutFrom(dareRulesFull, '## The "I understand" screen');
const checklist = legal('APPLE_APP_STORE_CHECKLIST.md');
const readme = legal('README.md');

describe('legal documents', () => {
  it('the app shows the same text as legal/*.md', () => {
    const docs = appCopy();
    expect(docs.terms).toBe(terms);
    expect(docs.privacy).toBe(privacy);
    expect(docs.guidelines).toBe(guidelines);
    expect(docs['dare-rules']).toBe(dareRules);
    // The operator-only part never reaches the app.
    expect(docs['dare-rules']).not.toContain('Dare content review');
  });

  it('every website page shows the text of its legal/*.md file', () => {
    // The same steps as scripts/build-website.mjs: Markdown → HTML, and links to the .md files go to the pages.
    const pages = [
      ['support.html', support],
      ['privacy.html', privacy],
      ['terms.html', terms],
      ['guidelines.html', guidelines],
      ['dare-safety.html', dareRules],
    ];
    const pageFor = Object.fromEntries([
      ['SUPPORT.md', 'support.html'],
      ['PRIVACY_POLICY.md', 'privacy.html'],
      ['TERMS_OF_SERVICE.md', 'terms.html'],
      ['COMMUNITY_GUIDELINES.md', 'guidelines.html'],
      ['DARE_SAFETY_RULES.md', 'dare-safety.html'],
    ]);
    for (const [page, markdown] of pages) {
      const body = marked
        .parse(markdown, { breaks: true })
        .replace(/href="([A-Z_]+\.md)(#[^"]*)?"/g, (all, md, hash = '') => (pageFor[md] ? `href="${pageFor[md]}${hash}"` : all));
      expect(file(`website/${page}`), `website/${page} is out of date – run node scripts/build-website.mjs`).toContain(`<main>${body}</main>`);
    }
    expect(file('website/dare-safety.html')).not.toContain('Dare content review');
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
    // Every reason in the app's report menu (src/lib/safety.ts), without its emoji.
    const reasons = file('src/lib/safety.ts').match(/REPORT_REASONS = \[([\s\S]*?)\] as const/)[1];
    const labels = [...reasons.matchAll(/label: '([^']+)'/g)].map((m) => m[1].replace(/[^A-Za-z -]/g, '').trim().toLowerCase());
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const label of labels) expect(guidelines.toLowerCase()).toContain(label);
  });

  it('the Privacy Policy says who can add you as a friend the way the database does it', () => {
    // The database: friends at once only with an adult's public account; otherwise a request
    // (supabase/migrations/20261220000000_launch_safety.sql).
    const addFriend = newestFunction('public.send_friend_request');
    expect(addFriend).toMatch(/they_are_private or private\.age_group\(target\) is distinct from 'adult'/);
    expect(privacy).toContain(
      'if your account is public and you are 18 or over, anyone can add you as a friend straight away. If you are under 18 (or haven\'t saved your birthday), or your account is private, people send a request that you can accept or decline.',
    );
    expect(privacy).not.toMatch(/if your account is public, anyone can add you as a friend straight away/);
    expect(privacy).toContain('Nobody can add someone under 18 as a friend straight away');
    // The Terms never promise the opposite.
    expect(terms).not.toMatch(/add (you|anyone|a public account) as a friend straight away/i);
  });

  it('the Privacy Policy and the App Privacy answers mention ML Kit\'s random code for each install', () => {
    expect(privacy).toContain('a random code for this install');
    const google = privacy.split('\n').find((line) => line.startsWith('| **Google LLC**'));
    expect(google).toContain('a random code for this install');
    const deviceId = checklist.split('\n').find((line) => line.startsWith('| Identifiers → **Device ID**'));
    expect(deviceId).toContain('ML Kit');
    expect(deviceId).toContain('**Analytics**');
    expect(deviceId).toContain('**Tracking: No**');
    const diagnostics = checklist.split('\n').find((line) => line.startsWith('| Diagnostics → **Performance Data**'));
    expect(diagnostics).toContain('ML Kit data-disclosure page');
  });

  it('the Guidelines and Support say how to report: ⋯ menu, or press and hold a comment or chat message', () => {
    const menu = 'For a post, story, peek, profile, Guess Who post, dare idea or hit up, tap its **⋯** menu.';
    const hold = 'For a comment or a chat message, **press and hold** it.';
    for (const doc of [guidelines, support]) {
      expect(doc).toContain(menu);
      expect(doc).toContain(hold);
    }
    // The old Support text sent people to a ⋯ on comments, which don't have one.
    expect(support).not.toMatch(/⋯\*\* on any post, story, peek, comment/);
    // The app really works that way: comments and chat messages open their menu with a long press.
    expect(file('src/app/(app)/comments/[postId].tsx')).toMatch(/onLongPress=\{\(\) => \{[\s\S]{0,160}openMenu\(item\)/);
    expect(file('src/app/(app)/chat/[id].tsx')).toMatch(/onLongPress=\{\(\) => \{[\s\S]{0,160}openMenu\(item\)/);
    expect(file('src/app/(app)/groups/chat/[id].tsx')).toContain('onLongPress={() => openMessageMenu(item)}');
  });

  it('Support answers cancel, restore and refund for Peekaboo+', () => {
    expect(support).toContain('**Settings → your name → Subscriptions → Peekaboo+**');
    expect(support).toContain('**Restore purchases**');
    expect(support).toContain('**reportaproblem.apple.com**');
    // The same words as the Peekaboo+ screen and the Terms.
    expect(file('src/app/(app)/plus.tsx')).toContain('Restore purchases');
    expect(terms).toContain('Settings → your name → Subscriptions → Peekaboo+');
  });

  it('the Dare Safety Rules say community dares need our OK, like the database', () => {
    // The database only picks an approved idea (supabase/migrations/20261220000000_launch_safety.sql).
    const pick = newestFunction('public.pick_daily_dare');
    expect(pick).toMatch(/d\.approved_at is not null/);
    expect(dareRules).toContain("A dare idea only becomes everyone's daily dare after the Peekaboo team has read it and approved it.");
    const row = checklist.split('\n').find((line) => line.includes('Physical harm, dares'));
    expect(row).toContain('approve');
    expect(row).toContain('1.4.5');
    expect(row).not.toContain('1.4.1');
  });

  it('the README is up to date for a paid app on Cloudflare Pages', () => {
    expect(readme).not.toMatch(/free app with no payments|GitHub Pages|\[OPERATOR NAME\]|\[CONTACT EMAIL\]/);
    expect(readme).toContain('Cloudflare Pages');
    expect(readme).toContain('https://peekaboo-4gz.pages.dev');
    expect(readme).toMatch(/Mailing address:\*\* left out on purpose/);
  });
});
