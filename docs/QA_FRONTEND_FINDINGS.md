# Frontend QA findings

Tested source: `claude/mobile-social-app-expo-h090jm`, fresh round-two revision `b0dc637576cfd5cf5033538d2a8080fd1e99a9a7`. The earlier audit was against `dc545759...`; its unpushed fixes were ported with checked patches, preserving the new Apple/Google, Inbox, chat, reply and group features. All failures below were rechecked against this fresh revision, not assumed to remain from the earlier audit.

Final verification used the fixed working tree on upstream revision `a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1`. The upstream change since the starting revision only replaces the Android APK invite link. The first comparison used `b0dc637`; the final original-source loader reads `a9e5ddf`, with the tested screen code unchanged. The final frontend rerun produced the same 42 passing / 47 failing baseline and 89 passing / 0 failing fixed results. The linked APK was not installed or tested on a phone.

All work used local source, invented users and mocked phone/network/database services. No test called the live Supabase project. Tests run real screen/component code with React 19.3's test renderer. They do not prove camera hardware, phone gestures, screenshots, push delivery, or native visual layout.

## Results

`node --test --test-reporter=tap tests/frontend/*.test.cjs`:

- Original source: 42 passing, 47 failing, 0 skipped (89 test results; the count includes the parent of three audience subtests).
- Fixed source: 89 passing, 0 failing, 0 skipped.
- Original source is loaded read-only with `QA_ORIGINAL=1` and `git show`. The working tree is never reset to run the old code.
- Durable logs: `.qa/frontend-before.tap` and `.qa/frontend-after.tap`.

Type checking passes. Expo lint passes with `EXPO_NO_TELEMETRY=1`; disabling telemetry avoids writing outside this workspace.

The final integration checks reported separately by the main audit passed 60 browser tests and 51 local REST tests. Three browser tests remain skipped because signed-in web rendering reaches the native pager limitation. These checks do not complete the phone controls marked pending in the route matrix below.

## Verified bugs and fixes

| ID | Severity | What broke and how to reproduce | Fix and proof |
|---|---|---|---|
| FE-01 | High | Start a dare, drop or forfeit photo; also select My Story; turn on Close friends only; confirm the story preview. The story was restricted, but the same photo became a profile post with the default `everyone` audience. A public account could expose the restricted photo to strangers. | Pass the selected audience to every generated post, and show the privacy switch for special posts even without a story. Three rendered screen cases fail on the original and pass after the fix (`share.test.cjs`). |
| FE-02 | High | Start showing your location while the permission prompt is delayed, then choose Hide. Complete the older permission prompt. The old request switched sharing back on. A delayed profile save could do the same; an old GPS lookup could upload coordinates after Hide. | Keep profile writes in order, discard superseded permission/GPS results, and cancel background refresh work when its effect ends. Hiding does not wait for GPS. The original fails all three controlled timing cases; all pass after the fix (`location.test.cjs`). |
| FE-03 | High | In Settings, switch Private account off then on while the first save is delayed. The older public save could finish last and leave the account public. Similarly, choose Friends of friends then Nobody for hit ups; the older, broader choice could win. | Queue privacy saves in the order selected. Merge only the changed profile fields so an unrelated late response cannot overwrite other local settings. Both original timing tests fail; both pass now (`settings.test.cjs`). |
| FE-04 | High | In Close friends, start with Bob excluded. Add Bob and then remove him before the first request finishes. Let the removal finish first and the older addition finish last. The screen said Bob was excluded while the saved list still included him. | Allow only one pending change per person; disable that person's row until the save settles. A failed save restores the old choice. The original privacy invariant fails (`true` stored versus `false` shown); the fixed tests pass (`privacy.test.cjs`). |
| FE-05 | High, conditional | Replace account A's signed-in session directly with account B's session without an intermediate signed-out state. The navigation tree kept its identity, so old chats, forms and component state could remain until new loads completed. The ordinary Log out then Log in path already unmounted it. | Give the navigation tree a key based on the signed-in user ID. The rendered test proves it now remounts on account change (`navigation.test.cjs`). Combine with the separate signed-media cache/auth fixes; this is a device state isolation issue, not a database authorization bypass. |
| FE-06 | Medium | Press Send twice before the first render disables it. Share sent two identical peeks; the direct chat, group chat and editor-to-group paths also sent duplicates. Delayed preview callbacks could use an old completion snapshot. | Use immediate in-flight locks and a live completion record where a send has several destinations. Retrying after a later destination fails still avoids resending successful destinations. Original cases make 2 sends; fixed cases make 1 (`share.test.cjs`, `chat.test.cjs`, `group-chat.test.cjs`, `editor.test.cjs`). |
| FE-07 | Medium | Open the profile preview with an allowed caption, then edit its caption to disallowed content and press Post. The final preview called the send function without checking the edited text. | Recheck the final caption at the write boundary. The original makes a post; fixed code blocks it and explains why (`share.test.cjs`). Server-side content controls are separately assessed in the database review. |
| FE-08 | Medium | Open a disappearing photo on a slow connection and go Back before its download completes. The old download continued and consumed the view even though the screen was gone. | Check cancellation before consuming the view/replay. Original test consumes 1 view; fixed test consumes 0 (`snap.test.cjs`). This test covers a photo download; it does not certify the native video playback failure path. |
| FE-09 | Medium | Open the app while Terms acceptance is loading, or make that database read fail. The original gate started open and stayed open after an error. | Start with the gate closed and only dismiss it after a confirmed acceptance or successful save. Original pending/error cases fail; all gate tests pass now (`terms.test.cjs`). |
| FE-10 | Medium | Enable location sharing, let the preference save, then make the GPS lookup fail. The original threw before returning the saved profile, leaving the screen unaware that sharing was enabled. | Return the committed preference even if refreshing coordinates fails; record that refresh failure and let the normal refresh retry. The location test confirms the screen receives the same sharing state that was saved (`location.test.cjs`). |
| FE-11 | Medium | Make logout reject while choosing Log out from the Terms screen or confirming it in Settings. The button callbacks had no error handler, producing an unhandled rejection without a useful explanation. This also matters now that the auth fix correctly reports rejected logout requests. | Catch the failure in both screens and show a clear error while keeping the current screen. Both rendered rejection tests pass (`terms.test.cjs`, `settings.test.cjs`). |
| FE-12 | High, signup gate | Make the new Apple/Google setup's Terms lookup fail. `useNeedsSetup` answered "setup not needed", skipping the required name/age/setup confirmations. The ordinary Terms modal could still appear, but it does not perform the age/name setup. | On a failed check, keep setup required. The original hook returns false; fixed returns true (`social-setup.test.cjs`). This is a client onboarding bypass, not proof that Apple or Google accounts identify the user's age. |
| FE-13 | High, conditional | Begin saving account A's setup and leave/switch accounts while the profile write is delayed. Let it complete after unmount. The old code still called the current-session `accept_legal` operation, which could accept Terms for account B. | Stop setup continuations after cancellation/unmount; prevent competing saves. The old test calls accept_legal once after unmount; the fixed test calls it zero times (`social-setup.test.cjs`). |
| FE-14 | Medium | Press the native Google sign-in button twice before busy state renders. Two native account-selection/login flows start and can compete to choose the signed-in account. | Use an immediate ref lock shared by the social buttons. The original starts 2 flows, fixed starts 1 (`social-setup.test.cjs`). Native Apple/Google delivery still needs device testing. |
| FE-15 | High, broken core feature | Send a video to a group chat. Every video was rendered paused with native playback controls disabled, and there was no tap action to open or play it. | Add a closeable full-screen media viewer: tap a photo/video to open it; a video plays there with sound, while thumbnails remain paused. The rendered test proves the action and active player flags; actual playback/decoding still needs a device (`group-chat.test.cjs`). |
| FE-16 | Medium | Report a group message. The report was about the sender's profile, with no ID for the offending message; a moderator could not find the exact reported content from that report. | Send `group_message` plus the actual message ID. The database hardening separately validates group membership and the sender. Original sends `user`/sender ID; fixed sends `group_message`/message ID (`group-chat.test.cjs`). |
| FE-17 | Medium | On a slow send in either chat, type the next message before the first request returns. Success of the first send erased the newly typed draft (and could clear a newly selected reply). | Clear only the exact draft/reply that was sent. Original loses the next draft; both fixed chat tests preserve it (`chat.test.cjs`, `group-chat.test.cjs`). |
| FE-18 | Medium | Search for one word, immediately search another, and deliver the older request last. The older result overwrote the newer result; query matching then hid the list, losing the correct results. | Accept only the latest search response/error. Both original direct/group cases lose the new result; both fixed cases keep it (`chat.test.cjs`, `group-chat.test.cjs`). |
| FE-19 | Medium | Send photo proof for a chat dare, let the photo save, then fail the dare update. The error was swallowed and the screen announced success even though the sender could not confirm the dare. | Explain the partial success and retry only the dare update; keep the successful photo recorded so retry does not resend it (`editor.test.cjs`). |
| FE-20 | Medium | Start recording, then leave while recording or while preparation is pending. The JS polling timer remained, and old preparation still attempted to start the recorder. A failure when stopping also rejected without a handled UI path. | Clear timers, stop/cancel pending work, avoid post-unmount sends, and handle stop failures. Three original cases fail and fixed cases pass (`voice.test.cjs`). These tests verify JS lifecycle; they do not claim that Expo's native auto-release leaves the physical microphone recording. |
| FE-21 | Medium, native presentation risk | Choose Report in the new message menu. The next sheet was requested immediately while the old native Modal was still closing. This conflicts with the app's established iOS menu-closing pattern. | Defer actions until native dismissal, with a guarded fallback timer. The sequencing test proves the next action waits and executes once. Whether the original failed visually on a particular phone remains unverified (`message-actions.test.cjs`). |
| FE-22 | Medium | Press Hit back and Ignore in the Inbox before the first render disables them. Both contradictory responses were submitted for the same hit up. | Lock the response immediately. The original submits 2 requests; fixed submits only the first choice (`inbox.test.cjs`). Database concurrency protection is tested separately. |
| FE-23 | High, conditional | Replace the signed-in account while an old bottom menu is open or a menu action is delayed. The global overlay survived the navigation reset, and its delayed action could still run after unmount using the next session. | Key overlays by account as well as navigation; cancel their timers and pending actions on unmount. Both original lifetime tests fail, fixed pass (`navigation.test.cjs`, `overlays.test.cjs`). |
| FE-24 | High, conditional destructive action | Open account A's final native Delete account confirmation, unmount/switch to B, and invoke the stored confirmation. It still called deletion using the current login. Old logout and Clear chat confirmations similarly acted after their source account was left; an old successful deletion response could log out B. Native Alerts can outlive React screens. | Guard native callbacks and post-request continuations by screen lifetime. Bind delete/logout requests to the account that approved them; the API layer separately validates expected user identity. The original stored-callback cases act after unmount; fixed cases make no operation. An in-flight deletion explicitly receives A's ID and does not log out a later login (`settings.test.cjs`, `terms.test.cjs`, `chat-list.test.cjs`). |

## Automated coverage

- Login: empty credentials; email versus username routing; leading `@`; wrong password; retry; password masking.
- Signup: empty form; username cleanup; independent age and Terms confirmations; email confirmation screen; missing password requirements, including emoji-only passwords. These tests use the real password/username/content validators and fake authentication services.
- Birthday validation: empty/zero/negative/huge/emoji inputs, invalid dates/months, leap dates, future dates, exact 13/100 year boundaries.
- Sharing: three restricted-audience regressions, repeated presses, a network failure and retry, partial success followed by retry, edited-preview validation.
- Privacy/settings: out-of-order saves, denied permission, obsolete GPS results, failed close-friend saves, failed GPS refresh.
- Session isolation, Terms read/save errors, and leaving a peek mid-download.
- Apple/Google UI availability, setup fields/confirmations, failed setup lookup, stale setup continuation, rejected logout and concurrent account-selection presses. Actual provider sign-in is covered separately with mocked native providers, not a live Google/Apple account.
- Direct/group message sending, preserving next drafts, replies, delete-for-me, group pin/delete, search response order, group video opening, exact report targets and subscription/timer cleanup.
- Inbox activity links/clear/seen/live reload, unique realtime listeners, contradictory hit-up responses, recorder cleanup/errors, native-menu action sequencing, and native confirmation callbacks retained after an account is left.
- Every statically declared `router.push`, `replace`, `dismissTo` or `navigate` destination across `src/` is checked against an existing screen. This checks links, not successful rendering or every button's runtime behavior.

## Complete screen inventory and remaining device checks

There are 40 screen/layout source files: 38 screens plus the root and signed-in layouts. Every route participates in the navigation-destination audit. ProfileSetup and SocialSignIn are additional components in existing routes. The following is the device test matrix, not a claim that every control was exercised on a phone.

| Route | Main controls/flows to exercise on a device | Additional local automated coverage |
|---|---|---|
| `/welcome` | Apple/Google or legacy account creation, old-account login, animation, small-screen layout | Browser checks owned by root QA; social button logic tested separately |
| `/sign-in` | Login, keyboard submit, create-account link | Rendered form tests |
| `/sign-up` | Name/username/email/password, signup mode, age/Terms boxes, legal links, submit | Rendered form tests |
| `/legal/[doc]` | Every document, back, long-text scrolling | Navigation destination audit |
| `/` | Chat/Camera/Home swipes and tabs, unread counts, refresh, notification arrival | Navigation account remount test; native pager still needs device verification |
| `/camera` | Permission allow/deny/settings, flip, flash, photo/video shutter, gallery, mode dial | Navigation audit; hardware pending |
| `/editor` | Text/stickers/filter/crop/zoom/undo/remove, save, send, cancel; direct chat, group/proof and Guess Who flows | Duplicate group media and partial dare-proof retry tests; native editing gestures pending |
| `/share` | Every destination, audience, friend picker, previews, send, back, retry | Rendered audience/send/failure tests |
| `/settings` | Every privacy/notification switch, hit-up audience, appearance, legal, birthday, logout/delete | Rendered privacy/order and retained native deletion/logout callback tests |
| `/birthday` | Day/month/year, confirmation, cancel, save, error | Birthday validation tests |
| `/blocked` | Empty/populated lists, unblock, errors, back | Navigation audit; controls pending |
| `/friends` | Search, request/cancel/accept/decline/unfriend, invite, profile links | Navigation audit; controls pending |
| `/friends-of/[id]` | Friend-only list, add buttons, own-user exclusion, back | Navigation audit; DB access tests owned by database QA |
| `/close-friends` | Add/remove rows, errors, rapid taps, scroll, back | Rendered race/rollback tests |
| `/profile/[id]` | Public/private/blocked/self, stats, story ring, edit/settings/menu, friend/hit-up buttons, posts | Navigation audit; DB access tests owned by database QA |
| `/edit-profile` | Name/username/bio/private, photo picker/crop/remove, save, taken username, errors | Navigation audit; controls pending |
| `/chat/[id]` | Text/voice/peeks/dares, typing/read state, reactions/replies, search, delete-for-me/everyone, save/report, friendship loss | Rendered sends/draft/reply/delete/search tests; services/auth covered separately; phone gestures pending |
| `/inbox` | Activity links/clear, hit-back/ignore/report/block, friend requests, pull refresh, live events, seen state | Rendered activity, subscription uniqueness, live reload and contradictory response tests |
| `/snap/[id]` | Photo/video playback, timer, replay, save/unsave, screenshot, zoom, back, slow download | Cancelled-photo test; native playback pending |
| `/stories/[user]` | Tap forward/back, hold pause, queue, viewers, react, delete/report, back | Navigation audit; controls pending |
| `/post/[id]` | Image/video, zoom, caption expand, like, comments, edit/delete/report, locked drops | Navigation audit; controls pending |
| `/post-compose` | Own-only edit/repost, caption, audience, preview, save, back, errors | Navigation audit; controls pending |
| `/comments/[postId]` | Add/reply/like/delete/report, sheet drag/dismiss, keyboard, errors | Navigation audit; controls pending |
| `/map` | Location opt-in/out, permission denial, friend markers, profile link, close | Location service race/error tests; native map pending |
| `/dare` | Capture, custom dare, incoming dares, chain/forfeit/streak cards, rules, refresh | Navigation audit; controls pending |
| `/dare-chain` | Pick up to three friends, limits, send, invite, skip | Navigation audit; DB limits owned by database QA |
| `/dare-friend` | Input/ideas, recipient selection, send, errors | Navigation audit; controls pending |
| `/dare-ideas` | Input, suggest, rules agreement, sort, vote/report/delete | Navigation audit; controls pending |
| `/forfeit/[nomination]` | Options, confirm/cancel, submit/error, back | Navigation audit; DB rules owned by database QA |
| `/guess` | Capture, one guess, reveal, report/block/delete, refresh | Navigation audit; DB rules owned by database QA |
| `/groups` | List, group link, new group, refresh | Navigation audit; controls pending |
| `/groups/new` | Name, member picker/limits, create/rename/add, failure | Navigation audit; controls pending |
| `/groups/[id]` | Missing/complete group states, post, nudge, edit/leave/delete/remove, refresh | Navigation audit; DB access owned by database QA |
| `/groups/chat/[id]` | Text/photo/video/voice/dare/proof, reactions/replies, search, seen/typing, photo/name, mute, pin/unpin, delete/report, membership loss | Rendered media opening/send/draft/report/reply/pin/delete/search/member-loss and polling cleanup tests; actual native media pending |
| `/peekers/[postId]` | Owner-only sections, profile links, back | Navigation audit; DB access owned by database QA |
| `/song` | Search/cancel, preview, pick/remove, third-party failure, back | Navigation audit; services tested separately |
| `/keeps` | Own-only grid, open, camera, missing/error states | Navigation audit; DB access owned by database QA |
| `/keeps/[id]` | Photo/video, save to Photos, repost, delete, close, missing/error states | Navigation audit; native media pending |
| Root/signed-in layouts | Setup-needed fallback, signed-out protection, social profile setup, splash, Terms, notification/location cleanup | Navigation/overlay remount, ProfileSetup and Terms tests; native launch/build verification still required |

Before release, use two disposable accounts in a separate test project on real Android and iOS devices. Follow `docs/TESTING.md` with the above route matrix, especially camera/video/microphone/permissions, gestures, repeated editor presses, screenshot notices, push taps, offline/slow network and refresh/back during uploads. The remaining phone checks are explicitly unverified; passing isolated React tests does not replace them.
