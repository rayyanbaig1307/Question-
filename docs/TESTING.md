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

1. You land on the **Welcome** screen with the bouncing ghost 👻.
2. Tap **Create account**.
   - Type a username with capitals or spaces – they're removed automatically.
   - After a second it says **"✅ @yourname is free!"**.
   - Tap **Let's go!** without ticking "I'm 13 or older" → you get a friendly error.
3. Fill everything in and tap **Let's go!** → you see **"You're in! 🎉 Logged in as @yourname"**.
   - If it says **"Check your email"** instead, "Confirm email" is still on in Supabase. Either tap the link in the
     email (the page it opens may look broken – that's OK, the account is confirmed) and log in, or turn the setting
     off (README step 3).
4. **Close the app completely and open it again** → you're still logged in.
5. Tap **Log out** → back to Welcome.
6. Tap **I already have an account**:
   - Wrong password → "That email or password doesn't look right."
   - Right password → you're back in.
7. Try signing up again with the **same username** → it says it's taken.
8. In Supabase → **Table Editor → profiles**, you'll see a row for each account you made.

## Step 3 – Profiles

For now you reach your profile from the **My profile** button (once the camera is built it's the round
picture in the top-left corner).

1. Tap **My profile**. You see your picture (a colorful letter for now), name, @username, **0 Posts · 0 Friends**,
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
   - **Blocked accounts** → "Nobody blocked" (you'll block people once friends search exists).
   - **Log out** asks first, then logs you out.
6. In Supabase → **Storage → avatars**, you'll see your picture in a folder named after your user id.

The photo grid, full-screen photo viewer, and deleting a post are tested in step 4 (once you can post).
**Report** and **Block** live in the **•••** menu on other people's profiles – you'll be able to reach those
in step 5 (friends search).
