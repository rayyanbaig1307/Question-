# Peekaboo 👀

A fun photo app for friends – Snapchat's camera-first vibe plus Instagram-style profiles.
Built with **Expo** (React Native + TypeScript) and **Supabase**.

* 📖 **The plan, in simple words:** [docs/PLAN.md](docs/PLAN.md)
* 🧪 **How to test each feature on your phone:** [docs/TESTING.md](docs/TESTING.md)

---

## One-time setup (about 15 minutes)

### 1. Install these

* **On your computer:** [Node.js](https://nodejs.org) (the "LTS" version) and [Git](https://git-scm.com).
* **On your phone:** the **Expo Go** app (App Store / Google Play).

### 2. Get the code

Open a terminal (Mac: "Terminal", Windows: "PowerShell") and run:

```bash
git clone https://github.com/rayyanbaig1307/Question-.git
cd Question-
git checkout claude/mobile-social-app-expo-h090jm
npm install
```

### 3. Set up Supabase (the back end)

> Skip the parts that are already done for you – the setup message from Claude says which.

1. Go to [supabase.com](https://supabase.com), log in and **create a new project**.
2. In your project, open **SQL Editor** → **New query**.
   Copy *everything* from `supabase/migrations/20261027000000_core_schema.sql`, paste it in, and press **Run**.
   This creates all the tables, privacy rules and photo storage.
3. **Make testing easy:** go to **Authentication → Sign In / Providers → Email** and turn **off** "Confirm email".
   (Otherwise every new test account has to click a link in an email first. Turn it back on before launching.)

### 4. Tell the app which Supabase project to use

1. In Supabase, click **Connect** (top of the page) or go to **Project Settings → API Keys**.
2. Copy the **Project URL** and the **publishable key** (starts with `sb_publishable_`).
3. In the project folder, copy the file `.env.example` and name the copy `.env`. Paste the two values in.

### 5. Run it on your phone

```bash
npx expo start
```

A QR code appears in the terminal.

* **iPhone:** open the normal Camera app and point it at the QR code.
* **Android:** open Expo Go and tap **Scan QR code**.

Your phone and computer must be on the **same Wi-Fi**. If it won't connect, stop it (Ctrl + C) and run
`npx expo start --tunnel` instead.

**Changed the `.env` file?** Stop the app and run `npx expo start --clear`.

---

## Where things are

```
src/
  app/          ← every screen (each file is one screen)
  components/   ← reusable pieces (buttons, avatars, the photo editor…)
  lib/          ← talking to Supabase (login, photos, posts, safety)
  theme.ts      ← all colors and sizes
supabase/
  migrations/   ← the database setup (tables + privacy rules)
docs/           ← the plan and testing guides
```

## Reviewing reports

When someone taps **Report**, a row appears in the `reports` table.
In Supabase open **Table Editor → reports** to read them. Change `status` to `reviewed` or `dismissed` when you're done.

## Handy commands

| Command | What it does |
| --- | --- |
| `npx expo start` | Run the app (scan the QR code with your phone) |
| `npm run typecheck` | Check the code for mistakes |
| `npm run lint` | Check the code style |
