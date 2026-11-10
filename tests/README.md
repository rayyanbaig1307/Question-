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
machine. The four Edge Function handlers (including revenuecat-webhook) are executed with fake HTTP, Auth, Apple and Storage responses.
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
  captions, Guess Who captions, comments, hit ups, dare ideas, group names). Only usernames block swearing
  (the owner's choice, 5 Nov); display names may swear but not hold a slur, and the test checks which place
  each column uses. It covers disguises (dots, fancy letters, invisible characters, look-alike letters,
  accents) on swearing in usernames and slurs in display names, real names that must still save (and the
  username check's own real-name rule: "Moby Dick" passes, "big dick" and "DICK" don't), private
  chat staying unfiltered, safe names for Apple/Google sign-up (a shared name that swears is kept, one with a
  slur is swapped), and the 2,000-character guard.
- `fresh-database.test.mjs`: a brand-new empty database takes every migration with no accounts made first;
  the report-alert migration adds the owner only when that account exists; `includeFixes:false` leaves out
  the hardening migration and every later one.
- `final-db.test.mjs`: a hidden dare idea cannot be reported to learn who wrote it; the daily cleanup lists
  the same files as before but only checks files that still exist; the local database gives new public
  functions to app roles the way a hosted project does; the preflight file only reads, labels every query
  and finds what it should on an untouched database; its "names must still be free" list matches the names
  in the migration files.
- `plus-extras.test.mjs`: Peekaboo+ extras. Peek-a-Save brings back a daily or chat dare streak only for Plus,
  only within 24 hours, once a month, only with a friend, and pushes the friend; a drop rewind only works for
  Plus, once a week, and can't be changed later; a Guess Who hint is Plus only, one per post, never names who
  posted it, and isn't given after you've guessed. Nobody can write those tables directly.
- `local-db.test.mjs`: the `applyMigrationFile` helper works on PGlite and keeps nothing of a file that fails.
- `plus-insights.test.mjs`: Peekaboo+ insights (`20261217000000_plus_insights.sql`). A profile visit is saved at
  most once an hour, never for yourself or across a block; "Show me in Profile views" off hides you and your own
  viewers; story re-opens are counted; screenshots send the owner a push without a name; free users get counts
  only and Plus users get who; the tables can't be read directly; deleting an account removes its rows.
- `group-dare-votes.test.mjs`: group dares get a group vote, Legit 🔥 or Cap 🧢
  (`20261216000000_group_dare_votes.sql`). A new proof starts at 0/0 and doesn't count, even if the app sends
  totals or the "old proof" flag; the poster, people outside the group, a blocked pair, a different logged-in
  account and visitors can't vote, the dare's sender can; one vote each, changeable and taken back, with the
  totals always equal to the votes table (also after 120 votes in separate transactions; PGlite runs them one
  at a time, so votes at the very same moment are only checked by `npm run test:concurrency`); a vote only
  counts while the voter is in the group, and only people who were in it when the proof was posted can vote
  (someone added later is refused with a clear message on older proofs but can vote on newer ones; the very
  same moment counts, one microsecond later doesn't; the app can't add a member row or move its join time back,
  while adding people, read marks, mute and leaving still work; spare accounts can't join to vote, and the
  ones added before the proof that vote Legit and leave change nothing; someone removed and added back can't
  vote again on older proofs; being removed takes your votes away; your votes in other groups and the votes on your own proofs stay; a
  group with votes can still be deleted); votes are anonymous
  and the votes table is not sent live; more Legit than Cap counts, a tie or more Cap doesn't; the dare streak
  counts a counting proof for both the doer and the dare's sender, mixes with one-to-one chat dares, keeps the
  3-day rule, stops when the votes flip and never counts your own dare; proofs from before the update (built on
  a database without this migration) keep counting until someone votes – after that the normal rule applies
  for good, also when the vote is taken back or its voter's account is deleted – their doers get a "cap" push
  but no "legit" push, and running the migration again changes nothing; app users can't change the totals or
  write votes; the proof push and the Chat list say
  "📸 Posted proof – legit or cap?"; the doer gets at most one "cap" and one "legit" push per proof, none when
  the group is muted, notifications are off or they left; a deleted account's votes are removed and the totals
  counted again; files, reports, the clean-up and the message rules still work for proofs.

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
  and thousands of seeded random strings. It also checks that the sign-up name check (`public_name_allowed`)
  treats the username as a name and the display name as content, like the app. Run it after changing either
  side.
- `tests/unit/username-search.test.mjs`: friend search sends `_` as a real underscore (not "any one letter"),
  drops `%`, `*` and `\` that the person typed, and `likePrefix` escapes `_`, `%` and `\`.
- `tests/unit/chat-delete.test.mjs`: a deleted peek or voice note counts as deleted even when its file
  clean-up fails; a delete the server refuses still shows the error.
- `tests/unit/media-urls-hook.test.mjs`: photos stay on screen when a new photo arrives, links for photos that
  left are dropped, and nothing carries over to a different login.
- `tests/unit/group-chat.test.mjs` (added to): a vote sends the account on screen, the proof and the choice,
  and passes on whether the proof still counts as an old one; a refused vote keeps the real reason; your own
  votes are read in one request for the proofs on screen, and a failed read gives the error back (so the screen
  keeps the votes it shows); the app's "does this proof count?" rule; live changes say what happened to which
  message.
- `tests/unit/group-proof-parity.test.mjs`: the app's "does this proof count?" rule (`proofCounts`) and the
  database's (`private.group_proof_counts`) give the same answer for every mix of 0–4 Legit, 0–4 Cap votes and
  the old-proof flag (PGlite).
- `tests/unit/legal-docs.test.mjs`: the app's copy (`src/lib/legalDocs.ts`) and every website page match
  `legal/*.md` (the operator-only part of the Dare Safety Rules never shows), and TERMS_VERSION is bumped when
  the Terms change. The Terms have the Peekaboo+ wording Apple checks. The documents say what the app and the
  database really do: who can add you as a friend straight away (18+ with a public account; everyone else gets
  a request, from the newest `send_friend_request`), that community dares need our OK first (from the newest
  `pick_daily_dare`), ML Kit's random code for each install (Privacy Policy and the App Privacy answers), every
  report reason in the app's menu, and how to report (⋯ menu, or press and hold a comment or chat message,
  checked against the screens). Support answers cancel, restore and refund. The legal README has no old
  placeholders. Run `node scripts/sync-legal.mjs` and `node scripts/build-website.mjs` if it fails after a
  change in `legal/`.
- 🫥🗿😃👾 The 4 stretchy face filters (10 Nov; `src/components/lens/warp/`, `src/lib/frameAccess.ts`):
  - `warp-shaders.test.mjs`: the four GPU programs compiled and run with CanvasKit (Skia's web version, the
    devDependency `canvaskit-wasm` 0.41.0) on a test pattern. Outside each warp nothing changes, inside it really
    changes, and with two faces close together the second face's Pixel Panic or (tilted) Gigachin pass keeps the
    first face's warp: each pass is see-through wherever it changes nothing. Those two checks fail with the
    older programs that painted the plain picture there.
  - `frame-matrix.test.mjs`: where a camera picture and the saved photo go on the screen (turns, mirror, cover).
  - `warp-track.test.mjs`: each face's memory (the bouncy mouth stays calm, the chin meter fills in about 1.1 s).
  - `warp-looks.test.mjs`: the four drawn on a pretend canvas with 0, 1 and 2 faces; nothing without a camera
    picture; each GPU program gets exactly its numbers; the same moment gives the same picture; cheap enough.
    Everything made from the camera picture (shaders, paints, the blur) goes on the frame's trash list as soon as
    it is made, also when a frame fails halfway (that check fails if the drawing puts things on the list after
    drawing with them).
  - `frame-guard.test.mjs`: nothing loads `react-native-vision-camera-worklets` in any way (TypeScript's own
    import finder: import, side-effect import, export … from, require, import(), files inside the package); only
    `warp/FrameFeed.tsx` uses `useFrameOutput`, `useDepthOutput` or `useAsyncRunner`; the camera's `zoom` and
    `exposure` are only plain numbers on every `<Camera>` and `useCamera` call (TypeScript types, tried first on
    a made-up file that passes a SharedValue, a spread and an `any`); `FRAME_ACCESS_AVAILABLE` only on iOS 17+
    with the new native part; and `markFramesBroken` remembers a failure only when it says so ('remember'), not
    for a camera error ('thisRun'), and after strikes in two different app starts ('strike').
  - `lens-ui-thread.test.mjs` (added to): the four drawn the drawing-thread way, with their trash list.
- Changed: `edge-security.test.mjs` (word filter in username sign-up: a display name may swear, a slur in it
  or swearing in the username is refused before any account is made, with the same message as the app),
  `apple-deletion.test.mjs` (a password-only account that sends an Apple code is now deleted, still without
  contacting Apple), `auth-provider.test.mjs` (logout and profile reload never mix up two accounts),
  `account-deletion-client.test.mjs` (plain error messages from the delete server), `group-chat.test.mjs`
  and `upload-integrity.test.mjs` (group photo and upload clean-up keep the real error).

Frontend (rendered screens, part of `npm test`):

- `home-pager.test.cjs`: phones still use the real native pager with the same settings; the web pager starts
  on the page asked for, reports swipes like the native one, and a swipe past Chat does not make the browser
  go back.
- `web-capture.test.cjs`: in a browser, Send to and Save in the editor say they need the phone app; on phones
  they work as before.
- `group-chat.test.cjs` (added to): group dare votes. Each proof's label follows the votes (waiting, legit,
  tie, cap, old proof), with the totals; Legit / Cap buttons for everyone except the poster (the dare's sender
  has them too), but not on proofs posted before you joined (those say "You joined after this was posted, so
  you can't vote on it" and "⏳ Waiting for votes"; if your join time can't be loaded the buttons show and the
  server decides), your own vote highlighted; tapping it again takes it back; a second tap while a vote is sent
  does nothing; a refused vote shows a toast (not an alert); the dare card counts only counting proofs and "Do
  it · post proof" comes back while none of yours counts; an old proof counts until someone votes and can be
  voted on; a live vote changes only the totals, without loading the chat again; old answers never win: an
  answer to your vote that arrives after a newer live update, a chat reload that set off before a live update
  or before your vote was answered, and an older "your votes" answer all leave the newer totals and your vote
  on screen (a failed "your votes" read too); a reply quote and the pinned banner say "📸 Dare proof"; a
  server without votes yet keeps the old rule.
- `chat-list.test.cjs` (added to): a vote (a message `UPDATE`) doesn't reload the Chat list; a new message
  does.
- Changed: `terms.test.cjs` (one pop-up only: a plain cover while checking, the Terms page only when agreeing
  is needed, "Couldn't check" after 15 seconds), `social-setup.test.cjs` (the Apple/Google setup check with
  Try again), `settings.test.cjs` (queued privacy saves, deletion after leaving Settings, switch rows not
  marked disabled), `navigation.test.cjs` (no screen until the saved login has loaded, so a start-up link is
  kept), `editor.test.cjs` (chat-dare proof when the dare is gone).
- Word filter on the name screens, with the app's real filter: `forms.test.cjs` (Sign up and Edit profile)
  and `social-setup.test.cjs` (the Apple/Google setup screen). A display name that swears saves; a slur in the
  display name or bio (in any disguise) or swearing in the username is refused and nothing is saved. On Sign up
  and Edit profile, a slur split across the username and the name is refused too (the app checks this; the
  database doesn't).
- 🎭 Peekaboo+ face filters (9 Nov), on the camera side:
  - `mode-dial.test.cjs` (added to): the row is Dare, Guess Who, Googly, then the 7 Plus filters in the order of
    `src/lib/lensLooks.ts` (chat cameras get all of them); without Plus only the filter bubbles get the ⭐ and say
    "needs Peekaboo+"; a refused swipe or tap glides the row back; every filter has a VoiceOver hint and no
    caption.
  - `camera-plus-filters.test.cjs` (new): CameraPage with face tracking. Without Plus a filter is refused and opens
    Peekaboo+; with Plus it shows on the selfie camera with its ring colour, and switching filters keeps the same
    camera; Plus running out switches the filter off (the Peekaboo+ screen only if the camera is on screen);
    "not sure yet" lets it on and switches it off after the wait unless Plus is confirmed, and swapping filters
    (or off and on again) never starts the wait again – once it's used up a Plus filter is refused; chat cameras; the
    shutter photo comes from the face camera; holding the shutter records a plain video.
  - `harness.cjs`: `@/lib/lensLooks` is the real file, loaded with a `require` that throws (that file must stay
    free of imports); `usePlusAnswer` defaults to 'no'; `calls.clearedTimers` lists the timers a screen stopped.
- 🫥🗿😃👾 The 4 stretchy face filters (Tiny Face, Gigachin, Big Mouth, Pixel Panic; 10 Nov), on the camera side.
  They need the camera's own pixels, so they show only on the new download (`src/lib/frameAccess.ts`):
  - `harness.cjs`: `@/lib/frameAccess` is mocked as **not available** by default (like App Store build 10,
    TestFlight 7–9, old APKs and Expo Go), so every existing screen test still checks today's exact lists.
    `frameAccessMock(available, { broken })` is the stand-in for the new download; its `markFramesBroken()` makes
    the screens re-render like the real one.
  - `mode-dial.test.cjs` (added to): on the new download the row has 15 spots (the plain camera, Dare, Guess Who,
    Googly, then the 11 filters in the order of `lensLooks.ts`); no filter bubbles without face tracking; the 4 are
    gone when they broke before, and go away at once when they break while the row is on screen (home and chat
    rows); chat and group chat cameras get them; without Plus all 4 get the ⭐; they have VoiceOver hints and no
    caption.
  - `camera-plus-filters.test.cjs` (added to): on the new download the 4 are Peekaboo+ (refused and Peekaboo+ opens
    without Plus; with Plus each shows on the selfie camera with its own ring colour and the same face camera, and
    the shutter photo comes from it); on an older download they never switch on and never open Peekaboo+ (Plus
    yes, no or not sure); when they break while one is on, the camera goes back to plain with no Peekaboo+ screen
    and they stay off; chat cameras; holding the shutter records a plain video.
  - `plus-screen.test.cjs` (added to): the face filters line says "5 live face filters (Heart Eyes, Crybaby, Aura &
    more)" on older downloads (unchanged) and "9 live face filters (Big Mouth, Heart Eyes & more)" on the new one,
    and goes back to 5 if the stretchy filters broke on that phone (Soft Glow and Golden Hour are free, so they
    aren't counted).
  - `lens-overlay.test.cjs` (added to): a stretchy filter draws the camera picture under it, mirrored when the
    picture says so; and right after each frame everything made from the picture is let go of (newest first, the
    picture's shader last), also when the filter fails halfway and when one thing can't be let go of.
  - `frame-feed.test.cjs`: `SoftGlowCamera` with a pretend FrameFeed: a camera error long after the stretchy
    pictures switched on only switches them off until the app closes ('thisRun'), one just after is a 'strike', a
    camera error with another filter on changes nothing; flipping the camera throws the old FrameFeed away and
    starts a new one for the other camera (`key={facing}`). And `FrameFeed` itself with a pretend camera and
    drawing thread: each picture says whether it is drawn mirrored, the camera's buffers go straight back, and
    going away lets go of every picture it kept or still had waiting. The camera-error and flip checks fail with
    the code before the review fixes.
- `settings.test.cjs` (added to): the version at the bottom of Settings is the download's own ("1.0.0 (10)" on
  App Store build 10 even after an update that says 1.1.0), the update's version in Expo Go or without the native
  part.

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
word-filter checks over HTTP (swearing refused in a username, saved in a display name; slurs refused in a
display name or bio, including fancy, invisible, look-alike and accented letters).

Newer HTTP checks: group dare votes through `/rpc/vote_group_proof` (a member and the dare's sender can vote;
the poster, an outsider, a different logged-in account and a visitor are refused; members read the totals
over REST, an outsider can't; only your own vote is readable; PATCHing the totals or POSTing a vote directly
changes nothing; the app's own `voteGroupProof` and `fetchMyProofVotes` through supabase-js; leaving the group
over REST takes your vote away and you can't vote any more); username search escaping (a hand-written pattern, and the app's own `searchUsers`
through supabase-js); the Community dares list loaded with the app's own `fetchIdeas`; a hidden dare idea
cannot be reported to learn who wrote it; app users cannot call the username-limit functions; the word
filter over HTTP (f.u.c.k, fancy letters, invisible and look-alike letters, accents, real names still save,
a huge comment refused quickly, a 1:1 chat dare not filtered).

Newer concurrency scenarios: ten people voting on one proof at once while changing and taking back votes, and
the voter whose account is deleted at that moment voting too (the totals equal the votes table, no deadlock,
one "cap" and one "legit" push); six people leaving the group while they and others vote (no vote from
someone who left stays, the totals stay exact); a voter deleting their account while the poster deletes the
proof, the dare's sender deletes the dare, the poster or another voter deletes their account, the group's
maker removes the voter or deletes the group (each pair takes turns, never a deadlock, with a pause widening
the gap); report and delete races (evidence kept quietly, dismissal releases it, a
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
   chat). A display name that only swears must NOT be listed (only usernames block swearing).
2. It runs `tests/database/deployment-preflight.sql` (read from disk each time, one query at a time, each
   read-only) and checks that every query lists exactly those rows.
3. It applies the new migrations one file at a time, each in its own transaction. The hardening migration
   must stop cleanly while a forfeit is paid twice; the rehearsal then fixes that by hand and applies the rest.
   After `20261216000000_group_dare_votes` it checks that the two old proofs (including a broken one) are
   marked as old proofs with no votes and as already having had their "legit" push, that nothing else was
   marked, and that the broken one can be voted on (and is no longer an old proof after that).
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
reproduction, fixes and evidence. 41/41 public tables have RLS (counted again on 5 Nov, with the Peekaboo+ and
group dare vote tables); this flag alone does not prove every possible
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

Re-run on 2026-11-05, after the owner allowed swearing in display names (only @usernames block it now) and
after two reviews of that change (the split-slur check on Sign up / Edit profile, the sign-up server's message
for a slur in a display name, and direct checks of the username's real-name rule):
`npm test` node part 346 passed, 0 failed, and the Vitest part 25 files, 329 passed. (The clock-dependent
"Scheduled drop reminder" test in `round2.test.mjs` used to fail at times of day when no time zone is at its
drop minute, for example 05:17 UTC. It now picks the drop time itself in that case and undoes it afterwards; it
passed at 12 different times spread over the day.)
Type check and lint: no errors. `npm run test:rest`: 66 passed, 0 failed. `QA_ORIGINAL=1` (run with the
`safe.directory` settings above, so the old app code really loads): 48 passed, 14 failed, and every one of
the 14 is the old code failing a check, none a git setup error. `npm run test:preflight`: 155 passed,
0 failed, 1 NOTE. Browser: 72 passed (one run). The concurrency and HTTP stress runs were not repeated.

Re-run on 2026-11-05, after group dare votes (Legit 🔥 / Cap 🧢, `20261216000000_group_dare_votes.sql`) and the
fixes from its two reviews (votes leave with the voter, account deletion takes the proofs in a fixed order,
old proofs follow the normal rule after the first vote and get no "legit" push, old totals never come back on
screen): `npm test` node part 385 passed, 0 failed, 0 skipped (20 database checks in
`group-dare-votes.test.mjs`, 18 new screen checks in `group-chat.test.cjs`, 1 in `chat-list.test.cjs`), and
the Vitest part 26 files, 337 passed (7 new in `tests/unit/group-chat.test.mjs`, 1 in
`group-proof-parity.test.mjs`). Type check and lint: no errors. `npm run test:rest`: 67 passed, 0 failed.
`npm run test:preflight`: 159 passed, 0 failed, 1 NOTE (20261214100000 and 20261215000000 have no extra checks
of their own there). `npm run test:concurrency`: qa_fixed 33 passed, 0 failed (qa_original 16 failed, as
expected). Browser: 72 passed (one run). Each new check was also run without the new code (the migration
moved away or one of its parts taken out, the old screen put back, or one line of the fix undone) and failed
there; on real PostgreSQL, taking out the account-deletion lock makes "the poster deletes the proof" deadlock,
and taking out the leave trigger or the vote's hold on your place in the group leaves votes behind. The HTTP
stress run and `QA_ORIGINAL=1` were not repeated.

Re-run on 2026-11-05, after the owner's rule "only people who were in the group when the proof was posted can
vote" (the vote checks the member's join time; app users lost the table rights to add or change member rows;
the chat hides the buttons on older proofs; and if the Peekaboo+ dare streak from `20261218000000_plus_extras`
is already in the database, this file keeps it), and the fixes from its review (the chat reads your join time
again on every reload and after a refused vote, so being removed and added back while the chat is open
takes the buttons away too): `npm test` node part 393 passed, 0 failed (22 checks in
`group-dare-votes.test.mjs`, 6 new screen checks in `group-chat.test.cjs`), the Vitest part 26 files, 339
passed (2 new in `tests/unit/group-chat.test.mjs`). Type check and lint: no errors. `npm run test:rest`: 67
passed, 0 failed (the vote check now also covers someone added late and a forged join time).
`npm run test:preflight`: 159 passed, 0 failed, 1 NOTE. `npm run test:concurrency`: qa_fixed 33 passed,
0 failed (qa_original 15 or 16 failed, as expected: the old daily-dare vote race doesn't show up every run).
One concurrency run made while three review helpers were running tests on the same machine timed out once
on "Deleting an account with 25,000 peeks" (15-second limit); on a quiet machine it takes about 4.7 seconds
and passed in both other runs. The two changed database checks, the Peekaboo+ streak
check and the three new "join time read again" screen checks were also run without the new code and failed
there. Once, by hand: the other
session's real `20261215`, `20261217` and `20261218` files applied before `20261216` keep their streak, and a
group proof the group says is legit still counts in it. Browser, the HTTP stress run and `QA_ORIGINAL=1` were not
repeated (they don't reach the group chat).

Re-run on 2026-11-09, after the five Peekaboo+ face filters (👀 Peekaboo Eyes, 🧠 Brain Buffering, 😭 Crybaby,
⚡ Aura Overload, 😘 Heart Eyes) and the review fix to their Plus check (while Plus is still "not sure", the wait
is counted once from the first filter, so swapping filters can't keep one on for ever): `npm test` node part 665
passed, 0 failed, 0 skipped (frontend 356, database 309), and the Vitest part 45 files, 665 passed. Type check and
lint: no errors. As the owner asked, nobody has looked at the new filters drawn in a picture or on a phone yet
(TESTING Step 67); the REST, rehearsal, concurrency and browser runs were not repeated (no database or server
change).

Re-run on 2026-11-10, after the 4 stretchy Peekaboo+ face filters (🫥 Tiny Face, 🗿 Gigachin, 😃 Big Mouth,
👾 Pixel Panic; new native package `react-native-vision-camera-worklets` 5.2.4, version 1.1.0) and the review fixes
(see-through warps for two faces, letting go of camera-picture objects after every frame, camera errors only hiding
the filters until the app closes unless they come just after switching on, a new FrameFeed per camera, the type
check on the camera's zoom and exposure, and the download's own version in Settings): `npm test` node part 694
passed, 0 failed, 0 skipped (frontend 385, database 309), and the Vitest part 50 files, 721 passed. Type check,
lint and `npx expo install --check`: no problems. The new checks for the review fixes were also run against the
code before the fixes and failed there (two-face shaders, trash list on a failing frame, camera errors, camera
flip). Nobody has seen the 4 on a phone yet (TESTING Step 68 needs the new build); the REST, rehearsal,
concurrency and browser runs were not repeated (no database or server change).

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
