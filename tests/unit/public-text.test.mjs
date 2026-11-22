import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// The checks on public chat messages (src/lib/publicText.ts): how a message is tidied, and no links and no phone
// numbers. The same cases run against the database in tests/database/public-chat-text.test.mjs, so the app and
// the server always agree.
const { cases, messages } = JSON.parse(readFileSync('tests/support/public-text-cases.json', 'utf8'));
const lib = loadLibrary('publicText');
const show = (text) => JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);

it.each(cases)('%s → %s', (text, problem) => {
  expect(lib.publicTextProblem(text)).toBe(problem);
});

it.each(messages.map(([typed, problem, saved]) => [show(typed), typed, problem, saved]))(
  'the message %s', (_, typed, problem, saved) => {
    expect(lib.publicMessageProblem(typed)).toBe(problem);
    if (problem === null) {
      expect(lib.tidyPublicText(typed)).toBe(saved);
      expect(lib.hasPublicText(typed)).toBe(true);
    }
  });

it('the four lists are the same as the database\'s (private.public_text_lists)', () => {
  const sql = readFileSync('supabase/migrations/20270102000000_public_chat_text.sql', 'utf8');
  const list = (name) => {
    const found = sql.match(new RegExp(`'${name}', jsonb_build_array\\(([^)]*)\\)`));
    expect(found, name).toBeTruthy();
    return [...found[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  };
  expect(list('endings')).toEqual([...lib.LINK_ENDINGS]);
  expect(list('said')).toEqual([...lib.SAID_ENDINGS]);
  expect(list('spaced')).toEqual([...lib.SPACED_ENDINGS]);
  expect(list('mail')).toEqual([...lib.MAIL_NAMES]);
  // A space after the dot is only for endings that are never everyday words.
  for (const word of ['me', 'co', 'gg', 'tv', 'uk', 'ca', 'app', 'info', 'link', 'site']) expect(lib.SPACED_ENDINGS).not.toContain(word);
});

it('a message with nothing to see can\'t be sent: spaces, zero-width and blank-looking characters', () => {
  for (const blank of ['', '   ', '\u200B', '\u3164', '\u2800', '\u200B \u200B', '\n\t']) {
    expect(lib.hasPublicText(blank), JSON.stringify(blank)).toBe(false);
    expect(lib.publicMessageProblem(blank)).toBe('size');
  }
  expect(lib.hasPublicText(' 👋 ')).toBe(true);
});

it('names and usernames: a link or a phone number in them is caught, ordinary names are fine', () => {
  expect(lib.hasLinkOrPhone('add me t.me/promo123 📲')).toBe(true);
  expect(lib.hasLinkOrPhone('promo123.com')).toBe(true);
  expect(lib.hasLinkOrPhone(null, 'Jess 07911 123456')).toBe(true);
  expect(lib.hasLinkOrPhone('sam_smith', 'Sam Smith 🌸', null, undefined)).toBe(false);
  expect(lib.hasLinkOrPhone('john.smith', 'J.R.')).toBe(false);
});
