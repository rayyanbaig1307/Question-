// Builds Peekaboo's small public website (website/) from the legal documents in legal/*.md:
// the home page (the glass landing page from glass/), Support, Privacy Policy, Terms of Service, Community Guidelines and Dare Safety Rules.
// Apple and Google both need the Privacy Policy (and Support) at a public web address.
// It also makes the invite page (invite.html): where personal invite links go (…/invite?c=<code>).
//
//   node scripts/build-website.mjs
//
// Run it after changing anything in legal/ (together with scripts/sync-legal.mjs), then upload the website/
// folder again (Cloudflare → Workers & Pages → peekaboo → Create deployment → upload the folder).
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'website');
const read = (name) => readFileSync(join(root, 'legal', name), 'utf8').replace(/\r\n/g, '\n').trim();
// Everything from `heading` onwards is for the operator, not users (same as scripts/sync-legal.mjs).
const cutFrom = (text, heading) => {
  const at = text.indexOf(heading);
  return at === -1 ? text : text.slice(0, at).trim();
};

// Each page: the web address (file), the document and the short name in the menu.
const pages = [
  { file: 'support.html', md: 'SUPPORT.md', title: 'Support' },
  { file: 'privacy.html', md: 'PRIVACY_POLICY.md', title: 'Privacy Policy' },
  { file: 'terms.html', md: 'TERMS_OF_SERVICE.md', title: 'Terms of Service' },
  { file: 'guidelines.html', md: 'COMMUNITY_GUIDELINES.md', title: 'Community Guidelines' },
  { file: 'dare-safety.html', md: 'DARE_SAFETY_RULES.md', title: 'Dare Safety Rules', cut: '## The "I understand" screen' },
];
// Links between the documents point at the .md files – on the website they go to the pages.
const linkFor = Object.fromEntries(pages.map((page) => [page.md, page.file]));
const fixLinks = (html) => html.replace(/href="([A-Z_]+\.md)(#[^"]*)?"/g, (all, md, hash = '') =>
  linkFor[md] ? `href="${linkFor[md]}${hash}"` : all);

const contact = (read('SUPPORT.md').match(/[\w.+-]+@[\w-]+\.[\w.-]+/) ?? [''])[0];
const year = new Date().getFullYear();

// The invite page uses the same download links and invite codes as the app, read straight from the app's code
// so they can never be different: src/lib/invite.ts (download links) and src/lib/inviteCode.ts (codes).
const source = (name) => readFileSync(join(root, 'src/lib', name), 'utf8');
const setting = (text, pattern, what) => {
  const found = text.match(pattern);
  if (!found) throw new Error(`Could not find ${what} in src/lib – the invite page needs it`);
  return found[1];
};
const inviteSource = source('invite.ts');
const codeSource = source('inviteCode.ts');
const appStoreLink = setting(inviteSource, /export const APP_STORE_LINK = '([^']+)'/, 'APP_STORE_LINK');
const androidLink = (inviteSource.match(/export const ANDROID_LINK: string \| null = '([^']+)'/) ?? [])[1] ?? null;
const codeAlphabet = setting(codeSource, /export const INVITE_CODE_ALPHABET = '([A-Z0-9]+)'/, 'INVITE_CODE_ALPHABET');
const codeLength = Number(setting(codeSource, /export const INVITE_CODE_LENGTH = (\d+);/, 'INVITE_CODE_LENGTH'));
const site = setting(codeSource, /export const INVITE_SITE = '([^']+)'/, 'INVITE_SITE');

const css = `
:root{--bg:#fff;--text:#14121f;--muted:#5d5873;--card:#f5f2fb;--line:#e6e0f2;--accent:#8650db;--pink:#fe59a5}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b10;--text:#f4f2fa;--muted:#a9a3bf;--card:#17151f;--line:#2a2638;--accent:#b18cff;--pink:#ff7ab8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
header.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header.bar a.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;color:var(--text);text-decoration:none;letter-spacing:-.5px}
header.bar img{width:40px;height:32px;object-fit:contain}
nav{display:flex;gap:14px;flex-wrap:wrap;font-size:15px}
nav a{color:var(--muted);text-decoration:none}nav a:hover,nav a.on{color:var(--text)}
main{max-width:760px;margin:0 auto;padding:28px 20px 60px}
main h1{font-size:34px;line-height:1.2;letter-spacing:-.5px}
main h2{margin-top:2em;font-size:23px}main h3{font-size:19px}
table{width:100%;border-collapse:collapse;display:block;overflow-x:auto;font-size:15px}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--card)}
blockquote{margin:1em 0;padding:4px 16px;border-left:4px solid var(--pink);background:var(--card);border-radius:8px}
code{background:var(--card);padding:2px 5px;border-radius:5px}
footer{border-top:1px solid var(--line);padding:24px 20px;text-align:center;color:var(--muted);font-size:14px}
footer a{color:var(--muted)}
.hero{background:linear-gradient(135deg,#fe59a5,#e469c7 50%,#8650db);color:#fff;text-align:center;padding:72px 20px 80px}
.hero img{width:190px;max-width:60%;height:auto}
.hero h1{margin:14px 0 6px;font-size:56px;letter-spacing:-2px;line-height:1}
.hero p{margin:0 auto;max-width:520px;font-size:20px;font-weight:700;opacity:.92}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;max-width:900px;margin:-40px auto 0;padding:0 20px}
.features div{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px}
.features b{display:block;font-size:18px;margin-bottom:4px}
.features span{color:var(--muted);font-size:15px}
[hidden]{display:none!important}
.invite{text-align:center;padding:40px 20px 8px;max-width:560px;margin:0 auto}
.invite img{width:120px;height:auto}
.invite h1{font-size:34px;line-height:1.2;letter-spacing:-.5px;margin:12px 0 8px}
.invite .lead{color:var(--muted);margin:0 0 20px}
.invite .label{color:var(--muted);font-size:14px;font-weight:700;text-transform:uppercase;margin:0}
.invite .code{font:800 34px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:4px;margin:4px 0 20px;overflow-wrap:anywhere}
.invite .missing{background:var(--card);border-radius:14px;padding:12px 16px}
.buttons{display:flex;flex-direction:column;gap:12px;margin:8px 0}
.btn{display:block;padding:15px 20px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--text);font-weight:800;text-decoration:none}
.btn.primary{background:linear-gradient(135deg,#fe59a5,#8650db);border:0;color:#fff}
.steps li{margin-bottom:10px}
`;

const nav = (current) =>
  pages.map((page) => `<a href="${page.file}"${page.file === current ? ' class="on"' : ''}>${page.title}</a>`).join('');

const layout = ({ title, current, body, home = false, head = '', script = '' }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Peekaboo – a camera-first app for close friends: stories, disappearing peeks, chat and a daily dare.">
${head}<link rel="icon" href="favicon.png">
<style>${css}</style>
</head>
<body>
<header class="bar"><a class="brand" href="index.html"><img src="logo-eyes.png" alt="">peekaboo</a><nav>${nav(current)}</nav></header>
${home ? body : `<main>${body}</main>`}
<footer>© ${year} 2865113 Ontario Inc. · <a href="mailto:${contact}">${contact}</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a> · <a href="support.html">Support</a></footer>
${script ? `<script>${script}</script>\n` : ''}</body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(root, 'assets/images/logo-eyes.png'), join(out, 'logo-eyes.png'));
copyFileSync(join(root, 'assets/images/favicon.png'), join(out, 'favicon.png'));

for (const page of pages) {
  const text = page.cut ? cutFrom(read(page.md), page.cut) : read(page.md);
  const body = fixLinks(marked.parse(text, { breaks: true }));
  writeFileSync(join(out, page.file), layout({ title: `${page.title} – Peekaboo`, current: page.file, body }));
}

writeFileSync(
  join(out, 'index.html'),
  layout({
    title: 'Peekaboo',
    home: true,
    body: `<section class="hero"><img src="logo-eyes.png" alt="Peekaboo eyes"><h1>peekaboo</h1>
<p>Peek it. Share it. Gone in 24h – or forever on your profile.</p></section>
<section class="features">
<div><b>👀 Peeks</b><span>Photos and videos for your friends that disappear after they're seen.</span></div>
<div><b>🎯 Daily dare</b><span>A new dare every day. Do it, post it, see who else did.</span></div>
<div><b>⏰ The drop</b><span>Once a day, everyone gets 2 minutes to show what they're doing.</span></div>
<div><b>🕵️ Guess Who</b><span>Post a mystery photo and let your friends guess who it is.</span></div>
</section>
<main><h2>For close friends only</h2>
<p>Your stories, peeks and chats go to the people you choose. No ads, and we never sell your data.
Peekaboo is for ages 13 and up.</p>
<p>Questions? See <a href="support.html">Support</a> or email <a href="mailto:${contact}">${contact}</a>.</p></main>`,
  }),
);

// The invite page: personal invite links (…/invite?c=<code>, or …/invite#<code>) open this.
// On purpose it shows NO name and asks no server anything: just the code, the download buttons and
// "Open in Peekaboo" (peekaboo://invite/<code>). The app shows who the invite is from once you're logged in.
// noindex: search engines don't list it. no-referrer: the code isn't passed on to the App Store or anyone else.
const invitePage = `<section class="invite">
<img src="logo-eyes.png" alt="Peekaboo eyes">
<h1>You're invited to Peekaboo 👀</h1>
<p class="lead">A friend wants to add you on Peekaboo – stories, peeks, chat and a daily dare, just for close friends.</p>
<div id="has-code" hidden><p class="label">Invite code</p><p class="code" id="code"></p></div>
<p class="missing" id="no-code" hidden>This link is missing its invite code. Ask your friend to send their link again.</p>
<div class="buttons">
<a class="btn primary" id="open" hidden>Open in Peekaboo</a>
<a class="btn" href="${appStoreLink}">Get Peekaboo on the App Store</a>
${androidLink ? `<a class="btn" href="${androidLink}">Get Peekaboo for Android</a>\n` : ''}</div>
</section>
<main><h2>How it works</h2>
<ol class="steps">
<li><b>Already have Peekaboo?</b> Tap <b>Open in Peekaboo</b>, then tap <b>Add</b>.</li>
<li><b>New to Peekaboo?</b> Get the app and make your account. Then come back to this page and tap <b>Open in Peekaboo</b>.</li>
<li><b>Button not working?</b> Open Peekaboo, go to your profile → ⚙️ <b>Settings</b> → <b>Invite friends</b>, and type the code under <b>Got a code from a friend?</b></li>
<li>If Peekaboo says it can't find the page, close the app completely and open it again so it updates, then tap <b>Open in Peekaboo</b> again.</li>
</ol>
<p>Only add people you know in real life.</p></main>`;

// Reads the code from the link, checks it the same way the app does (src/lib/inviteCode.ts), and shows it.
// It's put in with textContent (never as HTML), and nothing is sent anywhere.
const inviteScript = `
(function () {
  var ALPHABET = '${codeAlphabet}';
  var LENGTH = ${codeLength};
  function clean(text) {
    var code = String(text || '').trim().toUpperCase().replace(/[\\s\\-\\u2010-\\u2015]/g, '');
    if (code.length !== LENGTH) return null;
    for (var i = 0; i < code.length; i++) if (ALPHABET.indexOf(code.charAt(i)) === -1) return null;
    return code;
  }
  function decode(part) {
    try { return decodeURIComponent(String(part || '').replace(/\\+/g, ' ')); } catch (e) { return part; }
  }
  function fromLink() {
    var pairs = location.search.replace(/^\\?/, '').split('&');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i].split('=');
      if (pair[0] === 'c') return decode(pair[1]);
    }
    return decode(location.hash.replace(/^#/, ''));
  }
  var code = clean(fromLink());
  if (!code) {
    document.getElementById('no-code').hidden = false;
    return;
  }
  document.getElementById('code').textContent = code.slice(0, 5) + '-' + code.slice(5);
  document.getElementById('has-code').hidden = false;
  var open = document.getElementById('open');
  open.href = 'peekaboo://invite/' + code;
  open.hidden = false;
})();
`;

writeFileSync(
  join(out, 'invite.html'),
  layout({
    title: "You're invited to Peekaboo 👀",
    home: true,
    head: `<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<meta property="og:type" content="website">
<meta property="og:title" content="You're invited to Peekaboo 👀">
<meta property="og:description" content="A friend wants to add you on Peekaboo – the camera app for close friends.">
<meta property="og:image" content="${site}/logo-eyes.png">
`,
    body: invitePage,
    script: inviteScript,
  }),
);

// A missing page says so instead of showing the host's default error.
writeFileSync(join(out, '404.html'), layout({ title: 'Not found – Peekaboo', body: '<h1>Page not found</h1><p><a href="index.html">Go to the home page</a></p>' }));
// The home page is the glass landing page (glass/): its index.html replaces the plain home page above, and
// its css, js, fonts and three.js folders come along. The plain one stays as the fallback if glass/ is missing.
const glass = join(root, 'glass');
if (existsSync(join(glass, 'index.html'))) {
  copyFileSync(join(glass, 'index.html'), join(out, 'index.html'));
  for (const folder of ['css', 'js', 'fonts', 'vendor']) cpSync(join(glass, folder), join(out, folder), { recursive: true });
}

console.log(`Wrote website/ (${['index.html', ...pages.map((page) => page.file), 'invite.html'].join(', ')})`);
