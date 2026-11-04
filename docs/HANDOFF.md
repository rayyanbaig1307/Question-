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

## Done recently (newest first)

- **Not published yet (needs an OTA):** pushes now go only to the real Peekaboo app. Expo Go showed its own
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
4. After launch: check the Supabase `reports` table daily and act within 24 hours.

Waiting on the owner's word:
- **"build it"**: new native builds (TestFlight + Android APK). They're needed for Save to Photos
  (expo-media-library). After the APK build, update `ANDROID_LINK` in `src/lib/invite.ts`.
- **Confirm email** is OFF on purpose. Supabase's built-in mailer only sends to team members. To turn it on,
  first set up custom SMTP (for example Resend) under Auth → Emails → Set up SMTP.

Optional ideas the owner may ask for:
- An in-app list of likes and comments next to friend requests in Chat.

## Database changes

Migrations live in `supabase/migrations` and are applied in filename order. All of them up to
`20261203000000_add_public_friends.sql` are live. The old `20261129000000_moderation.sql` was deleted and never
applied.

Earlier sessions tested every migration on a local Postgres 16 with small stubs for Supabase's `auth`,
`storage`, `realtime` and `net` schemas before applying it. Recreate that if needed. Grant `net` usage to
`authenticated` and add `push_tokens` rows to see pushes in `net.sent`.
