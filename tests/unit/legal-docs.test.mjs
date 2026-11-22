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

  // Lives 🔴 (app 1.2): the Terms don't change (old downloads must show nothing new – no re-accept screen), so
  // the live duties are in the Community Guidelines (part of the Terms) and the Live rules card, and LiveKit is
  // named in the Privacy Policy. If the Terms are changed on purpose later, update the first two lines with the
  // new TERMS_VERSION.
  it('lives: the Terms and TERMS_VERSION stay as they were; Privacy names LiveKit; the Guidelines have the live rules', () => {
    expect(file('src/lib/legal.ts')).toContain("TERMS_VERSION = '2026-11-06'");
    expect(effectiveDate(terms)).toBe('2026-11-06');
    expect(terms).not.toMatch(/LiveKit/);
    expect(file('src/lib/legal.ts')).toContain("LIVE_RULES_VERSION = '2026-11-20'");
    expect(file('src/lib/legal.ts')).toContain("DARE_RULES_VERSION = '2026-10-31'");

    // Privacy: the new date (22 Nov: the public chat), LiveKit as a provider and in the short version, and how long
    // live data is kept.
    expect(effectiveDate(privacy)).toBe('2026-11-22');
    const livekit = privacy.split('\n').find((line) => line.startsWith('| **LiveKit, Inc.**'));
    expect(livekit).toContain("doesn't keep the video or sound");
    expect(livekit).toContain('your Peekaboo user ID (a random code)');
    expect(privacy).toContain("We don't record or save it, and neither does LiveKit – but friends watching could screen-record it.");
    expect(privacy).toMatch(/Google ML Kit \(basic technical data and a random code for this install, as above\) and LiveKit/);
    expect(privacy).toContain('| Live comments | Deleted 24 hours after the live ends. |');
    expect(privacy).toContain('for 90 days – **even if an account is deleted**');
    expect(privacy).toContain('or 90 days when an adult\'s live had viewers under 18');
    expect(privacy).toContain('only people who are friends with you **both** can watch');
    expect(privacy).toContain('Only the person who is live sees who is watching');
    // The website has the new Privacy Policy (with LiveKit) too.
    expect(file('website/privacy.html')).toContain('LiveKit, Inc.');

    // Guidelines: their own live section, and a separate sentence for reporting lives (the ⋯ sentence stays exact).
    expect(guidelines).toContain('## Going live 🔴');
    expect(guidelines).toContain('**Lives are for friends only.**');
    expect(guidelines).toContain('**Bringing a friend on needs their yes.**');
    expect(guidelines).toContain("If you're under 18: no physical dares on a live without an adult there.");
    expect(guidelines).toContain("**Don't move people to other apps**");
    expect(guidelines).toContain('**Lives can be reported too:**');

    // Support answers the two live questions, and the checklist has the 1.2 rows.
    expect(support).toContain('**How do I remove someone from my live?**');
    expect(support).toContain('**How do I turn off live notifications?**');
    expect(support).toContain('**Friends going live 🔴**');
    expect(file('src/app/(app)/settings.tsx')).toContain('Friends going live 🔴');
    expect(checklist).toContain('add **no background modes**');
    expect(checklist).toContain('**live comments** (1.2)');
    expect(checklist).toContain('**watching lives**');
    expect(checklist).toMatch(/re-check this questionnaire before submitting 1\.2/);
    expect(checklist).toContain('**Re-confirm the export-compliance answer for 1.2**');
    // The permission texts in the checklist are the ones in app.json.
    const app = JSON.parse(file('app.json'));
    const camera = app.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-camera')[1];
    expect(checklist).toContain(camera.cameraPermission);
    expect(checklist).toContain(camera.microphonePermission);
  });

  // The public chat 📸 (live for everyone 22 Nov): the documents must say what the server really does
  // (supabase/migrations/20261225000000_public_chat.sql). No re-accept was wanted, so TERMS_VERSION stays.
  it('public chat: the documents match the server rules, and the Terms keep their version', () => {
    const sql = file('supabase/migrations/20261225000000_public_chat.sql');
    expect(sql).toContain("private.age_group(person) = 'adult'");
    expect(sql).toContain("f.created_at > now() - interval '30 seconds'");
    expect(sql).toContain(">= 40 then");
    expect(sql).toMatch(/count\(distinct r\.reporter_id\)[\s\S]{0,200}>= 3 then/);
    expect(sql).toContain('create policy "You can delete your own public photos"');
    expect(sql).toContain('references public.profiles (id) on delete cascade');

    expect(privacy).toContain('- **Public chat:** a photo, message or sticker you post in the public chat is seen by everyone on Peekaboo who is 18 or over');
    expect(privacy).toContain('Each photo, message and sticker shows your name, username and profile photo');
    expect(privacy).toContain('If 3 different people report a photo or message, it is hidden from everyone except you.');
    expect(privacy).toContain('| Public chat photos, messages and stickers | Shown until you delete them, or your account.');
    expect(privacy).toContain('The public chat is only for people 18 and over too');

    expect(guidelines).toContain('## Public chat 📸 (18+ only)');
    expect(guidelines).toContain('one photo every 30 seconds, and up to 40 a day');
    expect(guidelines).toContain('When 3 different people report a photo or message');
    expect(guidelines).toContain('Nobody checks photos or messages before they go up');
    // The app's menu and report words.
    const screen = file('src/app/(app)/public-chat.tsx');
    expect(screen).toContain("label: 'Report photo'");
    expect(screen).toContain("label: 'Report message'");
    expect(screen).toContain("label: 'Delete'");
    expect(guidelines).toContain('then **Report photo**');
    expect(guidelines).toContain('then **Report message**');

    expect(terms).toContain('6.5 The **public chat** is one room for everyone on Peekaboo who is 18 or over');
    expect(terms).toContain('We are not responsible for what other users post in the public chat.');
    expect(effectiveDate(terms)).toBe('2026-11-06');
    expect(file('src/lib/legal.ts')).toContain("TERMS_VERSION = '2026-11-06'");

    const ugc = checklist.split('\n').find((line) => line.startsWith('| **1.2 User-generated content**'));
    expect(ugc).toContain('**Public chat 📸**');
    expect(ugc).toContain('check reports daily, public chat reports included');
  });

  // Messages and stickers in the public chat 💬 (22 Nov): the documents must say what
  // supabase/migrations/20270102000000_public_chat_text.sql really does. TERMS_VERSION stays.
  it('public chat messages: the documents match the server rules', () => {
    const sql = file('supabase/migrations/20270102000000_public_chat_text.sql');
    // Slow mode: counted in a private list deleting doesn't change, kept 24 hours.
    expect(sql).toContain("gap interval := case what when 'message' then interval '5 seconds' else interval '30 seconds' end;");
    expect(sql).toContain("most integer := case what when 'message' then 300 else 40 end;");
    expect(sql).toContain("perform private.public_chat_slow_mode(me, 'message');");
    expect(sql).toContain("perform private.public_chat_slow_mode(me, 'photo');");
    expect(sql).toContain("delete from private.public_chat_sends s where s.sent_at <= now() - interval '24 hours';");
    expect(sql).toContain('char_length(clean) not between 1 and 300');
    expect(sql).toContain("private.blocked_word(clean, 'content')");
    expect(sql).toContain("'Links aren''t allowed in the public chat.'");
    expect(sql).toContain("'Phone numbers aren''t allowed in the public chat.'");
    expect(sql).toContain('execute function private.check_plus_sticker()');
    expect(sql).toMatch(/count\(distinct r\.reporter_id\)[\s\S]{0,200}>= 3 then/);
    expect(sql).toContain("'live', 'live_comment', 'public_message'");
    expect(sql).toContain('create policy "You can delete your own public messages"');
    expect(sql).toContain('references public.profiles (id) on delete cascade');

    expect(privacy).toContain('slurs, links and phone numbers aren\'t allowed');
    expect(privacy).toContain('When someone reports a message, its words are kept with the report');
    expect(guidelines).toContain('one message or sticker every 5 seconds, and up to 300 a day');
    expect(guidelines).toContain('A message can be up to 300 characters.');
    expect(guidelines).toContain('**No links and no phone numbers** in messages');
    expect(terms).toContain('You can post photos, messages and stickers there; links and phone numbers are not allowed in messages, or in the name and username you post with.');
    expect(terms).toContain('A photo or message that 3 different people report is hidden');
    const ugc = checklist.split('\n').find((line) => line.startsWith('| **1.2 User-generated content**'));
    expect(ugc).toContain('**Report message** on every message and sticker');
    expect(ugc).toContain('messages and stickers: one every 5 seconds, 300 a day');
    expect(checklist).toContain('| User Content → **Emails or Text Messages** | Yes | Chat, group chat and public chat messages |');
    expect(checklist).toContain('`public_message` is a public chat message or sticker');
    // The app shows the very same sentences as the server.
    const lib = file('src/lib/publicChat.ts');
    expect(lib).toContain("link: \"Links aren't allowed in the public chat.\"");
    expect(lib).toContain("phone: \"Phone numbers aren't allowed in the public chat.\"");
    expect(lib).toContain("size: 'Messages can be 1 to 300 characters.'");
    expect(sql).toContain("raise exception 'Too many accent marks on one letter.'");
    expect(lib).toContain("marks: 'Too many accent marks on one letter.'");

    // No link or phone number in your name or username while you post (messages, stickers and photos).
    const nameWords = 'Your name or username looks like a link or a phone number. Change it in Edit profile to post in the public chat.';
    expect(sql).toContain(`raise exception '${nameWords}'`);
    expect(lib).toContain(`name: '${nameWords}'`);
    expect(sql.match(/perform private\.check_public_chat_name\(me\);/g)).toHaveLength(2);
    expect(privacy).toContain('Your name and username can\'t hold a link or phone number either while you post there.');
    expect(guidelines).toContain('and not in your name or username either: change them in **Edit profile** before you post.');

    // The 24-hour note for slow mode, and the 90-day private copy of public chat reports (it outlives an account).
    expect(privacy).toContain('we note when you post each photo, message or sticker and keep that note for 24 hours, even if you delete what you posted.');
    expect(sql).toContain("now() + interval '90 days'");
    expect(sql).toContain("for each row when (new.content_type in ('public_photo', 'public_message'))\n  execute function private.keep_public_chat_report();");
    expect(sql).toContain('create table if not exists private.public_chat_report_copies');
    expect(sql).not.toMatch(/public_chat_report_copies \([^)]*references/);
    expect(privacy).toContain('| Reported public chat photos and messages | When a public chat photo or message is reported, we keep a private copy of the report');
    expect(privacy).toContain('for 90 days – **even if the message, the photo or an account is deleted**');
    expect(privacy).toContain('copies of reports about public chat photos and messages (kept 90 days, see above)');
    expect(privacy).toContain('(reports about lives and the public chat: see below)');
    expect(checklist).toContain('`public_chat_report_copies`');
    // A repeat report does nothing.
    expect(sql).toContain('create trigger reports_once_public_chat before insert on public.reports');
    expect(ugc).toContain("reporting the same thing twice doesn't count (or push) twice");
  });

  it('the README is up to date for a paid app on Cloudflare Pages', () => {
    expect(readme).not.toMatch(/free app with no payments|GitHub Pages|\[OPERATOR NAME\]|\[CONTACT EMAIL\]/);
    expect(readme).toContain('Cloudflare Pages');
    expect(readme).toContain('https://peekaboo-4gz.pages.dev');
    expect(readme).toMatch(/Mailing address:\*\* left out on purpose/);
  });
});
