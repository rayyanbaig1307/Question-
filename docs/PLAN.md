# The plan (in simple words)

## What we're building

**Peekaboo** 👀 – a fun photo app for friends. It opens straight to the camera,
and every person has a profile with a photo grid.
("Peekaboo" is just a placeholder name – change `name` in `app.json` whenever you like.)

## The two halves

| Part | What it is | What it does |
| --- | --- | --- |
| **The app** | Built with **Expo** (React Native) in TypeScript | Everything you see and tap on your phone. One codebase works on iPhone and Android. |
| **The back end** | **Supabase** | Remembers everything: accounts, profiles, photos, messages. |

Supabase gives us four things:

1. **Login** – sign up and log in with email + password.
2. **Database** – tables (like spreadsheets) that hold profiles, posts, messages…
3. **Storage** – a place to keep the actual photo files.
4. **Realtime** – instant updates, so chat messages pop in without refreshing.

## The tables (our "spreadsheets")

| Table | What one row means |
| --- | --- |
| `profiles` | One person: username, display name, bio, profile picture, private account on/off, location sharing on/off |
| `friendships` | A friend request, or a friendship once it's accepted |
| `blocks` | "Person A blocked person B" |
| `reports` | Someone reported a person, post, story, message or comment |
| `posts` | A permanent photo on someone's profile (with caption) |
| `likes` / `comments` | Likes and comments on posts |
| `stories` | A photo that disappears after 24 hours |
| `story_views` | "This friend saw this story" |
| `messages` | A chat message or a peek (a photo that disappears once opened) |
| `locations` | Where someone is on the friend map – only while they share it |

Photos live in two storage "buckets":

* `avatars` – profile pictures (anyone logged in can see them)
* `media` – posts, stories and peeks (**private** – the app gets a short-lived link only if you're allowed to see the photo)

## Safety is built into the database

The rules live in the database itself (called "Row Level Security"), so even a hacked app can't break them:

* Private account → only friends see your posts.
* Stories → friends only, gone after 24 hours.
* Peeks → only the person you sent it to, and only until they open it.
* Chat → you can only message friends.
* Friend map → **off by default**. Only friends can see you, only while sharing is on.
  Hiding again deletes your spot from the map instantly.
* Blocking → removes the friendship; they can't see your profile, posts, stories or message you.
* Reports → saved in the `reports` table for you to review in the Supabase dashboard.

All of this is in `supabase/migrations/20261027000000_core_schema.sql` (later additions, like the Daily Dare,
are in their own dated files next to it).

## Build order

Core features, one at a time (✅ = done):

1. ✅ Project setup + database
2. ✅ Sign up / log in
3. ✅ Profiles (picture, name, username, bio, photo grid, full-screen photos, private account, block & report)
4. ✅ Camera + posting (take a photo, add text and stickers, post to your story or profile)
5. ✅ Friends (search by username, send / accept requests)
6. ✅ Chat + peeks (1-on-1, live)
7. ✅ Stories (tap through friends' stories)
8. ✅ Feed (friends' posts, likes, comments)
9. ✅ Friend map (share location, hide me)

10. ✅ Polish: in-app top bars, square grid, change photo, fun empty screens, invite friends, animations, vibrations

Then the viral features, in this order, only after the core works:

11. ✅ Daily dare (60 dares, one per day, same for everyone – `src/lib/dares.ts`,
    database change in `supabase/migrations/20261028000000_daily_dare.sql`)
12. Invite to unlock
13. Roast my profile
14. Fit check
15. Face swap stories
16. Mystery match

Extra: ✅ Discover tab – endless full-screen scroll of public posts (like Spotlight).

## How the screens fit together

```
            ┌──────────┬──────────┬──────────┬──────────┐
  swipe ←→  │   Chat   │  Camera  │ Stories  │ Discover │
            │          │ (start)  │  & Feed  │ (scroll) │
            └──────────┴──────────┴──────────┴──────────┘
              Tab bar at the bottom: 💬 Chat · 📷 Camera · ✨ Stories · 🔥 Discover
              Profile button at the top of the camera → your profile
```
