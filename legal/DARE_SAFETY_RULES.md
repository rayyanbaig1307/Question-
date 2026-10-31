# Peekaboo – Dare Safety Rules

These rules apply to every dare, forfeit, drop, dare chain, community dare and friend challenge in Peekaboo. They are part of the [Terms of Service](TERMS_OF_SERVICE.md).

## The rules

1. **Dares are optional.** You never have to do one. Skipping costs you nothing that matters.
2. **You decide.** You are the only person who can judge whether a dare is safe and legal for you, right now, where you are. If in doubt, don't.
3. **Nobody gets hurt.** No dare may risk injury to you or anyone else. No hitting, pushing, choking, holding breath contests, jumping from heights, or anything on roofs, balconies, roads or railways.
4. **No water unless you can swim and someone is watching.** Never near water alone, never at night, never when tired or after drinking.
5. **No fire, no weapons, no vehicles.** Nothing involving flames, fireworks, knives, guns, cars, bikes or scooters in traffic, or anything while driving.
6. **No alcohol or drugs.** Not as part of a dare, and not before doing one.
7. **No eating or drinking challenges that could harm you.** No eating things that aren't food, nothing you're allergic to, no very hot peppers or sauces if you have health conditions, no speed-eating or drinking large amounts of anything, and stop the moment you feel unwell.
8. **Only people who agree.** Everyone who takes part or appears on camera must know what's happening and say yes. No pranks on sleeping people, strangers, children or anyone who can't consent. No touching anyone without their clear consent.
9. **Nothing illegal and no damage.** No trespassing, theft, vandalism, disturbing businesses or traffic, or breaking rules of the place you're in (shops, pools, schools, workplaces). If staff ask you to stop, stop.
10. **Nothing humiliating or hateful.** Dares must be fun for everyone, including the people watching. No dares that target someone's body, identity or beliefs.
11. **Under 18?** Only do physical dares with a parent or adult present, and never do a dare a parent wouldn't be okay with.
12. **Film safely.** Don't film while doing something that needs both hands or your full attention. Have a friend film.
13. **Community dares** are written by other users. The same rules apply to them, and you can report any dare idea that breaks these rules. Ideas that break the rules are removed and their authors can be banned.

If you see a dare in Peekaboo that breaks these rules, report it.

## The "I understand" screen (shown once in the app before your first dare, forfeit or drop)

> **Before your first dare 🎯**
>
> Dares are just ideas for fun. You never have to do one.
>
> - Only do a dare if it's **safe and legal** for you, right where you are.
> - **No one gets hurt**: no fire, weapons, vehicles, alcohol, drugs, dangerous stunts or risky eating.
> - **Everyone agrees**: only film and involve people who say yes.
> - **Under 18?** Physical dares only with an adult present.
>
> By continuing you confirm you've read the [Dare Safety Rules], that **you decide what you do and take responsibility for it**, and that Peekaboo doesn't supervise dares and isn't liable for what you choose to do.
>
> [ I understand – let's go ]   [ Not now ]

Implementation note: built. The acceptance (user id + date + rules version) is stored in the `legal_acceptances` table, and the screen shows again if the rules version changes (`DARE_RULES_VERSION` in `src/lib/legal.ts`).

## Dare content review (for the operator)

**Done on 31 October 2026.** Every dare in `src/lib/dares.ts` was checked against the rules above. 63 dares that
broke them were rewritten in the same spot (so the daily order didn't change): open water, cold-water shock,
heights, stairs, vehicles and roads, pranks on sleeping people or without consent, choking and allergy risks, and
"clothes stay on". The full before/after list is in `legal/DARE_REVIEW_2026-10-31.md`.

Keep doing this whenever dares change:

- A dare must not involve open water (sea, lakes, rivers), roads or vehicles, heights, stairs, fire, weapons,
  alcohol or drugs.
- Pool dares say "only if you can swim – with someone watching".
- Pranks only on friends who are in on it, and never while they're asleep.
- No speed-eating, eating non-food, or stuffing the mouth (choking).
- Clothes stay on (the app is 13+).
- Community dare ideas are checked automatically for dangerous words by the database, can be reported, and are
  hidden after 3 reports.
