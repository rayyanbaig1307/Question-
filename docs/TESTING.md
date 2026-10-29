# How to test each feature on your phone

Before anything: do the one-time setup in the [README](../README.md), then run `npx expo start`
and scan the QR code with your phone (iPhone: Camera app, Android: Expo Go).

**Tip:** to test things between two people (friends, chat…), create a second account.
You can log out and log in as the other person, or use a second phone.
If "Confirm email" is off in Supabase, made-up emails like `test1@example.com` work fine.

**Something looks stuck?** Shake your phone → tap **Reload**.

---

## Step 1 – Project setup

1. Open the app. You should **not** see the "Almost ready! 🔌" screen.
   - If you do, your `.env` file is missing or wrong. Fix it, then run `npx expo start --clear`.
2. In Supabase, open **Table Editor** – you should see tables like `profiles`, `posts`, `stories`, `messages`.

## Step 2 – Sign up / log in

1. You land on the **Welcome** screen with the bouncing eyes 👀.
2. Tap **Create account**.
   - Type a username with capitals or spaces – they're removed automatically.
   - After a second it says **"✅ @yourname is free!"**.
   - Tap **Let's go!** without ticking "I'm 13 or older" → you get a friendly error.
3. Fill everything in and tap **Let's go!** → the app opens straight to the **camera** 📸 (you're logged in).
   - If it says **"Check your email"** instead, "Confirm email" is still on in Supabase. Either tap the link in the
     email (the page it opens may look broken – that's OK, the account is confirmed) and log in, or turn the setting
     off (README step 3).
4. **Close the app completely and open it again** → you're still logged in.
5. Log out: tap your round picture (top-left) → ⚙️ gear (top-right) → **Log out** → back to Welcome.
6. Tap **I already have an account**:
   - Wrong password → "That email or password doesn't look right."
   - Right password → you're back in.
7. Try signing up again with the **same username** → it says it's taken.
8. In Supabase → **Table Editor → profiles**, you'll see a row for each account you made.

## Step 3 – Profiles

Open your profile by tapping **your round picture in the top-left corner of the camera**.

1. Open your profile. You see your picture (a colorful letter for now), name, @username, **0 Posts · 0 Friends**,
   and "No posts yet 📸".
2. Tap **Edit profile**:
   - Tap **Change photo** → pick a picture → crop it into a square → it shows up right away.
   - Change your name and write a bio (watch the counter go up to 160).
   - Change your username to one that's taken (e.g. another account you made) → **Save** → "Taken!".
   - Change it to something free → **Save** → "Profile saved ✨" and the profile shows the new info.
3. Close and reopen the app → your new picture, name and bio are still there.
4. Pull down on your profile to refresh.
5. Tap the ⚙️ **gear** (top right) → **Settings**:
   - Flip **Private account** on → "Your account is private 🔒". Your profile now shows a **🔒 Private** badge.
   - **Blocked accounts** → "Nobody blocked" (until you block someone in step 5).
   - **Log out** asks first, then logs you out.
6. In Supabase → **Storage → avatars**, you'll see your picture in a folder named after your user id.

The photo grid, full-screen photo viewer, and deleting a post are tested in step 4 (once you can post).
**Report** and **Block** live in the **•••** menu on other people's profiles – try those
in step 5 (friends search).

## Step 4 – Camera + posting

1. Open the app → it goes **straight to the camera**. The first time, tap **Allow camera**.
   - Said no by accident? Tap **Open Settings** and turn the camera on for Expo Go.
2. **Swipe right** (or tap **Chat** at the bottom-left) → the Chat page. **Swipe left** twice (or tap **Stories**)
   → the Stories page. The 📷 button on those pages brings you back to the camera.
3. On the camera: tap 🔄 to flip to the selfie camera, ⚡ to turn the flash on (it turns yellow).
4. Tap the **big white circle** → your photo opens in the editor.
   - **Aa / T button** → type something → pick a color → the **Aa** circle switches between plain text and a
     colored bubble → **Done**. Tap the text later to change it.
   - **😊 button** → pick an emoji or a word sticker (LOL, OMG…).
   - **Drag** things with one finger. **Pinch** with two fingers to make them bigger/smaller, and **twist** to turn them.
   - Drag something to the **red trash can** at the bottom to remove it. ↩️ removes the last thing you added.
   - **✕** (top-left) asks before throwing the photo away.
5. Tap **Send to** → choose:
   - **My Story** (on by default) – friends can see it for 24 hours.
   - **Post to my profile** – type a caption if you want.
   - Tap **Send** → "Added to your story! ✨" and you're back on the camera.
6. Swipe to **Stories** → **My Story** shows your photo in a colorful ring with "1 photo · 23h left".
7. Take another photo, this time pick only **Post to my profile** with a caption → open your profile (top-left
   picture) → the photo is in your grid and the **Posts** count went up.
8. Tap the photo in the grid → it opens **full screen** with your caption at the bottom. Tap **•••** →
   **Delete post** → it disappears from your grid.
9. Tap the **🖼️ gallery button** (left of the shutter) → pick a photo from your phone → decorate and send it.
10. Check Supabase: **Table Editor → stories** and **posts** have your rows; **Storage → media** has the photos
    (in folders named after your user id).

**Good to know:** stories are hidden after 24 hours automatically. Friends' stories and the feed are
tested in steps 7 and 8.

## Step 5 – Friends

You need **two accounts** for this. Easiest: two phones. Or on one phone: log out and log in as the other
person when the steps say so (Settings → Log out).

1. As **Person A**: on the camera, tap the **👤+ button** (next to your picture, top-left) → **Friends**.
   - It says "Find your friends".
2. Type part of Person B's username → they show up. Tap **Add** → "Friend request sent 💌".
   The button changes to **Requested**, and they appear under **Waiting for them**.
3. As **Person B**: the 👤+ button on the camera now has a **red 1**. (If B is already on the camera screen,
   it appears by itself within a second or two – no refresh needed.)
4. Tap it → **Friend requests (1)** → **Accept** → "You and @personA are friends! 🎉".
   Both of you now see each other under **My friends**, and the **Friends** count on your profiles went up.
5. Tap Person A's row → their profile. You see a **Friends** button and a **👯 Friends** badge.
6. **Private accounts:** make Person B private (Settings). Log in as someone who is **not** B's friend and open
   B's profile → "🔒 This account is private". Friends of B can still see B's photos.
7. **Unfriend:** on a friend's profile tap **Friends** → **Unfriend**. Tap **Add friend** again to re-send.
8. **Cancel a request:** tap **Requested** → **Cancel request**.
9. **Report & block** (from step 3): on someone's profile tap **•••** (top-right):
   - **Report** → pick a reason → "Thanks for telling us 💛" → choose **Not now**.
     In Supabase → **Table Editor → reports**, you'll see the report.
   - **Block** → confirm. You go back, and they're removed from your friends.
     Logged in as the blocked person: searching for you finds nothing, and your profile is gone for them.
   - Undo it in **Settings → Blocked accounts → Unblock**.

## Step 6 – Chat + peeks

You need **two accounts that are friends** (step 5). Two phones make this much more fun, because messages
pop up live.

**Chat list**
1. **Swipe right** from the camera (or tap **Chat**). Your friends are listed, newest chats first.
   - No friends yet? It says so and offers a **Find friends** button.

**Messages**
2. As **Person A**: tap Person B → type "hi 👋" → tap the blue **↑** button. Your message shows on the right in purple,
   with "now · Delivered".
3. As **Person B**: the **Chat** button on the camera has a **red 1**. In the chat list, Person A shows
   **New Chat** in blue. Open it → the message is there (on the left).
4. Back on Person A's phone, under your message it now says **Opened** – without refreshing.
5. Write back and forth – new messages appear on the other phone within a second or two.
6. **Unsend:** press and hold your own message → **Unsend**. It disappears for both of you.
7. **Report:** press and hold the other person's message → **Report message** → pick a reason.

**Peeks** (photos that disappear once opened)
8. As **Person A**, in the chat with B, tap the pink **📷** button → take a photo (add stickers if you like)
   → **Send to** → Person B is already ticked (My Story is off) → **Send** → "Peek sent to 1 friend! 💌" and you're
   back in the chat, which shows "You sent a peek".
9. You can also send from the main camera: take a photo → **Send to** → tick one or more friends under
   **💌 Send as a peek** (you can tick My Story too).
10. As **Person B**: the chat list shows **New Peek** in pink. Open the chat → tap the pink
    **"New peek · tap to view"**. It opens full screen with a bar that runs down for **10 seconds**, then closes.
    Tap anywhere to close it sooner.
11. Tap the same peek again → it now says **Peek opened** and can't be opened again. 💨
    Person A sees **Opened** under it.
12. **No signal?** If the peek can't load, it says "Couldn't load the peek" and does **not** count as opened –
    try again later.

**Safety checks**
13. Unfriend Person B (their profile → **Friends** → **Unfriend**). The chat screen now says
    "You need to be friends to chat." and the message box is gone.
14. In Supabase → **Storage → media**, opened peeks get deleted the next time the sender opens that chat.

## Step 7 – Stories

You need **two accounts that are friends** (step 5).

1. As **Person A**: take 2–3 photos and send each to **My Story**.
2. Swipe to **Stories** (left from the camera). **My Story** shows "3 photos · 23h left" with your latest photo.
   The small **＋** adds another photo.
3. Tap **My Story** → your story plays full screen:
   - Bars at the top fill up, one per photo, **5 seconds** each.
   - **Tap the right side** → next photo. **Tap the left side** → previous photo.
   - **Press and hold** → pauses. Let go → carries on.
   - At the bottom it says **"0 seen"**.
4. As **Person B**: on the Stories page, Person A appears under **Friends** with a **colorful ring**. Tap it → watch.
   When it ends, it closes (or moves on to the next friend with new stories).
5. Back on the Stories page, Person A's ring is now **grey** (seen).
6. As **Person A**: open **My Story** → it now says **"1 seen"**. Tap it → Person B is in the list.
7. **Delete a photo:** in your own story tap **•••** → **Delete this photo**.
8. **Report:** in a friend's story tap **•••** → **Report story**.
9. **Privacy check:** someone who is **not** your friend never sees your story ring.
10. Stories disappear by themselves **24 hours** after posting.

## Step 8 – Feed (likes + comments)

1. Post a couple of photos to your profile (camera → **Send to** → **Post to my profile**). Ask a friend to do the same.
2. Swipe to the **Stories** page and scroll down past the stories → the **Feed** shows posts from you and your
   friends, newest first. Pull down to refresh; keep scrolling to load older posts.
3. **Double-tap a photo** → a big pink ❤️ pops up and the post is liked. Tap the ❤️ under it to unlike/like.
4. Tap the 💬 → **Comments**. Write one and tap the pink **↑**. Go back – the comment count went up.
5. Press and hold a comment:
   - your own comment → **Delete comment**
   - someone else's → **Report comment** (and if it's on *your* post you can delete it too)
6. Tap **•••** on a post → **Open full screen** (likes and comments work there too). On your own post you can
   **Delete post**; on a friend's you can **Report post**.
7. **Privacy check:** someone who isn't your friend never sees your posts in their feed. (They *can* see them on your
   profile if your account is public – make it private in Settings to stop that.)

## Step 9 – Friend map + hide me

You need **two accounts that are friends**, ideally on two phones.

1. On the camera, tap the **🗺️ map button** (top-right). The Friend Map opens.
   - At the bottom it says **"🙈 You're hidden – Nobody can see where you are."** That's the default.
2. Tap **Show me to my friends** → your phone asks for location permission → allow it.
   - You appear on the map as your picture with a **pink** ring, labelled **"You"**.
   - The card now says **"👀 Friends can see you"**.
3. On your **friend's phone**, open the map → you show up with a **purple** ring, your name and "now".
   Tap your picture → it opens your profile.
4. Your spot updates whenever you open the app (and every few minutes while it's open).
5. Tap **Hide me** → "🙈 You're hidden on the map". On your friend's phone you disappear from the
   map **within a second or two**.
6. You can also flip **Hide me on the map** in **Settings** (profile → ⚙️).
7. **Privacy checks:**
   - Someone who is **not** your friend never sees you, even with sharing on.
   - If you unfriend or block someone, you vanish from their map.
   - In Supabase → **Table Editor → locations**, your row is deleted the moment you hide.

## Step 10 – Polish (fixes + feeling alive)

1. **Settings gear:** it no longer floats over every screen. Open your profile (your picture, top-left on the
   camera) → the pink/purple **⚙️** is at the top right. It only shows on *your* profile; on a friend's profile
   you see **•••** instead.
2. **Back buttons:** Edit profile, Friends, Settings, Chat, Comments and Send to all have a round **‹** button at
   the top left. Nothing is cut off.
3. **Square grid:** on your profile every photo is a perfect square, 3 per row, no black bars.
   Pick a wide photo from your camera roll on the camera screen → instead of black bars you'll see a blurry copy of
   the photo filling the gaps.
4. **Change photo:** profile → **Edit profile** → tap your picture. Choose **📸 Take a photo** or
   **🖼️ Choose from camera roll** (or **Remove photo**). Crop it, tap **Save**. The new picture shows straight away
   on your profile, the camera screen (top-left) and the top of the Chat page.
5. **Fun empty screens:** a new account with no friends sees "It's quiet in here… too quiet 👀" on Chat,
   "Crickets…" on the feed, and a lonely-grid message on the profile – each with big buttons. The emoji bobs.
6. **Invite friends:** tap **Invite friends** (Friends screen, Settings, the dashed **＋ Invite** circle in the
   stories row, or an empty screen). Your phone's share sheet opens with a message – send it by text, WhatsApp, etc.
   It includes the **Android download link** (installs Peekaboo directly). iPhone friends see "coming to the App
   Store soon" – when Peekaboo is on TestFlight / the App Store, put that link in `src/lib/invite.ts`.
7. **Animations:** buttons squish and bounce when tapped; the shutter squishes, the screen flashes white and the
   phone buzzes when you take a photo; swiping between Chat, Camera and Stories gently shrinks and dims the page
   you're leaving.
8. **Vibrations:** taking a photo (strong tap), sending (happy double-buzz), liking a post (tap + the heart pops).
9. **Double-tap to flip:** on the camera, double-tap anywhere on the picture → it switches between the front
   (selfie) and back camera, with a little tap you can feel. Double-tap again to switch back.

## Step 11 – Daily Dare 🎯

1. Open the app on the camera: today's dare **pops down** in a pink banner (only if you haven't done it yet).
   It slides away by itself after about 6 seconds, or swipe it **up** to hide it. It won't pop up again that day.
   Tap it (or the round **🎯** button next to the add-friend button – it has a pink dot until you've done the dare).
2. The **Daily Dare** screen shows the dare, a live **"New dare in …"** countdown, and everyone's dare photos.
   (A new dare starts every day at 10:00 UTC = 6am New York.)
3. Tap **Do the dare 📸** → take a photo → decorate it → **Send to**. **🎯 Today's dare** is already ticked
   (add a caption if you like) → **Send**. You see "Dare done! 🎯🔥" and land back on the Dare screen with your photo
   in the grid.
4. The banner no longer pops up, and the **🎯** button on the camera shows a ✅.
5. Your dare photo also shows on your profile grid with a little 🎯, and in the feed with a pink
   **"🎯 Dare …"** tag. Tap the tag → the Dare screen.
6. You can also tick **🎯 Today's dare** on the Send screen after taking a normal photo.
7. **Privacy check:** dare photos from private accounts only show for their friends.

## Step 12 – Discover 🔥 (the endless scroll)

1. At the bottom of the home screen there's now a **tab bar**: 💬 Chat · 📷 Camera · ✨ Stories · 🔥 Discover.
   Tap a tab to jump there, or keep swiping left/right like before. Unread chats show a red number on 💬.
2. Tap **🔥 Discover**. You see one photo filling the whole screen. **Swipe up** for the next one, and the next…
3. Each photo shows who posted it (tap their name → their profile, where you can add them), the caption and any
   🎯 dare. On the right: **❤️ like**, **💬 comments**, **✈️ share**, **••• more** (report or block).
4. **Double-tap** a photo → big pink heart + buzz = liked.
5. Pull down on the first photo to refresh. At the very end: "You've seen it all! 🌱".
6. **Who shows up:** your own posts (marked **· You**, with **Delete post** in •••), posts from **public** accounts
   and from **your friends** – never private accounts you aren't friends with, never anyone you blocked (or who
   blocked you).
7. **Privacy check:** turn on **Private account** (Settings) → your posts disappear from strangers' Discover.
8. Block someone from **•••** → their posts vanish from your Discover straight away.

## Step 13 – Replay, save and "typing…" in chat

You need **two accounts that are friends** (two phones is easiest).

1. **Replay:** send a peek. Your friend opens it (10 seconds). In their chat it now says **🔁 Tap to replay** –
   they tap it and see it once more. After that it says **Peek opened** for good. On your side the status under
   your latest message says **Replayed 🔁**. (The replay is available for 24 hours after opening.)
2. **Save in chat:** press and hold a peek in the chat → **Save in chat 📌** (the phone buzzes). It turns purple with
   a 📌 and says **Saved peek · tap to view** – for **both** of you – and can be opened any time, with no timer.
   You can also tap **Save** at the top right while watching a peek.
3. **Unsave:** press and hold the saved peek → **Unsave**. It goes back to disappearing.
4. **Typing:** start typing a message. On your friend's phone, three bouncing dots appear at the bottom of the chat
   and **typing…** shows under your name at the top. They disappear when you stop typing for a few seconds, clear the
   box, or send the message.
5. **Privacy checks:** only the two people in a chat can save its peeks or see each other typing – never anyone else.

## Step 14 – Screenshot alerts 📸

Two friends, two phones.

1. In a chat, take a screenshot (iPhone: side button + volume up). Your friend's chat shows
   **"📸 Ayaan took a screenshot of the chat!"**, and on the Chat page their row says **Took a screenshot! 📸**.
2. Open a peek and screenshot it → they see **"📸 … took a screenshot of your peek!"**, and you get a little
   reminder that they'll see it.
3. Screenshot notices can't be unsent (press and hold does nothing on them).
4. Android: works on Android 14 and newer.

## Step 15 – Round of fixes

1. **Settings:** your profile → pink/purple ⚙️ (top right). It has Edit profile, Private account, Hide me on the map,
   Blocked accounts, Invite friends, Log out and **Delete account** (two warnings first – it really deletes everything).
2. **Discover** (🔥 tab) is now the photo feed: your friends' posts and yours first, then
   **"✨ More from everyone on Peekaboo"**. It refreshes every time you open it; pull down to refresh too.
3. **Stories** (✨ tab) is only stories: a row of circles at the top (**My Story** first – tap the pink ＋ to add one),
   then big cards for friends' stories. No stories → a friendly message instead of an empty heading.
4. **Full photos:** in Discover, each photo shows whole (nothing cut off) with rounded corners, then ❤️ and 💬,
   the number of likes, and the caption.
5. **Dare pill:** on the camera, under your picture: **"🎯 Today's dare · …"**. Tap it → Dare screen. Pink dot = not done
   yet, ✅ = done.

## Step 16 – Peekaboo Drop 👀

1. The first time you open this version, allow **notifications**.
2. Once a day, at a surprise time between 10am and 10pm (the same time for everyone), you get
   **"Peekaboo! 👀 You have 2 minutes to show what you're doing."**
3. Tap it → the camera opens with a big **⏱ 2:00** countdown and today's dare under it (do the dare, or just show
   what you're doing).
4. Take the photo → **Send to**: **👀 Today's Peekaboo drop** is ticked (tick 🎯 Today's dare too if you did the
   dare) → **Send**. You land on Discover and see **"Drop posted · On time! 👀🔥"**.
5. Your drop shows a green **👀 On time** badge (or **⏰ Late by 3h** if you posted later) in Discover, on the photo
   and with a 👀 on your profile grid.
6. Missed the notification? After the drop time, the camera shows a **"👀 Peekaboo! 1:42 left"** pill (or
   **"Post today's drop · you're late"**) until you've posted.
7. Only one drop a day. Trying to post a drop before today's drop time says it hasn't happened yet.

## Step 17 – Peek to see 🙈

Two friends, two phones. Your friend posts today's drop first.

1. Open **Discover**: their drop shows as a **blurry picture** with **"Give a peek to get a peek 👀"** and an
   **Open camera** button. Same on their profile grid (🙈) and when you open it full screen.
2. Tap **Open camera** → take your drop → Send. You land back on Discover: **"🔓 Today's drops unlocked!"**, a happy
   buzz, and their photo pops into view.
3. This only applies to drop posts – normal posts, stories and chat are never blurred.
4. Not friends with someone (public account)? You still only see the blurry preview of their drop until you post yours.

## Step 18 – Hold to reveal (scratch) 👆

1. After you've posted your drop, friends' drops in **Discover** still start **blurred**, with
   **"👆 Hold & scratch to reveal"**.
2. Hold your finger on the photo for a moment, then move it around: the blur wipes away under your finger, with tiny
   buzzes. (A quick swipe still scrolls the feed.)
3. Once most of it is clear, the rest disappears with a little **pop** and a happy buzz. It stays clear.
4. Don't like it? **Settings → Peekaboo drops → Scratch to reveal drops** → off. Drop photos then show normally.

## Step 19 – Push notifications 🔔

You need two accounts that are friends, on two phones. On **iPhone**, push notifications work inside Expo Go.

1. Open Peekaboo and allow notifications if asked.
2. Close Peekaboo (or lock the phone). From the other phone:
   - send a chat or a peek → **"Ayaan – hey!"** / **"Sent you a peek 👀"**
   - send a friend request → **"New friend request 👋"**; accepting it → **"You have a new friend 🎉"**
   - like your post → **"Liked your post ❤️"**; comment → **"Commented: …"**
3. Tap a notification → Peekaboo opens on the right chat / friends screen / post / comments.
4. **Settings → Notifications**: switch any type off (Messages & peeks, Friend requests, Likes, Comments, Daily
   Peekaboo drop) → those stop. Switch back on → they come back.
5. Log out → that phone stops getting that account's notifications.

Where it works:
- **iPhone in Expo Go:** ✅ everything.
- **Android in Expo Go:** ❌ push (Expo Go on Android doesn't allow it) – the daily drop alert still works.
- **Android download (APK):** ❌ push until a free Firebase project is connected; ✅ daily drop alert.
- **iPhone from TestFlight / App Store:** ✅ everything (needs the Apple Developer account).

## Step 20 – Videos 🎥

1. On the camera, **hold** the shutter: it turns red and a red bar fills up – you're recording (up to 10 seconds).
   Let go to stop. (The first time, allow the microphone – then hold again.) A quick tap still takes a photo.
2. The video plays in the editor. Add text/stickers if you like → **Send to** → pick My Story, a post, friends
   (as a peek), today's dare or your drop.
3. **Discover:** videos play by themselves when they scroll into view, with no sound – tap 🔈 for sound.
   Tap and hold → full screen with sound.
4. **Stories:** a video story plays for its full length, then moves on.
5. **Peeks:** a video peek plays once (and can be replayed once / saved, like photo peeks).
6. **Profile grid:** videos show a ▶ in the corner.
7. You can also pick a video (10 seconds or less) from your camera roll with the 🖼️ button.

## Step 21 – Comments, replies and comment likes 💬

1. Open a post → tap 💬 → write a comment → send. It shows at the bottom of the list.
2. Tap **Reply** under someone's comment → a pink "Replying to …" bar shows above the box → send.
   Your reply sits tucked in under that comment. (Replying to a reply puts it under the same comment.)
   Tap ✕ on the bar to go back to a normal comment.
3. Tap the 🤍 next to a comment → it turns pink ❤️ and shows "1 like". Tap again to unlike.
4. Hold down on **your own** comment → **Delete comment** (its replies go too).
5. On **your own post**, hold down on anyone's comment → you can delete it.
6. Hold down on someone else's comment (not your post) → **Report comment**.
7. With push on: the post owner gets **"Commented: …"**, the person you replied to gets **"Replied: …"**,
   and liking a comment sends **"Liked your comment ❤️"**.

## Step 22 – Report and Delete account 🚩

1. **Report a post:** on Discover tap ••• on someone else's post → **Report post** → pick
   **Spam / Bullying / Nudity / Something else** → "Thanks for telling us 💛" (you can also block them).
2. **Report a story:** open a friend's story → ••• → **Report story** → pick a reason.
3. **Report a comment:** hold down on someone else's comment → **Report comment** → pick a reason.
4. Reports are saved privately (the person never finds out). They show up in Supabase → Table editor →
   **reports** (reason = spam / bullying / nudity / other).
5. **Delete account** (try with a test account!): Settings → **Delete account** → confirm twice. You're logged
   out, and the account, its photos, videos, posts, stories, chats, comments and likes are gone for good.
   Logging in with it again says the login is wrong.

## Step 23 – Group Peek 👯

You need 2 friends on Peekaboo (or 2 test accounts) for this.
1. **Make a group:** Discover → tap **👯 Make a Group Peek** at the top (or Settings → Group Peek → ＋).
   Type a name, tick your friends, tap **Make group**. Your friends get "… added you to a group 👯".
2. The group page shows **"Waiting on …" 👀**, a progress bar, and everyone's status (✅ Posted / ⏳ Not yet).
3. After the daily drop alert, post your drop. Back in the group: you're ✅, the others are still ⏳.
4. Your friends' drops stay blurred with 🙈 – in the group **and** in Discover ("Waiting on your group 👀") –
   even though you posted yours.
5. Tap **Nudge** next to someone who hasn't posted → they get "… nudged you 👀". Tapping Nudge again
   within 15 minutes says to give them a minute.
6. When the last person posts → open the group: "Everyone posted! 🎉", a happy buzz, and all the drops pop
   in one by one. They're now clear in Discover too. Tap one to open it full screen.
7. ••• on the group page: **Edit group** (rename, add friends), **Leave group**, and – if you made it –
   **Delete group**. If you made it, hold down on a person to remove them.
8. The Discover row shows each group as "2/3 posted 👀" or "Everyone posted 🎉".

## Step 24 – Guess Who 🕵️

You need at least 2 friends on Peekaboo (with 4+ friends the guessing is harder).
1. **Post one:** Discover → tap **🕵️ Guess Who** at the top → ＋ (or take a photo/video and, on **Send to…**,
   pick **🕵️ Guess Who**). Picking Guess Who un-ticks everything else, so the photo can't give you away.
   Add a hint if you like → **Send**. It lasts 24 hours.
2. On your own card: "Your Guess Who 🤫" and, later, "3 guessed · 1 got it · 2 fooled 😈".
3. **On a friend's phone:** Discover → **🕵️ Guess Who · 1 to guess** → the card says "Who posted this?" with
   up to 4 names. Tap one → the real poster's picture pops in with flying emojis:
   "You got it! 🎉" or "Nope! It was … 😜". Only the first guess counts.
4. **Report:** ••• on a friend's card → **Report** → pick a reason. It's saved in Supabase → **reports**
   against the real poster (details say "Guess Who (anonymous) post") – the reporter isn't told who it was.
5. **Block:** ••• → **Block whoever posted this** → the card disappears and that person is blocked.
6. **Delete:** ••• on your own card → **Delete**.
7. The real poster is always saved in Supabase → **mystery_posts** (user_id).

## Step 25 – Who Peeked 👀

You need a friend's phone (or a test account) for this.
1. Post your Peekaboo drop.
2. **On your friend's phone:** they open Discover and scroll past your drop without revealing it
   (or before posting their own drop, so it's still locked).
3. **On your phone:** your drop in Discover now has a purple **"👀 0 peeked · 1 scrolled past"** pill. Tap it →
   **Who peeked**: your friend is under **💨 Scrolled past**.
4. **Friend:** posts their own drop, then holds and scratches yours clear (or opens it full screen).
5. **You:** pull down to refresh → **"👀 1 peeked · 0 scrolled past"**, and they move to **👀 Peeked**.
6. The pill also shows on your drop when you open it full screen. Only **you** see it – friends never see
   who peeked at your drop, and you never see this on anyone else's.

## Step 26 – Filters and stickers 🎨

1. Take a photo (or pick one from your camera roll). In the editor, **swipe left or right** on the photo:
   the colors change and the filter's name flashes up – No filter, Bubblegum 🍬, Grape 🍇, Sunny ☀️,
   Ocean 🌊, Noir 🖤, Vintage 📼. The little dots at the bottom show which one you're on.
2. Tap the 🙂 sticker button. At the top: **Peekaboo originals 👀** – googly eyes, one big googly eye,
   PEEKABOO 👀, a PEEK! speech bubble, an "I SEE YOU 👁️" sticky note and a CAUGHT 📸 stamp. Below: word
   stickers and emojis (👀 🔥 and more).
3. Stickers: **drag** with one finger, **pinch** to resize, **twist** two fingers to turn. Drag one onto the
   🗑️ to remove it.
4. Tap **Send to** and post it – the filter and stickers are part of the photo your friends see.
5. Videos get stickers and text, but no filters (the swipe and dots only show for photos).

## Step 27 – Voice notes 🎤

Works in Expo Go now. The Android download needs the next new version (voice notes add a new phone part).
1. Open a chat with a friend. With nothing typed, the right-hand button is a pink **🎤 mic**.
   (Start typing and it turns back into the send arrow.)
2. **Hold** the mic: the first time, allow the microphone, then hold again. While recording, a bar shows a red
   dot, the time and a moving waveform. **Let go to send.**
3. **Slide left** while holding ("‹ Slide to cancel") → the mic turns into a 🗑️ → let go to cancel.
4. A quick tap just reminds you to hold. Recordings under a second aren't sent; they stop at 1 minute.
5. The voice note shows in the chat as a bubble with ▶ play, its waveform and length. Tap ▶: it plays,
   the waveform fills in and the time counts down. Tap again to pause. Only one plays at a time.
6. Your friend gets "Sent you a voice note 🎤" (with push on), and the chat list shows "Voice note 🎤".
7. Hold down on a voice note → Unsend (yours) or Report (theirs).

## Step 28 – Reactions on stories 😂🔥😍😮👀

1. Open a friend's story. At the bottom there's a row: 😂 🔥 😍 😮 👀.
2. Tap one → a little buzz, a bunch of that emoji floats up the screen, and "Sent 🔥 to Sam" pops up.
   You can send more than one.
3. **Your friend's chat with you** now shows a bubble with a tiny picture of the story, the big emoji and
   "Reacted to your story" (you see "You reacted to Sam's story").
4. Their chat list says "Reacted 🔥 to your story", and with push on they get the same notification.
5. On **your own** story you still see "👁 N seen" instead of the emoji row.
6. Once the story is gone (after 24 hours or deleted), the reaction stays in the chat without the picture.

## Peek Match (dating, 18+) – Part 1: the safety gate 💘

**Use test accounts.** Your birthday can only be entered once per account.

Setting up the age check (once, by the app owner):
1. Make a free Stripe account at stripe.com. Stay in **Test mode** (the switch at the top) while testing.
2. In Stripe: Developers → API keys → **Create restricted key**. Give it **Write** access to
   "Identity verification sessions and reports" and **Read** access to sensitive verification results
   (the date of birth). Copy the key.
3. In Supabase: Edge Functions → **Secrets** → add `STRIPE_SECRET_KEY` = that key. (Never paste it in chat.)
4. For real checks later: switch Stripe to Live mode, get Identity approved, and replace the secret with a
   live key. Each real check costs about $1.50.

Testing:
1. Settings → **Dating** → **Peek Match (18+)** → you see what Peek Match is and how it keeps you safe.
2. **Under 18:** with a test account, enter a birthday less than 18 years ago → "Peek Match is for adults only".
   Go back to Settings: the Peek Match row is **gone for good** on that account.
3. **18+:** with another account, enter an adult birthday → Step 2 "Check my age".
   - Before the Stripe key is added: it says age checks aren't switched on yet.
   - After: tap **Check my age** → the Stripe page opens. In test mode you can pick a test result instead of
     using a real ID. Finish, come back to Peekaboo → it checks by itself (or tap "I'm done – check now").
   - Passed → "You're verified ✅" → flip the **Peek Match** switch on → "Peek Match is on 💘".
   - Failed → it says why, with **Try again**.
4. **Hide my dating profile** switch, and **Leave Peek Match** (deletes all dating stuff; your age check is kept,
   so you don't pay for it twice).

## Peek Match – Part 2: the dating profile 💘

(You need to be through Part 1: verified and Peek Match switched on.)
1. Settings → Peek Match → **Make my dating profile**.
2. **Photos:** tap ＋ to add from your camera roll (3 to 6). Tap a photo → **Make this my main photo** or
   **Remove photo**. A 7th photo isn't allowed.
3. **The basics:** first name, age (taken from your ID check – can't be changed), I am a Woman / Man /
   Nonbinary, and your **rough area**: tap **Use my location 📍** (allow location) – it fills in an area like
   "East London" you can edit. Your exact spot is never saved: it's rounded to about 1 km on the phone first.
4. **Prompts:** 3 prompts like "A dare I'd actually do…" – tap the prompt to swap it, type an answer.
5. **Who I'd like to see:** Women / Men / Nonbinary people, an age range (18+), and a distance (5–250 km).
6. **Save** → back on the Peek Match screen: "✅ Ann · 4 photos · 3 prompts · ready to be seen" (or what's
   still missing). Turn on **Hide my dating profile** → it says "hidden right now".
7. **Leave Peek Match** deletes the profile and all its photos.

## Peek Match – Part 3: finding people 👀

You need 2 verified test accounts in Peek Match, with finished profiles that fit each other (e.g. a woman
looking for men and a man looking for women, ages in each other's range, within each other's distance).
1. Peek Match screen → **Start peeking 💘** (shows once your profile is finished and not hidden).
2. One person at a time: name, age, area and a **rough** distance ("Less than 2 km away", "5 km away"…),
   then photos and prompts one after another.
3. Tap the **♥ on a photo or a prompt** → a sheet shows what you're liking → add a comment if you like →
   **Send like**. The other person gets "Someone liked your dating profile" (with push on) – it doesn't say who.
4. Tap **✕** (bottom left) to skip. People you liked or skipped don't come round again.
5. On the other account, the person who liked them shows up **first**.
6. **••• → Report** (Spam / Bullying / Nudity / Something else) → saved in Supabase **reports** against their real
   account, details "Peek Match profile". **Block** → you never see each other in Peek Match again (blocking
   someone in the normal app does the same).
7. People who don't fit what *both* of you are looking for never show up. Nobody can see your friends, posts,
   stories or exact location.

## Peek Match – Part 4: matches and the match chat 💬

Use the same 2 test accounts as Part 3 (they fit each other).
1. Account A likes B (♥ on a photo or prompt, maybe with a comment).
2. Account B: Peek Match screen → **Matches & likes 💬** → **Likes you** shows A's photo, name and comment.
   Tap it → "💘 A liked your answer: …" + their comment + their profile → **💘 Match** (or ✕ to skip).
   (Or B finds A first in **Start peeking** and likes back – then B sees "It's a match! 💘" → **Say hi 👋**.)
3. Both get "It's a match! 💘" (with push on) and the chat opens.
4. In the chat, their picture at the top is **blurred** 🙈, with a bar: "Photos unblur when you've both sent
   5 messages · You 2/5 · Ben 3/5". Tap their name to see their profile – photos blurred too.
5. Send 5 messages each → a buzz, "📸 Photos unblurred! Peekaboo 👀", and everything is clear.
6. New messages pop in live; the Matches list shows the last message and a pink dot for unread.
7. **•••** in the chat: **Unmatch** (the chat disappears for both), **Report** (saved in **reports** as
   "Peek Match chat"), **Block** (you never see each other in Peek Match again; the chat ends).

## Peek Match – Part 5: Add as friend 🤝

Use 2 test accounts that have matched (Part 4).
1. Account A, in the match chat: **••• → Add as a Peekaboo friend 🤝** → it explains that this shares your
   normal Peekaboo profile once they say yes → **Send request**. The chat shows
   "💌 You asked Ben to be Peekaboo friends". (Asking again doesn't send another.)
2. Account B: the match chat shows a pink card **"💌 Ann wants to be Peekaboo friends · Say yes"** (and B also
   gets a normal friend request in Friends, with push on).
3. B taps **Say yes** → "🎉 You're now Peekaboo friends!" appears in the chat for both. They're now in each
   other's normal **Friends** list, and can chat, send peeks and see stories like any friend.
4. ••• now shows **See Ben's Peekaboo profile** → opens their normal profile.
5. Before B says yes, neither of you can see the other's normal account. The 💌/🎉 notices don't count toward
   the 5 messages for unblurring photos.

## Step 29 – Profile song 🎵

1. Your profile → **Add a profile song 🎵**.
2. Type a song or artist (e.g. "Espresso") → results appear with cover art.
3. Tap **▶** on any song → its free 30-second preview plays (the time left counts down). Tap again to pause.
   Only one preview plays at a time.
4. Tap **Pick** → back on your profile the song shows under your bio: cover art, name, artist, ▶ preview and
   **Full song on Apple Music ↗** (opens Apple Music).
5. **Change** → pick another, or **Remove song**.
6. Friends see your song on your profile and can play the preview too.
   (Peekaboo only saves the song's name and Apple links – never any music.)

## Step 30 – Close friends ⭐

1. Settings → **Close friends** → tap the ⭐ next to friends to add them (tap again to remove). Only you see
   this list.
2. Take a photo → **Send to…** → tick My Story and/or Post to my profile → **Who can see your story?**
   **🌍 Everyone** or **⭐ Close friends**.
3. Post to **Close friends**. On a close friend's phone: Stories shows your circle with a **green ring** and a
   "⭐ Close friends" tag on your card; the story shows "⭐ Close friends" at the top. Posts show the same tag.
4. On a friend who is **not** on your list: that story and post don't show up at all (and can't be opened).

## Step 31 – Dark, Light or Match phone 🌙☀️📱

1. Settings → **Appearance** → tap **☀️ Light**. Peekaboo restarts for a second and comes back in light colors
   (soft white background, same pink/purple style).
2. Check the main screens: Chat, Stories, Discover, profile, Settings, chats, comments, Peek Match. Text should
   be dark on light backgrounds; the camera, full-screen photos, peeks and stories stay dark (they're photos).
3. **📱 Match phone** → follows your phone's own light/dark setting. Switch your phone's appearance in its
   settings and come back – Peekaboo switches too.
4. **🌙 Dark** → back to the dark look.
(The Android download needs the next new version for "Match phone" to follow the phone; Light and Dark work.)
