# Peekaboo – Apple App Store checklist

Everything Apple asks for before Peekaboo can be on TestFlight and the App Store, and what still has to be built. Google Play asks for almost the same things; the differences are noted at the end.

## A. What must exist in the app (App Store Review Guidelines)

| Apple rule | What it means | Peekaboo status |
| --- | --- | --- |
| **1.2 User-generated content** | Apps with user content must have: a way to filter objectionable content, a way to report it, a way to block abusive users, and published contact info; and must act on reports within 24 hours. | Report (with reasons) ✅, Block ✅, screenshot alerts ✅. **To do:** show the Community Guidelines and a contact email inside the app; a Terms/Guidelines acceptance at sign-up; the operator must actually review the `reports` table daily. |
| **1.1.4 Sexual content / 1.2** | Dating apps are allowed but must not be "hookup" or pornographic, and must moderate. | Peek Match is 18+ with ID verification ✅, has its own blocks/reports ✅. Keep nudity banned (Guidelines ✅). |
| **5.1.1(v) Account deletion** | If users can create an account, they must be able to delete it in the app. | Settings → Delete account ✅ (server function). |
| **5.1.1 Data collection and storage** | Ask only for what you need, explain each permission, don't require login for features that don't need it. | Permission texts for camera, microphone, photos, location, notifications ✅ (`app.json`). Location only while sharing ✅. |
| **5.1.2 Data use and sharing** | Privacy policy link in the app and in App Store Connect. | **To do:** host `PRIVACY_POLICY.md` publicly and link it in Settings and at sign-up. |
| **5.1.4 Kids** | Not aimed at kids; minimum age 13. | Sign-up has an "I'm 13 or older" check ✅. Don't choose the Kids category. |
| **4.8 Sign in with Apple** | Only required if you offer another third-party login (Google, Facebook). | Email/password only, so not required ✅. |
| **2.1 Completeness** | No placeholders, no crashes, reviewers must be able to use every feature. | **To do:** give Apple a demo account and a way to see Peek Match without a real ID (see section D). |
| **2.5.4 Background location** | Not used. | ✅ (`locationAlwaysPermission: false`). |
| **Export compliance** | Declare encryption use. | `usesNonExemptEncryption: false` in app.json ✅ (standard HTTPS only). |
| **EULA** | Apple's standard EULA applies unless you provide your own; a custom one must include Apple's minimum terms. | Section 14 of `TERMS_OF_SERVICE.md` contains Apple's required terms ✅. Paste the Terms URL in App Store Connect → App Information → License Agreement (or keep Apple's standard EULA and still link the Terms in the app). |

## B. App Privacy "nutrition labels" (App Store Connect → App Privacy)

Answer **"Yes, we collect data from this app"**, then declare the following. All of it is **linked to the user's identity** (it is tied to their account) and **none of it is used for tracking** (no ads, no data brokers), so answer "No" to tracking and do not add the App Tracking Transparency prompt.

| Apple category | Data type | Purpose(s) to tick |
| --- | --- | --- |
| Contact Info | Email Address | App Functionality |
| User Content | Photos or Videos; Audio Data (voice notes); Other User Content (captions, comments, dares, dating prompts) | App Functionality |
| User Content | Customer Support (emails you receive) | App Functionality |
| Identifiers | User ID | App Functionality |
| Location | Precise Location (friend map, only when sharing is on); Coarse Location (Peek Match distance) | App Functionality |
| Sensitive Info | Date of birth / age-verification result (Peek Match) and ID-document images processed by Stripe | App Functionality. Declare "Other Data Types: Government ID (processed by a third party, not stored by us)" |
| Usage Data / Diagnostics | Crash and performance data is **not** collected (no analytics SDK) | Leave unticked |
| Other Data | Friend list within the app, blocks, reports | App Functionality |

Messages, friends' usernames and the fact that a screenshot happened fall under "User Content / Other User Content".

## C. Age rating questionnaire (App Store Connect → Age Rating)

Recommended answers, which produce a **17+** rating (because of dating and unrestricted user content):

- Cartoon or Fantasy Violence: None · Realistic Violence: None · Profanity or Crude Humor: Infrequent/Mild (user content) · Mature/Suggestive Themes: Infrequent/Mild · Horror/Fear: None · Medical/Treatment: None · Alcohol, Tobacco, Drugs: None · Simulated Gambling: None · Sexual Content and Nudity: None (banned by guidelines) · Contests: None.
- **Unrestricted Web Access:** No.
- **Gambling:** No.
- **User-generated content / messaging / dating:** these flags are what push the rating to 17+. Do not try to answer "no" to get 12+; Apple rejects mis-rated apps and the dating feature is 18+ anyway.

Google Play's questionnaire (IARC) gives "Mature 17+" / "PEGI 18" for the same answers.

## D. App Store Connect listing – what to prepare

- **Name:** Peekaboo (check it is available; add a subtitle like "Dares, drops and friends" if the plain name is taken).
- **Bundle ID:** `com.rbaig18.peekaboo` (already in `app.json`).
- **Privacy Policy URL** and **Support URL** (public pages – see `legal/README.md`), **Marketing URL** optional.
- **Support contact:** the `[CONTACT EMAIL]`, which must be answered.
- **Screenshots:** 6.9" iPhone (at least 3) and 6.5" iPhone; optionally iPad is not needed because `supportsTablet` is false.
- **Description, keywords, promotional text, category** (Social Networking; secondary Lifestyle).
- **Age rating:** 17+ (section C).
- **App Review notes (important):**
  - A **demo account** (email + password) that already has friends, posts, stories and a chat, so the reviewer can see every feature.
  - A sentence explaining the **Peek Match age check** and how the reviewer can see Peek Match without uploading a real ID: either give a second demo account that is already verified, or ask the developer session to add a "review mode" switch that marks a specific account as verified. Apple will not pass their own ID through Stripe.
  - A note that **dares are optional suggestions**, that the safety rules are shown before the first dare, and how reporting/blocking works.
  - Mention that location is only shared while the user turns it on.
- **Content Rights:** confirm you own or have licences for all content (profile songs are Apple's own 30-second previews via the iTunes Search API, which Apple permits for previews).
- **Export compliance:** already answered in app.json (no non-exempt encryption).

## E. Things the developer session still needs to build before App Store submission

1. **Sign-up:** add "By continuing you agree to the Terms of Service and Privacy Policy" with working links, and record the acceptance (date + version) on the profile.
2. **Settings:** links to Terms, Privacy Policy, Community Guidelines, Dare Safety Rules, and a "Contact us" line showing the email.
3. **Dare safety screen:** the one-time "I understand" screen from `DARE_SAFETY_RULES.md` before the first dare, forfeit or drop; store the acceptance in the database.
4. **Dare list review:** remove or rewrite risky dares in `src/lib/dares.ts` per the list in `DARE_SAFETY_RULES.md`; add the same rule check to community dare ideas (and a Report button on ideas).
5. **Report screen:** link to the Community Guidelines and show the "we act within 24 hours" line.
6. **Review mode for Peek Match:** a safe way to let an Apple reviewer (and you, for testing) into Peek Match without a real ID – e.g. an allow-list of account IDs that count as verified, set only from the database.
7. **Public web pages** for the Privacy Policy and Terms (GitHub Pages or similar) and their URLs in Settings.
8. **Google Maps key** for Android so the map is not grey in the Play Store build.

## F. Operator's ongoing duties (these matter as much as the documents)

- Check the `reports` table at least daily and act within 24 hours (remove content, warn or ban). Keep a simple log of what you did.
- Answer emails to the contact address within a few days; privacy requests within 30 days.
- Report any confirmed child-safety material to the authorities (in Canada: Cybertip.ca / local police) and preserve the evidence.
- If a data breach happens, note what happened and tell affected users and the Privacy Commissioner as required.
- Review the dare list whenever you add dares.
- Keep the Privacy Policy accurate when the app changes (new data, new providers).

## G. Google Play differences

- Needs the same Privacy Policy URL, a **Data safety** form (same answers as section B), the IARC age rating questionnaire, and the "Account deletion" URL/in-app path.
- Google requires a **Target audience and content** declaration (not for children) and may ask for a **UGC policy** statement – the Community Guidelines cover it.
- Android background location is not used; the `ACCESS_FINE_LOCATION` permission needs the same justification text as iOS (already in the permission string).
