# Local QA suite

Audited branch: `claude/mobile-social-app-expo-h090jm`, final source revision
`a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1`. The audit started at `b0dc637`; the
only subsequent upstream change was the Android invitation download link, which
was included and checked. All fixes are local and unpushed.

## Run the tests

Install Node 24 and run `npm ci`. No `.env`, Supabase project, account, real JWT or
service key is needed. Do not configure the suite to use a real backend.

```sh
npm test
npm run typecheck
npm run lint
npx expo install --check
```

`npm test` runs 142 database results, 89 rendered frontend results (including one
parent result), and 188 API/library checks. PGlite executes the actual migrations,
constraints, functions and RLS. Auth, Storage metadata, Vault, cron, push queues
and native/provider services have local stand-ins. Queued notifications never
leave the machine. The three Edge Function handlers are executed with fake HTTP,
Auth, Apple and Storage responses. These are not hosted Edge gateway tests.

## Real concurrent database and HTTP tests (Windows x64)

These additional scripts use the pinned portable PostgreSQL 16.15 dependency.
They create disposable clusters, bind only to `127.0.0.1`, use invented accounts
and shut servers down in finally handlers. Allow local sockets/processes in your
test runner. Cluster files remain under the local work/QA folders for inspection.

```sh
npm run test:concurrency
npm run test:rest:setup
npm run test:rest
```

The setup downloads PostgREST 16.5 from its official GitHub release and verifies
the pinned SHA-256 before extraction into `.qa/tools/postgrest/`. Internet access
is needed for this one setup step and dependency installation. The HTTP tests use
real signed test JWTs, expired/forged tokens, role changes and RLS over HTTP.
They include 1,000 reads from 40 synthetic users at 32 concurrent requests and 240
group writes from 24 authors at 24 concurrent requests. Check authorization and
exact counts as well as speed. Results go to `.qa/rest-after.json`. The separate
known medium moderation bypass is recorded as an issue, not a passing test.

For the larger stress pass on Windows PowerShell:

```powershell
$env:QA_STRESS='1'
npm run test:rest
Remove-Item Env:QA_STRESS
```

This mode uses 100 invented accounts, 10,000 reads at 128 concurrent requests and
2,400 group writes at 64 concurrent requests. Both modes run the same 51 checks;
the request count is load volume, not thousands of additional test cases.

Storage metadata is exposed only in this local fixture to exercise ownership and
deleted-user RLS through HTTP. The real Storage HTTP/S3 service, GoTrue signup,
hosted gateway and realtime server are not running. This suite cannot certify
their configuration, physical byte deletion, push delivery or distributed load.
Windows paths in the native scripts need adapting on other operating systems.

## Browser tests

```sh
npm run test:browser:build
npm run test:browser
```

Chrome is used if installed at the normal Windows path. Otherwise install the
Playwright Chromium browser with `npx playwright install chromium`. The build
ignores `.env` and substitutes `qa-backend.invalid` and a fake key. Playwright
blocks all off-machine requests except that fake host, which it intercepts.
It uses temporary browser profiles, never the user's logged-in browser.

The final result was 60 passed and 3 skipped across 320px/412px phones and desktop.
The website is checked in light and dark mode, including all legal pages, links,
image loading, overflow and a real 404. Logged-out app forms cover empty/hostile
inputs, taken/free names, bad login, timeout/retry, back, refresh and protected
links. Three signed-in browser cases are explicitly skipped because the native
pager fails on web (`codegenNativeCommands is not a function`). Set `QA_FULL_WEB=1`
to reproduce that failure. This does not prove a native phone launch failure.

## Reproducing the original failures

Frontend and API loaders support `QA_ORIGINAL=1` in a clone containing the audited
commit; they read source with `git show`, without changing the working tree.
Database fixtures accept `includeFixes:false`. The concurrency script always
compares original and fixed schemas; only fixed-scenario failures fail the run.
For HTTP, use `QA_ORIGINAL=1` to omit the fix migration.
Original failures are intentional evidence, not a green baseline. A source ZIP
without Git history can run fixed tests but not original-source loaders.

## Limits and release checks

See `docs/QA_API_ROUND2.md`, `docs/QA_FRONTEND_FINDINGS.md` and
`tests/database/findings.txt` for severity, reproduction, fixes and evidence.
39/39 public tables have RLS; this flag alone does not prove every possible policy
combination. Review old data using `deployment-preflight.sql` before a separately
authorized release. The unique forfeit index deliberately refuses old duplicates;
NOT VALID constraints preserve old malformed rows while rejecting new ones.
The historical owner-report fixture is synthetic, not a real owner's login.

Real Apple/Google login and token revocation, device camera/audio/codecs/maps,
push, screenshots/gestures, Storage bytes and hosted realtime/cron still require
a disposable integrated test environment and physical devices. No production
data was read or changed, no real message was sent, and nothing was deployed.
