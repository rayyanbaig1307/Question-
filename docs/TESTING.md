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
