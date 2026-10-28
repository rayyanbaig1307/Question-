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
   (There's no download link in it yet: the Expo Go test version only opens for the app's owner. When Peekaboo is on
   TestFlight / the App Store, put the link in `src/lib/invite.ts` and every invite will include it.)
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
