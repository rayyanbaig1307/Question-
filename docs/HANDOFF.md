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
| Owner's app account | `@coolname`, user id `d3614487-2fa7-477c-8b64-be66ce1f5f3f` |
| Test account | `@ayaan` (owner's brother), birthday 8 Jul 2007, friends with the owner |
| App review account | `review@peekaboo.invalid` / `@peekaboo_review` (password is in App Store Connect → App Review Information) |
| Legal operator | 2865113 Ontario Inc. (Ontario, Canada), rbaig18@z2automation.net. There's no mailing address, on purpose. |

## Now: QA round 2 is done on this branch, but NOT released (4 Nov)

**Status.** A big QA and security review was folded in: the supplied QA patch plus our own review fixes. It
is finished and **tested on this computer only**. **Nothing has been pushed, deployed, migrated on the
hosted project or published as an OTA.** The live app and live database are still the old ones (app code up
to `a9e5ddf`, migrations up to `20261212000000_chat_extras.sql`). Releasing needs the owner's "go".

- **Commits** (local only): from `ac246c3` (the supplied patch: security fixes, hardening migration
  `20261213102659`, local test suite) to the branch head. `ee96f61` makes the tests run on Linux,
  `468e792` patches dev-tool advisories (glob/minimatch overrides; no app or native package changed), and
  the commits after it hold the review fixes for the database, the Edge Functions and the app.
- **New migrations (not applied):** `20261213102659_qa_round2_security_hardening`,
  `20261213200000_qa_review_media_fixes`, `20261213210000_qa_review_robustness_fixes`,
  `20261213220000_username_auth_limits`, `20261214000000_public_word_filter`, `20261214100000_qa_final_db_fixes`.
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
- Public text (names, bios, captions, comments, hit ups, dare ideas, group names) is now word-checked by
  the database too, not just the app. Private chat is still not filtered.
- Username login has fairer limits (see below). A server problem says "Could not reach the login service.
  Please try again." instead of "Wrong username or password".
- Deleting an account on an iPhone signed in to a different Apple ID still deletes the account, but no longer
  disconnects that other Apple ID (it could be someone else's).
- A deleted photo, video or voice note disappears at once for everyone; its file is removed by the daily
  cleanup a little later. Files a report still needs stay hidden while the report is `open` or `reviewed`,
  until it is set to `dismissed` or let go with `release_report_evidence`.
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
- Profile song title/artist are not word-filtered (real song titles contain these words).
- Private chat is not word-filtered on purpose (1:1 and group chat, chat dares). Checked by the app only, not
  the database: the hit-back note, the "Dare a friend" screen, and a word split across username + display name.
- Word filter mistakes: real words like Polish "spić", Czech "špic", Spanish "pedó" and the surname "Fück" are
  blocked. Letters like ı, ø and ł aren't mapped, so a slur spelled with them gets through (app and server alike).
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

- **Name filter** (`src/lib/cleanWords.ts`): swearing is blocked in usernames and display names only.
  "Dick"/"Cock" are allowed when written like a real name ("Moby Dick"). Bios, captions, comments, hit ups and
  group names allow swearing but block slurs. **Private chats between friends aren't filtered at all** (the
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
