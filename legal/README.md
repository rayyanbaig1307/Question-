# Peekaboo – legal documents

These are the documents Peekaboo needs on the App Store and Google Play. Peekaboo is free to download and now has a paid extra: **Peekaboo+**, an optional monthly subscription (iPhone only for now, through Apple).

| File | What it is | Where it must appear |
| --- | --- | --- |
| `TERMS_OF_SERVICE.md` | The agreement between the operator and every user. Includes the Peekaboo+ subscription terms (section 9), the dare waiver, the hit-up rules, limits on liability and Apple's required terms (section 15). | Accepted in the app (sign-up, and again when `TERMS_VERSION` changes), in Settings, on the Peekaboo+ screen ("Terms of Use"), on the website and linked in the App Store description. |
| `PRIVACY_POLICY.md` | What data the app collects, why, where it is stored, who sees it, which outside services get it (Supabase, Expo, RevenueCat, Apple, Google) and how people delete it. Written to match what the app really does. | Website (Apple and Google both need a public address), in Settings, on the Peekaboo+ screen, and in the App Store "Privacy Policy URL" field. |
| `COMMUNITY_GUIDELINES.md` | The rules for what people may post and how they treat each other, and how to report and block. | In Settings and on the website. |
| `DARE_SAFETY_RULES.md` | The safety rules and the "I understand" text people must accept before their first dare, drop or forfeit. The end of the file (from "The 'I understand' screen") is for the operator only. | Shown in the app before the first dare (one time), in Settings and on the website. |
| `SUPPORT.md` | The help page: contact email, reporting, blocking, account questions, and cancelling, restoring and refunding Peekaboo+. | Website only (`/support`) – it is the App Store "Support URL". |
| `APPLE_APP_STORE_CHECKLIST.md` | Everything Apple asks for (App Privacy answers, age rating, listing, the subscription, review notes, required in-app features) and where each item stands. | For the owner and the developer sessions; not shown to users. |
| `DARE_REVIEW_2026-10-31.md` | The before/after list of the dares that were made safer on 31 October 2026. | For the owner; not shown to users. |

## Who, when and contact

- **Operator:** 2865113 Ontario Inc. (Ontario, Canada). **Contact:** rbaig18@z2automation.net. Both are filled in everywhere – there are no placeholders left.
- **Effective date:** 6 November 2026 (Terms) and 9 November 2026 (Privacy Policy: the new face filters and the expressions they react to). Change it whenever you change what a document says.
- **Mailing address:** left out on purpose – that's the owner's choice. The company's registered office is public in the Ontario Business Registry anyway. Selling Peekaboo+ in the EU would make Apple show the company's address there (see section F of the checklist). Add an address here and in the Contact sections if that ever changes.

## Honest note on liability (please read)

These documents are written to protect the operator as far as the law allows: users accept the risks of dares, promise not to do anything dangerous or illegal, agree that we don't supervise or verify dares, agree to pay for claims caused by their own behaviour, and agree to limits on what we can be held liable for.

No document can make it impossible for someone to sue, and no court will enforce a waiver for everything. In particular:

- Waivers are weaker or invalid for **people under 18**, for **gross negligence** or deliberate harm, and under **consumer-protection laws** (Ontario's Consumer Protection Act, the EU/UK rules, Quebec's Consumer Protection Act). The documents say so instead of pretending otherwise, because a clause that over-reaches can make a whole section unenforceable.
- The strongest protection is **not relying on paper alone**: keep the dares themselves safe (see the dare review at the end of `DARE_SAFETY_RULES.md` and in `DARE_REVIEW_2026-10-31.md`), approve only safe community dare ideas, act on reports within 24 hours, and keep the safety rules in people's faces.
- Peekaboo is run by a company (2865113 Ontario Inc.), so the company, not you personally, is the party that gets sued. The next step that helps most is **general liability insurance** for the business once it has real users.
- Have a lawyer read these before launch. They were drafted by an AI assistant from the app's actual behaviour and the main laws and rules that apply (PIPEDA and Ontario law in Canada, COPPA for under-13s, GDPR/UK GDPR for Europe, CCPA for California, Apple's App Store Review Guidelines and its subscription rules). That is a solid draft, not legal advice.

## The public website

Apple and Google need the Privacy Policy (and a Support page) at a public web address that stays up.

- `node scripts/build-website.mjs` turns these files into the `website/` folder (home, support, privacy, terms, guidelines, dare safety).
- It is hosted on **Cloudflare Pages**: project `peekaboo`, live at https://peekaboo-4gz.pages.dev (`/privacy`, `/support`, `/terms`, `/guidelines`, `/dare-safety`).
- After every change: run the script, then upload the `website/` folder again (Cloudflare → Workers & Pages → peekaboo → Create deployment → upload the folder).
- These addresses go in App Store Connect (Privacy Policy URL, Support URL, Marketing URL) and in the App Store description.

## Inside the app

The app shows the Terms, Privacy Policy, Community Guidelines and Dare Safety Rules itself (Settings → Legal & safety, the sign-up screen, the Peekaboo+ screen and the Dare screen), from a copy in `src/lib/legalDocs.ts`. After editing anything in this folder:

1. `node scripts/sync-legal.mjs` – so the app gets the new text.
2. `node scripts/build-website.mjs` – so the website gets it too, then upload `website/`.
3. If the Terms or the Dare Safety Rules change in a way people must agree to again, bump `TERMS_VERSION` / `DARE_RULES_VERSION` in `src/lib/legal.ts` – everyone is then asked to accept the new version. A small wording fix that doesn't change what people agree to needs no bump.

`npm test` checks that the app's copy and the website match these files (`tests/unit/legal-docs.test.mjs`).
