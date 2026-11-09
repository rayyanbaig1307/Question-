// The website's invite page (website/invite.html, made by scripts/build-website.mjs) and what the Privacy
// Policy says about invite links. The page must show only the code (no name, no server call, no key), use the
// same download links and the same code rules as the app, and be up to date with the build script.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { afterAll, describe, expect, it } from 'vitest';

import { loadLibrary } from './libHarness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const page = file('website/invite.html');
const code = loadLibrary('inviteCode');
const constant = (name) => file('src/lib/invite.ts').match(new RegExp(`export const ${name}[^=]*= '([^']+)'`))[1];

// Runs the page's own script for a web address, with a tiny stand-in for the browser.
function runPage(href) {
  const url = new URL(href);
  const elements = {};
  for (const id of ['code', 'has-code', 'no-code', 'open']) elements[id] = { id, hidden: true, textContent: '', href: '' };
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    location: { search: url.search, hash: url.hash, href },
    document: { getElementById: (id) => elements[id] },
  });
  return elements;
}

describe('the website invite page', () => {
  const temp = mkdtempSync(join(tmpdir(), 'peekaboo-site-'));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('is up to date with scripts/build-website.mjs (run it after changing the invite page or the links)', () => {
    // Build a fresh copy somewhere else and compare (the year in the footer may differ).
    for (const part of ['scripts/build-website.mjs', 'legal', 'src/lib/invite.ts', 'src/lib/inviteCode.ts', 'assets/images/logo-eyes.png', 'assets/images/favicon.png']) {
      mkdirSync(dirname(join(temp, part)), { recursive: true });
      cpSync(join(root, part), join(temp, part), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
    execFileSync(process.execPath, [join(temp, 'scripts/build-website.mjs')], { stdio: 'pipe' });
    const year = (text) => text.replace(/© \d{4}/, '© YEAR');
    expect(year(readFileSync(join(temp, 'website/invite.html'), 'utf8')), 'run: node scripts/build-website.mjs').toBe(year(page));
  });

  it('shows no name, asks no server anything, and holds no key', () => {
    expect(page).toContain("<h1>You're invited to Peekaboo 👀</h1>");
    for (const banned of [/supabase/i, /sb_publishable/i, /\beyJ[\w-]{10,}/, /apikey/i, /fetch\(/, /XMLHttpRequest/, /invite_preview/, /config\.js/, /innerHTML/]) {
      expect(page).not.toMatch(banned);
    }
    // Nothing anywhere on the website has a key or a config file either.
    const files = readdirSync(join(root, 'website'));
    expect(files).not.toContain('config.js');
    for (const name of files.filter((name) => name.endsWith('.html'))) {
      expect(file(`website/${name}`), name).not.toMatch(/sb_publishable|supabase\.co/i);
    }
  });

  it('is kept out of search engines and does not pass the code on to other websites', () => {
    expect(page).toContain('<meta name="robots" content="noindex">');
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
    expect(page).toContain(`<meta property="og:title" content="You're invited to Peekaboo 👀">`);
  });

  it('uses the same download links as the app (src/lib/invite.ts)', () => {
    expect(page).toContain(`<a class="btn" href="${constant('APP_STORE_LINK')}">Get Peekaboo on the App Store</a>`);
    expect(page).toContain(`<a class="btn" href="${constant('ANDROID_LINK')}">Get Peekaboo for Android</a>`);
    expect(page).toContain("If Peekaboo says it can't find the page, close the app completely and open it again so it updates");
  });

  it('shows the code from ?c= or #, and the Open in Peekaboo button opens peekaboo://invite/<code>', () => {
    for (const href of [
      'https://peekaboo-4gz.pages.dev/invite?c=BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev/invite?utm=x&c=bcdfg-hjklm',
      'https://peekaboo-4gz.pages.dev/invite#BCDFGHJKLM',
      'https://peekaboo-4gz.pages.dev/invite?c=BCDFG%2DHJKLM',
    ]) {
      const shown = runPage(href);
      expect(shown.code.textContent, href).toBe('BCDFG-HJKLM');
      expect(shown['has-code'].hidden).toBe(false);
      expect(shown.open.hidden).toBe(false);
      expect(shown.open.href).toBe('peekaboo://invite/BCDFGHJKLM');
      expect(shown['no-code'].hidden).toBe(true);
    }
  });

  it('a link without a working code shows a note and no Open button (and never puts the text on the page)', () => {
    for (const href of [
      'https://peekaboo-4gz.pages.dev/invite',
      'https://peekaboo-4gz.pages.dev/invite?c=',
      'https://peekaboo-4gz.pages.dev/invite?c=%3Cimg%20src%3Dx%3E',
      'https://peekaboo-4gz.pages.dev/invite?c=AEIOUAEIOU',
      'https://peekaboo-4gz.pages.dev/invite#%E0%A4%A',
    ]) {
      const shown = runPage(href);
      expect(shown['no-code'].hidden, href).toBe(false);
      expect(shown.open.hidden).toBe(true);
      expect(shown.open.href).toBe('');
      expect(shown.code.textContent).toBe('');
    }
  });

  it('checks codes exactly like the app does (src/lib/inviteCode.ts)', () => {
    expect(page).toContain(`var ALPHABET = '${code.INVITE_CODE_ALPHABET}';`);
    expect(page).toContain(`var LENGTH = ${code.INVITE_CODE_LENGTH};`);
    const samples = ['BCDFGHJKLM', 'bcdfg-hjklm', ' bcd fgh jkl m ', 'BCDFG–HJKLM', 'ABCDFGHJKL', 'BCDFGHJKL', 'BCDFGHJKLMN', '23456789BC', 'BCDFGHJKL0', 'bcdfg_hjklm'];
    for (const sample of samples) {
      const shown = runPage(`https://peekaboo-4gz.pages.dev/invite?c=${encodeURIComponent(sample)}`);
      const app = code.normalizeInviteCode(sample);
      expect(shown.open.hidden ? null : shown.open.href.replace('peekaboo://invite/', ''), sample).toBe(app);
    }
  });
});

describe('the Privacy Policy and invite links', () => {
  const privacy = file('legal/PRIVACY_POLICY.md');

  it('says what the invite page and the app show, and that a link is never easier than adding by username', () => {
    expect(privacy).toContain('- **Invite links:** you can share your own invite link (Settings → Invite friends).');
    expect(privacy).toContain('The invite web page only shows the invite code – never your name or photo.');
    expect(privacy).toContain('straight away only if your account is public and you are 18 or over, otherwise with a friend request.');
    expect(privacy).toContain('You can get a new link at any time, and the old one stops working.');
    expect(privacy).toContain('your invite code, and whose invite links you used and when (to stop misuse)');
    // The old sentence about adding friends is still there, word for word.
    expect(privacy).toContain("If you are under 18 (or haven't saved your birthday), or your account is private, people send a request that you can accept or decline.");
  });

  it('the app copy and the website have the new wording too', () => {
    expect(file('src/lib/legalDocs.ts')).toContain('The invite web page only shows the invite code – never your name or photo.');
    expect(file('website/privacy.html')).toContain('The invite web page only shows the invite code – never your name or photo.');
  });
});
