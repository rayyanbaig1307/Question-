# Peekaboo – legal documents

These are the documents Peekaboo needs before it goes on the App Store or Google Play:

| File | What it is | Where it must appear |
| --- | --- | --- |
| `TERMS_OF_SERVICE.md` | The agreement between you (the operator) and every user. Includes the dare waiver, the Peek Match rules, limits on liability and Apple's required terms. | Link at sign-up (must be accepted), in Settings, and on the App Store listing. |
| `PRIVACY_POLICY.md` | What data the app collects, why, where it is stored, who sees it, and how people delete it. Written to match what the app actually does. | Public web page (Apple and Google both require a URL), link at sign-up, in Settings, and in the App Store "Privacy Policy" field. |
| `COMMUNITY_GUIDELINES.md` | The rules for what people may post and how they treat each other. | In Settings and on the Report screen. |
| `DARE_SAFETY_RULES.md` | The short safety rules and the "I understand" text people must accept before their first dare, Drop or forfeit. | Shown in the app before the first dare (one-time) and reachable from the Dare screen. |
| `APPLE_APP_STORE_CHECKLIST.md` | Everything Apple asks for (privacy labels, age rating, review notes, required in-app features) and what still needs to be built or filled in. | For you and the developer sessions; not shown to users. |

## Before publishing, fill in the placeholders

The effective date is filled in (31 October 2026). Search all files for `[` and replace:

- `[OPERATOR NAME]` – your legal name, or your company's name if you set one up (recommended – see below).
- `[CONTACT EMAIL]` – an email you check, e.g. `hello@peekaboo.app`. Apple requires a working contact.
- `[MAILING ADDRESS]` – a postal address (a P.O. box is fine). Required for privacy-law notices.

## Honest note on liability (please read)

These documents are written to protect you as far as the law allows: users accept the risks of dares, promise not to do anything dangerous or illegal, agree that you don't supervise or verify dares, agree to pay for claims caused by their own behaviour, and agree to limits on what you can be held liable for.

No document can make it impossible for someone to sue, and no court will enforce a waiver for everything. In particular:

- Waivers are weaker or invalid for **people under 18**, for **gross negligence** or deliberate harm, and under **consumer-protection laws** (Ontario's Consumer Protection Act, the EU/UK rules, Quebec's Consumer Protection Act). The documents say so instead of pretending otherwise, because a clause that over-reaches can make a whole section unenforceable.
- The strongest protection is **not relying on paper alone**: keep the dares themselves safe (see the dare review in `APPLE_APP_STORE_CHECKLIST.md`), act on reports within 24 hours, and keep the safety rules in people's faces.
- Two practical steps reduce *your personal* exposure far more than any wording: **run Peekaboo through a corporation** (an Ontario or federal corporation costs a few hundred dollars and takes a day online), so the company, not you, is the party being sued; and **get general liability insurance** for the business once it has real users.
- Have a lawyer read these before launch. They were drafted by an AI assistant from the app's actual behaviour and the main laws that apply (PIPEDA and Ontario law in Canada, COPPA for under-13s, GDPR/UK GDPR for Europe, CCPA for California, Apple's App Store Review Guidelines). That is a solid draft, not legal advice.

## Hosting the public pages

Apple and Google need the Privacy Policy (and ideally the Terms) at a public web address that stays up. Easiest options:

1. **GitHub Pages** from this repository: turn on Pages for the `legal/` folder and the files become `https://<your-github-name>.github.io/<repo>/PRIVACY_POLICY` (Markdown renders automatically).
2. Any free static host (Netlify, Vercel, Cloudflare Pages) with the same files.

Put the resulting URLs into App Store Connect (Privacy Policy URL, Support URL).

## Inside the app

The app shows these documents itself (Settings → Legal & safety, the sign-up screen, and the Dare screen), from a copy in `src/lib/legalDocs.ts`. After editing anything in this folder, run `node scripts/sync-legal.mjs` so the app gets the new text. If the Terms or the Dare Safety Rules change in a way people must agree to again, also bump `TERMS_VERSION` / `DARE_RULES_VERSION` in `src/lib/legal.ts` – everyone is then asked to accept the new version.
