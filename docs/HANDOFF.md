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
| Android APK (v10) | link in `src/lib/invite.ts` (`ANDROID_LINK`) |
| Owner's app account | `@coolname`, user id `d3614487-2fa7-477c-8b64-be66ce1f5f3f` |
| Test account | `@ayaan` (owner's brother), birthday 8 Jul 2007, friends with the owner |
| App review account | `review@peekaboo.invalid` / `@peekaboo_review` (password is in App Store Connect → App Review Information) |
| Legal operator | 2865113 Ontario Inc. (Ontario, Canada), rbaig18@z2automation.net. There's no mailing address, on purpose. |

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
- Last good published update: `2805de80-32fd-4d0b-b2ea-859a479862b0` (commit `6c768aa`). Every app change up
  to then is live. Commits after it only touch docs.

## Media cleanup and the Android map (4 Nov)

- **Cleanup:** `supabase/functions/cleanup-media` (verify_jwt off; checks `x-cleanup-key` against the Vault
  secret `media_cleanup_key`) runs daily at 04:17 UTC from pg_cron job `peekaboo-media-cleanup`. It deletes the
  files of stories / Guess Who posts that ended 7+ days ago and of opened, unsaved peeks 7+ days old – never posts,
  Keeps, voice notes, saved/unopened peeks, or anything reported. Rules: `public.media_cleanup_candidates` in
  migration `20261208000000_media_cleanup.sql` (live). A new media feature needs no change: only those three
  kinds are ever touched.
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
- `delete-account` revokes the Apple token when the app sends `apple_code` (needs secrets `APPLE_KEY_ID`,
  `APPLE_PRIVATE_KEY`; skipped without them).
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

## Face mesh + Soft Glow lens (branch `mediapipe-faces`, not switched on)

MediaPipe Face Landmarker (478 face points + 52 expression scores) as our own VisionCamera v5 camera output in
`modules/face-mesh`, plus a Soft Glow demo lens (`src/components/lens/`). It isn't in `package.json` yet, so
builds are unchanged. Not tested on a phone. Steps, sizes and risks: `docs/FACE_MESH.md`.

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
   `private.report_alert_people`. Then open the `reports` table in Supabase.

Waiting on the owner's word:
- **"build it"**: new native builds (TestFlight + Android APK). They're needed for Save to Photos
  (expo-media-library). After the APK build, update `ANDROID_LINK` in `src/lib/invite.ts`.
- **Confirm email** is OFF on purpose. Supabase's built-in mailer only sends to team members. To turn it on,
  first set up custom SMTP (for example Resend) under Auth → Emails → Set up SMTP.

Optional ideas the owner may ask for:

## Database changes

Migrations live in `supabase/migrations` and are applied in filename order. All of them up to
`20261204000000_apple_google_sign_in.sql` are live (its sign-up hook is not switched on yet). The old `20261129000000_moderation.sql` was deleted and never
applied.

Earlier sessions tested every migration on a local Postgres 16 with small stubs for Supabase's `auth`,
`storage`, `realtime` and `net` schemas before applying it. Recreate that if needed. Grant `net` usage to
`authenticated` and add `push_tokens` rows to see pushes in `net.sent`.
