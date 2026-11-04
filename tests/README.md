# Local QA suite

Branch: `claude/mobile-social-app-expo-h090jm`. The QA round 2 audit checked the app as it was at
`a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1`. The audit started at `b0dc637`; the only change in between
was the Android download link, which was included and checked. The supplied fixes are commit `ac246c3`.
The later review fixes and their tests are the commits after it on this branch. All of it is local only:
nothing is pushed, deployed, migrated on the hosted project or published. The release order is in
`docs/HANDOFF.md`.

## Run the tests

Install Node (the suite was written with Node 24 on Windows and also runs with Node 22 on Linux) and run
`npm ci`. No `.env`, Supabase project, account, real JWT or service key is needed. Do not configure the
suite to use a real backend.

```sh
npm test
npm run typecheck
npm run lint
npx expo install --check
```

`npm test` first runs the rendered frontend checks (`tests/frontend`) and the database checks
(`tests/database/*.test.mjs`) with `node --test`, then the API/library checks (`tests/api`, `tests/unit`)
with Vitest. The two parts are joined with `&&`: if the first part fails, Vitest does not run. Use
`npm run test:api` to run the Vitest part on its own. The newest counts are under "Latest results" at the
end of this file.

PGlite executes the actual migrations, constraints, functions and RLS. Auth, Storage metadata, Vault,
cron, push queues and native/provider services have local stand-ins. Queued notifications never leave the
machine. The three Edge Function handlers are executed with fake HTTP, Auth, Apple and Storage responses.
These are not hosted Edge gateway tests.

## What the newer test files cover

Database (PGlite, part of `npm test`):

- `security.test.mjs`, `round2.test.mjs`: the first and second QA rounds' database rules. `round2` was
  changed where it expected the old behaviour: you can only report what you can see, and an author's
  delete of reported content now works quietly while the file is kept hidden for the report.
- `review-media.test.mjs`: keeps can only use your own files; reports only for content you can see, with
  the reported person taken from the content; a dismissed report lets go of its files, a reviewed one
  keeps them; every app delete waits for the daily cleanup, so nobody can tell whether they were reported;
  only allow-listed functions can be run by app users; `can_cleanup_snap` adds no lock rows for files that
  do not exist; cleanup and report lookups use indexes.
- `review-robustness.test.mjs`: an account with very many peeks can still be deleted; big deletes use only
  a few lock-table entries; each file name has its own lock row; old malformed messages keep working while
  new bad ones are refused (the message rules are now triggers, not NOT VALID checks).
- `username-auth-limits.test.mjs`: the SQL side of the username login limits. Only the server can reserve or
  give back a try, the old call still works during the update, a refund gives back exactly one request's
  tries, and old rows are cleaned up a few at a time.
- `word-filter.test.mjs`: the database word filter on public text (usernames, display names, bios,
  captions, Guess Who captions, comments, hit ups, dare ideas, group names). It covers disguises (dots,
  fancy letters, invisible characters, look-alike letters, accents), real names that must still save,
  private chat staying unfiltered, safe names for Apple/Google sign-up, and the 2,000-character guard.
- `fresh-database.test.mjs`: a brand-new empty database takes every migration with no accounts made first;
  the report-alert migration adds the owner only when that account exists; `includeFixes:false` leaves out
  the hardening migration and every later one.
- `final-db.test.mjs`: a hidden dare idea cannot be reported to learn who wrote it; the daily cleanup lists
  the same files as before but only checks files that still exist; the local database gives new public
  functions to app roles the way a hosted project does; the preflight file only reads, labels every query
  and finds what it should on an untouched database; its "names must still be free" list matches the names
  in the migration files.
- `local-db.test.mjs`: the `applyMigrationFile` helper works on PGlite and keeps nothing of a file that fails.

API and library (Vitest, part of `npm test`):

- `tests/api/username-auth-limits.test.mjs`: the username-auth function running the real SQL. 8 wrong tries
  per name and address, 40 per name from all addresses, 30 per address; a correct login gives its try back;
  an outage fails closed and gives tries back. The address comes from `cf-connecting-ip`, otherwise from
  `X-Forwarded-For` read from the end (forged entries ignored); IPv6 counts per /64 block.
- `tests/api/delete-account-review.test.mjs`: an iPhone signed in to a different Apple ID can still delete
  the account, and an Apple login that is not the caller's is never cancelled. An Apple code from an account
  with no Apple login is never sent to Apple, and the account is still deleted.
- `tests/api/delete-account-release-order.test.mjs`: deployed before the database update, delete-account
  changes nothing (not even the Apple link). Apple is only contacted once the deletion is opened and the
  Guess Who file list has loaded.
- `tests/unit/word-filter-parity.test.mjs`: the app's filter (`src/lib/cleanWords.ts`) and the database's
  give the same answer: same word lists, a fixed word list, every invisible and look-alike letter, accents,
  and thousands of seeded random strings. Run it after changing either side.
- `tests/unit/username-search.test.mjs`: friend search sends `_` as a real underscore (not "any one letter"),
  drops `%`, `*` and `\` that the person typed, and `likePrefix` escapes `_`, `%` and `\`.
- `tests/unit/chat-delete.test.mjs`: a deleted peek or voice note counts as deleted even when its file
  clean-up fails; a delete the server refuses still shows the error.
- `tests/unit/media-urls-hook.test.mjs`: photos stay on screen when a new photo arrives, links for photos that
  left are dropped, and nothing carries over to a different login.
- Changed: `edge-security.test.mjs` (word filter in username sign-up), `apple-deletion.test.mjs` (a
  password-only account that sends an Apple code is now deleted, still without contacting Apple),
  `auth-provider.test.mjs` (logout and profile reload never mix up two accounts),
  `account-deletion-client.test.mjs` (plain error messages from the delete server), `group-chat.test.mjs`
  and `upload-integrity.test.mjs` (group photo and upload clean-up keep the real error).

Frontend (rendered screens, part of `npm test`):

- `home-pager.test.cjs`: phones still use the real native pager with the same settings; the web pager starts
  on the page asked for, reports swipes like the native one, and a swipe past Chat does not make the browser
  go back.
- `web-capture.test.cjs`: in a browser, Send to and Save in the editor say they need the phone app; on phones
  they work as before.
- Changed: `terms.test.cjs` (one pop-up only: a plain cover while checking, the Terms page only when agreeing
  is needed, "Couldn't check" after 15 seconds), `social-setup.test.cjs` (the Apple/Google setup check with
  Try again), `settings.test.cjs` (queued privacy saves, deletion after leaving Settings, switch rows not
  marked disabled), `navigation.test.cjs` (no screen until the saved login has loaded, so a start-up link is
  kept), `editor.test.cjs` (chat-dare proof when the dare is gone).

## Real PostgreSQL and HTTP tests (Windows and Linux)

These extra scripts use the pinned portable PostgreSQL 16.15 dependency. They pick the right PostgreSQL
and PostgREST build for Windows or Linux. They create throw-away clusters, bind only to `127.0.0.1`, use
invented accounts and shut servers down in finally handlers. Allow local sockets/processes in your test
runner. Cluster files stay under `.qa/` for inspection.

```sh
npm run test:concurrency
npm run test:rest:setup
npm run test:rest
npm run test:preflight
```

The setup downloads PostgREST 16.5 from its official GitHub release and checks the pinned SHA-256 (one for
Windows, one for Linux) before unpacking it into `.qa/tools/postgrest/`. Internet access is needed for this
one setup step and for installing dependencies. The HTTP tests use real signed test JWTs, expired/forged
tokens, role changes and RLS over HTTP. They include 1,000 reads from 40 synthetic users at 32 concurrent
requests and 240 group writes from 24 authors at 24 concurrent requests. Check authorization and exact
counts as well as speed. Results go to `.qa/rest-after.json` (`.qa/rest-before.json` with `QA_ORIGINAL=1`).
The old "known medium" public-name moderation bypass is fixed (OPEN-01) and is now covered by passing
word-filter checks over HTTP.

Newer HTTP checks: username search escaping (a hand-written pattern, and the app's own `searchUsers`
through supabase-js); the Community dares list loaded with the app's own `fetchIdeas`; a hidden dare idea
cannot be reported to learn who wrote it; app users cannot call the username-limit functions; the word
filter over HTTP (f.u.c.k, fancy letters, invisible and look-alike letters, accents, real names still save,
a huge comment refused quickly, a 1:1 chat dare not filtered).

Newer concurrency scenarios: report and delete races (evidence kept quietly, dismissal releases it, a
report that loses the race keeps nothing), parallel username logins (correct ones never use up the
wrong-password allowance; wrong ones stop at 8 per name and address and 40 per name), a 25,000-peek account
deletion and other heavy deletes racing posts, reports, file deletes and uploads, and a daily cleanup that
stays fast with 20,000 old peeks.

### On Linux: run as a normal user

The portable PostgreSQL refuses to run as `root`. On Linux, run the real-PostgreSQL scripts
(`test:concurrency`, `test:rest`, `test:preflight`) as an ordinary user, and let that user write to the
project's `.qa/` folder first (once, as root: `mkdir -p .qa && chown -R <user> .qa`; `.qa/` is not in Git,
so a fresh copy does not have it yet). For example:

```sh
su <user> -s /bin/bash -c 'cd <project folder> && PATH=<node folder>/bin:$PATH npm run test:rest'
```

On the Claude cloud machine that is
`su claude -s /bin/bash -c 'cd /home/user/Question- && PATH=/opt/node22/bin:$PATH node tests/integration/postgrest.mjs'`.

With `QA_ORIGINAL=1` the loaders read the old code with `git show`. Git refuses a repository that belongs to
another user, so mark the project folder as safe for that one command:

```sh
su <user> -s /bin/bash -c 'cd <project folder> && PATH=<node folder>/bin:$PATH GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=<project folder> QA_ORIGINAL=1 npm run test:rest'
```

On the Claude cloud machine that is
`su claude -s /bin/bash -c 'cd /home/user/Question- && PATH=/opt/node22/bin:$PATH GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/home/user/Question- QA_ORIGINAL=1 node tests/integration/postgrest.mjs'`.

### Larger stress pass

On Windows PowerShell:

```powershell
$env:QA_STRESS='1'
npm run test:rest
Remove-Item Env:QA_STRESS
```

On Linux: `QA_STRESS=1 npm run test:rest` (as a normal user, see above).

This mode uses 100 invented accounts, 10,000 reads at 128 concurrent requests and 2,400 group writes at 64
concurrent requests. Both modes run the same checks; the request count is load volume, not more test cases.

Storage metadata is exposed only in this local fixture to exercise ownership and deleted-user RLS through
HTTP. The real Storage HTTP/S3 service, GoTrue signup, hosted gateway and realtime server are not running.
This suite cannot certify their configuration, physical byte deletion, push delivery or distributed load.

## Release rehearsal (real PostgreSQL, not part of `npm test`)

`npm run test:preflight` runs `tests/database/preflight-rehearsal.mjs` (on Linux as a normal user, see above).
It rehearses the release on a throw-away local PostgreSQL 16 server:

1. It builds the database as the live app has it now (every migration before `20261213102659`) with invented
   people, and saves the kinds of old rows the live app allowed: a forfeit paid twice, broken chat messages,
   a keep pointing at someone else's photo, reports, bad words in public text (and the same words in private
   chat).
2. It runs `tests/database/deployment-preflight.sql` (read from disk each time, one query at a time, each
   read-only) and checks that every query lists exactly those rows.
3. It applies the new migrations one file at a time, each in its own transaction. The hardening migration
   must stop cleanly while a forfeit is paid twice; the rehearsal then fixes that by hand and applies the rest.
4. It checks the old rows still work, then runs the preflight again on the finished database (twice) and on a
   brand-new empty one.

The rehearsal fails if `deployment-preflight.sql` loses a query for any problem it seeds, or gains a
`[HARD BLOCKER]` query it does not know. An unknown `[INFO]` query only has to run, and is shown as a NOTE.
A migration newer than the ones the rehearsal knows is also shown as a NOTE: it is applied, but nothing extra
is checked for it.
When you add a new kind of query, teach the rehearsal what it should list (`kindOf`/`keysOf` and the expected
sets in the script).

Output: PASS / FAIL / NOTE lines and "N passed; M failed". The exit code is 1 on any FAIL. NOTE lines are
information, not failures. Options:

- `QA_NATIVE_ROOT=<folder>`: where the throw-away cluster goes (default `.qa/`).
- `QA_KEEP_CLUSTER=1`: keep the cluster folder afterwards (it is deleted by default).
- `QA_PREFLIGHT_SQL=<path>`: run against another copy of the preflight file (for example to check that a
  wrong query is caught).

Limits: the Supabase auth, storage, vault and cron schemas are local stand-ins, as in the other database
tests. Old rows are saved through the old app rules where the app had a way in (as the user); hit ups and
the dare nomination are inserted directly. It applies files by name, like the other tests, so it does not
prove what the Supabase CLI does (see the duplicate migration version note in `docs/HANDOFF.md`).

## Browser tests

```sh
npm run test:browser:build
npm run test:browser
```

Playwright needs Chrome or Chromium. It uses, in this order: the path in `QA_CHROME_PATH`, Chrome at the
normal Windows path, or the Chromium preinstalled at `/opt/pw-browsers/chromium` (on the Claude cloud
machine it is already there). Otherwise install Playwright's own with `npx playwright install chromium`.
The build ignores `.env` and substitutes `qa-backend.invalid` and a fake key. Playwright blocks all
off-machine requests except that fake host, which it intercepts. It uses temporary browser profiles, never
the user's logged-in browser. Results go to `.qa/browser-results.json`.

The suite has 72 checks: 24 on each of three screen sizes (320px and 412px phones, and desktop). All are
expected to pass and none is skipped. The website is checked in light and dark mode, including all legal
pages, links, image loading, overflow and a real 404. Logged-out app forms cover empty/hostile inputs,
taken/free names, bad login, timeout/retry, back, refresh and protected links. Signed-in checks (against the
fake backend) cover the Settings privacy switch after a failed save, the home page and its Chat / Camera /
Home tabs, the editor's "please use the phone app" message, and a link to `/settings` opening that page
instead of home.

The signed-in web app no longer crashes in the pager (OPEN-02 is fixed). Phones use the native pager
(`src/components/home/HomePager.tsx`); the browser uses a small web version (`HomePager.web.tsx`). On the web
a tap at the very end of a page slide can be dropped, so the signed-in checks wait until the pages have
stopped moving before they tap. This web-only quirk does not affect phones.

## Reproducing the original failures

Frontend, API and library loaders support `QA_ORIGINAL=1` in a clone that contains the audited commit; they
read the old source with `git show`, without changing the working tree (as another user on Linux, see the
`safe.directory` note above). Database fixtures accept `includeFixes:false`. It leaves out every migration
whose file name sorts at or after `20261213102659_qa_round2_security_hardening.sql` (`FIRST_FIX_MIGRATION` in
`tests/database/local-db.mjs`): the hardening migration and every later fix migration, including new ones.
The concurrency script always runs both the original and the fixed database; only a failure in the fixed one
fails the run. For HTTP, `QA_ORIGINAL=1` leaves out the same migrations and loads the old app code.
Original failures are intentional evidence, not a green baseline. A source ZIP without Git history can run
the fixed tests but not the original-source loaders.

## Limits and release checks

See `docs/QA_API_ROUND2.md`, `docs/QA_FRONTEND_FINDINGS.md`, `tests/database/findings.txt` and
`docs/QA_REPORT.txt` (its INTEGRATION UPDATE says what happened to each open item) for severity,
reproduction, fixes and evidence. 39/39 public tables have RLS; this flag alone does not prove every possible
policy combination.

Before the release, run `deployment-preflight.sql` read-only on a copy, one query at a time; the full release
order is in `docs/HANDOFF.md`. The unique forfeit index deliberately refuses old duplicate forfeit payments:
that query is a `[HARD BLOCKER]` to sort out by hand. Old malformed chat messages are kept and keep working.
Since `20261213210000` the message rules are triggers that check new rows and changes to the checked fields,
so there is nothing to "validate later". The local database has no owner account: on a fresh database nobody
gets report alerts until the owner adds themselves by hand (see `README.md`).

Real Apple/Google login and token revocation, device camera/audio/codecs/maps, push, screenshots/gestures,
Storage bytes and hosted realtime/cron still require a disposable integrated test environment and physical
devices. No production data was read or changed, no real message was sent, and nothing was deployed.

## Latest results

Final local run on 2026-11-04, Linux, on the branch with every fix in place. Everything ran on this
machine with invented users: PGlite, a local PostgreSQL 16 and a local PostgREST 16.5. Nothing was
pointed at the hosted project.

| What | Command | Result |
| --- | --- | --- |
| Frontend + database (PGlite) | `npm test` (node part) | 335 passed, 0 failed, 0 skipped |
| API, units, Edge Functions (Vitest) | `npm test` (vitest part) | 25 files, 317 passed, 0 failed |
| Type check | `npm run typecheck` | no errors |
| Lint | `npm run lint` | no errors |
| Expo package versions | `npx expo install --check` | "Dependencies are up to date" |
| Real PostgreSQL concurrency | `npm run test:concurrency` (as a normal user) | qa_fixed 30 passed, 0 failed |
| Real HTTP + signed logins | `npm run test:rest` (as a normal user) | 66 passed, 0 failed |
| Real HTTP stress | `QA_STRESS=1 npm run test:rest` | 66 passed, 0 failed; 2,400 writes (64 at once) in 3.0 s, 10,000 reads (128 at once) in 6.2 s, 95% of reads answered within 125 ms |
| Release rehearsal | `npm run test:preflight` (as a normal user) | 154 passed, 0 failed, 1 NOTE (not a failure: the newest migration, 20261214100000, is applied, but the rehearsal has no extra checks of its own for it; tests/database/final-db.test.mjs covers it) |
| Browser (3 screen sizes) | `node tests/browser/build.mjs && npx playwright test`, run 4 times | 72 passed each run, 0 failed, 0 flaky, 0 skipped |
| Security advisories | `npm audit` / `npm audit --omit=dev` | 4 moderate, all in the lint tools (eslint-config-expo -> eslint-plugin-import / eslint-plugin-react -> minimatch); 0 in the app itself |

The concurrency, stress and rehearsal runs, and 3 of the 4 browser runs, were made just before the last
small fix (the Community dares list leaves out ideas from people who blocked you). `npm test`, type check,
lint, the HTTP check and one browser run were repeated after it.

Old code for comparison: the concurrency script always also builds the old database (every migration
before 20261213102659), and all 16 of its qa_original scenarios fail. `QA_ORIGINAL=1 npm run test:rest`
(the live a9e5ddf app code with that old database) gives 48 passed and 14 failed. Those failures are the
problems this round fixes, so they are expected.

The 4 lint-tool advisories have no fix that works with the eslint-config-expo version this Expo SDK
expects; they never ship in the app.

Not tested here: real phones, real Apple/Google sign-in, the hosted Supabase project (its Storage,
its PostgREST version, its cf-connecting-ip header) and push delivery. See docs/TESTING.md Step 62.
