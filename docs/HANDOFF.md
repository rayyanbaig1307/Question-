# Handoff – where Peekaboo is right now (4 Nov 2026)

Read this first in a new session, together with `CLAUDE.md`. It says what's done, what's open, how we work,
and the owner's standing preferences.

## How to work with the owner

- The owner is non-technical. Write plain, short English with no jargon. Give click-by-click steps for
  anything they must do themselves (Supabase, Apple, Expo), one place at a time.
- After every published update, post the Expo Go link and the update page link:
  - `exp://u.expo.dev/3c421eae-c4ec-47ea-92da-4b2d07b7d13e?channel-name=preview`
  - `https://expo.dev/accounts/rbaig18s-team/projects/peekaboo/updates/<update group id>`
- The app updates itself on launch (`src/lib/appUpdates.ts`). Tell the owner to open it once, or close and
  reopen it.
- Work on branch `claude/mobile-social-app-expo-h090jm` and push with `git push -u origin <branch>`. Don't
  open pull requests unless asked. `main` is only the initial commit.
- Never commit `.env` or any key. Never ask the owner to paste keys or tokens into chat.
- Don't put model names in commits or files.
- Supabase changes: test the migration first (see "Database changes" below). Then apply it with the Supabase
  tool, which shows the owner an Allow pop-up. If the pop-up times out, ask the owner to say "go" and tap
  Allow quickly. Don't work around it.
- The Apple team is shared with the owner's brother's apps (FitVault+, HouseFree). Never revoke or reuse their
  certificates, keys or profiles.

## Accounts and IDs (no secrets here)

| What | Value |
|---|---|
| Supabase project | `vclexbnnykjpmxoyakcp` (Free plan) |
| Expo project | `@rbaig18s-team/peekaboo`, id `3c421eae-c4ec-47ea-92da-4b2d07b7d13e`, channel/branch `preview` |
| iOS bundle id | `com.rbaig18.peekaboo`, Apple team `TMFHJ8D3H5` (2865113 Ontario Inc.) |
| App Store Connect name | "Peekaboo: Dare Your Friends" (iOS 1.0, Prepare for Submission) |
| TestFlight public link | https://testflight.apple.com/join/3DWqzxhS (works once Apple's beta review passes) |
| Android APK (v16) | link in `src/lib/invite.ts` (`ANDROID_LINK`) |
| Owner's app account | `@coolname`, user id `df5aae76-7e6a-4e91-9645-5b897a533156` (Sign in with Apple, since 4 Nov 2026; the old id d3614487-… was deleted). Gets report alerts and a lifetime Plus row (product_id 'tester') in plus_members |
| Test account | `@ayaan` (owner's brother), birthday 8 Jul 2007, friends with the owner |
| App review account | `review@peekaboo.invalid` / `@peekaboo_review` (password is in App Store Connect → App Review Information) |
| Legal operator | 2865113 Ontario Inc. (Ontario, Canada), rbaig18@z2automation.net. There's no mailing address, on purpose. |

## Now (9 Nov): Peekaboo 1.0 is LIVE on the App Store; group Guess Who, invite links and face filters

- **Live:** Peekaboo 1.0 (build 10) is "Ready for Distribution" and Peekaboo+ Monthly is APPROVED (owner's screenshot
  8 Nov; the Plus session confirmed via the ASC API). App Store link: https://apps.apple.com/app/id6829561855
  (Apple id 6829561855; 6761857728 is FitVault+, not ours). Production OTAs are allowed again – only from a commit
  already tried on `testing`, and only on the owner's explicit "publish".
- **Stickers in chats** (other session, `fb07a97`, migration `20261221000000_chat_stickers.sql`, live; OTA `97c9a584`
  on `testing`).
- **Group Guess Who** (owner, 9 Nov: "a person can send a guess who picture to the group … and people can guess who out
  of all the people"). Commits `3de9e25`, `697e9c8`, `b71dc4b`. Migration `20261222000000_group_guess_who.sql`
  (sha256 starts `592eebd9c7e2`) – copy page https://claude.ai/artifact/GL1ZfTtpymrduDQyD6QSxd. **Live** on the database
  (owner pasted it 9 Nov; all function bodies checked against local). On `testing` since update `7cbb8560`; the
  newest `testing` update is `98d4c0de` (from `6eed150`, see invite links). Not on `production` yet (owner's "publish").
  - How it works: a group Guess Who is a `mystery_posts` row with `group_id` + a server-made people list
    (`group_candidates`), never a `group_messages` row, so the sender never appears in messages, file paths, pushes,
    the chat list or old apps. Photos only (1080×1440, Skia re-encode where available), 3 per person per group per
    24 h (private log), groups of 3+, 24 h like every Guess Who. Everyone else in the group guesses from all the people
    on the list; you see who it was only after guessing; counts only after guessing. A block with ANYONE in the group
    hides all of that group's Guess Whos (no oracle). Block-the-poster only after guessing; no Peekaboo+ hints in
    groups. `mark_group_chat_read` now stores "read up to the newest message", not "now" (so Seen can't time a post).
  - Known and accepted: if the poster deletes their account, their group Guess Whos vanish at the same moment they
    leave the member list. Old app versions get the push/chat-list line but can't open the card until they update.
    Storage `owner_id` on mystery files is the uploader (same as today's Guess Who). Without Skia (Expo Go / very old
    builds) the phone's own JPEG encoder is used, so a very technical person could tell iPhone from Android.
- **Invite links** (owner, 9 Nov: "people can invite their friends on with a link that they created"). Commits
  `aab85e1`, `7788495` (work-in-progress snapshots), `c58a347` (built), `013109a`, `48311c6` (review fixes). Migration
  `20261223000000_invite_links.sql` (sha256 starts `851f5638ffad`) – copy page
  https://claude.ai/artifact/8d56ggog3oH3jki11KWBe4. **Live** (owner pasted it 9 Nov; the 11 functions, grants, RLS,
  triggers and the outcome check all match local). OTA `testing` update `98d4c0de-13a2-4a14-925a-7d2967ac9e41` from
  `6eed150` (also has the other session's dare safety). Not on `production` yet. **Still to do:** the owner re-uploads
  `website/` (it now has `invite.html`) to Cloudflare Pages – planned together with the face-filter Privacy change so
  it's one upload. Link format `https://peekaboo-4gz.pages.dev/invite?c=CODE`
  (10 chars from `23456789BCDFGHJKLMNPQRSTVWXZ`). The website page shows no names and makes no server calls; the owner
  must re-upload `website/` to Cloudflare Pages after it ships. Rules: instant friends only with a public adult and no
  history; otherwise a request; 20 a day per person and per link; once 3 under-18s used an adult's link in 24 h,
  further under-18s get "busy" and the owner's alert people are pushed (this hold applies when the link's owner is an
  adult or has no birthday saved – `private.age_group(owner) is distinct from 'teen'`; the app treats the server's
  "This invite link is busy" error the same as a `busy` result); removed friendships are remembered
  (`private.past_links`) so a link can't undo a decline/unfriend/block; ban and block checks.
- **Face filters 🎭** (owner, 9 Nov: bring the web app's filters into the camera; "don't test them, just push it and
  add it properly to the app"). Five new **Peekaboo+** filters, drawn live over the camera and onto the photo:
  👀 Peekaboo Eyes, 🧠 Brain Buffering, 😭 Crybaby, ⚡ Aura Overload, 😘 Heart Eyes (ported from the web branch
  `claude/wonderful-planck-oe81zm`, never merged). JS only, so they ship **by OTA** to every iPhone build that has
  face tracking (App Store build 10 and TestFlight builds 7–9). Each one shows at rest and an expression makes it
  stronger (raise your brows, hold still, squint, open your mouth, blow a kiss).
  - Where: the list is `src/lib/lensLooks.ts` (no imports – the camera and mode row read it); drawing in
    `src/components/lens/filters/`; each face's springs/progress/charge in `src/components/lens/faceTrack.ts`
    (details and rules in `docs/FACE_MESH.md`). Soft Glow and Golden Hour look unchanged, and are now **free for
    everyone** (owner, 9 Nov: "make the soft glow and golden hour free, make the rest behind the pay wall") –
    `plus: false` in `lensLooks.ts`.
  - Plus gate (`CameraPage` + `usePlusAnswer()` in `lib/plus.ts`): when we're sure you don't have Plus, the Plus
    bubbles show a small ⭐, and a tap or swipe onto one opens Peekaboo+ and the row glides back. "Not sure yet"
    (cold start, no internet) lets the filter on and switches it off after 8 s if Plus never shows up. The 8 s
    count from the first filter you pick: swapping filters, or off and on again, doesn't start them again, and
    once they're used up a Plus filter is refused until Plus is confirmed. When Plus ends, a filter that's on
    switches off. Chat cameras have the filters too. Videos stay plain (as before).
  - Peekaboo+ screen: "5 live face filters (Heart Eyes, Crybaby, Aura & more)". Privacy Policy now 9 Nov (the
    filters read simple expressions too; still on the phone only) – the owner must **re-upload `website/`**
    (one upload together with the invite page). App Store screenshots or subscription text that show a filter
    must say it's Plus. Phone checks: TESTING Step 67.
  - **Not in this update:** the 4 stretchy filters (Tiny Face, Gigachin, Big Mouth, Pixel Panic) change the camera
    picture itself, so they need **a new native build** (task "Face filters B"). **Android has no face mesh yet**,
    so Android shows no filter bubbles until a new APK.

## Now: App Store launch (6 Nov) – build 10 ready, owner's checklist in progress

**Owner's ask (6 Nov):** "work on the subscription and getting it onto the App Store and submitting it". This session
leads RevenueCat + submission; the Peekaboo+ session (`session_01P3d3mZc9v7nJ2AKkZ6Jc5g`) holds the App Store Connect
API key and does ASC API work on request (no double submits).
- **Code:** `bcc76a1` + `2ea24d4` (launch fixes: legal/Terms/Privacy for Peekaboo+, TERMS_VERSION 2026-11-06, no
  background audio, fuller camera/mic texts, no "Coming soon" buttons, App Store invite link on the production
  channel, Report/Block on opened peeks, Dangerous dare + Self-harm reasons, robust purchases incl. Ask to Buy and
  OTA reloads, "Unlocking your Peekaboo+…" while the webhook catches up, Delete account billing warning, safer
  webhook). `7d838ef`: TESTERS empty (the owner's free Plus is gone; his plus_members row was expired by the Plus
  session).
- **Build 10** (EAS `25760a8b-441b-4077-91ab-d319b5d009d7`, profile `production`, **channel `production`**, env
  `production`, from `2ea24d4`): VALID in App Store Connect, attached to version 1.0 (in place of build 4), in TestFlight
  for the internal group. NOT submitted for review. EAS env `production` now has EXPO_PUBLIC_SUPABASE_URL/KEY (added
  6 Nov) besides the RevenueCat key.
- **Store app OTAs go to `production`** from now on (only from a commit already tried on `testing`, never during review):
  `set -a && . ./.env && set +a && npx eas-cli@27.1.0 update --branch production --message "…" --platform ios
  --non-interactive --environment production --clear-cache`, then the usual `strings` check. Builds 7–9 stay on `testing`.
- **Waiting on the owner** (all in his checklist page https://claude.ai/artifact/VjK4WkoZUPJcBudybi5fYs):
  1. Paste the safety migration `20261220000000_launch_safety.sql` (copy page https://claude.ai/artifact/Q253FQ6Jmwypt1zTZrnPPd;
     the MCP approval pop-up timed out again). Check: `dare_ideas.approved_at` exists, trigger `friendships_need_their_ok`.
  2. Paste the new `revenuecat-webhook` code in the dashboard (copy page https://claude.ai/artifact/RXoRpEYWtqPEgRu3dTqMNq;
     live is still v1), Verify JWT off, then RevenueCat "Send test event" → check `private.plus_events` has a TEST row.
  3. Subscription 6830983771 review screenshot (still MISSING_METADATA) and Paid Apps agreement Active.
  4. Test buy on build 9 (testing channel, update `d0c8d510`), then build 10 checks; App Privacy (+Purchases,
     Device ID purpose), age rating, review account content, website upload (website.zip sent), then submit
     (subscription + version in one draft submission).
- Description already has Terms, Privacy and Apple's standard EULA links (added by the Plus session via the API).
- **Later on 6 Nov:** the safety migration and the new webhook are live (owner pasted both; TEST event arrived),
  subscription 6830983771 is READY_TO_SUBMIT (review screenshot + the missing Zimbabwe price), Paid Apps / bank /
  tax all Active, and the owner's sandbox test buy on build 10 worked end to end (INITIAL_PURCHASE 00:16:44Z →
  plus_members). First `production` OTA: `1e03f9f5-859b-4cdd-b87f-d37829eada69` (by the Plus session, owner's ask)
  = `35b7986` (Plus unlocks without a restart: 'use no memo' in usePlus/usePersonPlus/useDare) + `490c38e`
  (camera bubbles: Dare, Guess Who, Googly, Soft Glow, Golden Hour).
- **Production OTA `31ebc3e2-31f1-41ed-a6d5-06ecc62fa720`** (7 Nov, owner's "publish") from `7df92ea`: the app opens on
  Home (`START_PAGE = HOME`), Plus ends cleanly (`691e4ed`: plusSurelyOff + plusLapse resets a Plus theme/icon), and no
  banner for the chat you have open (`4182b4a` + `afe9652`: group chat pushes are type 'group_chat').
- **Submission (7 Nov, by the Plus session on the owner's ask):** website re-uploaded (/terms has "9. Peekaboo+"),
  App Privacy published (Purchase History, Product Interaction, Device ID, Diagnostics), review notes set, age rating
  override 13+, Australia + Brazil (and China) unavailable, draft review submission `be1312d0` with version 1.0 / build 10;
  the owner attaches Peekaboo+ Monthly in the web UI and submits (the first subscription can't be added by API).
  **No `production` OTAs while in review.** Still open: content on @peekaboo_review (0 posts/stories/groups on 7 Nov).
- **SUBMITTED 7 Nov 2026 01:52 UTC** (submission `be1312d0`): Peekaboo 1.0 (build 10), Peekaboo+ Monthly and the Peekaboo+
  group are WAITING_FOR_REVIEW. Release is manual ("Manually release this version"). After approval: the owner presses
  Release; then production OTAs are allowed again (only from commits tried on `testing`).

## Now: QA round 2 and group dare votes are LIVE (5 Nov): database and app update

**Status.** A big QA and security review was folded in: the supplied QA patch plus our own review fixes.
On 5 Nov the owner said "go" and the **server side was released** to the live project, in this order:
1. Safety check (`tests/database/deployment-preflight.sql`, read-only): no hard blockers, no old stranger
   reports to save, no broken old messages or keeps.
2. `delete-account` deployed (version 8, "Verify JWT" off, as before).
3. Migrations applied in order: `20261213102659` hardening, `20261213200000` media fixes, `20261213210000`
   robustness, `20261213220000` username limits, `20261214000000` word filter, `20261214100000` final fixes.
   Each was sent with a 15-second lock limit, so it could never keep live users waiting.
4. `username-auth` (version 5, "Verify JWT" **on**, as before) and `cleanup-media` (version 2, "Verify JWT"
   off, as before) deployed.
5. Checked afterwards: every function, privacy rule, trigger and permission on the live database matches the
   tested local copy (only differences: line endings and code comments in old functions that predate this
   work). Supabase's security advisor shows nothing new.
**Applied later the same day:** `20261215000000_peekaboo_plus` (by the Peekaboo+ session) and
`20261216000000_group_dare_votes` (see "Group votes live" below). Not applied: that session's
`20261217000000_plus_insights` and `20261218000000_plus_extras` (they are its own; it waits for the owner's OK).
`20261218` can come after `20261216` safely: it replaces the dare streak with its Peek-a-Save version, which
counts group dares too.
**App update published (5 Nov, owner's "Ok do both"):** OTA `346a8ad8-384b-4a95-885d-929ff02c69f2` on branch
`preview` (runtime `exposdk:58.0.0`, Android + iOS), built from `e3fbac4`: all the QA app fixes, group dare
Legit / Cap votes, the Inbox-bell header (`23853ae`) and the crop Rotate fix (`a6a4c62`). Checked after
publishing: both bundles contain the project URL and key (the "setup-needed" text in them is only the code's
fallback). No native package changed since the installed builds, so no new build is needed. The other session's
Peekaboo+ TestFlight build 7 listens on the `testing` channel, so this update does not reach it. **Any next
`preview` OTA must be built from this branch (or include `e3fbac4`)**, or the QA fixes and votes disappear.
**Golden Hour redesigned (6 Nov; owner: "the filters look very similar… golden hour… less similar, more golden and
shiny"):** `b2cc907` (+ merge `7927868`). Golden Hour is now "liquid gold in the low sun": warm gold over the whole
face (nostrils, moustache, lips, eyes and brows keep their colour), polished highlights, a thin gleam gliding across
the face every 5 s with glints (never over the eyes/brows), a low sun just past the left edge with a thin streak and
sunbeams (placed from `fill`, so the saved photo matches), a light amber tint with warm corners and a few golden
orbs. None of Soft Glow's sparkles/glitter/halo; Soft Glow is pixel-identical. About 16 draws/3 blurred per frame
(was 45/41). Made with a design round (4 variants, 3 judges) and 3 fix-and-check rounds on the owner's own selfie
(preview tools: real MediaPipe points + CanvasKit, in the session scratchpad, not committed); the face gold was then
toned down by hand (FACE_GOLD 0.36, LOW_GOLD 0.27, warmer colours) because at full strength it read as yellow face
paint. `a66ddcf`: the photo now uses the same moment of the gleam as the screen (LensOverlay → `shownTime`).
`tests/unit/face-looks.test.mjs` checks the two looks stay different, the draw budget and the sun placement.
Leftovers: the camera still works out `face.light`/`face.rim` (goldenLight.ts) every frame though no look uses them
now (9 Nov: stopped with the face filters work – see "Face filters" under Now). OTA `4e9d211e-b499-4a8a-b1aa-7ba828f95eed` on **`testing`**, then follow-up `3e4102c` (gold kept out of
the hair, gleam pieces fade in smoothly, richer gold) as OTA `831dd1ef-fd0a-46f9-96ae-0f194c65b818`. Not yet seen on a phone.
**Face filters draw live on the camera (5 Nov, late; owner: "I want to see it moving and tracking my face, like the
googly eyes"):** ✨ Soft Glow and 🌅 Golden Hour never drew on the camera preview, only on the saved photo. The cause
was `soft()` in `lensPaint.ts`: its default `style = BlurStyle.Normal` is worked out on the camera's drawing thread
before `BlurStyle` exists there, so the first frame threw and `LensOverlay`'s safety net switched the filter off.
Fixed in `2c31570` (no default; `style ?? BlurStyle.Normal` in the body); `LensOverlay` now warns once if drawing
ever stops; `tests/unit/worklet-order.test.mjs` fails on any worklet whose parameter default reads an outside name.
OTA `86618bc8-7116-4ece-a9e4-ecfac0825d73` on branch **`testing`** (includes the Peekaboo+ session's `a365c28`). Not
yet seen on a phone: check it on TestFlight (close and reopen the app twice first).
**`20261219000000_plus_fixes` is live (checked 5 Nov, ~22:15 UTC):** `public.my_broken_streaks` on the live database is
byte-for-byte the file's version (after removing Windows line endings from the paste), users can run it and visitors
can't, and the owner's account `df5aae76…` is in `private.report_alert_people`. It was pasted in the SQL Editor (no
history row).
**Everything on the owner's TestFlight build (5 Nov, owner: "push all the features… I want to test the features on
TestFlight", RevenueCat later):** this branch now contains the whole Peekaboo+ branch (merged `00848ff`, then
`ec6aa50`), and OTA `4b19b737-bf78-4180-bdf6-b46b1dcbd56a` on branch **`testing`** (the channel of the Peekaboo+
TestFlight build 7; `--environment preview`, which has `EXPO_PUBLIC_REVENUECAT_IOS_KEY`) from `a54b189`: all
Peekaboo+ features, group Legit / Cap votes, story rings, the keyboard fix and the new Galaxy icon picture in the
icon picker. The chats keep one keyboard fix (`KeyboardSafeView`); the Peekaboo+ session's `useKeyboardLift` was
removed when merging `ec6aa50` (agreed with that session). Tests on the merged code: `npm test` 434 + 373,
`test:rest` 67, `test:preflight` 161, `test:concurrency` qa_fixed 33, browser 72 – all passed. The `preview`
channel (everyone else's installed builds) still runs the non-Plus app (`c63740e4`): Plus code needs Plus native
builds. Both sessions now merge each other's branch before publishing to `testing`.
**App update published (5 Nov evening, owner's "publish"):** OTA `c63740e4-5224-48b6-a442-8315886ad9b3` on
branch `preview` (runtime `exposdk:58.0.0`, Android + iOS) from `1ab940e`: the message box no longer hides behind
the keyboard on iPhone (chats, group chats, comments, dare and hit-up boxes lift by the keyboard's height;
Android unchanged), and story rings on profile pictures (glowing pink-purple, green for close friends, grey once
watched; tap opens the story) in the Chat list, chat header, profile, feed, posts, friend lists, group chats,
members and comments. Checked after publishing: both bundles contain the project URL and the new screens'
text. **Any next `preview` OTA must be built from this branch (or include `1ab940e`).** Also live since 5 Nov
evening: the Peekaboo+ session's `20261217000000_plus_insights` and `20261218000000_plus_extras` (pasted by the
owner; no history rows); the functions this app calls kept the same shape (checked).
**New Galaxy app icon (owner said "use it", 5 Nov):** `design/galaxy-icon/fx-galaxy.png` (1024, no transparency)
and `fx-galaxy-preview.png` (180), made by `scripts/make-galaxy-icon.py`: a Milky Way band and stars behind the
logo eyes. Handed to the Peekaboo+ session to replace `assets/icons/fx-galaxy.png` and its preview on its branch;
it needs a new app build (icons live inside the app).
**Group votes live (5 Nov, 20:40 UTC):** `20261216000000_group_dare_votes` is applied to the live database.
Supabase's approval question never showed in the owner's app, so the owner pasted the file (with
`set local lock_timeout = '15s';` after `begin;` and a migration-history row before `commit;`) into the SQL
Editor; history shows `20261105204027 group_dare_votes`. Checked afterwards: all 9 new or changed functions
match a local copy exactly; the one old proof is marked as an old proof (it keeps counting until someone votes)
with its "legit" push marked as sent; app users have only SELECT on `group_proof_votes` and lost INSERT/UPDATE
on `peek_group_members`; visitors can't call `vote_group_proof`. The security advisor shows only the two
expected new entries (the private `group_proof_alerts` table and the app's `vote_group_proof`).
For the next database change: Supabase's approval question does not appear in the owner's app. Put the SQL on a
page with a Copy button for the SQL Editor instead (that worked).
**Done after the release (5 Nov):** the 14 old photo files of deleted accounts were deleted. They were put on
the cleanup waiting list (`private.media_deferred_deletions`) and the daily cleanup was started once by hand
(the same call the pg_cron job makes); it answered `removed 14 of 14`, and the leftover-file check below now
finds 0. **Still to do after the release:** the cf-connecting-ip check, the phone checks in `docs/TESTING.md`
Step 62, and turning on "Prevent use of leaked passwords" in Supabase → Authentication → Email settings
(the advisor suggests it; it was already off before; Supabase only offers it on the Pro plan and above).

- **Commits**: from `ac246c3` (the supplied patch: security fixes, hardening migration
  `20261213102659`, local test suite) to the branch head. `ee96f61` makes the tests run on Linux,
  `468e792` patches dev-tool advisories (glob/minimatch overrides; no app or native package changed), and
  the commits after it hold the review fixes for the database, the Edge Functions and the app.
- **New migrations (the first six applied live on 5 Nov, see above):** `20261213102659_qa_round2_security_hardening`,
  `20261213200000_qa_review_media_fixes`, `20261213210000_qa_review_robustness_fixes`,
  `20261213220000_username_auth_limits`, `20261214000000_public_word_filter`, `20261214100000_qa_final_db_fixes`.
  Also `20261216000000_group_dare_votes` (group dares: Legit or Cap votes, see below): it ships with this
  release, in step 3 with the others and before the OTA, because the new app needs it. It doesn't need
  `20261215000000_peekaboo_plus` (another session's work, which sorts just before it), but apply that one too,
  in order: it only adds an empty Peekaboo+ table and a "does this person have Plus?" check that nothing uses
  until Peekaboo+ is released, so it's harmless and keeps the files in one simple order.
  Between the migration and the OTA (and on any phone that hasn't picked up the update yet – close and reopen
  the app twice), the group chat still shows every new proof as "✅ Did the dare" and has no Legit / Cap
  buttons, while the notification already says "📸 Posted proof – legit or cap?".
  `20261207000000_report_alerts.sql` was also changed: it now adds the owner to the alert list only if that
  profile exists. The live database already ran it, so nothing changes there; it only lets a brand-new
  database set up cleanly. Don't run it again on live.
- **Edge Functions changed (not deployed):** `delete-account`, `username-auth` and `cleanup-media`.
- **App:** JS-only, so an OTA is enough (no new native module, `npx expo install --check` is clean).
- **Tests:** `tests/README.md` says how to run them, what each file covers and the latest results.
  `docs/QA_REPORT.txt` has an INTEGRATION UPDATE at the top saying what happened to each open item.

What people will notice once it's released:
- Opening a link or a notification while the app is closed opens that page, not home.
- People who already agreed to the Terms see only a short plain cover at start-up (no Terms page sliding).
  Without internet, after about 15 seconds: "Couldn't check" with Try again and Log out.
- Photos in group chat, the Home feed, the grid, Guess Who and Keeps stay on screen when a new photo arrives.
- The Community dares list loads again (it fails in the live app).
- Chat-dare proof for a dare that's gone says "Photo sent" and goes back to the chat.
- Public text (usernames, display names, bios, captions, comments, hit ups, dare ideas, group names) is now
  word-checked by the database too, not just the app. Swearing is now fine everywhere except @usernames, so a
  display name like "Fuck Off" saves; slurs are still blocked in all public text. Private chat is still not
  filtered.
- Username login has fairer limits (see below). A server problem says "Could not reach the login service.
  Please try again." instead of "Wrong username or password".
- Deleting an account on an iPhone signed in to a different Apple ID still deletes the account, but no longer
  disconnects that other Apple ID (it could be someone else's).
- A deleted photo, video or voice note disappears at once for everyone; its file is removed by the daily
  cleanup a little later. Files a report still needs stay hidden while the report is `open` or `reviewed`,
  until it is set to `dismissed` or let go with `release_report_evidence`.
- Group dares: the group decides if a proof is real. A new proof doesn't count straight away any more:
  everyone else in the group (the person who sent the dare too) taps **Legit 🔥** or **Cap 🧢**. Votes are
  anonymous – everyone sees the totals ("🔥 2 · 🧢 1"), you see your own vote, nobody sees who voted what. Tap
  your vote again to take it back. A proof counts when it has more Legit than Cap votes; no votes or a tie is
  "not decided", more Cap votes means it doesn't count, and the doer can post new proof. Only counting proofs
  go into "2 of 4 did it", "🔥 Everyone did it!" and "✅ You did it". A counting proof also keeps the dare
  streak going between the doer and the person who sent the dare (shown in their one-to-one chat). The doer
  gets one push the first time someone calls cap, and one when the group says legit. The proof's own
  notification now says "📸 Posted proof – legit or cap?" instead of "✅ Did the dare!". Proofs posted before
  the update keep counting until someone votes on them (after that, the normal rule applies). Group dares
  now also count toward the 🔥 dare streak in one-to-one chats – old group proofs too – so some streaks can go
  up on the day of the release. Only people who were in the group when the proof was posted can vote on it
  (owner's choice, 5 Nov): someone added later sees "You joined after this was posted, so you can't vote on
  it". A vote also only counts while the voter is in the group: someone who leaves (or is removed) takes their
  votes with them, so spare accounts can't join to vote, or vote and leave.
- Friend search treats `_` as a real underscore. In Settings, a privacy choice is still saved if you leave
  quickly, and screen readers no longer call the switches "disabled".
- The web version works when signed in (it used to crash). Sending or saving from the web editor says
  "Sending and saving from the web isn't ready yet. Please use the Peekaboo phone app."

Username login limits (only wrong passwords count; a correct login gives its try back), each per 15 minutes:
8 wrong tries per username from one internet address, 40 per username from all addresses together, 30 from
one address across all usernames. Username-only sign-ups (only ones that really make an account count): 5 per
address per hour, 100 per hour for everyone together.

### Release order (follow it exactly)

1. **Preflight.** Run `tests/database/deployment-preflight.sql` on a copy, or read-only (every query only
   reads), **one query at a time** (the SQL editor only shows the last result). Every `[HARD BLOCKER]` must
   return no rows on the live database. Fix them there by hand before step 2 (for a forfeit paid twice,
   delete the post that `forfeits.done_post_id` does not point to), then run that query again on live.
   **Save the result of the `[INFO]` "old open or reviewed reports made by someone who cannot see that
   content" query** – it's needed after the release, and later runs miss reports whose content was deleted in
   the meantime. Run the word-filter query (the last one) only after its migration is in.
2. **Deploy `delete-account`**, just BEFORE the migrations, and do steps 2 and 3 in one sitting. Keep its
   "Verify JWT" setting as it is now (see the "Verify JWT" note under step 4). Until the migrations are in,
   it safely answers "Could not finish deleting your account. Please try again." and changes nothing – so in
   that gap nobody can delete their account.
3. **Apply the migrations in filename order**, at a quiet time. Each one holds table locks (including
   Storage's file table) until it finishes. If one waits a long time, it's safe to cancel: each file rolls
   back fully and can be run again – run it again soon, because account deletion keeps saying "try again"
   until the migrations are in. If the first one (`20261213102659`) can't go in today, put the old
   `delete-account` back (the copy from commit `a9e5ddf`, same "Verify JWT" setting) until it can. Once that
   first migration is in, never put the old one back. `20261213210000` fills its file-lock table once (a few
   seconds on a big database).
4. **Right after, deploy `username-auth` and `cleanup-media`**, each with its "Verify JWT" setting kept (see
   the note below). The old live versions keep working against the new database in the short gap. The new
   versions must NOT go first: before the migrations they answer 503 or do nothing.

   **Keep each function's "Verify JWT" setting.** Before step 2, write down the "Verify JWT" setting each of
   the three functions has now (Supabase → Edge Functions → the function → Details, or the Supabase tool's
   `get_edge_function`), and deploy each one with that same setting. `cleanup-media` must be OFF (see "Media
   cleanup" below): its daily job sends no login token. Logged-out phones call `username-auth` with the
   publishable key, which is not a login token, so it is expected to be OFF too – check it and keep it as it
   is. Keep `delete-account` as it is now too. The Supabase tool and a plain `supabase functions deploy` turn
   the check ON unless told otherwise (Supabase tool: `verify_jwt: false`; command line:
   `supabase functions deploy <name> --no-verify-jwt`). If that happens to `cleanup-media`, the daily cleanup
   quietly fails every night (deleted files pile up, hidden, in Storage); if it happens to `username-auth`,
   every username login and sign-up fails.
5. **Publish the OTA right after**, from the branch head (the recipe in `CLAUDE.md`, and check the bundle).
   First write down the update group id that is live on `preview` now (expo.dev → Updates). If the new
   update crashes, republish that one, not the old id in the Publishing section.
6. **After the release:**
   - Run this once, read-only. It lists media files whose owner no longer exists:
     `select o.name from storage.objects o where o.bucket_id = 'media' and o.owner_id is not null and not exists (select 1 from auth.users u where u.id::text = o.owner_id);`
     Remove any listed file in Supabase → Storage → `media` (the dashboard should delete as the service role;
     not checked on the live project yet), never with a SQL `delete`. If a delete is refused because a report
     keeps the file, decide on that report first (`select public.release_report_evidence('<report id>');`).
     Limit: it only finds files whose `owner_id` is set.
   - For each old report on the saved list that the owner agrees to let go:
     `select public.release_report_evidence('<report id>');`
   - Hosted checks we could not do locally:
     - That `cf-connecting-ip` reaches `username-auth` and is set by Cloudflare, not by the caller. Right after
       step 4, add a temporary log line to `username-auth` that prints the `cf-connecting-ip` and
       `x-forwarded-for` values, and redeploy it (same "Verify JWT" setting, see step 4). From a computer,
       send one test login with a made-up username (no real account is used or touched) and an extra header
       `cf-connecting-ip: 203.0.113.9`. Check that the log shows the computer's real public address, not
       203.0.113.9. Then remove the log line and redeploy straight away (same setting): the log line must not
       stay deployed, because it would record everyone's internet address. If the made-up value comes
       through, a caller can fake their address, and only the 40-per-name and 100-per-hour caps can be
       trusted. If neither header arrives, every phone counts as one address: 30 wrong passwords from anyone
       block all username logins for 15 minutes, and only 5 username sign-ups an hour work for everyone. In
       that case redeploy the old `username-auth` (the copy from commit `a9e5ddf`, same setting; it still
       works with the new database) until this is fixed.
     - That the XML functions one preflight query uses (`query_to_xml` / `xmltable`) work there.
     - Storage behaviour: a normal user's delete hides the file at once and the next `cleanup-media` run
       removes the bytes; a reported file is kept.
     - The phone checks in `docs/TESTING.md` Step 62.
   - Keep an eye on the daily cleanup: it must keep running, or deleted files pile up (hidden) in Storage.
     It handles at most 1,000 files a run. `select count(*), min(requested_at) from private.media_deferred_deletions;`
     should not keep growing day after day. Files kept for an open or reviewed report stay in it until the
     report lets go of them (list those with
     `select d.object_name, e.report_id from private.media_deferred_deletions d join private.report_media_evidence e on e.object_name = d.object_name;`).

Check before using the Supabase CLI: two pairs of migrations share a version number (`20261207000000`
inbox_live + report_alerts, `20261208000000` drop_reminders + media_cleanup). The CLI keys migrations by
version, so `supabase db push` / `db reset` may trip on the second file of each pair. Not tested; don't
rename files that are already live.

### Owner decisions and known issues

- When someone deletes their account, their files go too, even ones kept for a report. The report rows stay.
- Setting a report to `dismissed` lets go of its files for good; setting it back does not bring them back.
  Use `reviewed` to keep them.
- The file-lock table (`private.media_path_locks`) only grows: one tiny row for every media file name ever
  uploaded, used in a post, story, message or keep, reported or deleted (every existing file gets one when
  `20261213210000` runs). Rows are never removed. Asking to delete a file that doesn't exist no longer adds a
  row, but someone who calls the database directly can still add rows with made-up file names by saving
  posts, messages or keeps with them. Each row is tiny. Safe to leave.
- If an author blocks someone, that person can no longer report the author's posts, stories or comments
  (they can still report the author's profile).
- Swearing is only blocked in @usernames (owner's choice, 5 Nov). Display names, bios, captions, comments, hit
  ups, dare ideas and group names may swear; slurs are blocked in all of them. The two messages stay the same.
- Group dare votes, the small cases (decided while building it, 5 Nov; easy to change): someone who leaves
  the group, or is removed by the group's maker, loses their votes and the totals are counted again (a vote
  only counts while you're in the group – otherwise spare accounts could join, vote Legit and leave). So the
  group's maker can take votes away by removing people; that is visible to everyone, and nobody learns who
  voted what (owner said OK to the rule "only people in the group when the proof was posted can vote", 5 Nov;
  removing someone taking their votes away is still the builder's choice). A deleted account's votes are
  removed too. People added after a proof was posted can't vote on it (the server checks the member's join
  time, which only the server sets; app users also lost the table rights to add or change member rows).
  Someone who leaves and is added again counts as joining at that new time, so they can't vote again on older
  proofs. Someone with a block (either way) with the poster can't vote on that proof – they can't see it
  anyway. Vote pushes follow the group's mute and the doer's "Messages" notification setting; a doer who left
  the group gets none. A proof that starts counting because a Cap voter left (rather than through a vote)
  sends no "The group says legit" push; the next vote that keeps it counting does. Several counting proofs
  for one dare add one dare to the streak, not several. An old proof (from before the update) follows the
  normal rule as soon as anyone votes, even if every vote is taken back later, and its doer gets no "The
  group says legit" push (it already counted). The "X of N did it" count still includes a proof by someone
  who has since left the group (as before).
- Rare: if someone deletes their account or leaves a group at the very same moment as someone else deletes a
  dare (or the whole group) with several proofs they voted on, one of the two can fail once (deleting an
  account then says "Could not finish deleting your account. Please try again."). Trying again works. With
  one proof – deleting an account at the same moment as someone voting, leaving, deleting the proof, deleting
  its dare, deleting the group or deleting their own account – the two just take turns (checked on real
  PostgreSQL).
- Profile song title/artist are not word-filtered (real song titles contain these words).
- Private chat is not word-filtered on purpose (1:1 and group chat, chat dares). Checked by the app only, not
  the database: the hit-back note, the "Dare a friend" screen, and a slur split across username + display name
  (Sign up and Edit profile).
- Word filter mistakes: real words like Polish "spić", Czech "špic" and Spanish "pedó" are blocked (the surname
  "Fück" is fine now as a display name). Letters like ı, ø and ł aren't mapped, so a slur spelled with them gets
  through (app and server alike).
- Signed photo links made before a delete keep working until they run out (about an hour, shorter for peeks).
- Username login lock-out: someone with many internet addresses can keep one username's 40-try limit full, so
  the real owner must wait. People on shared Wi-Fi share the 30-try "from here" limit. Apple/Google/email
  accounts are not affected.
- Profile reports keep no evidence: the person can change their picture or bio right away (SEC-EVIDENCE-02).
- Group pictures (the photo set for a group, not photos sent in group chat) and profile pictures sit in the
  public `avatars` bucket, and any logged-in person can list every file there, so they can find other groups'
  pictures (already true in the live app; SEC-AVATARS-03). Photos, videos and voice notes sent in group chat
  are private to the group's members.
- The "Your account was deleted. Bye 👋" message is cut off almost at once (APP-2, cosmetic).
- Phones still on the old JS can't post the same story to the profile again after deleting that post, until
  the OTA lands (COMPAT-2).
- On an iPhone with a different Apple ID, the account is deleted, but Peekaboo stays listed under the
  account's own Apple ID and also under the iPhone's Apple ID (the Apple prompt during deletion adds it
  there). Remove it under each one in Settings → your name → Sign-In & Security → Sign in with Apple, on a
  device signed in with that Apple ID, or at account.apple.com.
- Web: `Alert.alert` does nothing anywhere in the app (use a toast for web messages). A tap at the very end of
  a page slide can be dropped. iOS Safari's edge swipe-back can't be blocked.
- On a fresh database nobody gets report alerts until the owner adds themselves: find your user id in
  Supabase → Authentication → Users, then run
  `insert into private.report_alert_people (user_id) values ('<id>');`

## Publishing (OTA) and builds

**Test channel:** there's a `testing` channel/branch for trying changes in Expo Go before they go live
(`exp://u.expo.dev/3c421eae-c4ec-47ea-92da-4b2d07b7d13e?channel-name=testing`). Installed builds use `preview`, so
nothing on `testing` reaches users or Apple's reviewer. The Inbox + chat dare streaks (`d636971`) are on `testing`
as update `b9693978-610a-43e9-b6bd-9236ca3559de`. The owner tested and OK'd it: it's **live on `preview`** as update
`b73eb4c8-d867-42f7-bfd6-70af64c303de` (head `a20e651`).

- Earlier sessions used a second "publishing" session to run `eas update` and native builds, because it holds
  the Expo/App Store Connect credentials. A new session can publish itself if `EXPO_TOKEN` is set
  (`npx eas-cli@27.1.0 whoami`). Follow the OTA recipe in `CLAUDE.md` and check the bundle for the Supabase
  URL.
- **Before every publish, check that the app opens.** On 4 Nov an update crashed the app on launch: two
  hooks subscribed to the same Supabase realtime channel name, and realtime-js throws when `.on()` is added
  after `subscribe()`. Every `supabase.channel(name)` must use a unique name per listener (see
  `useIncomingRequestCount` in `src/lib/friends.ts`). If a launch crash happens, republish the last good update
  group first, then fix.
- Last good published update: check expo.dev → Updates (preview) for the newest one the owner OK'd. The old
  `2805de80…` (commit `6c768aa`) is out of date: many app changes were published after it. For the QA
  release, use the id written down in step 5 of "Release order".

## Media cleanup and the Android map (4 Nov)

- **Cleanup:** `supabase/functions/cleanup-media` (verify_jwt off; checks `x-cleanup-key` against the Vault
  secret `media_cleanup_key`) runs daily at 04:17 UTC from pg_cron job `peekaboo-media-cleanup`. It deletes the
  files of stories / Guess Who posts that ended 7+ days ago and of opened, unsaved peeks 7+ days old – never posts,
  Keeps, voice notes, saved/unopened peeks, or anything reported. Rules: `public.media_cleanup_candidates` in
  migration `20261208000000_media_cleanup.sql` (live). A new media feature needs no change: only those three
  kinds are ever touched. After the QA release it also removes the files people deleted in the app (hidden at
  once, removed on the next run), within the same 1,000-files-a-run limit.
- **Android map:** `app.config.js` adds `android.config.googleMaps.apiKey` from the EAS env var
  `GOOGLE_MAPS_ANDROID_API_KEY` (iOS untouched – Apple Maps). Without it the Android map is grey. Needs the
  owner to create the key (Google Cloud project peekaboo-513706 → Maps SDK for Android, restricted to
  com.rbaig18.peekaboo + the EAS SHA-1) and then a new Android build.

## Website (for the App Store / Google links)

`website/` is built by `node scripts/build-website.mjs` from `legal/*.md` (home, support, privacy, terms,
guidelines, dare safety). Re-run it after legal changes, then re-upload the folder to Cloudflare Pages
(project `peekaboo`, live at https://peekaboo-4gz.pages.dev – `/privacy`, `/support`, `/terms`). Its URLs go in App Store Connect and Google Auth Platform → Branding.

## In progress: Sign in with Apple / Google (owner's call, 4 Nov)

New accounts are made with **Sign in with Apple (iPhone)** or **Sign in with Google (Android)**. That means no
passwords, no confirmation email and no Resend/domain. Old accounts (username or email + password) still log in.
- Code: `src/lib/socialAuth.ts` (native modules guarded; hidden in Expo Go/old builds, which keep the old
  Create account button), `components/SocialSignIn.tsx` (buttons on welcome + sign-in), `components/ProfileSetup.tsx`
  (new Apple/Google people pick a username + agree to the Terms once; "setup done" = any `legal_acceptances`
  terms row). Google is Android-only (`react-native.config.js` + `expo.autolinking.ios.exclude` keep it out of
  iOS). Google's Web client ID (`687778288055-…apps.googleusercontent.com`, project `peekaboo-513706`, not a secret)
  is in `socialAuth.ts`; `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` can override it.
- Migration `20261204000000_apple_google_sign_in.sql`: new-user trigger takes Google's name; plus
  `public.hook_only_apple_or_google_sign_ups`, inert until the owner switches on the "Before User Created" auth
  hook (do that only after the new builds are out).
- Live now: the migration (applied 4 Nov) and `delete-account` v5. Not published yet: the app code (it needs the
  new native builds; an OTA alone just keeps the old buttons).
- `delete-account` disconnects Apple when the app sends `apple_code`, but only after the account deletion has
  been opened and the Guess Who file list has loaded, and only if the account has an Apple login of its own.
  Best effort: an Apple failure doesn't stop the deletion. Needs `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` and
  skips this step without them. (That is the new version, waiting for the QA release. The live v5 still
  cancels whichever Apple login the code belongs to – finding R2-API-02.)
- Owner's steps, in order: Supabase Apple provider (Client IDs `com.rbaig18.peekaboo`); Google Cloud project with
  Web + Android OAuth clients (Android SHA-1 from expo.dev → Credentials); Supabase Google provider (web client
  ID + secret); give us the web client ID; the Apple "Sign in with Apple" key → Edge Function secrets; then "build
  it"; then switch on the hook.


- **Published (update `f947f748-1128-476d-9e5c-b40602268385`, commit `6c9a4db`):** pushes now go only to the real Peekaboo app. Expo Go showed its own
  logo on notifications, so it no longer signs up for pushes and takes itself off the list the next time it opens
  (`registerForPush` in `src/lib/notifications.ts`).

- **Name filter** (`src/lib/cleanWords.ts`): swearing is blocked in @usernames only (changed 5 Nov: display
  names used to be blocked too). Display names, bios, captions, comments, hit ups and group names allow
  swearing but block slurs. **Private chats between friends aren't filtered at all** (the
  owner's call, "free speech"). Report/Block still work in chats.
  Once the QA release is out, the database checks the same public text too
  (`20261214000000_public_word_filter.sql`: `private.blocked_word` and the `word_filter` triggers). The two
  must stay identical: change the word lists or rules in both `cleanWords.ts` and the migration's SQL, then
  run `npx vitest run tests/unit/word-filter-parity.test.mjs`. Only new or changed text is checked.
- **iOS push notifications fixed.** APNs key `RYQ8XWNZP4` was uploaded to EAS and attached to
  `com.rbaig18.peekaboo`. Receipts came back "ok". No rebuild was needed.
- **Reports are handled in the Supabase dashboard only.** The in-app owner screen was removed at the owner's
  request. `docs/TESTING.md` Step 54 explains how: the `reports` table, delete the content row, Auth → Users →
  Ban.
- Removed the dead Glam/Glow/Pup lens code. Only the 🤪 Googly lens is left.
- Launch-crash fix (unique realtime channel names).
- Friends:
  - Adding a **public** account makes you friends at once. **Private** accounts get a request.
  - Friend requests appear at the top of Chat with Accept / ✕.
  - Tapping the Friends number on a profile shows that person's friends, but **only to their friends**
    (`public.friends_of`).
- Guess Who posts straight from the editor (no "Send to…"). It never goes to a story or the profile grid.
- Birthday checks: real date, not in the future, not over 100 years ago, 13+. Checked in the app and the DB.
- **Hit ups are 18+ only** (DB-enforced). Under-18s see no button and can't be hit up.
- Passwords: 8+ characters with a letter and a number, in the app, the `username-auth` function and Supabase
  Auth settings.
- Googly eyes follow the face live (Reanimated shared values) and in recorded videos (eye track stored in the
  overlay PNG, `src/lib/eyeTrack.ts`).
- Earlier work: Keeps (save edits), username-only sign up, chat long-press options, the final logo
  everywhere, hit ups, and much more (see `git log`).

## Reactions, replies, group photo, pinned message (4 Nov)

- `20261212000000_chat_extras.sql`: `message_reactions` and `group_message_reactions` (one per person per message;
  push to the sender), `reply_to` on `messages` and `group_messages` (same-chat check), `peek_groups.photo_path`
  (avatars bucket, `set_group_photo`), `pinned_message_id` (`pin_group_message`), realtime for both reaction
  tables and `peek_groups`. Applied live on 4 Nov (owner said "go"); safe to publish.
- App: `components/MessageActions.tsx` (hold menu with reactions, ReactionChips, ReplyQuote), `lib/reactions.ts`.

## Group chats part 2 + chat search (4 Nov)

- `20261211000000_group_chat_more.sql` (applied): `group_messages.kind` ('text','photo','video','voice','dare',
  'proof') + media columns + `dare_id`; files must be the sender's own; proof must be for a dare in the same
  group; a new `group` storage folder; `can_read_media` lets members read `<owner>/group/…` and group voice
  notes; pushes and `my_group_chats` use `private.group_message_preview`; typing channel `typing-group:<id>`
  (members only, realtime.messages policies).
- App: camera/editor take `group` / `groupDare` params (straight to the group chat); `useGroupTyping` in
  `lib/typing.ts`; "Seen by" from `peek_group_members.chat_read_at` (polled every 15 s); search in both chats
  (`searchConversation`, `searchGroupMessages`, ilike on body, jump to message if loaded).
- **Live on `preview`** as update `9658dbdc-cbdb-4bb9-85ad-6a8cfa43f821` (head `90a1055`) after the owner OK'd it.

## Delete for me, Clear chat, Group chat (4 Nov)

- `20261209000000_delete_for_me.sql` (applied): `message_hides`, `hide_message`, `clear_chat`.
  `fetchConversation` / `fetchRecentMessages` filter hidden ids.
- `20261210000000_group_chat.sql` (applied): `group_messages` (members only), `peek_group_members.chat_read_at`
  and `chat_muted`, `mark_group_chat_read`, `set_group_chat_muted`, `my_group_chats()`, a push trigger, and
  realtime. App: `lib/groupChat.ts`, `(app)/groups/chat/[id].tsx`. Chat list group rows open the chat and show
  unread counts and the last message. Text only for now. **Live on `preview`** as update
  `f5e1ac5c-3d97-43cd-8499-73802a97812d` (head `c2abb68`), after the owner tested it on `testing`.

## Dare them back, live Inbox, server drop reminder (4 Nov)

- `components/DareBackButton.tsx` on friends' dare posts (FeedCard `canDareBack`, post/[id]) → a chat dare.
- Inbox listens live (likes, comments, comment_likes, friendships, hit_ups added to `supabase_realtime` by
  `20261207000000_inbox_live.sql`, applied). One channel per visit with a unique name.
- `20261208000000_drop_reminders.sql`: `push_tokens.utc_offset_minutes`, `register_push_token(push_token, phone,
  utc_offset default null)`, `private.send_drop_reminders()` run every minute by pg_cron
  (`peekaboo-drop-reminders`). It sends to users whose last app open was 7–45 days ago at their local drop minute,
  once a day. The app sends `utc_offset` and falls back to the old 2-argument call if the server doesn't have
  it yet, so publishing doesn't depend on this migration. **Applied live (4 Nov)**: pg_cron job
  `peekaboo-drop-reminders` runs every minute (check `cron.job_run_details`).

## Inbox 🔔 + chat dare streaks (done, 4 Nov)

- **Inbox** (`src/app/(app)/inbox.tsx`): hit ups, friend requests and Activity moved out of the Chat list into
  an Inbox behind a 🔔 bell in the Chat header (`PageHeader` `inbox` prop), with a red number and a slim
  "N new in your Inbox" row. There's a **Clear** for activity and pull-to-refresh in Chat and the Inbox. Opening
  the app clears delivered notifications and the badge (`useClearNotificationsWhenOpen` in `lib/notifications.ts`).
  Foreground notifications show as a banner only (`shouldShowList: false`).
- **Chat dares** (`20261206000000_chat_dare_streaks.sql`, applied live): `messages.dare_state` (null → 'claimed'
  → 'done', or 'nope'), `claim_chat_dare`, `confirm_chat_dare`, `chat_dare_streak`. Proof peek: chat → `/camera?
  to=…&chatDare=<id>` → editor claims after sending. A streak counts completed dares between two people with no
  gap over 3 days; it shows under the name in the chat header.

## Activity 🔔 (done, 4 Nov)

At the top of Chat: likes, comments, replies, comment likes, "added you", "accepted your request" and "hit you
back" from the last 30 days. It comes from `public.my_activity()` (`20261205000000_activity.sql`, applied live)
and `src/lib/activity.ts`. **Published** as update `9701c213-a6ed-4373-9bb7-b3ca20540406`, built from `dc54575`
with only the Activity commit (`abb5aa3`) on top, so the unfinished Apple/Google sign-in code was left out.
Newest published update: `c1a737b9-e5d0-444e-8c21-22d7b5ecae34` = `dc54575` + `abb5aa3` + `5fa9b29` (Contact us
opens the mail app without showing the address). Still without the sign-in work.
**From now on, publish OTAs from branch head only.** The new native builds (iOS 4 / Android v12) share runtime
`exposdk:58.0.0` and the `preview` channel. They would download any newer old-base update and lose the sign-in
work, or crash on mismatched JS patch versions. Make sure the newest preview update is head-based before or as
those builds go out. The
"seen" marker is kept on the phone. New items count on the Chat tab until you
leave Chat. There's no realtime listener: it refreshes on focus, when the app comes back to the front, and
when a push arrives.

## Peekaboo+ ⭐ payments (branch `plus-payments`, not live)

- RevenueCat (`react-native-purchases`, loaded through a guard in `src/lib/plus.ts`; native module `RNPurchases`).
  App Store product `peekaboo_plus_monthly`, entitlement `plus`, offering `default` (Monthly package). iPhone only.
  Without `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, on Android, in Expo Go or on older downloads, the screen says "coming soon".
- Has Plus = tester (`TESTERS` in `plus.ts`) or RevenueCat entitlement `plus` or a `public.plus_members` row that
  hasn't run out. `configurePurchases(userId)` runs from `(app)/_layout.tsx` (RevenueCat app user id = Supabase id).
- Screen `(app)/plus.tsx`; locked themes, chat backgrounds and stickers open it. ⭐ badge: `components/PlusBadge.tsx`.
- Server: migration `20261215000000_peekaboo_plus.sql` (not applied; adds `public.log_plus_event` for the webhook)
  and Edge Function `revenuecat-webhook` (not deployed; owner steps at the top of its file).
- Needs a new native build (TestFlight) before it works on phones. An OTA alone keeps showing "coming soon".
- Plus insights (branch `plus-insights`, not live): 👀 who viewed your profile (`/profile-views`, button on your
  own profile), 🔁 who rewatched your story and 📸 who screenshotted it (in the story's "Seen by" sheet), and 📸
  screenshots of your posts (`/screenshots/[id]`, from the post). Settings → Privacy has "Show me in Profile views".
  App code: `src/lib/insights.ts`. Server: migration `20261217000000_plus_insights.sql` (not applied). Names are
  only handed out by the server when `private.is_plus` says yes (a `plus_members` row) – the `TESTERS` list in
  `plus.ts` is app-only, so a tester without a row sees the free version of these screens.

## Peekaboo+ extras (branch `plus-extras`, not live)

- Migration `20261218000000_plus_extras.sql` (not applied; needs `20261215000000_peekaboo_plus.sql` first).
  Every check is on the server with `private.is_plus`.
- 🙈 **Peek-a-Save** (`public.peek_a_save`, `public.my_broken_streaks`, table `peek_a_saves`): a daily dare or
  chat dare streak (2+ long) that broke less than 24 hours ago can be brought back, 1 per calendar month (UTC),
  no carry-over. The friend gets a push. `dare_streaks()` and `private.dare_streak` were rewritten to count saves.
  Cards: Dare screen (all broken streaks) and the 1-on-1 chat (that friend's chat dare streak). The daily drop
  has no streak, so there's nothing to save there.
- ⏰ **Drop rewind** (`posts.drop_rewound`, table `drop_rewinds`, trigger `posts_set_drop_fields_rewind`): once a
  week (Monday–Sunday UTC) a late drop is posted as "On time". The real lateness is kept in `drop_rewinds`. If
  the server says no, the drop is just posted late. Choice on Send to, only once the drop is late.
- 🕵️ **Guess Who hint** (`public.mystery_hint`, table `mystery_hints`): one clue per post per person, never the
  name or id. Button under the 4 names on Guess Who.
- `public.plus_allowances()` tells the app what's left. Without the migration all three stay hidden.
- The testers in `src/lib/plus.ts` only have Plus in the app: for the server features they also need a
  `plus_members` row.

## Face mesh + face filters (merged; on the iPhone builds that have face tracking)

MediaPipe Face Landmarker (478 face points + 52 expression scores) as our own VisionCamera v5 camera output in
`modules/face-mesh`, with the face filters drawn in `src/components/lens/` (Soft Glow, Golden Hour and, since
9 Nov, the five new Plus filters – see "Face filters" under Now). It's in App Store build 10 and TestFlight builds
7–9 (the same list as `docs/FACE_MESH.md`); Android has no face mesh yet. Steps, sizes and risks: `docs/FACE_MESH.md`.

## Open items

Owner's to-do:
1. **App Store blocker:** the Account Holder must accept the updated **Paid Applications Schedule**
   (developer.apple.com/account, then App Store Connect → Business). New apps can't be submitted until this
   is done.
2. **Age rating:** answer Apple's new social media questions in App Store Connect → Peekaboo → App
   Information → Age Rating. The app has user content, chat and friends, and is for ages 13+.
3. Before submitting:
   - a full test run with the review account
   - 5 screenshots
   - confirm the app name
   - a fresh story on the review account
4. After launch: act on reports within 24 hours. Every new report sends the owner a push ("🚩 New report"), from
   the `alert_new_report` trigger on `public.reports` (`20261207000000_report_alerts.sql`, live). Who gets it:
   `private.report_alert_people`. Then open the `reports` table in Supabase. After the QA release:
   `dismissed` lets go of a report's files for good, `reviewed` keeps them.

Waiting on the owner's word:
- **"go" for the QA round 2 release** – follow "Release order" near the top of this file, step by step.
- **"build it"**: new native builds (TestFlight + Android APK). They're needed for Save to Photos
  (expo-media-library). After the APK build, update `ANDROID_LINK` in `src/lib/invite.ts`.
- **Confirm email** is OFF on purpose. Supabase's built-in mailer only sends to team members. To turn it on,
  first set up custom SMTP (for example Resend) under Auth → Emails → Set up SMTP.

Optional ideas the owner may ask for:

## Database changes

Migrations live in `supabase/migrations` and are applied in filename order. All of them up to
`20261212000000_chat_extras.sql` are live (the sign-up hook from `20261204000000_apple_google_sign_in.sql` is not
switched on yet). The QA migrations from `20261213102659` on are NOT applied yet (see "Release order" above).
The old `20261129000000_moderation.sql` was deleted and never applied.

Test a migration locally before applying it. The local suite in `tests/README.md` runs every migration on
PGlite (`npm test`) and on a real PostgreSQL 16 (`npm run test:concurrency`, `npm run test:rest`), with
stand-ins for Supabase's `auth`, `storage`, `realtime`, `vault`, `cron` and `net`. `npm run test:preflight` rehearses a
release against `tests/database/deployment-preflight.sql`. When a new migration adds a public function that
app users may call, add it to the allow-list in `tests/database/review-media.test.mjs` on purpose (or revoke
it). Never point the tests at the live project.
