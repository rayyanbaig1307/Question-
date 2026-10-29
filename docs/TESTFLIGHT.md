# Getting Peekaboo onto iPhones with TestFlight 🍎

TestFlight is Apple's way of letting friends install a test app. Once it's set up, anyone with an iPhone
taps one link, installs the free TestFlight app, and gets Peekaboo like a normal app. No Expo Go needed.

You only do the "You" steps once. Everything else is done for you.

## Step 1 – Make sure your Apple Developer membership is active (You)

1. Open the **Apple Developer** app → **Account** tab. It should say **Apple Developer Program** with an
   expiry date about a year away. (You'll also have an email from Apple: "Welcome to the Apple Developer Program".)
2. If it still says "Enroll" or "Pending", Apple hasn't finished yet – it usually takes up to 2 days. Wait for
   the email, then come back.
3. On a computer or your phone's browser, open **developer.apple.com/account**. If a yellow banner asks you to
   **review and accept an updated agreement**, accept it. (Builds fail silently until this is done.)

## Step 2 – Make a key that lets Expo talk to Apple for you (You)

This key lets Expo create the signing files and send Peekaboo to TestFlight. It is **not** your password.

1. Go to **appstoreconnect.apple.com** and sign in with the same Apple ID.
2. **Users and Access** → **Integrations** tab → **App Store Connect API** → **Team Keys**.
   (The very first time there's a **Request Access** button – tap it and agree.)
3. Tap **＋ Generate API Key**. Name: `Expo`. Access: **Admin**. Tap **Generate**.
4. On that page, write down (or screenshot) two things:
   - **Issuer ID** (long code at the top of the page)
   - **Key ID** (short code next to your new key)
5. Tap **Download API Key**. You get a file ending in **.p8**. Apple only lets you download it **once** – keep
   it somewhere safe (Files app, iCloud Drive).

**Never paste the .p8 file or its contents into the chat.** It goes straight to Expo in the next step.

## Step 3 – Give that key to Expo (You)

You'll also need your **Team ID**: **developer.apple.com/account** → **Membership details** → **Team ID**
(10 letters/digits).

1. Go to **expo.dev**, sign in, open **Projects** → **peekaboo** → left menu **Environment variables**.
2. Tap **Create variable** four times and add these (Environment: **production**; Visibility: **Sensitive** –
   not "Secret", or Expo's tool can't read it):

   | Name | Value |
   |---|---|
   | `EXPO_ASC_API_KEY_PATH` | type **File** → upload the **.p8** file |
   | `EXPO_ASC_KEY_ID` | the **Key ID** from Step 2 |
   | `EXPO_ASC_ISSUER_ID` | the **Issuer ID** from Step 2 |
   | `EXPO_APPLE_TEAM_ID` | your **Team ID** |

3. Tell the chat "the Apple key is on Expo".

(These stay inside Expo. They are never put into the app itself.)

## Step 4 – The first iPhone build (Done for you)

Expo builds Peekaboo for iPhone (about 15–30 minutes). Using your key it also registers the app's ID with
Apple and makes the signing files. You don't need to do anything.

## Step 5 – Create the app's page in App Store Connect (You)

1. **appstoreconnect.apple.com** → **My Apps** → **＋** → **New App**.
2. Platform **iOS**. Name: **Peekaboo** – if Apple says the name is taken, pick another, e.g.
   "Peekaboo – Friends" or "Peekaboo Snaps" (this is only the App Store name; the app itself still says Peekaboo).
   Primary language: English. **Bundle ID**: pick `com.rbaig18.peekaboo` from the list. SKU: `peekaboo`.
   User access: Full access. Tap **Create**.
3. Open the new app → **App Information** → under **General Information** copy the **Apple ID** (a 10-digit number,
   it's not secret) and tell the chat: "App Store Connect Apple ID is 1234567890".

## Step 6 – Send it to TestFlight (Done for you)

The build is uploaded to TestFlight. Apple "processes" it for 10–30 minutes, then it appears under
**TestFlight** in App Store Connect.

## Step 7 – Invite friends (You)

- **Just you and a few people with Apple IDs you add:** App Store Connect → **TestFlight** → **Internal Testing**
  → **＋** → add testers by email → they get an email with the install button.
- **Anyone with a link (up to 10,000 people):** **TestFlight** → **External Testing** → **＋** → name the group
  "Friends" → add the build → tap **Enable Public Link**. The **first** time, Apple does a quick "Beta App Review"
  (usually a day). After that, share the public link – it goes into Peekaboo's "Invite friends" message too.

## Later: push notifications on iPhone

Push notifications on iPhone need one more Apple key (an "APNs key"). When you're ready:
**developer.apple.com/account** → **Certificates, IDs & Profiles** → **Keys** → **＋** → name `Peekaboo Push`,
tick **Apple Push Notifications service (APNs)** → Continue → Register → **Download** the .p8 (once!) and note its
**Key ID**. Then on **expo.dev** → Credentials → iOS → **Push Key** → upload it. Everything else is automatic.
Until then the app works fine on iPhone; it just won't buzz for new messages.
