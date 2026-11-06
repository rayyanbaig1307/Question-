# Peekaboo – Apple App Store checklist

Everything Apple asks for before Peekaboo (with the **Peekaboo+** subscription) can go on the App Store, and where each item stands. Updated **6 November 2026** for Apple's late-2026 rules. Google Play differences are at the end.

Legal operator everywhere: **2865113 Ontario Inc. (Ontario, Canada)**, rbaig18@z2automation.net.
Public pages: https://peekaboo-4gz.pages.dev (`/terms`, `/privacy`, `/support`, `/guidelines`). They are built from this folder with `node scripts/build-website.mjs` – **upload the `website/` folder again after every change here** (Cloudflare → Workers & Pages → peekaboo → Create deployment).

## A. What must be in the app (App Store Review Guidelines)

| Apple rule | What it means | Peekaboo status |
| --- | --- | --- |
| **1.2 User-generated content** | A way to filter objectionable content, report it, block abusive users, published contact info, and acting on reports within 24 hours. | ✅ Report (with reasons) on posts, stories, peeks, chat and group messages, comments, profiles, Guess Who, dare ideas and hit ups. ✅ Block on profiles, chats and after every report, plus a Blocked accounts list. ✅ Word filter on public text (app + server). ✅ Every new report pushes "🚩 New report" to the owner. ✅ Contact us, Terms, Privacy, Guidelines and Dare Safety Rules in Settings → Legal & safety. **Owner duty:** check reports daily (section H). |
| **1.4.1 / 1.4.5 Physical harm, dares** | No content that encourages dangerous activity. | ✅ Dares are social, not physical (`docs/DARES.md`). ✅ Dare Safety Rules must be accepted before the first dare. Community dare ideas: word check, hidden after 3 reports. |
| **2.1 Completeness** | No placeholders or crashes; the reviewer can reach every feature, including the subscription. | Demo account `review@peekaboo.invalid` (password only in App Store Connect). It must have content (posts, a story on submit day, a group, a chat) and **no Peekaboo+**, so the reviewer sees the real paywall. The editor's "Coming soon" buttons must be gone. |
| **2.5.4 Background modes** | Only declare background modes the app really uses. | The store build must **not** declare background audio (`expo-audio` with `enableBackgroundPlayback: false`). Needs a native build. |
| **3.1.1 In-App Purchase** | Digital extras must be sold with Apple's In-App Purchase. | ✅ Peekaboo+ uses Apple In-App Purchase through RevenueCat. No other way to pay. |
| **3.1.2 Subscriptions** | The buy screen shows the name, length, what you get, the full renewal price, how to cancel, Restore purchases, and links to the Terms of Use and Privacy Policy. The App Store description must also link both. | ✅ Peekaboo+ screen (`src/app/(app)/plus.tsx`): real store price on the button, "renews automatically every month… cancel at least 24 hours before", Restore purchases, Terms of Use and Privacy Policy links, Manage subscription for members. ✅ Terms section 9 has the full subscription terms. ✅ The App Store description already has a Peekaboo+ paragraph with the Terms and Privacy links. |
| **4.8 Sign in with Apple** | Apps that offer another social login must also offer Sign in with Apple. | ✅ On iPhone the only social login is Sign in with Apple (Google is Android-only). `usesAppleSignIn: true`. |
| **5.1.1(i) / 5.1.2 Privacy policy** | A privacy policy link in the app and in App Store Connect, matching what the app does (including every SDK). | ✅ Privacy Policy (6 Nov 2026) covers RevenueCat, purchase data, Peekaboo+ insights, the ⭐ badge, and the on-device face filters (Google ML Kit / MediaPipe). Upload the new `website/` before you publish App Privacy. |
| **5.1.1(ii) Permission texts** | Each permission text must say every use. | Camera text must mention videos and face filters, microphone text must mention voice notes (`app.json`). Needs a native build. |
| **5.1.1(v) Account deletion** | Delete account in the app. If the person has a subscription, tell them billing continues through Apple and how to cancel. | ✅ Settings → Delete account. The confirm step must tell Peekaboo+ members that Apple keeps billing and offer Manage subscription. Deleting also disconnects Sign in with Apple **only if** the `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` secrets are set in Supabase (check the names). |
| **Kids / age** | Not a kids app; minimum age 13. | ✅ "I'm 13 or older" at sign-up; hit ups 18+ only (checked by the server). Don't pick the Kids category or "Made for Kids". |
| **Export compliance** | Declare encryption. | ✅ `usesNonExemptEncryption: false` in `app.json` (standard HTTPS only). |
| **EULA** | Apple's standard EULA applies unless you add your own. | Keep **Apple's standard EULA**. Our Terms (section 15) also contain Apple's minimum terms, and the description links both. |

## B. App Privacy (App Store Connect → App Privacy)

Start with **"Yes, we collect data from this app"**. Unless a row says otherwise: **Linked to the user = Yes**, **Used for tracking = No** (no ads, no data brokers, no ad SDKs, so no App Tracking Transparency prompt), purpose **App Functionality**. Answers must include what the SDKs inside the app collect (RevenueCat, Google ML Kit, Expo).

| Apple category → data type | Collect? | What it is |
| --- | --- | --- |
| Contact Info → **Name** | Yes | Display name; the name Apple shares at sign-in |
| Contact Info → **Email Address** | Yes | Apple ID email or Hide-My-Email address; older accounts' email |
| Contact Info → Phone / Physical address / Other | No | – |
| Health & Fitness, Sensitive Info, Contacts, Browsing History | No | – |
| Financial Info | No | Apple handles payment; we never see card details |
| Location → **Precise Location** | Yes | Friend map, only while sharing is on |
| Location → Coarse Location | No | – |
| User Content → **Emails or Text Messages** | Yes | Chat and group chat messages |
| User Content → **Photos or Videos** | Yes | Posts, stories, peeks, drops, Guess Who, Keeps, profile and group pictures |
| User Content → **Audio Data** | Yes | Voice notes and the sound in videos |
| User Content → **Customer Support** | Yes | Emails people send us |
| User Content → **Other User Content** | Yes | Captions, comments, bios, profile song, dare ideas, votes, reactions, hit-up notes |
| User Content → Gameplay Content | No | – |
| Search History | No | Searches are run, not stored; song searches go straight to Apple |
| Identifiers → **User ID** | Yes | Supabase account id (also the RevenueCat app user id) |
| Identifiers → **Device ID** | Yes | Push-notification token per device. No advertising id |
| Purchases → **Purchase History** | Yes | Peekaboo+ status and renewals through RevenueCat. Purposes: **App Functionality** and **Analytics** (RevenueCat's subscription charts) |
| Usage Data → **Product Interaction** | Yes | Story views and rewatches, who peeked a drop, profile visits, screenshots of stories and posts (Peekaboo+ insights), last app open (drop reminders) |
| Usage Data → Advertising Data / Other Usage Data | No | – |
| Diagnostics → **Performance Data** and **Other Diagnostic Data** | Yes | Google ML Kit (googly-eyes lens) sends Google technical data. **Linked: No.** Purpose: **Analytics**. Check the answers against Google's page developers.google.com/ml-kit/ios-data-disclosure before publishing (it couldn't be opened from the developer session) |
| Diagnostics → Crash Data | No | No crash-reporting SDK |
| Other Data → **Other Data Types** | Yes | Birthday (hit ups 18+ check), the "13 or older" confirmation, Terms acceptances, blocks and reports |

Privacy Policy URL: `https://peekaboo-4gz.pages.dev/privacy`. Then **Publish**. (App Privacy was filled in once before; edit it to add **Purchases → Purchase History**, **Product Interaction** and **Diagnostics**.)

## C. Age rating (App Store Connect → App Information → Age Ratings)

Apple's new questionnaire is required for new apps (an Unrated app can't be published).

| Question | Answer | Why |
| --- | --- | --- |
| Parental Controls | No | No parent tools in the app |
| Age Assurance | No | Only "I'm 13 or older" and a typed birthday; no ID check and no Declared Age Range API |
| Unrestricted Web Access | No | No in-app browser |
| User-Generated Content | **Yes** | Photos, videos, stories, comments |
| Messaging and Chat | **Yes** | 1:1 and group chat, voice notes, hit ups |
| Social Media | **Yes** (the plain "Yes") | Home shows public posts with likes and comments. Don't pick "Yes, but disabled for users under 13" – that needs the Declared Age Range API |
| Advertising | No | No ads |
| Profanity or Crude Humor | Infrequent / Mild | People can swear in captions, comments and chat (slurs are blocked in public text) |
| Mature or Suggestive Themes | Infrequent / Mild | Some cheeky dares, and user content |
| Contests | Infrequent | Dare streaks, community dare votes, Legit/Cap votes |
| Horror/Fear, Alcohol/Tobacco/Drugs, Medical, Health or Wellness, Sexual Content or Nudity, Graphic Sexual Content, Cartoon/Realistic/Graphic Violence, Guns or Weapons, Simulated Gambling | None | Banned by the Guidelines and Dare Safety Rules |
| Gambling, Loot Boxes | No | – |
| Made for Kids | No | Peekaboo is 13+ |

**Expected result: 13+** (Social Media sets 13+ as the minimum), which matches the Terms. Australia shows 16+ and Brazil A16 for apps with social media. No override needed.

## D. App Store Connect listing

- **Name:** Peekaboo: Dare Your Friends (set). **Subtitle:** Photos, peeks & daily drops.
- **Category:** Social Networking (secondary: Photo & Video).
- **Support URL:** https://peekaboo-4gz.pages.dev/support · **Marketing URL:** https://peekaboo-4gz.pages.dev/ · **Privacy Policy URL:** https://peekaboo-4gz.pages.dev/privacy
- **Copyright:** 2026 2865113 Ontario Inc.
- **Description:** already has the Peekaboo+ paragraph (monthly, auto-renews, price shown before you buy, charged to the Apple Account, cancel at least 24 hours before renewal in Settings → your name → Subscriptions) plus links to Apple's standard EULA, our Terms (https://peekaboo-4gz.pages.dev/terms) and Privacy Policy.
- **Screenshots** (JPG or PNG, **no transparency**, up to 10 per size, iPhone only because `supportsTablet` is false):
  - **1206 × 2622** (iPhone with Dynamic Island, medium display) – **required**.
  - **1320 × 2868** (large display) – upload it too. Without it, Apple asks for the older 6.5" large set instead.
  - Pad, don't stretch, if your phone's shape differs. Screenshots that show Peekaboo+ extras (themes, moving chat backgrounds, Golden Hour, the ⭐ badge) must say they're part of Peekaboo+, or use the free look.
  - 6 screenshots are uploaded; check they are in both sizes.
- **Content Rights:** "Yes, it contains third-party content" (iTunes song previews and user uploads) and confirm you have the rights.
- **Pricing:** the app itself is **Free**.
- **Release option:** "Manually release this version" for the first launch.
- **App Review Information:** sign-in required = Yes, the demo account, your contact name, phone and email, and notes that explain: how to log in ("Have a username and password? Log in", not Sign in with Apple), where Peekaboo+ is (Settings → ⭐ Peekaboo+, or a locked theme) and that it uses the sandbox, that the reviewer will see an updated Terms screen once (tap Agree), dares and the safety rules, hit ups (18+), location only while sharing is on, the face filters work on the phone only, and how Report and Block work.

## E. The Peekaboo+ subscription (App Store Connect → Monetization → Subscriptions)

- ✅ Group `Peekaboo+` (id 22547761) and product **`peekaboo_plus_monthly`** (1 month, US$6.99 / CA$9.99). The product ID must match RevenueCat and `src/lib/plus.ts`.
- ✅ RevenueCat: project, app, In-App Purchase key, entitlement `plus`, offering `default`.
- **Localization:** display name `Peekaboo+ Monthly` (2–30 characters, no emoji); description **45 characters or fewer**, e.g. `Profile views, themes, stickers and more` (40).
- **Review Information:** an **App Review screenshot** of the Peekaboo+ screen with the real price, taken on a TestFlight build while logged in to an account **without** Plus (still missing). You can replace it later, but not remove it.
- **Review notes:** "Open Settings (profile → gear) → ⭐ Peekaboo+, or tap a locked theme. The demo account has no Plus, so you can buy with a Sandbox account."
- **Purchase options:** App Store only (turn multiseat off). Family Sharing off (it can't be turned off again). No free trial or intro offer in 1.0.
- **Availability:** must match the app's countries (see F).
- **Server notifications:** App Store Server Notifications V2 URL from RevenueCat (production and sandbox). The RevenueCat webhook to Supabase (`revenuecat-webhook`, secret `REVENUECAT_WEBHOOK_AUTH`) is set but **untested**: make one sandbox purchase and check that a `plus_members` row appears.

## F. Business and compliance (owner only, on the website)

- **Paid Apps Agreement** (Business → Agreements) – Account Holder only. Until it says **Active**, the app gets no price and the reviewer can't buy. Then **Tax Forms** (W-8BEN-E for a Canadian company, plus the GST/HST number) and **Bank Account** in the company's name.
- **Small Business Program** (15% instead of 30%) – optional, Account Holder only; the whole team (the brother's apps too) counts toward the US$1M cap.
- **EU Digital Services Act (DSA)** – a required field. Selling a subscription makes 2865113 Ontario Inc. a **trader**, and Apple then shows the company's D-U-N-S address, phone and email on the product page in the 27 EU countries. Choose one:
  - declare **trader** and accept that the address is shown in the EU, or
  - leave **all 27 EU countries out** of the app's and the subscription's availability for now (then you're not trading in the EU).
  - Never declare "not a trader" while selling Peekaboo+ in the EU.
- **Australia and Brazil** have their own under-16 / child-safety rules for social apps. Leaving them out of 1.0 (with the EU decision) is the safe choice until a lawyer has looked.
- **Digital Goods and Services questionnaire** (if it shows): "Yes, customers can consume digital goods" → "uses Apple In-App Purchase exclusively". The EU answer is locked for 12 months.
- **Texas SB 2420** (age assurance and parent consent for under-18s since June 2026): not an App Review blocker, but ask a lawyer. It may later need Apple's Declared Age Range API (a native build).

## G. Submitting ("Add for Review")

The first subscription must go to Apple **together with the app**, in the same submission:

1. On the **iOS 1.0** version page, choose the store build (made with the EAS `production` profile).
2. On the subscription page (`Peekaboo+ Monthly`) → **Add for Review** → create a draft submission and include the **subscription group** and the **iOS 1.0 version**.
3. On the version page → **Add for Review** → add it to the same draft.
4. **Draft Submissions** (bottom right, or App Review in the sidebar) → check every item → **Submit for Review**.

Everything in the submission must be accepted before any of it is approved. After approval the status is "Pending Developer Release" → **Release This Version**.

## H. Operator's ongoing duties (these matter as much as the documents)

- Check reports at least daily and act within 24 hours (remove content, warn or ban). Keep a simple log of what you did.
- Answer emails to the contact address within a few days; privacy requests within 30 days.
- **Billing questions:** we can't refund – send people to reportaproblem.apple.com. If someone asks, delete their Peekaboo+ purchase log (`private.plus_events`) and their customer record in RevenueCat (the Privacy Policy promises this).
- Report any confirmed child-safety material to the authorities (in Canada: Cybertip.ca / local police) and keep the evidence.
- If a data breach happens, note what happened and tell affected users and the Privacy Commissioner as required.
- Review the dare list whenever you add dares.
- Keep the Privacy Policy and the App Privacy answers accurate when the app changes (new data, new providers or SDKs). After any change in `legal/`: run `node scripts/sync-legal.mjs` and `node scripts/build-website.mjs`, upload `website/`, and bump `TERMS_VERSION` in `src/lib/legal.ts` if people must agree again.

## I. Google Play differences

- Peekaboo+ can't be bought on Android yet (iPhone only). If it's added, Google Play Billing is required and the Terms and Privacy Policy need a Google Play section.
- Needs the same Privacy Policy URL, a **Data safety** form (same answers as section B), the IARC age rating questionnaire, and the "Account deletion" URL/in-app path.
- Google requires a **Target audience and content** declaration (not for children) and may ask for a **UGC policy** statement – the Community Guidelines cover it.
- Android background location is not used; the location permission needs the same justification text as iOS.
