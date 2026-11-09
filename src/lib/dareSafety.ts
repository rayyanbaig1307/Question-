import { HATEFUL, joinSingles, plainLetters } from './cleanWords';

// ---------------------------------------------------------------------------
// Dare safety 🛡️: dares can't ask anyone to hurt someone (or themselves), rape, abuse, do sexual stuff,
// be hateful, or be spam. This covers every dare people write: chat dares, group dares and community dare
// ideas.
//
// The database runs the very same check (private.dare_problem in
// supabase/migrations/20261224000000_dare_safety.sql), so a changed or old app can't skip it. The rules
// below are copied there word for word: change both together. tests/support/dare-safety-cases.json is run
// against both, so they can't drift apart.
//
// How it works: the dare is tidied first (look-alike letters made plain, "k1ll" → "kill", "r a p e" → "rape"),
// then checked against these lists. Each list is a pattern on the tidied text with a space before and after,
// so only whole words count ("skill" is fine, "kill" isn't).
// ---------------------------------------------------------------------------

export type DareProblem = 'harm' | 'sexual' | 'hate' | 'spam';

// What people see when a dare isn't allowed. The database uses exactly the same sentences.
export const DARE_NOT_ALLOWED: Record<DareProblem, string> = {
  harm: "That dare isn't allowed – no hurting anyone (or yourself), no violence and no abuse. 🙏",
  sexual: "That dare isn't allowed – nothing sexual and no nudity. 🙏",
  hate: "That dare isn't allowed – no hate, bullying or slurs. 🙏",
  spam: "That dare looks like spam – no links, phone numbers or the same thing over and over. 🙏",
};

// "Kill it" / "killing it" means "do great" – that's fine.
const SAFE_PHRASES = ' (kill|kills|killed|killing|slay|slays|slayed|slaying) it ';

const TARGETS =
  '(him|her|them|someone|somebody|anyone|people|a person|a stranger|strangers|a kid|kids|a child|children|a baby|' +
  'an animal|a dog|a cat|your sister|ur sister|your brother|ur brother|your mom|ur mom|your mum|ur mum|your dad|' +
  'ur dad|a girl|a boy|yourself|urself|a teacher|your teacher|ur teacher|a homeless person)';

export const DARE_RULES: Record<Exclude<DareProblem, 'spam'>, string[]> = {
  harm: [
    ' (kill|kills|killed|killing|murder|murders|murdered|murdering|stab|stabs|stabbed|stabbing|strangle|strangles|strangled|strangling|behead|beheaded|beheading|suffocate|suffocating|massacre|kidnap|kidnaps|kidnapped|kidnapping|torture|tortures|tortured|torturing|shoot up|set fire to|arson|bomb threat) ',
    ' (kys|suicide|suicidal|selfharm|self harm|cut yourself|cut urself|hang yourself|hang urself|end your life|end ur life|slit your|slit ur|go die|drink bleach|overdose|starve yourself) ',
    ' (rape|rapes|raped|raping|rapist|molest|molests|molested|molesting|grope|gropes|groped|groping|abuse|abuses|abused|abusing|abuser|assault|assaulted|assaulting) ',
    ` (shoot|shot|punch|punched|kick|kicked|slap|slapped|hit|beat|choke|choked|hurt|attack|attacked|burn|burned|trip|push|pushed|poison|poisoned|drown|drowned|spit on|pee on|piss on) ${TARGETS} `,
    ' beat (up|the shit out of|the crap out of) ',
  ],
  sexual: [
    ' (nude|nudes|naked|nudity|sex|sexting|porn|porno|pornhub|blowjob|handjob|masturbate|masturbating|jerk off|jerking off|jerkoff|cum|horny|onlyfans|strip|stripping|striptease|boob|boobs|tits|titties|dickpic|dick pic|nipple|nipples|pussy|vagina|penis|asshole|condom|panties) ',
    ' (show|send|flash|pic of|picture of|photo of|video of|touch|lick|grab) ([a-z]+ ){0,2}(ass|butt|bum|dick|cock|crotch|privates|private parts|chest|body|boobs|tits|penis|vagina) ',
    ' (take off|remove) ([a-z]+ ){0,2}(clothes|underwear|bra|boxers|panties) ',
  ],
  hate: [
    ' (nazi|nazis|hitler|heil|kkk|white power|hate crime|n word|nword|terrorist|terrorists) ',
    ' (bully|bullies|bullied|bullying|cyberbully|harass|harassing|harassment|stalk|stalking|dox|doxx|doxxing) ',
    ' (call|tell) ([a-z]+ ){0,3}(ugly|fat|fatty|stupid|loser|worthless|disgusting|slut|whore|bitch) ',
  ],
};

// Spam: checked on the dare as typed (in small letters) …
export const SPAM_RAW = [
  'https?://',
  'www\\.',
  '[a-z0-9-]+\\.(com|net|org|io|ly|gg|xyz|me|co|app|link|ru|tk|info|biz)( |/|$)',
  '[0-9][0-9 -]{6,}[0-9]',
];
// … and on the tidied text: one letter 10 times in a row, or one word 5 times in a row.
export const SPAM_TIDY = ['([a-z])\\1\\1\\1\\1\\1\\1\\1\\1\\1', '( [a-z]+)\\1\\1\\1\\1 '];

// "K1LL  @ll" → "kill all": plain letters, small, number-letters swapped back, and only a–z and single spaces.
export function tidyDare(input: string): string {
  return plainLetters(input)
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

// What's wrong with a dare, or null when it's fine.
export function dareProblem(input: string): DareProblem | null {
  const raw = input.toLowerCase();
  const tidied = tidyDare(input);
  const versions = [` ${tidied} `, ` ${joinSingles(tidied)} `].map((text) => text.replace(new RegExp(SAFE_PHRASES, 'g'), ' '));
  // Slurs (the word filter's list), as whole words only, so "be an errand" isn't mistaken for one.
  const slurs = new RegExp(` (${HATEFUL.join('|')}) `);
  if (versions.some((text) => slurs.test(text))) return 'hate';
  for (const problem of ['harm', 'sexual', 'hate'] as const) {
    for (const rule of DARE_RULES[problem]) {
      const pattern = new RegExp(rule);
      if (versions.some((text) => pattern.test(text))) return problem;
    }
  }
  if (SPAM_RAW.some((rule) => new RegExp(rule).test(raw))) return 'spam';
  if (SPAM_TIDY.some((rule) => new RegExp(rule).test(` ${tidied} `))) return 'spam';
  return null;
}

// A friendly sentence for the screen, or null when the dare is fine.
export function checkDare(input: string): string | null {
  const problem = dareProblem(input);
  return problem ? DARE_NOT_ALLOWED[problem] : null;
}
