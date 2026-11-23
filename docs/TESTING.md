# How to test each feature on your phone

The automated local-only suite and commands are in [tests/README.md](../tests/README.md).
Use a dedicated test project for this manual checklist. The automated suite never
needs a real Supabase URL, account or key. Its results do not replace phone checks:
camera, microphone, gestures, native playback, push and real Apple/Google login
still need a test build on a device. Use the new social sign-in/setup flow where
available; the legacy signup steps below apply to fallback builds.

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
2. Type part of Person B's username → they show up. Tap **Add**. What happens depends on B's account and on B's
   age (from the birthday B saved in Settings → **Birthday**). A saved birthday can't be changed, so use one test
   account for each case below (made-up birthdays are fine):
   - B's account is **public** (the normal setting) **and B is 18 or over** → "You and @personB are friends! 🎉"
     straight away. No request. B gets a notification "You have a new friend 🎉 · personA added you as a friend".
   - B is **under 18**, or **hasn't saved a birthday** → "Friend request sent 💌", even if B's account is public.
     The button changes to **Requested**, B appears under **Waiting for them**, and nothing changes until B
     accepts. (This keeps strangers from becoming friends with a 13-year-old in one tap.)
   - B's account is **private** (Settings → Private account) → a friend request too, whatever B's age.
3. (Only if it was a request) As **Person B**: the **Chat** tab has a red number, and a **Friend requests 💌** box sits at
   the top of Chat with A's row and **Accept** / **✕**. (The 👤+ button on the camera shows a red 1 too.)
4. (Only if it was a request) Tap **Accept** → "You and @personA are friends! 🎉". Both of you now see each other under
   **My friends**, and the **Friends** count on your profiles went up.
   **Someone's friends:** on a **friend's** profile, tap the **Friends** number → their friends list, each with an
   **Add** button. On anyone you're not friends with, the number can't be tapped – add them first.
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
13. **Report a peek:** Person A sends B a new peek. B opens it and taps **⋯** (top right, next to **Save**):
    - While the menu is open, the peek is covered ("Peek hidden while the menu is open 🙈") and the timer bar
      stops. A video peek pauses under the cover.
    - **Cancel** → the peek is back and the bar carries on from where it stopped (a video plays on from the same
      spot, not from the start). Opened the menu right at the end? You get 1 extra second, but only once per
      peek: opening the menu again near the end gives no more time, so it can't be kept on screen this way.
    - **Report peek** → the peek is covered ("Peek hidden while you report it 🚩") and the timer stops → pick a
      reason → "Thanks for telling us 💛" → **Not now** or **Block**. Tap anywhere to close the peek.
    - Your own peek (open one you saved in the chat) has no ⋯ button.

**Safety checks**
14. Unfriend Person B (their profile → **Friends** → **Unfriend**). The chat screen now says
    "You need to be friends to chat." and the message box is gone.
15. In Supabase → **Storage → media**, opened peeks get deleted the next time the sender opens that chat.

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
   It's your username and the App Store link (since 22 Nov – see Step 66).
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
2. Tap **Open camera** → take your drop → Send. You land back on Discover: **"🔓 All drops unlocked!"**, a happy
   buzz, and their photo pops into view.
3. **Every** drop opens, not just today's: scroll down to your friends' **older** drops (from days you skipped)
   and open their profiles – no 🙈 left anywhere. Public accounts' drops further down Home open too.
4. They stay open until the **next day's drop goes off**. Then the new day's drops show the 🙈 straight away
   until you post the new drop (late is fine). Older drops follow **an hour later** (so the clocks changing can't
   lock them before you can post). Drops from days you posted stay open for good.
5. This only applies to drop posts – normal posts, stories and chat are never blurred.
6. Never posted a drop at all? You only see the blurry previews.

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

1. On the camera, **hold** the shutter: it turns red and a red bar fills up – you're recording (up to 30 seconds, or 60 with Peekaboo+). With ⚡ on, the back light stays on the whole video; with the selfie camera a bright ring lights up the screen edges. Works with the googly lens too (the eyes follow your face in the video – see Step 42).
   Let go to stop. (The first time, allow the microphone – then hold again.) A quick tap still takes a photo.
2. The video plays in the editor. Add text/stickers if you like → **Send to** → pick My Story, a post, friends
   (as a peek), today's dare or your drop.
3. **Discover:** videos play by themselves when they scroll into view, with no sound – tap 🔈 for sound.
   Tap and hold → full screen with sound.
4. **Stories:** a video story plays for its full length, then moves on.
5. **Peeks:** a video peek plays once (and can be replayed once / saved, like photo peeks).
6. **Profile grid:** videos show a ▶ in the corner.
7. You can also pick a video (30 seconds or less, or 60 with Peekaboo+) from your camera roll with the 🖼️ button. Without Peekaboo+, a 30–60 second video says "Videos up to 60 s come with Peekaboo+ ⭐" and offers the Peekaboo+ page.

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
1. **Make a group:** Chat → 👯 Groups → **＋ New** (or Settings → Group Peek → ＋).
   Type a name, tick your friends, tap **Make group**. Your friends get "… added you to a group 👯".
   The new **group chat** opens straight away ("Say hi to the group!"). **Back** goes to where you started (the
   Chat list, or the Group Peek list) – never back to the form.
2. Tap the group's name at the top of the chat (or ••• → **👯 Group info & drops**): the group page shows
   **"Waiting on …" 👀**, a progress bar, and everyone's status (✅ Posted / ⏳ Not yet).
3. After the daily drop alert, post your drop. Back in the group: you're ✅, the others are still ⏳.
4. Your friends' drops stay blurred with 🙈 – in the group **and** in Discover ("Waiting on your group 👀") –
   even though you posted yours.
5. Tap **Nudge** next to someone who hasn't posted → they get "… nudged you 👀". Tapping Nudge again
   within 15 minutes says to give them a minute.
6. When the last person posts → open the group: "Everyone posted! 🎉", a happy buzz, and all the drops pop
   in one by one. They're now clear in Discover too. Tap one to open it full screen.
   If someone never posts that day's drop, the group's drops from that day open during the next day (once nobody
   can post that day's drop any more) instead of staying hidden for good.
7. ••• on the group page: **Edit group** (rename, add friends), **Leave group**, and – if you made it –
   **Delete group**. If you made it, hold down on a person to remove them.
8. The Discover row shows each group as "2/3 posted 👀" or "Everyone posted 🎉".

## Step 24 – Guess Who 🕵️

You need at least 2 friends on Peekaboo (with 4+ friends the guessing is harder).
1. **Post one:** Home → tap the **🕵️ Guess Who** circle → ＋ (or pick the 🕵️ mode on the camera). Take a
   photo/video, add text or stickers if you like → **Post Guess Who**. There's no "Send to…" step: it only
   ever goes to Guess Who, never to your story or your profile grid. It lasts 24 hours.
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
2. Check the main screens: Chat, Stories, Discover, profile, Settings, chats, comments. Text should
   be dark on light backgrounds; the camera, full-screen photos, peeks and stories stay dark (they're photos).
3. **📱 Match phone** → follows your phone's own light/dark setting. Switch your phone's appearance in its
   settings and come back – Peekaboo switches too.
4. **🌙 Dark** → back to the dark look.
(The Android download needs the next new version for "Match phone" to follow the phone; Light and Dark work.)

## Step 32 – (Peek Match was here – it's been removed and replaced by Hit ups, see Step 43)

## Step 33 – 3 tabs: Chat · Camera · Home 🏠

1. The bottom bar now has **3 tabs**: 💬 **Chat** · 📷 **Camera** · 🏠 **Home**. Peekaboo still opens on the **Camera**. Swipe left/right between them like Snapchat, or
   tap a tab.
2. **Home** is Stories + Discover in one, like Instagram's home page:
   - **Top row:** story circles that scroll sideways – **My Story** first (pink ＋ to add one; tap the circle to
     watch yours), then friends' stories (colorful ring = new, grey = seen, green = close friends), then an
     **Invite** circle at the end.
   - **Under it:** the Guess Who / Group Peek row, then the **feed**: your friends' posts (and yours) first, then
     "✨ More from everyone on Peekaboo". ❤️, 💬 and ••• work like before; pull down to refresh.
3. **Brand new account** (no friends' stories *and* no posts): one friendly "Welcome to Peekaboo!" message with
   **Take a photo** and **Invite friends** – not two empty sections.
4. **Top bars:** on **Chat** and **Home**, the 📷 button is top left and **your profile picture is top right** –
   tap it to open your profile.
5. **The Camera is cleaner:** top left = your picture (a red number on it = new friend requests) and a small
   **🎯 Dare** chip (tap it for today's dare); top right = flip and flash, side by side; bottom = gallery · shutter ·
   **map**. The "Add friends" button is gone from the camera – find friends from your profile or Chat.
6. Old habits still work: posting a drop lands you on **Home**; the Stories and Discover tabs are gone.

## Step 34 – Dares with some bite 🎯

1. Camera → **🎯 Dare** chip → the dare screen. Today's dare is one of **365** new ones – bold, messy and silly
   (cannonball in your clothes, crack an egg on a friend's head, ice bucket, eat a whole lemon, sing in a shop…).
   A new one every day at the usual time; the same dare only comes round again after a year.
2. Under the dare: the house rules – nobody gets hurt · no fire · no nudity · friends must be in on it.
3. Old dare posts still show a 🎯 tag; because the list changed, the text on posts from before this update
   now shows the new dare for that day (only test posts are affected).

## Step 35 – Camera modes 📷🎯👀🕵️

1. On the Camera, the loose "🎯 Dare" and "👀 Post today's drop" pills are gone. Just above the shutter there's a
   **mode dial**: **📷 Photo · 🎯 Dare · 👀 Drop · 🕵️ Guess Who**. Swipe it sideways or tap a mode – the one in
   the middle is what you'll post, and the shutter's ring takes its colour (white / pink / red / yellow).
   A pink dot on a mode means something's waiting there (dare not done yet, a drop to post).
2. **Dare**: today's dare shows above the dial (tap it for the rules). Snap → it's your answer to the dare.
3. **Drop**: above the dial you see the countdown ("👀 Peekaboo! 1:42 left", pulsing) or "⏰ Late by 3h · post anyway".
   Before today's drop has happened it says so and the shutter is dimmed (nothing to post yet).
4. **Guess Who**: "Posted without your name · friends guess who it was". Snap → posted anonymously.
5. Photo mode keeps the screen clean. Swiping left/right **outside** the dial still moves between Chat · Camera · Home.

## Step 36 – Dare chains 😈 ("I dare YOU")

Use 2 test accounts that are friends (A and B).
1. **A** does today's dare (Camera → Dare mode → snap → Send). Right after, a new screen: **Dare your friends 😈**.
   Tick B (up to 3 friends) → **Dare 1 friend** → "😈 Dared 1 friend – they have 24 hours".
   (**Dare someone who isn't on Peekaboo** opens the share sheet with the dare + download links.)
2. **B** gets a push: "🎯 You've been dared! A dared you to do today's dare. You have 24 hours ⏳". Tapping it opens the
   Dare screen, which shows **😈 Dared you today · A dared you · ⏳ 23h left**. On B's camera in Dare mode the line under
   the dare says "😈 A dared you · 23h left".
3. **B** does the dare → on both phones it flips to **✅ Did it**. A's Dare screen shows **🔗 Your dare chain** with
   "You dared B ✅", plus **Dare more friends (2 left)**.
4. You can only dare after doing the dare yourself, only friends, max 3 a day, and not someone who already did it.
5. If B doesn't do it within 24 hours it shows **💀 Ran out of time** (forfeits come in the next step).

## Step 37 – Forfeits 💀

Use the 2 friend test accounts from Step 36. A dare only becomes a forfeit after the 24 hours run out, so to test
it today, ask the chat to shorten one in the database (or wait a day).
1. **A** dared **B** and B didn't do it in time. On A's Dare screen, under **🔗 Your dare chain**, B's row now shows
   **Pick a forfeit 💀** → a list of 40 forfeits (nobody can type their own) → tap one → **Give this one**.
2. **B** gets a push "💀 You owe a forfeit – A picked yours: …". B's Dare screen shows **💀 Forfeits · You owe A: …**
   with **Pay it 📸**.
3. **Pay it 📸** opens the camera with "💀 YOUR FORFEIT" at the top. Snap → **Send to…** has **💀 Pay my forfeit**
   ticked → **Send** → "Forfeit paid 💀✅ Respect."
4. The post shows on B's profile and in Home with a purple **💀 Forfeit · …** tag. A gets a push "💀 Forfeit paid"
   and on A's Dare screen it says **✅ Paid** (tap to see the post).
5. You can't pick a forfeit early, for someone who did the dare, twice, or pay the same one twice.

## Step 38 – Dare streaks 🔥

Use 2 friend accounts (A and B).
1. Both do today's dare. On both Dare screens a **🔥 Dare streaks** box appears: "🔥 1 with B · ✅ Both done today".
2. Tomorrow, if only A does it: A sees "🔥 1 with B · ⏳ B still has to"; B's camera (Dare mode) shows
   "🔥 Keep your 1-day streak with A" under the dare, and B's Dare screen says "⚠️ Your turn – or it ends".
3. Both do it → 🔥 2. Miss a day (either of you) → back to 0 and the row disappears until you both do one again.
4. Streaks are worked out from your dare posts, so deleting a dare post can lower a streak.

## Step 39 – Community dares 💡

1. Dare screen → **💡 Suggest a dare for everyone · we approve ideas before they run** → the Ideas screen. The card
   says ideas with at least 3 🔥 get checked by the Peekaboo team. Type an idea (10–120 letters) → **Suggest**.
   One idea a day each. Dangerous words (fire, knife, roof, alcohol, nudity…) are refused by the database with
   "Keep it silly, not dangerous".
2. Everyone sees the ideas under **Top** / **New** with the suggester's @name. Tap 🔥 to vote (tap again to take it back).
   ••• on someone's idea → **Report** (3 reports from different people hide it); on your own → **Delete**.
3. **The owner's OK:** an idea with **at least 3 🔥** shows "👀 waiting for our check" after the @name. It can't run
   yet – votes alone are not enough.
   - To approve it (owner, Supabase dashboard): Table Editor → **dare_ideas** → read the text. Only approve it if
     it follows the Dare Safety Rules and you'd be happy for a 13-year-old to do it. Then fill its **approved_at**
     cell with the date and time now (for example `2026-11-06 09:00:00+00`) and save. The full steps are at the
     top of `supabase/migrations/20261220000000_launch_safety.sql`.
   - Back in the app (go back and open the Ideas screen again): the idea now shows "🔥 ready to run".
   - People can't approve ideas, not even their own: a new idea always starts with approved_at empty.
   - To take an approval back before it has run: set approved_at back to empty (NULL).
4. At the next dare change **after** the approval (10:00 UTC), the top **approved** idea with at least 3 🔥 that
   hasn't run yet becomes everyone's dare: the Dare screen card says **💡 COMMUNITY DARE · by @name**, and the
   camera's Dare mode shows it too. Dare posts from that day get a tag "🎯 Dare … · by @name". An approval never
   changes today's dare in the middle of the day.
5. No approved idea with 3 votes → the built-in list runs as usual. An idea only ever runs once.

## Step 40 – Terms & safety 📜

1. **Existing account:** open Peekaboo → a full-screen **Our Terms** page with a short summary. Tap any of the four
   links (Terms, Dare Safety Rules, Privacy, Guidelines) – the document opens right there, **Back** returns.
   **I agree** → into the app. (**Log out** is the only other way out.) It never shows again unless the Terms change.
2. **New account:** Sign up has a second tick box "I agree to the Terms of Service (including the Dare Safety Rules)
   and the Privacy Policy" with tappable links. You can't make an account without ticking it. After signing up you
   are **not** shown the Terms page again – the tick counted.
3. **First dare:** do a dare, a drop, pay a forfeit or suggest a dare idea → a **Before your first dare 🎯** sheet:
   the safety points + "I understand – let's go". **Not now** cancels. After agreeing once it never shows again.
4. **Settings → Legal & safety:** Terms, Privacy Policy, Community Guidelines, Dare Safety Rules all open in the app.
5. **Dare screen:** the house-rules line under today's dare now ends with **Full rules** (tap → Dare Safety Rules).
6. **Report** anything → the pop-up says "We review every report within 24 hours".
7. In Supabase → Table Editor → **legal_acceptances**: one row per person per document, with the date it happened.

## Step 41 – Hype rating 🔥 😬 💀 (replaces "Legit or cap")

Use 2 friend accounts (A and B) and one account that isn't friends with A (C).
1. **A** does today's dare (or pays a forfeit). On **B's** Home feed, A's post shows a row under the 🎯 tag:
   **How bold was it?  [🔥 0]  [😬 0]  [💀 0]** (🔥 Iconic · 😬 Mid · 💀 Unhinged).
2. **B** taps 💀 → it fills and counts 1. Tap it again → rating taken back. Tap 🔥 → switches to Iconic.
3. **A** gets a push the first time anyone rates the dare: "Your friends are rating your dare 👀" (only the first
   one, so no spam). On A's own post the row shows just the totals – you can't rate yourself.
4. Ratings are **anonymous**: everyone sees the totals, nobody sees who picked what.
5. After **3 ratings** the label shows the winner, e.g. **💀 Unhinged**.
6. The same row is on the full-screen post. **C** (not a friend) sees the totals but can't rate.
7. Only dare and forfeit posts have it; normal posts just have likes and comments.

## Step 42 – Googly lens 🤪 (live, like a Snapchat lens)

Needs the **new Android download (v9)** – it has the face tracking built in. Expo Go can't run it.
1. Open the Camera. On the round mode bubbles above the shutter, swipe to **🤪 Googly** (first bubble after the
   plain camera). The camera turns to the selfie side.
2. Point it at a face → a pair of googly eyes sits on the eyes and **follows the face** as it moves, tilts and
   comes closer. Up to 4 faces at once. Flip to the back camera with the flip button – works there too.
3. Tap the shutter → the photo opens in the editor with the googly eyes already on the faces. They're normal
   stickers now: drag, pinch to resize, or drop on the trash. Then **Send to** as usual.
4. **Hold** the shutter to record a video with the lens. When the video opens in the editor, the bottom says
   "👀 Sticking the eyes to your face… %". After a few seconds it says "The googly eyes follow your face!" – play
   it back: the eyes move with your face (turn, tilt, come closer). Send it as a story and as a peek in a chat:
   your friend sees the eyes moving too. (If it finds no face, the eyes stay as normal stickers.)
5. In **Expo Go** (or an older download) the 🤪 bubble shows "The googly lens works in the Peekaboo app download"
   and the camera stays normal. Your iPhone gets the lens once TestFlight is set up.

## Step 43 – Hit ups 👋 (Peek Match is gone)

You need 2 test accounts that **aren't friends**, both with a birthday saved, both 18+ (hit ups are adults only).
1. **The dating part is gone:** no Match tab, no dating profiles, no ID check, no Stripe. The bottom bar is just
   Chat · Camera · Home.
2. **Birthday:** if an account has none, Peekaboo asks once when it opens (or Settings → **Birthday**). Saved
   once, only you see it, can't be changed.
3. **Hit up:** on account A, open B's profile (search in Friends, or tap them on Home) → under **Add friend**
   there's **👋 Hit up**. Tap it → write a message if you want (up to 150 letters) → **Send hit up** → "Hit up
   sent 👋", and the button now says **Hit up sent ✓**.
4. **B gets it:** a notification "👋 A hit you up" (with push on – it uses the Friend requests switch). Tapping
   it opens **Chat**, where a **Hit ups 👋** box at the top shows A's picture, name and message. The Chat tab
   has a red number for it too.
5. **Hit back:** B taps **Hit back** → "You and A can chat now 🎉" → the chat opens with A's message already in
   it. They're friends now. A gets "👋 B hit you back!" (and **not** the usual "new friend" alert).
6. **Ignore** (try with a third account): the hit up disappears for B. A is **never told** – A's button keeps
   saying **Hit up sent ✓**.
7. **No messages until they hit back:** before B hits back, B isn't in A's Chat list and nothing else can be sent.
8. **Both hit each other up** → you're connected straight away (B sees **👋 Hit back – A hit you up** on A's
   profile).
9. **Safety rules:**
   - **Under 18:** someone whose birthday makes them under 18 never sees a Hit up button on anyone, and nobody
     sees one on them (it just looks unavailable – their age is never given away).
   - **Birthday checks:** month 13, day 32, a future date, a year more than 100 years ago, or an age under 13
     all show a red message under the boxes and the Save button stays off.
   - No birthday → tapping **👋 Hit up** says "Add your birthday first".
   - **They** have no birthday → tapping **👋 Hit up** says "<name> can't get hit ups yet" (they add it in Settings →
     Birthday, then it works).
   - 10 hit ups a day; the 11th says "You've used your 10 hit ups for today".
   - Settings → **Who can hit me up**: **Everyone** / **Friends of friends** (only people who share a friend
     with you) / **Nobody** (the button disappears for everyone).
   - Blocked (either way) → no button.
   - **•••** on every hit up in Chat → See profile · **Report** · **Block**.
10. **New Terms:** because the Terms changed (dating removed, hit up rules added), everyone sees "Our Terms"
    once more and taps agree.

## Step 44 – Your story from your profile 📸

1. Post something to **your story**, then open your profile (your picture, top right of Chat or Home).
2. Your profile picture now has the colorful ring → **tap it** → your story plays.
3. At the bottom of your own story: **👁 N seen** and **🗑 Delete**. Delete asks first, then removes that photo or
   video for everyone (••• → **Delete from my story** works too).
4. No story up → no ring, and tapping the picture does nothing. On a friend's profile, the ring means they have
   a story up – tap it to watch.

## Step 45 – See your story before you post it ✨

1. Take a photo (or video) → add text, stickers or a filter if you like → **Send to**.
2. Leave **My Story** ticked → **Send**. Your story now opens **full screen, exactly how friends will see it**
   ("This is how your story will look"), with **⭐ Close friends** at the top if you picked that.
3. **✏️ Edit** → back to the editor with your text and stickers still there. Change anything → **Send to** →
   **Send** → the preview again.
4. **Share to story** → it's posted. (If **Post to my profile** is ticked too, the profile preview comes next.)
5. **✕** at the top closes the preview without posting.

## Step 46 – A simpler "Send to…" screen 📤

1. Take a photo → **Send to**. At the top: your photo, **"Where should it go?"**, a one-line hint and an **✏️ Edit**
   button (back to the editor).
2. Just two groups:
   - **📣 Post it:** ✨ **My Story** (ticked already) and 🖼️ **My Profile**. When either is ticked, one switch
     appears: **⭐ Close friends only** (off = all your friends see it). A caption box shows for My Profile.
   - **💌 Send to friends:** tick friends to send it just to them (it disappears after they open it).
3. The big button at the bottom **says what will happen**: "Send to My Story", "Send to My Story + Sam",
   "Send to My Story + 2 more"… With nothing ticked it says "Pick where it goes" and can't be tapped.
4. **Today's dare**, **Guess Who**, **drop** and **forfeit** only show up when you took the photo for one of
   those (the 🎯 / 🕵️ / 👀 bubbles on the camera, or the Dare page) – and then they're already ticked.

## Step 47 – A cleaner Home 🏠

1. **Home** now has just the **story circles** on top, then the feed. The Guess Who / Group Peek buttons under
   the stories are gone.
2. **🕵️ Guess Who** is a circle in the story row, right after **My Story**. A red number = posts you can still
   guess (with a colorful ring); grey = nothing new. Tap it → the Guess Who page (＋ top right to post one).
3. **👯 Group Peeks** moved to **Chat**, above your chats: each group shows "2 of 4 posted today's drop" (green
   when everyone has). Tap one to open it; **＋ New** makes another. No groups yet → one **Make a group** row.
   (Settings → Group Peek still works too.)

## Step 48 – Post page and comments, Instagram style 💬

1. Open a post (tap it on your profile). The photo sits between the top bar and a **dark panel underneath**:
   ❤️ likes and 💬 comments, any dare tags, then the caption with the poster's name in bold – no more words
   floating on the photo. A long caption shows 3 lines; tap it to read the rest.
2. Tap **💬** (here or under a post on Home) → the comments **slide up from the bottom** over the post, with the
   post still showing dimmed behind. Write, reply, like and long-press to delete/report like before.
3. Close it by **dragging the grey bar at the top down**, **tapping the dimmed area above**, or the phone's back
   gesture. You're right back on the post (or Home), and the comment count is updated.

## Step 49 – Zoom into photos 🔍

1. Open your profile (or anyone's) → tap a photo in the grid.
2. **Pinch** with two fingers → it zooms in towards your fingers (up to 5×). Let go a little zoomed and it
   stays; let go at normal size and it snaps back.
3. While zoomed, **drag with one finger** to look around – it stops at the photo's edges.
4. **Double-tap** a spot → zooms in on it. Double-tap again → back to normal.
5. Not zoomed: one-finger swipes do what they did before (e.g. swipe back on iPhone). Videos don't zoom.
6. **The "half the screen" bug (21 Nov):** on a friend's photo, pinch towards the **top-left** and let go quickly,
   lifting your two fingers a moment apart. Do it 10 times, then again on a photo in **Public chat** and in a
   **group chat**. Every time the photo either stays zoomed with no black gap at any edge, or springs back to
   exactly its normal place – never shifted with black on the left and top.
7. A photo with **black bars** above and below it (a sideways photo from the camera roll is easiest): zoom in 2×
   and drag it hard up, down, left and right, also with your fingers on the black bar when you pinch. When you let
   go, the black bar never comes onto the screen past the photo's edge (while the zoomed photo is still shorter
   than the screen it just stays in the middle, up and down).

## Step 50 – Sign up with just a username 👤

1. Log out → **Sign up**. Under the username there's a choice: **📧 With email** or **👤 Just a username**.
2. Pick **Just a username** → the email box disappears and a note warns that without an email a forgotten
   password can't be recovered. Fill in name, username, password, tick the boxes → **Let's go!** → you're in.
3. A username that's taken says "That username is already taken" (same as before).
4. **Log in** now has one box: **Email or username**. Type the username (with or without @) and the password.
   Email accounts can log in with their username too. A wrong password says "Wrong username or password".
5. After 8 wrong passwords for the same username in 15 minutes it asks you to wait 15 minutes.

## Step 51 – The real logo 👀✨

Needs the **new downloads** (Android APK / TestFlight build) for the icon and loading screen; the in-app parts
arrive with the normal update.
1. **Home screen icon:** the googly eyes with the sparkle on the pink→purple square (iPhone), or inside the
   phone's circle/squircle (Android). Android "themed icons" show white eyes.
2. **Opening the app:** the loading screen shows the rounded icon tile with "peekab👀" under it.
3. **Home page:** the "peekab👀" wordmark sits in the top bar instead of the word Peekaboo (navy letters in
   light mode, white in dark mode).
4. **Welcome screen** (logged out): the eyes bob up and down above the wordmark, on the logo's colours.
5. **Android notifications:** the small icon in the status bar is the white eyes.

## Step 52 – Hold down a chat 📌🔕

1. **Chat** → press and hold a friend's row → a menu for that friend: **📌 Pin chat to top**, **🔕 Mute
   notifications**, **🙈 Hide their stories**, **⭐ Add to close friends**, **👤 See profile**, **🚫 Block**.
2. **Pin** → the chat jumps to the top of the list and shows a small 📌. Hold again → **Unpin**.
3. **Mute** → a 🔕 shows next to their name, and their messages, peeks and screenshot notices no longer send
   you a notification (the chat and the red number still update). Hold again → **Unmute**. Your messages to
   them still notify them as usual.
4. **Hide their stories** → their circle disappears from the story row on Home (their profile still shows the
   story). Hold again → **Show their stories again**.
5. **Close friends** toggles the same list as Settings → Close friends.

## Step 53 – Clean words 🧼

1. **Usernames: no swearing.** "fuckboy", "f.u.c.k", "the_shit" say "Let's keep it clean…" and won't save.
   Usernames like ishita, nazir, pornsak, hancock, scunthorpe are fine.
2. **Display names (your name on your profile) may swear:** "Fuck Off" or "Big Dick" saves, and so do real names
   like "Moby Dick" or "Alex Cock". (Changed 5 Nov: display names used to block swearing.)
3. **Bios, chats, comments, captions, hit ups, group names:** swearing is allowed.
4. **Slurs are blocked in public places** – display names, bios, captions, comments, hit ups, dare ideas, group
   names (also sneaky spellings like "n1gg3r"): "That word isn't allowed on Peekaboo" (in a username: "Let's keep
   it clean…"). After the QA round 2 release the database checks this too, with the same words and the same
   message (see Step 62).
5. **Private chats aren't filtered at all**: any word goes through in a chat or a chat dare to a friend.

## Step 54 – Reports (owner, in Supabase) 🚩

Reports are handled in the Supabase dashboard only – there's no owner screen in the app. Check at least once a
day and act within 24 hours.

1. Have a test account report a post, a comment, a message and a profile.
2. Supabase → **Table Editor → reports**: each report is a row with the reporter, the reported account, the
   reason, what kind of thing it was (`content_type`) and its id (`content_id`).
3. **Remove it:** open the matching table (posts, mystery_posts, stories, comments or messages), find the row
   with that id and delete it. Then set the report's `status` to `reviewed`.
4. **Ban someone:** Supabase → **Authentication → Users** → find them → **Ban user**. (Unban the same way.)
5. Nothing to do: set the report's `status` to `dismissed`.
6. **After the QA round 2 release:** an open or `reviewed` report keeps the reported photo/video file safe, even
   if its owner deletes it. `dismissed` lets go of the files for good (setting it back doesn't bring them back);
   the daily cleanup can then delete them. To let go of one report's files yourself, run
   `select public.release_report_evidence('<report id>');` in the SQL editor. Deleting a file in Storage that a
   report still keeps should be refused (not yet checked on the live project). One exception: if the reported
   person deletes their whole account, their files go too, even ones a report keeps, so save anything you need
   first.

## Step 55 – Keeps 📦 (save your edits)

1. Take a photo, add a filter/text/sticker → in the editor, tap the **⬇️** button (top row). It turns green ✓
   and says "Saved to Photos and your Keeps" (or just "Saved to your Keeps" on an older download without
   Photos access).
2. Your profile → **Keeps** → a grid of everything you saved (only you can see it). Tap one → full screen with
   **Save to Photos**, **Post it** (goes through the normal Send to… screen) and 🗑 delete.
3. The first save asks for permission to add to Photos; saying no still keeps it in Peekaboo.

## Step 56 – Sign in with Apple / Google 🍎

Needs the newest download (new TestFlight / APK). Expo Go and older downloads still show the old
"Create account" button.

1. **iPhone:** log out → the welcome screen shows **Continue with Apple** and **Log in with username or email**.
   Tap Continue with Apple → Face ID → the **Almost there! 🎉** screen.
2. **Android:** the same, with **Continue with Google** → pick a Google account → Almost there.
3. Almost there: your name is filled in (from Apple the first time, or from Google). Pick a username (✅ when it's
   free), tick **I'm 13 or older** and **I agree to the Terms** → **Let's go!** → the camera opens.
4. Back arrow or **Cancel and log out** on that screen → back to the welcome screen. Signing in again shows
   Almost there again (until you finish it).
5. Log out, then **Continue with Apple/Google** again → straight into the app (no setup the second time).
6. **Old accounts:** **Log in with username or email** still works with the password, e.g. @coolname.
7. **Delete account** on an Apple account: Settings → Delete account → Apple asks for Face ID once more → the
   account is gone. On iPhone: Settings → your name → Sign-In & Security → Sign in with Apple → Peekaboo is no
   longer listed (needs the Apple key secrets, see `docs/HANDOFF.md`). If the iPhone uses a different Apple ID
   than the account, the account is still deleted. After the QA round 2 release, Peekaboo then stays listed
   under both Apple IDs (see Step 62).
8. **Sign-up guard** (once it's switched on): the old Create account button on an old download says "New accounts
   are made with Apple or Google now. Update Peekaboo to the newest version."

## Step 56 – Inbox 🔔 (activity, hit ups, friend requests)

1. **Chat** now shows only your chats (and Group Peeks). A **🔔 bell** next to your picture has a red number for
   new things; a slim "🔔 3 new in your Inbox" row shows above the chats while there's something new.
2. Tap the bell → **Inbox**: **Hit ups 👋** (Hit back / Ignore), **Friend requests 💌** (Accept / ✕) and
   **Activity** – "B liked your post ❤️", "B commented: “…”", "B replied to your comment", "B liked your comment",
   "B added you as a friend 🎉", "B accepted your friend request 🎉", "B hit you back 👋". New ones have a dot.
3. Tap an activity: likes/comments open the post, friend things open the profile.
4. **Clear** (next to Activity) empties the activity list. Leaving the Inbox marks everything as seen (the red
   numbers for activity go away; hit ups and requests stay until you answer them).
5. **Pull down** to refresh in Chat and in the Inbox.
6. **No more pile-ups:** opening Peekaboo clears its notifications off the lock screen and the number on the app
   icon. While the app is open, a new notification shows as a quick banner only.
7. Blocked people never show up; your own likes/comments never show up.

## Step 57 – Dares in chat: confirm + dare streak 🔥

1. A dares B in chat (🚩 button). B sees **Do it · send proof** and **Already did it? Tap ✅**.
2. B taps **Do it · send proof** → camera → sends a peek → "Proof sent 🎯 Now they confirm it". (Or B taps
   **Already did it? Tap ✅**.) A gets a notification "🎯 B did your dare!".
3. A's dare card: "B says they did it! Check the proof, then:" **✅ Confirm** / **❌ Nope**.
   - **Confirm** → the card turns green "✅ DARE COMPLETED"; B gets "✅ Dare completed!"; B's card shows
     **Dare A back 🎯**.
   - **Nope** → B sees "A says that didn't count – try again!" and can do it again.
4. **Dare streak:** each dare you two complete adds to "🔥 N dare streak" under the name at the top of the chat.
   More than 3 days without a completed dare resets it.
5. Nobody can confirm their own dare or fake a completed one.

## Step 58 – Dare them back, live Inbox, drop reminder ⏰

1. **Dare them back:** a friend's daily-dare post (Home feed, or opened full screen) shows **🎯 Dare <name> back**.
   Write a dare → "Dare sent to <name> 🎯 It's in your chat" → it's a dare card in your chat with them (Step 57).
   Not shown on your own posts or on posts from people you're not friends with.
2. **Live Inbox:** keep the Inbox open on phone A. From phone B like A's post, comment, hit A up or add A – it
   appears on A within a second or two, no pull-down needed.
3. **Drop reminder from the server:** someone who hasn't opened Peekaboo for 7–45 days still gets
   "⏰ Peekaboo drop!" at their local drop time (once a day; not if they turned Drops off in Settings →
   Notifications). People who open the app normally get the phone's own reminder instead, never two.

## Step 59 – Delete for me, Clear chat, Group chat 💬

1. **Delete for me:** hold any message in a chat → **Delete for me**: it's gone from your chat only (your friend
   still has it). Your own messages also have **Delete for everyone** (gone for both).
2. **Clear chat:** in Chat, hold a friend's row → **🧹 Clear chat** → confirm. The chat is empty for you only;
   new messages show up as normal.
3. **Group chat:** Chat → **👯 Groups** → tap a group → its chat. Messages show the sender's name and picture;
   everyone in the group sees them live. Others get "👯 Group name · Ray: hey".
4. In the Chat list a group shows its latest message and a blue unread number.
5. **•••** in a group chat → **Group info & drops** (the Group Peek page) or **Mute group chat** (no notifications).
   The Group Peek page has a **💬 Group chat** button too.
6. Hold your own group message → **Delete for everyone**. Hold someone else's → See profile / Report.
7. Someone not in the group can't read or write its chat. Leaving or being removed ends access.

## Step 60 – Group chats: photos, voice, group dares, typing, Seen, search

1. **Photos/videos:** in a group chat tap 📷 → the gallery button → pick a photo or video → **Send to group** → it
   shows in the chat for everyone in the group (stays there). Others get "👯 Squad · Ray: 📷 Photo". (A picture
   **taken** with the camera goes as a snap that disappears – see Step 70.)
2. **Voice notes:** with nothing typed, hold 🎤, talk, let go → a voice note in the group chat.
3. **Group dares:** tap 🚩 → write a dare → "🎯 Ray dared the group". Each person taps **Do it · post proof** →
   camera → their photo/video appears as "⏳ Legit or cap? Vote!" for everyone else ("⏳ Waiting for votes" for
   them), and the rest of the group votes on it (see Step 62, check 14). The card shows "2 of 4 did it: …" (only proofs the group said are legit) and turns green
   with "🔥 Everyone did it!" when the whole group has.
4. **Typing:** while someone types, the top says "Sam is typing…".
5. **Seen:** under your newest message, "👁 Seen by Sam, Ali" (or "everyone") once they've opened the chat.
6. **Search:** group chat → ••• → **🔎 Search this chat**; one-on-one chat → the 🔎 button at the top right.
   Type a word → matching messages → tap one to jump to it.
7. Someone outside the group can't open the group's photos or voice notes.

## Step 61 – Reactions, replies, group photo, pinned message

1. **Reactions:** hold any message (one-on-one or group) → a row of ❤️ 😂 🔥 😮 😢 👍 on top → tap one. It shows
   under the message with a count; the sender gets "Ray · Reacted ❤️ to your message". Tap another to change it,
   the same one (or the chip under the message) to take it back.
2. **Reply:** hold a message → **↩ Reply** → a "Replying to …" bar above the box → send. Your message shows the
   one you answered above it.
3. **Group photo & name:** group chat → ••• → **📷 Change group photo** (pick a square photo) / **Remove group photo**
   / **✏️ Change name & people**. The photo shows in the Chat list and at the top of the group chat.
4. **Pinned message:** in a group chat hold a message → **📌 Pin to the top** → it shows in a bar under the name for
   everyone; tap it to jump there, ✕ (or hold → Unpin) to unpin.
5. People outside a chat can't react or pin; a reply can only point at a message in the same chat.

## Step 62 – Phone checks for the QA round 2 release 🧪

The automated tests can't prove these. Do them **after** the QA release (database first, then the app update –
see "Release order" in `docs/HANDOFF.md`). The new app needs the new database, so don't try it against the live
database before the migrations are in. Use the real app (TestFlight / APK) on **both an iPhone and an Android**.
These checks run on the live project (unlike the rest of this checklist). Use test accounts only, never a
real person's account (deleting can't be undone).

1. **Terms check at start-up:**
   - With an account that already agreed: close the app fully and open it. A short plain cover (a spinner),
     then the app. Nothing slides down and the Terms page never shows.
   - With an account that must agree (for example after a Terms change): after the short cover the **Our Terms**
     page shows. **I agree** → it slides away and you're in. **Log out** also works. ⚠️ If the Terms page ever
     fails to appear for someone who must agree, stop and report it – it's the legal gate.
   - Airplane mode on, open the app → after about 15 seconds **Couldn't check** with **Try again** and **Log out**.
     Airplane mode off → **Try again** → straight in (no Terms page if you agreed before).
2. **Chat ← Camera → Home:** swipe between the three pages and tap the tabs. The haptic tick on each page, the
   shrink/dim animation, the tab bar fading and the camera warming up are all as before. The Friend Map and
   hold-to-reveal photos still work.
3. **Links from a closed app:** close the app fully, then tap a chat or friend notification (or a `peekaboo://`
   link) → that page opens, not Home. The splash screen stays until it does, with no flash of the Welcome screen.
4. **Word filter:**
   - A display name, bio, caption, comment, hit up, dare idea or group name with a slur → "That word isn't
     allowed on Peekaboo." and it isn't saved.
   - A display name with swearing (Edit profile → Name → "Fuck Off") → it saves and shows on your profile.
   - A username with swearing → "Let's keep it clean – that word can't be in a username or name."
   - In a private chat (one-on-one or group, dares too) the same words still go through.
5. **Photos stay on screen:** in a group chat with photos, have someone send a new photo → the photos already
   there stay put (no blank flash). Same on the Home feed when you pull down to refresh.
6. **Community dares:** Dare screen → **💡 Suggest a dare for everyone · we approve ideas before they run** → the
   **🔥 Top** and **🆕 New** lists load, with each idea's @name.
7. **Chat-dare proof for a dare that's gone:** A dares B in chat. While B takes the proof photo, A holds the
   dare → **Delete for everyone**. B sends the photo → **Photo sent** "That dare isn't there any more, so it
   can't be marked as done. Your photo is already sent." → back to the chat (no endless "Tap Send again").
8. **Delete account with a different Apple ID** (use a throwaway Apple test account): on an iPhone signed in to
   a different Apple ID than the one the Peekaboo account uses, Settings → **Delete account** → approve the
   Apple prompt → the account is deleted (it is not blocked). Peekaboo then stays listed under both Apple IDs
   (the account's and the iPhone's). Remove it under each one by hand (see `docs/HANDOFF.md`).
9. **Username login after wrong passwords:** with a test account that has a password (log in with its
   username, not its email; not @coolname or the App Review account, since it gets locked for 15 minutes),
   type a wrong password 8 times from the same phone. The next try says "Lots of login tries for this
   username – wait 15 minutes and try again" (even with the right password). Switch from Wi-Fi to mobile data → the right password works. A right
   password never counts as a try.
10. **Settings privacy switch:** turn on airplane mode → flip **Private account** → "Could not save" and the switch
    stays where it was. Airplane mode off → flip it → "Your account is private 🔒". Flip it twice quickly on slow
    data and leave Settings at once → your profile shows your last choice. VoiceOver/TalkBack read each switch
    as a working switch (not "dimmed" or "disabled").
11. **Delete a sent peek or voice note** in a chat → it disappears with no error.
12. **Group photo:** change a group's photo → it works. On a flaky connection you may see an error, but nothing
    breaks.
13. **Web version** (`npx expo start`, then press **w**): log in, open the photo editor and tap **Send to** or the
    save button → "Sending and saving from the web isn't ready yet. Please use the Peekaboo phone app." In Chrome
    on Android, swiping right on Chat doesn't leave the app. (On iPhone Safari the edge swipe-back can still go
    back – a web page can't block it.)
14. **Group dares: Legit or Cap** (needs three phones with test accounts in one group – call them A, B and C):
    - A dares the group (🚩). B taps **Do it · post proof** and sends a photo. Everyone sees "⏳ Legit or cap?
      Vote!" on it (B sees "⏳ Waiting for votes"). The dare card still says "Nobody has done it yet", and B
      still has the **Do it · post proof** button. A and C got the usual "👯 Squad · B: 📸 Posted proof – legit or
      cap?" notification (not "Did the dare").
    - B's photo has no Legit / Cap buttons for B. A (who sent the dare) and C do have them.
    - C taps **Legit 🔥** → "You said legit 🔥", the button turns pink, and within a second or two all three
      phones show "🔥 1 · 🧢 0" and "✅ Legit – it counts". The card says "1 of 3 did it: B", B sees "✅ You
      did it", and B gets "The group says legit 🔥".
    - A taps **Cap 🧢** → all phones show "🔥 1 · 🧢 1" and "⚖️ Tie – not decided". The card goes back to "Nobody
      has done it yet" and B gets the **Do it** button back. B gets "Someone called cap on your proof 🧢".
    - C taps **Legit 🔥** again → "Vote taken back"; now "🔥 0 · 🧢 1" and "🧢 Cap – doesn't count" (cap
      majority). C taps **Cap 🧢**, then **Legit 🔥**: the totals follow, but B gets no more notifications.
    - Tap a button twice very quickly → only one vote is counted.
    - In the one-to-one chat between A and B, the 🔥 dare streak goes up while B's proof counts, and down
      again when it doesn't. A proof for your own dare never changes a streak.
    - Turn on airplane mode and tap a vote → "Vote not saved – …" and nothing changes. Try it on the web
      version too: you see the message there (no silent failure).
    - C leaves the group (or A, if A made the group, removes C) → on A's and B's phones C's vote disappears from
      the totals within a second or two ("🔥 0 · 🧢 1"). Add C back: on B's photo C now sees "You joined after
      this was posted, so you can't vote on it" instead of the buttons (C counts as joining again now) – also
      if C kept the chat open the whole time (it shows after the next message, or after C taps a vote once).
      On a new proof posted after that, C has the buttons again.
    - Add a fourth test account D to the group after B posted the photo → on B's photo D sees "🔥 0 · 🧢 1",
      "🧢 Cap – doesn't count" and "You joined after this was posted, so you can't vote on it", with no
      buttons. B posts a new proof for the dare → D has Legit / Cap on that one.
    - A proof posted before the update still shows "✅ Did the dare" and counts until someone votes on it. After
      the first vote it follows the normal rule, even if that vote is taken back (then "⏳ Legit or cap? Vote!"),
      and its poster gets no "The group says legit 🔥" for it.


## Step 63 – Message box above the keyboard, and story rings on pictures 💬🟣

**Message box (iPhone).** The owner's iPhone hid the message box behind the keyboard. Check on an iPhone,
also with Settings → Accessibility → Motion → **Reduce Motion** and **Prefer Cross-Fade Transitions** on:
1. Open a one-to-one chat and tap **Send a chat** → the keyboard opens and the box sits right on top of it
   (no gap, not hidden). Type a long message: the box grows upwards and stays visible.
2. Switch to the emoji keyboard and back (the keyboard changes height) → the box follows it.
3. Drag the messages down to close the keyboard → the box goes back to the bottom.
4. The same in a group chat, in **Write a dare** (🚩) and in **Hit up** on someone's profile.
5. On Android: everything works as before.

**Story rings.**
1. Friend B posts a story. On A's phone, B's picture gets a **glowing pink-purple ring** (green for a
   close-friends story) in: the Chat list, the top of the chat with B, B's profile, B's posts in the feed, a
   post opened on its own, friend lists, group chats (next to B's messages), the group's member list and
   comments. (Up to 30 seconds after B posts, or open Home to see it at once.)
2. Tap B's picture in any of those places → B's story opens. Close it → the ring turns **grey** (no glow) and
   still opens the story.
3. Without a story, tapping the picture does what it did before: the Chat list opens the chat, the chat top
   and the feed open the profile, comments open the profile. Holding a picture in the Chat list (or the
   member list) still opens the menu.
4. Your own story: your picture on your profile has the ring and opens your story.
5. Hide B's stories (hold B in the Chat list → hide stories) → B's ring goes away everywhere.

## Step 64 – Peekaboo+ ⭐ (buy, restore, delete account)

You need an iPhone with the newest **TestFlight** build. In TestFlight buying is free: Apple uses test
("sandbox") payments, so no real money is taken. A test subscription renews every day, up to 6 times, and then
stops by itself. Use a test account that doesn't have Peekaboo+ yet.

⚠️ Never tap **Subscribe** or **Restore purchases** while logged in as the App Review account
(`review@peekaboo.invalid`). The test subscription could move to it, and then Apple's reviewer would never see
the buy screen.

**Buy**
1. Settings → **⭐ Peekaboo+** (or tap a 🔒 theme in Settings → Appearance) → the Peekaboo+ screen: "Unlock it
   all ⭐", the list of extras, and at the bottom **Subscribe · (price)/month**. Under the button: the small print
   (charged to your Apple Account every month, renews by itself, cancel in Settings → your name → Subscriptions
   at least 24 hours before it renews) and **Restore purchases · Terms of Use · Privacy Policy**. Both documents
   open when you tap them.
   - No price after a few seconds → **Couldn't load the price · Retry**. Usually something in App Store Connect
     isn't finished yet (see `docs/HANDOFF.md`).
2. Tap **Subscribe** → Apple's buy sheet (free in TestFlight) → confirm → "Welcome to Peekaboo+ ⭐". The title now
   says "You're a member ⭐", every extra has a ✓, and the button is **Manage subscription** (it opens Apple's
   subscriptions sheet).
   - Close Apple's sheet without buying → nothing happens and nothing changes.
3. **"Unlocking…":** right after buying, the server can take a few seconds to hear about it. Straight away, open
   your profile → **👀 Profile views** (and also a story's viewers list, a post's screenshots, a Guess Who hint, Drop
   rewind or Peek-a-Save). They say **"⏳ Unlocking your Peekaboo+…"** – never the buy button again. Meanwhile
   the Peekaboo+ screen may say "A few extras, like who viewed your profile, can take a few seconds to switch on."
   - Wait a few seconds, then pull down (or tap it) → the names show.
   - Still "Unlocking…" after a minute → the server never heard about the purchase. Stop and tell Claude.
4. The extras that live only in the app work at once: a Plus theme, the Heart Eyes filter, 60-second videos.

**Restore**
5. Delete Peekaboo, install it again from TestFlight and log in to the **same** test account → Settings →
   ⭐ Peekaboo+ already says **You're a member ⭐** (there is no Restore button for members), and Profile views
   shows the names again. (Restore itself can only be tried on an account that doesn't have Plus – never the
   App Review account.)
6. (If you can) on an Apple Account that never bought it → **Restore purchases** → "We didn't find a Peekaboo+
   subscription on this Apple Account."

**Delete account with Peekaboo+**
7. Logged in to the test account that has Peekaboo+: Settings → **Delete account** → the first warning also
   says "If you pay for Peekaboo+, Apple keeps billing you until you cancel it. Please cancel it first." and has
   a **Manage subscription** button (it opens Apple's subscriptions sheet). Tap **Cancel** there unless you really
   want to delete this test account.
8. With an account that has no Peekaboo+, the same warning has no billing line and no **Manage subscription**.
9. Deleting an account does **not** cancel the subscription. Cancel it in Settings → your name → Subscriptions.

## Step 65 – Guess Who in a group chat 🕵️

You need a group chat with **at least 3 people** (you + 2 test accounts or friends).

1. Open the group chat → tap the **📷** button. The camera shows a **🕵️ Guess Who** bubble next to the lenses (not in
   a "post proof" camera, and not in a group of 2). Tap it: the ring turns yellow and it says "No name on it · the
   group guesses who sent it". Holding the shutter takes a photo (no video in this mode).
2. Take a photo → the editor shows a **3:4 box** in the middle: what's inside the box is exactly what gets sent. Add
   text or a sticker if you like (drag one to the bin at the bottom of the box to remove it) → **Send Guess Who**.
   You're back in the chat with "Guess Who sent 🕵️ No name on it – let the group guess!".
3. Your own card says **🕵️ Your Guess Who**, with no counts yet. Hold it or tap **⋯** → **Delete** is there.
4. On the other phones: a push **"🕵️ Someone posted a Guess Who – who was it?"** (never a name), and in the chat a
   card **🕵️ Who sent this?** in the middle (no avatar, no name), "N people can guess", and a name button for every
   person in the group except themselves. The Chat list line says "🕵️ Guess Who – who sent it?" with no name.
5. Tap a name → "You got it! It was X 🎯" or "Nope! It was X 🙈" plus "You guessed Y", and now the counts
   "N guessed · R got it". Only that phone sees the answer. ⋯ now offers **Report** and **Block whoever posted this**
   (before guessing: only Report).
6. Post 3 Guess Whos in the same group in a day → the 4th says "You can post 3 Guess Whos in this group a day"
   (deleting one doesn't give it back).
7. After 24 hours the card is gone from the chat.

## Step 66 – Invite friends 🔗 (changed 22 Nov: just your username and the App Store link)

1. Tap any **Invite friends** button (Home, Chat, Friends, Close friends, a new group, Dare a friend) → the share
   sheet opens straight away with exactly:
   "Add me on Peekaboo 👀 My username is @yourname" and, on its own last line,
   `https://apps.apple.com/app/id6829561855`. **No** TestFlight link, **no** Android download link and **no**
   `pages.dev` link – on the TestFlight build and on the App Store app alike.
2. Send it to yourself in iMessage → the message shows your words, then an **App Store card** with the Peekaboo icon
   (it can take a second to appear).
3. Settings → **Invite friends** (or the **Invite friends** button at the top of Friends when you have friends) →
   the "Invite friends" screen: **Your username @yourname**, "Friends get the Peekaboo App Store link and your
   username…", **Invite friends** (the same share as step 1), **Got a code from a friend?** and **Turn off my old
   invite link**. Public adults see "Anyone who searches your username can add you…"; private or under-18 accounts
   see "People who search your username send you a friend request." No website link or code is shown.
4. On a second phone, search the username → **Add** works as usual.
5. **Old invite links still work** (people sent them before 22 Nov): open one → the website page → **Open in
   Peekaboo** → the invite screen with **Add**. Typing its code in **Got a code from a friend?** opens the same
   screen. **Turn off my old invite link** (asks first) → "Done ✨ Your old invite link doesn't work any more", and
   that old link now says "This invite link doesn't work any more".
6. Dare chain → **Dare someone who isn't on Peekaboo** → the message has the dare, "Get Peekaboo and add me – my username
   is @yourname" and the App Store link as the last line.

## Step 67 – Peekaboo+ face filters 🎭

Five new Peekaboo+ filters sit at the end of the camera's bubble row, after ✨ Soft Glow and 🌅 Golden Hour:
👀 Peekaboo Eyes, 🧠 Brain Buffering, 😭 Crybaby, ⚡ Aura Overload and 😘 Heart Eyes. iPhone only (App Store build 10
or a TestFlight build), after the update.

1. **With Peekaboo+:** swipe to each new bubble. The camera turns to the selfie side and the filter is drawn on your
   face straight away, and follows it when you move. Then try the expression: 👀 raise your eyebrows (the eyes pop
   bigger), 🧠 hold still, 😭 squint (more tears), ⚡ open your mouth (more lightning), 😘 blow a kiss (more hearts).
   Soft Glow and Golden Hour still look the same as before.
2. 🧠 **Brain Buffering:** hold still → the number counts up to 100 % (about 9 seconds) and the screen flashes green
   with a ✓. Move around while it's loading → it goes down again. Once it's at 100 %, shake your head → it starts
   again from 0.
3. Take a photo with each filter → the photo in the editor looks like the screen did (the tears, hearts, sparks and
   the brain's number are in the same places).
4. Two people in the picture → each face gets its own filter.
5. **Without Peekaboo+** (a test account without Plus): the five new filter bubbles have a small gold ⭐. Tap one,
   or swipe onto one → the Peekaboo+ screen opens, and when you come back the row has slid back to where you were
   (the camera stays plain). ✨ Soft Glow and 🌅 Golden Hour have no ⭐ and just work: they're free for everyone.
6. Open a chat → 📷 → the filters are in that camera's bubble row too (same ⭐ rule). Send a peek with a filter.
7. With a filter on, **hold** the shutter → it records a normal video without the filter (expected for now).
8. Plus ends while a filter is on (or log in to an account without Plus) → the filter switches off and the camera is
   plain again.
9. An older download or an Android phone → no filter bubbles at all (only Dare, Guess Who and Googly).
10. On the oldest iPhone you have: does the camera still feel smooth with each filter on? Tell us if one stutters.

## Step 68 – The 4 stretchy face filters 🫥🗿😃👾 (new TestFlight build, version 1.1)

Four new Peekaboo+ filters that stretch and squash the camera picture itself: 🫥 **Tiny Face**, 🗿 **Gigachin**,
😃 **Big Mouth** and 👾 **Pixel Panic**. They need the **new iPhone build** (TestFlight build 11, then the App Store
build 1.1) on **iOS 17 or newer**. On every older download their bubbles are simply not there. Android: not yet
(the code is in the next APK, but it stays switched off until an Android phone has passed these checks).

**A. On the new TestFlight build (do the same again on the App Store 1.1 build before it goes to Apple):**

1. The app opens normally (wait 10 seconds on the first screen, then go to the camera).
2. **With Peekaboo+**, swipe the bubble row: the 4 new bubbles sit between the other filters
   (👀 🫥 🗿 🧠 😭 😃 ⚡ 😘 👾, after ✨ Soft Glow and 🌅 Golden Hour). The row has 14 bubbles in all.
3. **Selfie camera → 😃 Big Mouth:** your mouth is big and bouncy, sits right on your mouth and follows your head the
   right way when you move left, right and tilt (not the opposite way). Open wide → it gets bigger. Then flip to the
   **back camera** and point it at someone (or a photo of a face) → it still sits on the mouth.
4. Try each one: 🫥 **Tiny Face** (a tiny face inside a soft blurred head – talk and it shrinks more), 🗿 **Gigachin**
   (a long chin – pout and the "CHIN POWER" meter climbs to "GIGACHIN" at 100 %), 👾 **Pixel Panic** (your face turns
   to big pixels with torn stripes and an ERROR tag – raise your brows for more). No black screen, no frozen picture,
   no line or edge around the stretched part.
5. The older filters still look the same as before: ✨ Soft Glow, 🌅 Golden Hour, 👀, 🧠, 😭, ⚡, 😘.
6. **Take a photo** with each of the 4 → the photo in the editor looks like the screen did, and it isn't narrower,
   wider or more zoomed in than a photo without a filter.
7. With a stretchy filter on, **hold** the shutter → a normal video without the filter (expected – videos stay plain).
8. **Chat camera:** open a chat → 📷 → the 4 new bubbles are there too. Send a peek with Big Mouth.
9. **Without Peekaboo+** (a test account without Plus): the 4 new bubbles have the small gold ⭐; tapping one opens
   the Peekaboo+ screen and the row slides back. The Peekaboo+ screen says **"9 live face filters (Big Mouth,
   Heart Eyes & more)"**.
10. **3 minutes of 🗿 Gigachin** on the selfie camera: the phone doesn't get hot and the camera doesn't stutter or
    slow down. Tell us if it does (it can be made lighter by an update, no new build needed).
11. With 😃 Big Mouth on, **double-tap to flip the camera** a few times: no flash of a frozen or back-to-front
    picture; after a moment the filter is back on the other camera.
12. **Two faces side by side** (you and a friend, cheek to cheek) with 👾 Pixel Panic, then 🗿 Gigachin: both faces get
    the filter, and there is no straight cut line through one face where the other face's filter starts.
13. **Settings** → at the very bottom it says **Peekaboo 1.1.0 (11)** (or the new build's number).

**A2. After the "upright, full screen, no flashing" update (12 Nov, TestFlight build 11, testing channel):**

Close the app fully and open it twice, so the update is in. Then:

1. **Selfie camera, each of the 4** (🫥 🗿 😃 👾): the picture is **the right way up** and **fills the whole
   screen** – no strip of plain camera on the right or at the bottom. Your face moves the same way as in the
   normal camera. 👾 Pixel Panic's blocks sit on your own face.
2. **Back camera**, the same checks, pointed at a face (a friend, or a photo of a face).
3. Swipe the bubbles from 🫥 Tiny Face to 😃 Big Mouth to 👾 Pixel Panic and back, through the other filters
   between them: **no black flash, no snapping** back and forth.
4. **One minute on 🗿 Gigachin**: no freezing, no switching back to the plain camera.
5. ✨ Soft Glow and 🌅 Golden Hour now reach the right and bottom edges too.
6. **Take a photo** with each of the 4: it matches the screen (the stretched part sits where it was).
7. **The small line at the top** (only on these testing builds, only with a stretchy filter on): send one
   screenshot with the selfie camera and one with the back camera. Expected: `… 90→270m R✓ … ok` (selfie) and
   `… 270→270 R✓ … ok` (back). Words at the end like `oob2` or `gap1` instead of `ok` are fine to send too – they
   tell us what to fix next.
8. After using a stretchy filter, pick 😘 Heart Eyes and **flip the camera** a few times: just one short flash
   each time, like before. Then pick 😃 Big Mouth on that camera: it works straight away, the right way up.
9. Swipe from the camera to Chat and back a few times with 🗿 Gigachin on: it comes back every time, no freezing.

**B. On an older iPhone build (App Store build 10, or TestFlight 7–9) after the update:**

1. The app opens normally.
2. The camera row is the same as before: no 🫥 🗿 😃 👾 bubbles. The 7 filters from Step 67 still work.
3. The Peekaboo+ screen still says "5 live face filters (Heart Eyes, Crybaby, Aura & more)".
4. **Settings** → at the very bottom it still says **Peekaboo 1.0.0** with the old build number, e.g. "1.0.0 (10)" –
   not 1.1.0. That is how you tell an old download from the new one.

If anything in A goes wrong, say which step and which camera (front or back). Most fixes can go out by update.

## Step 69 – Lives 🔴 (new TestFlight build, version 1.2)

You need **two iPhones on the new 1.2 TestFlight build** whose accounts are **friends** (both with a saved birthday),
plus, for the "old phones" checks, **TestFlight 11**, one older build on the testing channel (**TestFlight 9**) and
**Expo Go**. Lives start switched to "testers only" (you and @ayaan) – the steps to change who can go live are at the
top of `supabase/migrations/20261226000000_livestreams.sql`. Android stays off until an Android phone has passed
these checks too. If a step goes wrong, write down its number (and the G-number) – most fixes go out by update.

**First, before anything else:** on your phone, Camera → swipe the bubbles to 🔴 → tap the shutter → **Go live**.
The other phone sees you live. (This proves LiveKit, the secrets and the room all work.)

**A. Going live (phone A) and watching (phone B)**

1. Phone A: the 🔴 **Go live** bubble sits right after 🕵️ Guess Who. In 🔴 mode there's no gallery button, and the
   shutter opens the **Go live** sheet (no photo, no video). (G1)
2. The sheet says "Only your friends can watch", who gets a notification, and "We don't record or save your live –
   but friends watching could screen-record it". The first time, the **Live rules** card comes first → **I agree**.
3. **Microphone never allowed before** (or switch it off in iPhone Settings → Peekaboo first): Go live asks for it;
   tap **Don't allow** → the sheet says "Peekaboo needs your camera and microphone…" with **Open Settings**, and
   nothing starts. Allow it, come back, and tap Go live again. (G11)
4. A **3·2·1** countdown, then the **LIVE** pill and the timer. Phone B gets "🔴 … is live" (only once every 2 hours
   per friend), and a pink **LIVE** circle shows at the front of Home (Home checks every 30 seconds).
5. Phone B: tap the circle → "Starting…" with A's picture, then A's video full screen. **Phone B's silent switch
   on: you still hear A.** (G7)
6. Phone B: comment ("Add a comment…" – "Everyone watching sees your comment and name"), tap ❤️ and double-tap the
   video → hearts float up on **both** phones. (G2 – if A never sees B's hearts, tell us: hearts can be switched off
   by an update.) A bad word → "That word isn't allowed on Peekaboo." and nothing is sent.
7. Phone A: **👀 n** → the sheet lists B. Flip, mute (B hears nothing, then A again), ⋯ → **Turn comments off** → B
   sees "Comments are off".
8. **Bring on:** A → 👀 → **Bring on** B → "Bring … on?" → **Ask them**. B gets "🎥 … wants you on their live" with a
   60-second bar → **Join live** → (camera/mic allowed) → a split screen, A on top, B below, on **both** phones.
   **A hears B and B hears A.** (G7) B → **Leave stage** → back to watching. Ask again and let it run out → A sees
   "… didn't answer". B taps **Not now** → A sees "… said not now", and asking a third time says "You can't ask …
   again this live".
9. **Camera hand-off:** before going live, pick ✨ Soft Glow (or a face filter), then go to 🔴 and go live → the live
   camera works (no black screen). After the live, the filter camera works again. Same for B coming on stage. (G6)
10. **End:** A → ✕ → **End** → "That's a wrap 🎬" with minutes, friends, ❤️ and 💬 → **Done** → back to the camera.
    B sees "…'s live has ended" (never why) with **Say something nice 💬**, **Report** and **Block**.
11. **After a live:** play a story video with sound and record a voice note – sound works as before. Open an invite
    link – it still works. (G3, G7)

**B. When things go wrong (each on its own short live)**

1. A puts Peekaboo in the background for **10 seconds** → B sees A paused; A comes back → video, sound and A's own
   mute choice are back. For **more than 90 seconds** → the live ends ("Your connection dropped."). (G8)
2. A takes (or declines) a **phone call** mid-live → afterwards the sound and the mic work again. (G8)
3. **Airplane mode for 5 seconds at about minute 2**, then a **10-second app switch at about minute 2** – on A, then
   on B. Each time the live carries on (B may see "Reconnecting…" briefly). (G8)
4. A **removes** B (👀 → ⋯ → Remove from my live) → B sees "You were removed from this live." and can't get back in
   for that live. (G4)
5. A brings on a friend who is **not friends with B** → B goes to "Hang on a moment" **before** the new person's
   video appears, and comes back by itself when they leave the stage. (G4, G12)
6. **Unfriend or block mid-live** → the other person is out within a few seconds.
7. Two reports of the live (from two accounts) → the live ends ("Your live was ended for a safety check.").
8. Nobody joins for 5 minutes → "Nobody joined, so we ended your live." (lead: set `empty_minutes` lower to test).
   Time limit: set `max_minutes = 3` for a test → "That's 3 minutes!". (G8)
9. **A notification tapped mid-live** (a message, or the drop alert): A is asked "End your live to open this?" →
   **Stay** keeps the live going. No banners pop up over A's live.
10. **An app update waiting:** open the app **from a "… is live" notification** while an update is waiting → the
    live is never restarted; the update happens after **Done**. (G8)
11. **Home during the 3·2·1:** A taps Go live and presses Home before the countdown ends → no friend gets the "… is
    live" notification while A is away; A comes back → the live starts, with sound and camera. (G8)
12. **Watching, then a chat on top:** B taps a message notification while watching → the chat opens (no live
    banner blocks it); B goes back to the live → it rejoins by itself.
13. **On stage, then leaving:** B (on stage) taps ✕ → back on Home the camera works at once (not black or frozen).

**C. Old phones and other builds**

1. **TestFlight 11, TestFlight 9 and Expo Go** (after the update reaches them): no 🔴 bubble, no live circles on
   Home, no "Friends going live" switch in Settings, **no Terms screen**, and no "… is live" notification when a
   friend goes live. (G1)
2. **A 1.2 phone that never goes live:** opening the app is as fast as on build 12; a story video with sound, a voice
   note, the silent switch and AirPods all behave as before. (G7b)
3. **Settings** on the 1.2 build: Notifications has **Friends going live 🔴**; switch it off → no more live
   notifications for that phone. At the bottom: **Peekaboo 1.2.0** with the new build number.

**D. Checks for the developer (alongside A–C):** G5 (taking a co-host off really stops their camera), G9 (LiveKit's
participant list shows a hidden viewer) and G10 (after a live ends, an old host ticket can't rebuild the room – or the
one-minute check removes it again). G13 (review round 3): while a friend is on stage, a viewer who should wait and
reconnects with an old ticket (airplane mode for 20 s, then back) sees only the host, never the person on stage –
LiveKit refuses them the stage's camera (subscription permissions from `live_stage_allowlist`); a friend of both who
joins mid-stage sees the person on stage within about 5 seconds. Plan B for each gate is in the design.

## Step 70 – Snaps in group chats, photos from your camera roll, deleting a group 👀🗑️ (21 Nov)

Needs the database update `20261229000000_group_snaps.sql` first (the developer does this), then the app update.
You need 3 phones or test accounts in one group: **A** (you, who made the group), **B** and **C**.

**A. Snaps in a group chat**
1. A: open the group chat → 📷 → **take** a photo → the button says **Send snap** → tap it → "Snap sent 👀".
   In the chat A sees **"You sent a snap · ✓ Delivered"** – not the photo. B and C get "👯 Squad · A: 📸 Sent a snap".
2. B: the chat shows a pink **"New snap · tap to view"** pill (no photo in the chat). Tap it → the photo shows for
   10 seconds (a video plays to its end), then closes. The pill now says **"Tap to replay"** → tap → it shows once
   more → now **"Snap opened"** and can't be tapped.
3. A (within 15 seconds): under the snap **"👁 Opened by B"**; once C opens it too: **"👁 Opened by everyone"**.
   Before anyone taps it, it says only "✓ Delivered" – never "Seen by" as well, even after B and C opened the chat.
   **Screenshot:** B opens a new snap and takes a screenshot while it's on screen → B sees "📸 They'll see you took
   a screenshot"; A gets "👯 Squad · B: 📸 Took a screenshot of your snap" and the line under the snap adds
   "📸 Screenshot by B". A second screenshot of the same snap sends nothing more. A saved snap sends no notice
   (it's a normal photo). (On Android 13 and older, screenshots can't be noticed – same as one-on-one peeks.)
4. **Save in chat:** C opens a new snap, then holds it in the chat → **Save in chat 📌** (or taps **Save** while
   it's open) → "Saved in chat 📌 Everyone in the group can open it again". Now everyone sees it **as a normal photo**
   in the chat with "📌 Saved by C", and can open it full screen any time. C (or A, who sent it) can hold it →
   **Unsave** → it's a snap again (gone if it's over a day old).
5. Someone who hasn't opened a snap can't save it (no Save in chat when you hold a new one).
6. **A day later** a snap nobody saved says "Snap expired" (and "Expired · opened by …" for A).
7. **Someone added later:** add D to the group → D sees older snaps as "Sent before you joined" and can't open them.
8. **Report:** B opens a snap → ••• → **Report snap** → the snap is hidden while you report.
   **Bad signal:** B turns on airplane mode and taps a new snap → "Couldn't load the snap … tap it again in the next
   few minutes – that still counts as your first look". Back in the chat the pill says **"Tap to view"**. Airplane
   mode off, tap it within 4 minutes → it shows, and afterwards the pill says "Tap to replay" (the replay is still
   there). Wait longer than 4 minutes (or close the app) instead → the pill says "Tap to replay" and a tap uses the
   replay.
9. **Picked from Photos:** 📷 → gallery button → pick a photo → **Send to group** → it's a normal photo that stays.
10. **Still the same:** a group dare proof (**Do it · post proof**), a group 🕵️ Guess Who and the Public chat send
    exactly as before (never as a snap).
11. **An old app version** (a phone that hasn't updated yet) in the group: a snap shows as an empty grey box –
    never the photo. A saved snap shows as a normal photo there too. Also when one person is signed in on two
    devices: B opens a snap on the updated phone while an iPad (or second phone) with an older app is signed in to
    the same account and open in the group chat → the iPad still shows only the grey box (opening it only lets the
    phone that opened it download it). Known limit: if a snap is saved and later unsaved, a device that already
    showed it as a photo (an old app) can keep showing it for up to an hour, because a download link lasts an hour.

**B. Photos from your camera roll in a one-on-one chat**
1. A → a chat with B → 📷 → **take** a photo → **Send** → "Peek sent 👀" (a normal peek, as before).
2. A → 📷 → gallery button → pick a photo → **Send** → "Photo sent 📷". B's Chat list says **New Photo**; in the
   chat **"New photo · tap to view"** → it opens with no timer, label "Photo 📷", no Save/Unsave button, and ••• says
   **Report photo** (never "peek"). Afterwards it says "Photo · tap to view" and opens any time. B gets "Sent you a
   photo 📷".
3. An old app version shows it as "New peek · tap to view" → it opens and stays (a saved peek).

**C. Delete or leave a group**
1. A (who made it): group chat → ••• → at the bottom **🚪 Leave group** and **🗑️ Delete group**. Delete → the
   message says it deletes the group and its chat for everyone and can't be undone → **Delete group** → "Group
   deleted 🗑️" and you're on the **Chat list**. B and C: the group is gone from their Chat list.
2. B (didn't make it): ••• → only **🚪 Leave group** → **Leave** → "You left Squad" → Chat list.
3. Make a group with B, then B leaves: A is the **only one left** → ••• shows only **🗑️ Delete group** (the message
   says you're the only one left). The same works for someone who didn't make the group.
4. Make a group with B only, then add C later from the group page (✏️ Change name & people). Now A (the maker)
   leaves → B, who has been in it longest, now has **🗑️ Delete group** (and C only **🚪 Leave group**). (If B and C
   were both picked when the group was made, they joined at the same moment: then one of them gets Delete group –
   always the same one on every phone, and it's the one the server lets delete it.)
5. The last person in a group only sees **🗑️ Delete group** (see 3) – nobody is left to leave it to. (Only if two
   people leave at the very same moment does the second one's **Leave** delete the group: "nobody was left, so it's
   deleted".)
6. The same options are on the group page (tap the group's name → •••).
7. A deleted group's picture disappears within a day (the daily cleanup deletes it). Nothing to check on the phone:
   groups that everybody had left before this update (an old app's "Leave group" left them behind empty) are
   deleted when the database update runs, and their files go to the daily cleanup.

**D. Make a group → its chat opens** (see Step 23): Chat → ＋ New → pick friends → **Make group** → the new group chat
opens; Back goes to the Chat list.

**E. Uploads try again by themselves:** send several photos in a row in a group chat (also on bad signal, e.g.
walking out of Wi-Fi). A one-off hiccup no longer shows "server error": the app quietly tries again (up to 2 more
times) and the photo is sent **once**.


## Step 71 – Main Character Mode 🌆 (your face in a comic poster)

TestFlight **build 13** on the `testing` channel first, then the App Store app (on for everyone since 22 Nov). Also have an older
download handy for step 18 (Android or Expo Go). Write down the number of any step that goes wrong – most fixes go
out by update. What the mode is and how to add new characters: `docs/MAIN_CHARACTER.md`.

1. Home camera → swipe the mode row to 🌆 (right after 🤪 Googly) → the row **stays** there, the shutter ring turns
   orange and a card says "🌆 Main Character · your face in a comic poster · Tap to start". **No page opens.** Swipe
   between Chat / Camera / Home and back → still no page opens. Tap the card (or the shutter, or 🌆) → the Main
   Character screen fades in on the selfie camera. Holding the shutter on the home camera opens it too (no video
   starts). ✕ goes back. (The first time, the camera permission question may show: "Allow camera".)
2. Your face is in **Street Boss**'s face, in comic colours, and follows you when you move, turn and tilt your head.
   Talk and open your mouth wide → the face does **not** pump or squash. No room behind you shows round your face.
   Nothing is upside down or mirrored the wrong way. The small Peekaboo logo is top left.
3. Opening the screen starts the camera **once** (no second black flash a moment later).
4. Swipe left and right → each of the 6 characters (Street Boss, Getaway Driver, Beach Hustler, Night Rider, Rich
   Mogul, Mall Cop), the name pops up big; each one jumps to its own scene. Tap 🌴 → the scene changes (its name
   pops up under 🌴), the character stays; swipe again → the scene you picked stays. Swiping fast doesn't stutter.
   The first 3 visits show "Swipe ← → for a new character · 🌴 for a new scene". Close and reopen the screen → it
   starts on the character and scene you used last; if you had picked a scene with 🌴, your first swipe goes back
   to each character's own scene. With VoiceOver on (Settings → Accessibility): the screen reads "Character,
   Street Boss"; swipe up or down with one finger → the next or previous character, and its name is read out.
5. Flip → back camera on a friend's face → their face goes in.
6. Cover the camera or turn away → after a couple of seconds "Point the camera at a face 👀" and the face hole is
   skin coloured. Tap the shutter then → "We can't see a face – look at the camera 👀". Turn your head away **just
   as** you tap the shutter (try it on LITE too, step 11) → the same "We can't see a face" message, never "Couldn't
   make your poster". Two people → the bigger face is used.
7. Tap the shutter and **swipe straight away** → nothing changes; a white flash, then the **MISSION PASSED /
   +RESPECT** banner (pink-purple tilted band, blocky letters, a happy buzz) pops over the still-moving poster,
   then the finished poster. It looks like the screen did at the press (same face position, same character, same
   scene) and the face is sharp, not blurry. 🌴 and flip do nothing while it is being made. On the finished poster
   the ✕ (top left) sits above the poster, not on its corner.
8. **Share** → the iPhone share sheet: write down which of Instagram, TikTok and Snapchat show up and where each
   puts the picture. The shared picture has the small Peekaboo logo top left.
9. **Save** → "Saved to Photos ✅" → in Photos, with the logo. **My story** → *Send to…* with My Story ticked → post
   → you're back on Home, and your story has **no** logo. Posting and sending both go back to Home, so open the mode
   again and take a new poster for each of the next two: **Send** → *Send to…* with My Story **not** ticked → pick a
   friend → they get it as a peek, **no** logo. **Take another** → back to the live poster.
10. Hold the shutter on the Main Character screen → "Main Character videos are coming soon 🎬".
11. Tap the **FULL/LITE** pill (top right, testing channel only) → **LITE**: your real camera face shows through
    the hole, moving with you (no comic look live); move fast → it may lag a little but never jumps off screen;
    take a poster → it still has the comic look. This is what App Store build 10 shows. Tap it again → FULL.
12. **After step 11 (or any camera hiccup), go back to the home camera → the 4 stretchy Plus filters (🫥 🗿 😃 👾)
    are still there**, also after closing and reopening the app twice.
13. Editor → **Keep** a photo → the copy in Photos has the logo, the one in Keeps doesn't. Keeps → open it → Save to
    Photos → the logo is on that copy too. (Videos still go without the logo for now.) Colours: take a very
    colourful photo (bright pink or orange, or a bright sticker on it), Keep it, then put the copy in Photos next to
    the same photo inside the app → the colours look the same, not duller or more washed out (on the iPhone).
14. Plane mode → open the mode → the 6 characters still work. Back online: once the database update
    `20261231000000_main_character.sql` is done, upload a test character made with the `online` step (both files,
    `docs/MAIN_CHARACTER.md`) → close the app fully (swipe it away) and open it again, open the mode and wait a few
    seconds → the poster doesn't change by itself; swipe right from Street Boss → the new character is there, named
    from its file name, with the face in the right place, and the live face doesn't stall while it arrives. Also
    upload a scene with the **same name** into `backgrounds` → close and reopen the app, open the mode, tap 🌴 until
    its name pops up → the new scene shows behind the character (never a copy of the character itself).
15. Use it for 3 minutes → does the phone get hot, or the picture stutter or shimmer (flickering bands or lines on
    the face)? Try the oldest iPhone you have.
16. Friends with very light and very dark skin try it → does the face blend in and **still look like them** (skin
    not turned orange)?
17. While on the Main Character screen, start a live from another phone's invite (if lives are on for you) → the
    screen says "Your camera is busy with a live 🔴" and the camera hands over without an error; afterwards the
    poster comes back. Point the camera away from faces as the live ends → "Point the camera at a face 👀" shows,
    and the shutter says "We can't see a face" (no flash or banner) until it sees you again.
18. Android, Expo Go: no 🌆 bubble on the home camera. (After it is switched on for everyone: the App Store app,
    build 10, shows the bubble and the LITE look of step 11.)

## Step 72 – Messages and stickers in the public chat 💬 (22 Nov)

Needs the database update `20270102000000_public_chat_text.sql` first, then the update on the `testing` channel
(TestFlight). Use two adult accounts (A and B, birthdays 18+), one under-18 account (C), and if you can, a phone that
hasn't updated yet (D, 18+). Write down the number of any step that goes wrong.

1. A: Chat → **Public chat · 18+** → at the bottom there is a message box ("Say something to everyone"), a 📷 on the
   left and a 😊 sticker button inside the box. The line at the top says "Be kind · no links or phone numbers". The
   newest things are at the bottom, next to the box, like a normal chat.
2. A types "hi everyone 👋" → the ↑ button turns blue → tap it → the message shows at the bottom straight away and
   the box empties. B (in the room) sees it within a couple of seconds, with A's name and picture. The keyboard
   never covers the box (iPhone and Android).
3. A sends another message straight away → "Message not sent – Slow mode is on – one message every 5 seconds 🐢",
   and the words stay in the box. Wait 5 seconds → it sends.
4. A tries each of these → each one says why and nothing is sent: `example.com` and `see you at site dot com`
   ("Links aren't allowed in the public chat."), `www.example`, `name@gmail.com`, `555 123 4567` ("Phone numbers
   aren't allowed in the public chat."), a slur ("That word isn't allowed on Peekaboo."). Swearing like "this is
   so fucking good" **is** allowed. Typing more than 300 characters stops at 300 ("0 left" shows under the box).
5. 😊 → the sticker sheet (the same as in chats) → tap 👀 Googly eyes → it shows big in the room, no bubble. Tap a
   word sticker (LOL) → it shows as the pink word. Tap an emoji → it goes as a normal message. Without Peekaboo+,
   a ⭐ Peekaboo+ sticker opens the Peekaboo+ screen and nothing is sent; with Peekaboo+ it sends.
6. B holds A's message → "@A" with **Report message** and **See profile** → Report message → pick a reason →
   "Thanks for telling us 💛 … Do you also want to block them?" → **Not now**. The owner's phone gets "🚩 New
   report – Someone reported a public_message for …". In Supabase → Table Editor → `reports`, the newest row's
   `details` starts with `Message: "` and A's words.
7. A deletes that message (hold it → **Delete**) → it's gone for A and B. The report in Supabase still has the words.
8. A sends a new message. B and two more adults on the new app (3 different people) each report that same
   message → it disappears for everyone except A; A sees "🙈 Hidden: several people reported this message. Only you
   can see it." (Others see the change the next time the room reloads.) B reporting it a second time does nothing:
   no second "🚩 New report" on the owner's phone.
9. B blocks A (from the report question, or A's profile) → A's messages and photos leave B's room, and B's leave A's.
10. 📷 in the message box → the camera → take a photo → **Post in public chat** → it shows in the room as a big
    photo card, with ⋯ → Report photo / Delete like before. Photo slow mode is still 30 seconds; a photo right
    after a message is fine.
11. C (under 18) has no Public chat row and can't get in. An account with no birthday sees "Add your birthday to join".
12. D (an older app): the public chat shows only the photos, exactly as before – no empty grey boxes for messages.
13. Plane mode on → send → "Message not sent – Can't reach the internet…" and the words stay. Plane mode off → send.
14. Plane mode on → leave the room and open it again → "Couldn't load the room" with **Try again** (not the old
    photos-only room). Plane mode off → **Try again** → the room with the message box is back.
15. A sends a message and deletes it straight away, then sends another at once → "Slow mode is on…" (deleting
    doesn't start the 5 seconds again). Then type a message, tap ↑ and keep typing while it sends → the new words
    stay in the box.
16. A sets their name (Edit profile) to `see site.com` → in the public chat, ↑, 😊 and 📷 each say "Change your name
    first – Your name or username looks like a link or a phone number…" and nothing is sent. Change the name back →
    sending works again.
17. Messages that look empty or odd: a message of only spaces can't be sent (↑ stays grey). Paste a word with lots
    of accent marks piled on one letter (like "z̷̢̛͖̈́a̵l̶g̴o̷") → "Too many accent marks on one letter."

## Step 73 – Instant sends 📤 (Send to…, chat cameras, texts, the drop)

Everything you send now goes out in the background: the screen closes (or the message shows) at once, with
"Sending…", and a small pill at the top says how it's going. Use two phones (yours and a test friend's) on the
`testing` update. On an iPhone, **Settings → Developer → Network Link Conditioner** can make the internet bad
on purpose (turn it on with "Very Bad Network", later "100% Loss"; turn it off at the end).

1. Normal internet. Chat with a friend → camera → take a photo → **Send** → you're back in the chat straight away
   with a faded "👀 Sending peek…" bubble, which becomes "You sent a peek · Delivered" a moment later. Your friend
   gets exactly one peek.
2. Type a text and tap Send twice quickly → the box empties at once, one faded "Sending…" bubble, then one message.
   Send 3 texts quickly → they arrive in the same order. Send a sticker and a voice note → each shows at once.
3. Hold a message → react 🔥 → it shows at once.
4. Camera → photo → Send to… → tick a friend and **My Story** → Send → the screen closes at once; the pill says
   "Sending…"; then a toast "Shared to … 🎉". The friend gets one peek, your story ring updates.
5. **The drop** (in the 2 minutes): drop camera → photo → Send to… → no "Before your first dare" sheet if you agreed
   before → Send → Home at once with "📤 Posting your drop…" at the top → then "Drop posted · On time! 👀🔥" and
   your friends' drops unlock.
6. Dare: do the Daily Dare → Send → you land on the Dare page and "Dare your friends" opens → pick a friend → "Dare
   1 friend" (it may say "Posting your dare…" for a moment) → the friend is dared.
7. **Very Bad Network**: repeat 1, 4 and 5 → each screen still closes at once and shows "Sending…"; it either gets
   through or says "Couldn't send · tap to try again" (outside the chat: a short red "⚠️ Not sent · tap" pill just
   under the top bar).
8. **100% Loss**: send a peek → it keeps saying "Sending…" while it tries (with no internet at all that can take a
   few minutes: each try waits up to a minute), then the bubble says "Couldn't send · tap to try again". Turn the
   internet back on → tap the bubble → **Try again** → exactly ONE peek arrives on the friend's phone (never two).
9. 100% Loss → send a text → close the app fully (swipe it away) while it says "Sending…" → internet on → open the
   app → the chat shows it as "Not sent – tap to try again" (it's never sent by itself later) → tap → Try again →
   one message arrives. Or Delete → it's gone.
10. Send to… → Edit → back to the editor → change something → Send to… → Send → the friend gets the final picture
    (with your change).
11. Go back from Send to… without sending (on a test account), wait 15 minutes, close and reopen the app → after the
    next daily clean-up, Supabase → Storage → media → your folder has no extra file left from that photo.
12. Edit profile → pick a new picture → Save → it saves quickly and the new picture shows everywhere.

## Step 74 – Faster loading ⚡ (Home, chats, peeks, the drop camera, Send to…)

Use the `testing` update, two phones, and a weak signal for the last checks (Network Link Conditioner → "Very Bad
Network", as in Step 73).

1. Close the app fully and open it → Home's posts show first; the story circles, the Guess Who number and the red
   number on the Chat tab can come a second or two later. Pull down on Home → it refreshes as before.
2. Scroll Home to the bottom → more posts load ("You're all caught up 🌱" at the very end). Like a post → the heart
   fills at once and stays filled after a pull-down.
3. Open a chat, go back, open it again → the messages are there at once (no spinner), and a new message from your
   friend still pops in.
4. While a chat with Friend A is open, have Friend B send you a message → Friend A's chat stays still (no flicker);
   the Chat list still shows Friend B's message.
5. Delete a message "for me" → it's gone; close and reopen the chat → still gone. Clear a chat from the Chat list →
   open it → empty.
6. Tap a new peek → it opens quickly; tap a video peek → it plays with its text and stickers.
7. **The drop**: during the 2 minutes, swipe to the camera → it's in drop mode at once (countdown at the top). Post
   your drop → Home → your friends' drops unlock straight away (with "🔓 All drops unlocked!").
8. Open the app from the drop notification → the drop camera opens → take the photo → Send to… → Send → On time.
9. Camera → photo → Send to… → your friends' names are there at once (no empty list first).
10. On "Very Bad Network": repeat 1, 3 and 7 → everything still works, just slower; nothing gets stuck.

## Step 75 – Sends on a bad signal, after leaving the app, and after logging out 📤 (review fixes, 23 Nov)

Use the `testing` update and two phones (yours and a test friend's). As in Step 73, **Settings → Developer → Network
Link Conditioner** makes the internet bad on purpose ("Very Bad Network" is about 1 bar; "100% Loss" is no internet).
Airplane mode works too. Turn both off at the end.

1. **Chat camera on 1 bar**: Very Bad Network → open the chat with your friend → camera → photo → **Send** → you're
   back in the chat at once with "👀 Sending peek…". Wait → it becomes your sent peek. Your friend gets exactly one.
2. **Chat camera with no internet, then back on**: airplane mode on → chat → camera → photo → Send → "Sending…"
   while it tries (about 15 seconds) → "Couldn't send · tap to try again". Within 10 minutes, turn airplane mode
   off from Control Center → back in the app it goes by itself (or tap it → Try again). Your friend gets exactly
   ONE peek.
3. **Retry never sends twice**: Very Bad Network → send a peek and 2 texts → if any says "Couldn't send · tap to try
   again", turn the bad network off → tap it → **Try again** → on your friend's phone every peek and text is there
   exactly once (never twice), and the texts are in the order you sent them.
4. **Send to… while the drop's 2 minutes run out**: open the drop alert → take the photo with about 20 seconds left
   → on Send to… untick "Today's drop" if it's ticked, tick a friend → wait until the 2 minutes are over → tap Send
   → Send to… closes at once (no spinning button) and the friend gets the peek once. Do it again with "Today's drop"
   ticked and Very Bad Network on → Send → Home at once with "📤 Posting your drop…" → "Drop posted · …" (Late is
   fine here). Your profile shows ONE drop.
5. **The photo uploads while you pick**: drop camera → photo → on Send to… stay 20 seconds (type a caption) with
   airplane mode on, then turn it off and wait 10 seconds → Send → the drop posts within a second or two.
6. **Locking the phone mid-send**: 100% Loss → send a peek → lock the phone at once → wait 15 minutes → turn the
   bad network off → unlock and open Peekaboo → the peek says "Not sent – tap to try again" (it is NOT sent by
   itself after so long) → tap → Try again → one peek arrives. Then: the same, but turn the bad network off and
   come back after 1 minute → it simply carries on and arrives by itself (it can take up to a minute).
7. **The pill**: 100% Loss → send a peek from Send to… → go to the Home camera → the "📤 Sending…" pill sits just
   under your picture and the flip / flash buttons; tap flip → the camera flips (the pill never takes the tap). When
   it fails it says "⚠️ Not sent · tap" → tap it → Try again / Delete.
8. **Send to… with one part refused**: tick My Story and a friend who has blocked the test account (or who isn't
   a friend any more) → Send → one toast says the peek couldn't be sent, and another says "Shared to your story! 🎉".
9. **Dare your friends, then leave**: Very Bad Network → do the Daily Dare → Send → on "Dare your friends" pick a
   friend → "Dare 1 friend" → while it says "Posting your dare…", tap back → open a chat → nothing closes by
   itself, no message pops up, and the friend is NOT dared.
10. **Profile picture in a dead spot**: airplane mode on → Edit profile → pick a new picture → wait 10 seconds →
    airplane mode off → Save → it saves (no "Can't reach the internet"), and the new picture shows everywhere.
11. **Log out deletes unsent sends**: 100% Loss → send a text → Settings → Log out → turn the bad network off → log
    back in → the text is gone (no "Not sent") and was never sent.
12. **First drop ever on this phone**: on a test account that never agreed to the dare rules, tick "Today's drop"
    and My Story → Send → "I understand" → the rules sheet slides away, then the story preview opens by itself
    (no second tap needed) → Share → Home.
