# Main Character Mode 🌆

Your face in a comic poster. You pick a character (a painted person standing in front of a scene), your face goes
into the character's face, and it follows you live. Tap the shutter, a banner pops up, and you get a finished
poster you can share, save, post to your story or send to a friend.

Status (22 Nov 2026): **you approved all 12 pictures, and Phase 1 is going out by app update to the `testing`
channel only** (your TestFlight build 13). You check it with `docs/TESTING.md` Step 71. The developer notes are in `docs/FACE_MESH.md`, "Main Character Mode".

## Who sees it

- **iPhone app downloads with face tracking only** (App Store build 10 and newer, TestFlight 7 and newer). Not on
  Android, in Expo Go or on the website: there is no 🌆 bubble there, and the page says "Main Character Mode needs
  the newest Peekaboo app on an iPhone."
- **For now only on the `testing` channel** (your TestFlight build 13), like lives. The switch
  `MAIN_CHARACTER_FOR_EVERYONE` in `src/lib/mainCharacter/config.ts` stays `false` until all of these are true:
  App Store 1.1 is approved and released, you gave the final yes on the banner words (below) in writing, and Step 71
  passed. Turning it on is its own app update (testing first, then the App Store app, never while Apple is
  reviewing).
- **Free.** One switch (`MAIN_CHARACTER_PLUS`) makes it Peekaboo+ only.

Two ways it runs, picked by the phone by itself:

| Phone | Live poster | Saved poster |
|---|---|---|
| App Store build 12 / TestFlight 13, iOS 17 or newer ("full") | your face from the camera, in comic colours, every frame | a fresh drawing of exactly what was on screen |
| App Store build 10, TestFlight 7–9, iOS 16, or after a camera hiccup ("lite") | the real camera shows through the face hole, moved so your face sits in it | made from the photo, with the full comic look |

On the testing channel a small **FULL/LITE** pill (top right) lets you see the lite look on your own phone.

## What people do

1. Home camera → swipe the mode row to 🌆 (right after 🤪 Googly). The row stops there, the shutter ring turns
   sunset orange and a card says "🌆 Main Character · your face in a comic poster · Tap to start". Nothing opens
   until you tap the card, the shutter or the 🌆 bubble.
2. The Main Character screen fades in on the selfie camera. Swipe left or right for the next character (its name
   pops up), 🌴 for the next scene, flip for the back camera (put a friend's face in). Each character brings its
   own scene until you pick one with 🌴; the picked scene then stays while you swipe. Next time the screen opens
   on the character and scene you used last, and your first swipe goes back to each character's own scene.
   With VoiceOver on, swipe up or down with one finger to change the character (its name is read out).
3. Shutter → white flash → the **MISSION PASSED / +RESPECT** banner → the finished poster.
4. **Share** (the iPhone share sheet), **Save** (into Photos), **My story**, **Send** (pick friends), **Take another**.
   Holding the shutter says "Main Character videos are coming soon 🎬" (videos are Phase 2, a new app download).

## The small Peekaboo logo

- Pictures that **leave the app** (the share sheet and Save to Photos) get the small white Peekaboo logo, top left.
  This is now also true for the editor's **Keep** (the copy in Photos) and **Keeps → Save to Photos**. On an
  iPhone the copy keeps the photo's own bright colours (iPhone photos use wider colours than older screens).
- Pictures that **stay inside Peekaboo** (your story, peeks to friends, your Keeps) never get it.
- The Main Character screen shows the logo too (live and on the finished poster), so screenshots carry it.
- **Videos still leave without the logo** until the Phase 2 app download.
- Where it sits is one setting (`WATERMARK` in `src/lib/watermark.ts`).

## The banner words

**MISSION PASSED** with **+RESPECT** under it are your own words (`MISSION_TITLE` and `MISSION_REWARD` in
`src/lib/mainCharacter/config.ts`). The letters are Bungee (a free font, SIL Open Font License; the licence is in
`assets/fonts/Bungee-OFL.txt`) on our own pink → purple band. Please give your final yes on these words in writing
before the mode is switched on for everyone. Changing them later is a one-line app update.

## The characters and scenes in the app

6 characters, each with its own scene, come inside the **iPhone** update (about 4.3 MB, downloaded once per
iPhone; Android and the website get none):

| Character | Its scene |
|---|---|
| Street Boss | neon street |
| Getaway Driver | coast highway |
| Beach Hustler | beach drive |
| Night Rider | rooftop |
| Rich Mogul | marina |
| Mall Cop | mall plaza |

The finished files are in `assets/main-character/`. They were made from your 12 big master pictures (about 80 MB,
not kept in the project) with:

```sh
python3 scripts/make-main-character-assets.py bundle <art-folder>
```

That step cuts the face hole, measures where the eyes, nose and chin are, reads the skin colour from the painted
cheeks, and writes the list the app uses (`src/lib/mainCharacter/art.generated.ios.ts`). It needs Pillow, numpy
and mediapipe (mediapipe is not on the normal Python here: Claude uses a separate Python setup for it). If a
picture changes, run it again, then run the tests (`tests/unit/main-character-parity.test.mjs` checks that the
app finds each face hole where the script says it is).

## Adding a new character or scene (no app update needed) ⭐

New characters and scenes can show up in the app by themselves. They live in the Supabase storage folder
**main-character**.

**Always ask Claude to make the files first.** Say for example: "Please run the Main Character online step on
this picture – it's a character called Disco Queen" (or "…it's a scene called Night Pier"). Claude runs:

```sh
python3 scripts/make-main-character-assets.py online <your picture> <out-folder>            # a character
python3 scripts/make-main-character-assets.py online <your picture> <out-folder> --scene    # a scene
```

It makes:
- `disco-queen.webp` – the picture, the right size (1080 × 1920), small enough (under 1.5 MB), with any hidden file
  data taken out. A character gets its see-through face hole cut here. Phones use a picture of exactly this size
  as it is; any other size has to be redrawn on the phone first, which can make the live poster stutter for a
  moment.
- `disco-queen.json` – **characters only**: where the face goes (eyes, nose, chin, the hole's outline, the skin
  colour).

Why always this step: a photo app can't make a see-through hole (iPhone Photos saves HEIC or JPEG, which can't have
one), and without the `.json` the app has to guess where the face goes – it leaves out anything that doesn't look
like a normal face hole.

Then upload them yourself:

1. Open supabase.com → your Peekaboo project → **Storage** → **main-character**.
2. Characters: open **characters** and drag in **both** files (`.webp` and `.json`).
   Scenes: open **backgrounds** and drag in the `.webp`.
3. That's it. Phones pick it up the next time someone opens Main Character Mode after closing and reopening the app
   (swipe Peekaboo away, then open it again), or within about 30 minutes if the app stays open. The pictures are
   downloaded while the mode is open, at most 3 new ones per visit, newest first, so give it a few seconds. New
   characters sit just before Street Boss: swipe right from Street Boss to see them. (The poster on screen never
   changes by itself when they arrive.)

Good to know:
- **The file name is the name people see**: `disco-queen.webp` shows as "Disco Queen". Use small letters and
  dashes. Names with bad words are skipped by the app. A character and a scene may have the same name (for example
  `characters/beach.webp` and `backgrounds/beach.webp`): the app keeps them apart.
- **To fix a picture**, upload a new one with the **same name** (replace it). Phones download the new version.
  The same name as one of the 6 built-in characters replaces that one too (once it has downloaded).
- **To remove one**, delete its files in the folder. It goes away on phones at their next check.
- Files over 1.5 MB, pictures smaller than 512 or bigger than 4096 pixels on a side, and pictures that aren't
  tall (like a phone screen) are refused by the folder or the app.
- **Art rules** (legal): no weapons, smoking or drinking; no logos or brand marks; no real car shapes; nothing
  taken from a real game (its logos, fonts, screen texts or characters).
- The folder exists only after the database update `supabase/migrations/20261231000000_main_character.sql`
  (the developer does this with your Allow pop-up, or gives you a copy page). Without it the app just shows the
  6 built-in characters. Nobody can upload, change or delete these pictures from the app – only you, in the
  Supabase dashboard.

## The skin colour

Each character has a skin colour. It is used for the skin plate behind your face and for a gentle pull of your skin
towards it (10 %, skin only – never your eyes, brows or lips), keeping your own light and shade.

- **Characters with a painted face** (the 6 built-in ones, and pictures you give the `online` step with the face
  still painted on): read from the painted cheeks before the hole is cut (4 cheek points of the face model).
- **Characters that already have a hole** (the `online` step measures them the app's way), **and online characters
  without a `.json`** (the app's guess): the solid paint in a ring round the hole (from its
  edge out to 1.25 × its size). Only skin-coloured pixels count, and of those the brighter half (the lit skin, not
  the shadows, the neck under the jaw or brown hair). With fewer than 200 skin pixels the app isn't sure: it uses
  the middle colour of the whole ring for the plate only, with no pull.
- "Skin-coloured" means: more red than green, more green than blue, and in a skin range that is wider than for
  photos (YCbCr: Cr 135–215, Cb 70–135, not too dark), because the painted sunset light makes the faces very red.

If someone's face looks too orange, the pull can go to 0 by app update (`COMIC.toneMix` in
`src/components/mainCharacter/comicShader.ts`).

## Switches (each one an app update, no new download)

In `src/lib/mainCharacter/config.ts` unless it says otherwise:

| Switch | What it does |
|---|---|
| `MAIN_CHARACTER_ENABLED` | `false` = the whole mode is off |
| `MAIN_CHARACTER_FOR_EVERYONE` | `false` = `testing` channel only (now) |
| `MAIN_CHARACTER_ON_ANDROID` | Android stays off until an Android phone has passed the checks |
| `MAIN_CHARACTER_PLUS` | `true` = Peekaboo+ only |
| `MISSION_TITLE`, `MISSION_REWARD` | the banner words |
| `LIVE_FACE_FROM_CAMERA` | `false` = always the lite look live |
| `SNAP_FROM_SCREEN` | `false` = the saved poster always comes from the photo |
| `LITE_CAMERA_MOVE` | `'off'` = in the lite look the hole stays still and you line your face up yourself |
| `LIVE_COMIC_GENTLE` | softer comic look live (less shimmer) |
| `LIVE_WORDMARK` | the small logo on the Main Character screen |
| `COMIC`, `COMIC_LIVE` (`comicShader.ts`) | how strong the comic look is |
| `WATERMARK` (`src/lib/watermark.ts`) | where the logo goes on pictures that leave the app |
| `HOLE`, `HOLE_CHECK`, `FIT`, `SKIN` | where the face goes and how it fits (numbers the art script measured) |

## Still open (your answers)

1. Your OK on the 12 pictures (please look once more for weapons, smoking, drinking, logos or brand marks).
2. Your final yes on the banner words, MISSION PASSED / +RESPECT, before it goes to everyone.
3. The logo's place on shared pictures: top left (planned, visible on Instagram, Snapchat and TikTok) – OK?
4. The small logo on the Main Character screen itself – OK?
5. Videos from the editor and Keeps leave without the logo until the Phase 2 download – OK?
