import { useEffect, useState, useSyncExternalStore } from 'react';

import { supabase } from './supabase';
import type { PostWithAuthor } from './types';

// Community dares that replaced the built-in dare on a given day (filled in by lib/communityDares).
// Screens that show a dare use `useDare(day)`, so they redraw the moment one arrives.
const overrides = new Map<string, { text: string; author: string }>();
const listeners = new Set<() => void>();
let version = 0;

export function setDareOverride(day: string, dare: { text: string; author: string }) {
  const current = overrides.get(day);
  if (current && current.text === dare.text && current.author === dare.author) return;
  overrides.set(day, dare);
  version += 1;
  listeners.forEach((listener) => listener());
}

export function allDareOverrides(): Record<string, { text: string; author: string }> {
  return Object.fromEntries(overrides);
}

// One dare per day, the same for everyone. Bold, messy and funny – but never actually dangerous.
// The list is a year long, so a dare only comes round again after 365 days.
// House rules (shown on the Dare screen): nothing that can hurt anyone, no fire, clothes stay on,
// friends have to be in on it, and nothing that'll get you in trouble.
export const DARE_RULES = 'House rules: nobody gets hurt · no fire · clothes stay on · friends must be in on it';

export const DARES = [
  // 💦 Water
  'Cannonball into a pool, lake or sea with ALL your clothes on',
  'Get a friend to dump a bucket of ice water on your head',
  'Run through a sprinkler in your nicest outfit',
  'Water balloon fight – film the biggest splat',
  'Stand under a cold shower for 30 seconds in your clothes. No screaming.',
  'Belly flop. Yes, really. Film it.',
  'Drink a glass of water while doing a handstand against a wall',
  'Ride a bike or scooter straight through the biggest puddle you can find',
  'Dunk your whole head in a sink of cold water and come up smiling',
  'Have a water gun duel at 10 paces',
  'Jump in a fountain, pool or sea at sunrise or sunset',
  'Wash your hair in a public fountain or garden hose',
  'Fill your shoes with water and walk 20 steps',
  'Get soaked by a wave on purpose',
  'Pour a bottle of water over your head in the middle of a conversation, keep talking normally',
  'Slip and slide: tarp, hose, dish soap, go',
  'Sit on a water balloon until it pops',
  'Do a cartwheel into a pool',
  'Get a friend to spray you with a hose while you eat a sandwich',
  'Bob for apples in a bucket – no hands',
  'Float on your back in a lake or pool for a whole minute, fully dressed',
  'Make it rain: friend on a balcony, you below, one jug of water',
  'Walk through a car wash hand-held hose zone with the brush going',
  'Shower with your sunglasses on and act like it\'s totally normal',
  'Swim one length holding a rubber duck above the water',
  'Wade into the sea or a river until it\'s up to your knees – in jeans',
  'Have an ice cube put down the back of your shirt and don\'t react',
  'Fill a kiddie pool with cold water and sit in it reading a book',
  'Get hit by three water balloons in a row without flinching',
  'Jump off a diving board or pool edge doing the silliest pose mid-air',

  // 🍋 Food
  'Eat a whole lemon like an apple',
  'Crack an egg on a friend\'s head (they get to crack one on yours)',
  'Pie in the face: whipped cream, paper plate, friend',
  'Eat a spoonful of hot sauce with a straight face',
  'Let a friend blindfold you and feed you three mystery foods. Guess them.',
  'Drink a cup of pickle juice in one go',
  'Eat ice cream with ketchup on top. Finish it.',
  'Make a smoothie out of three random things in the fridge and drink it',
  'Eat a raw onion slice like a cracker',
  'Egg roulette: six eggs, some boiled, some raw – smash one on your forehead',
  'Chug a glass of milk, then do 10 jumping jacks',
  'Eat a spoonful of mustard',
  'Let a friend squeeze a whole lime into your mouth',
  'Dip a fry in a milkshake, then in mayo, then eat it',
  'Eat a whole clove of garlic. Breathe on a friend.',
  'Wear a blindfold and spread peanut butter on a friend\'s face. Their turn next.',
  'Eat a bowl of cereal with orange juice instead of milk',
  'Try a baby food jar and rate it',
  'Food fight in the kitchen: one handful each, then clean up',
  'Eat a spoonful of the sourest candy you can find without pulling a face',
  'Eat a whole chilli pepper (a mild one is fine, we\'re not animals)',
  'Make a sandwich with your eyes closed and eat whatever you made',
  'Eat a slice of bread in under 20 seconds, no water',
  'Let a friend pour syrup on your hand and lick it off like a dog',
  'Drink a mystery drink a friend mixed from three things in the fridge',
  'Smash a cake with your face, no hands',
  'Eat something while hanging upside down off the couch',
  'Pour cereal into your pocket and eat it from there all day',
  'Eat a spoonful of flour and try to whistle',
  'Lick the floor of your kitchen (sweep first, you monster)',
  'Eat a marshmallow off a friend\'s forehead, no hands',
  'Eat a hot dog with chocolate sauce',
  'Chug a can of soda, then say the alphabet without burping',
  'Try the weirdest flavour of chips in the store and finish the bag',
  'Eat a whole banana without using your hands',
  'Stuff as many grapes in your mouth as you can and say your name',
  'Eat breakfast in the shower',
  'Order the most ridiculous custom drink you can invent at a café',
  'Eat your lunch with a toothpick only',
  'Let a friend dress you up in whipped cream and sprinkles',

  // 😈 Friends (they have to be in on it!)
  'Flour bomb a friend (a handful, from behind, with a laugh)',
  'Wake a friend up with an air horn or pots and pans',
  'Carry a friend on your back for a whole block',
  'Wrap a friend in toilet paper like a mummy – full body',
  'Give a friend a wet willy and run',
  'Plastic wrap a friend\'s doorway and film them walking into it',
  'Swap outfits with a friend for an hour',
  'Draw on a sleeping friend\'s face with washable marker',
  'Fill a friend\'s shoes with cereal',
  'Piggyback race against another pair',
  'Have a friend push you around a store in the shopping cart',
  'Give a friend a dramatic slow-motion high five that misses',
  'Shaving cream fight – one can each',
  'Let a friend do your makeup with their eyes closed',
  'Wrestle a friend in the mud or wet grass',
  'Let a friend give you a haircut… of one single hair',
  'Stick 20 sticky notes on a friend without them noticing',
  'Pour a cold drink down a friend\'s back in public',
  'Human wheelbarrow race across the yard',
  'Hide in a friend\'s closet and jump out',
  'Let a friend slap you with a slice of ham',
  'Sumo wrestle a friend wearing pillows under your shirts',
  'Carry a friend bridal-style into a shop and ask for a table for two',
  'Have a friend spray you with silly string head to toe',
  'Tickle fight to the death (okay, 30 seconds)',
  'Egg a friend\'s car with… a boiled egg, gently. Then wash it.',
  'Let a friend put makeup on you in public',
  'Arm wrestle three friends in a row',
  'Give a friend a piggyback up a full flight of stairs',
  'Let a friend push you down a grassy hill in a laundry basket',
  'Thumb war a stranger (ask nicely)',
  'Dance battle a friend in a car park',
  'Hold a friend\'s hand everywhere for an hour, no explanation',
  'Have a friend hit you with a pillow every time you say "um" for an hour',
  'Let a friend draw a face on your belly and make it talk',
  'Chase a friend with a water pistol until they surrender',
  'Pin a friend down and tickle until they say the password',
  'Get three friends to carry you like a king through a mall',
  'Trade phones with a friend for an hour. No peeking rules.',
  'Scare a friend around a corner. Film the scream.',

  // 🏙️ Public silliness
  'Sing the chorus of a song out loud in a store',
  'Walk through a mall like a runway model, full attitude',
  'Lie on the floor of a shop like it\'s a beach',
  'Dance in the middle of a crosswalk (while the light\'s green!)',
  'Order fast food in a terrible accent and keep it up',
  'Ask a stranger to take a photo of you doing a superhero pose',
  'Do 20 push-ups in the middle of a busy place',
  'Walk backwards through the whole supermarket',
  'Slow dance with a lamp post',
  'Do the worm on the floor of a shopping centre',
  'Wear a towel as a cape in public all afternoon',
  'Hold a "FREE HUGS" sign for 10 minutes',
  'Narrate everything you do out loud in a David Attenborough voice while shopping',
  'Ride a kids\' coin ride outside the supermarket',
  'Pretend a shop mannequin is your friend and have a chat',
  'Do a full cartwheel in a public square',
  'Walk a banana on a leash',
  'Make a strangers\' day: give 5 compliments in 5 minutes',
  'Sit on the floor of an elevator for a whole ride',
  'Ask for directions to somewhere you\'re standing right in front of',
  'Do a plank on a bench in a busy park',
  'Wear swimming goggles all day. Everywhere.',
  'Have a tea party on the floor of a hardware store',
  'Gallop like a horse through a car park',
  'Try on the most ridiculous outfit in a clothes shop and walk out of the changing room like a star',
  'Yell "I LOVE THIS TOWN" from a bridge or hill',
  'Start a conga line with at least three strangers',
  'Play air guitar at full power in a shop with music on',
  'Lie down in the frozen food aisle for 10 seconds',
  'Wear your clothes inside out all day',
  'Do a dramatic death scene on a park bench',
  'Walk into a bakery and ask if they sell cars',
  'Moonwalk past a security guard',
  'Carry a cardboard box and tell people your pet rock is sleeping in it',
  'Say "hello" to every single person you pass for 5 minutes',
  'Ride a scooter or bike while singing opera',
  'Do a fake interview with a stranger: "how does it feel to be here today?"',
  'Hold the door for people for 10 minutes and bow each time',
  'Wear a party hat to the supermarket',
  'Jog on the spot at a bus stop until the bus comes',
  'Read a kids\' book aloud to a friend on a bench, with voices',
  'Pretend to be a tour guide and give three strangers a tour of the car park',
  'Start a round of applause for nothing in a busy place',
  'High-five 10 strangers',
  'Walk into a shop and announce "I have arrived"',

  // 🌲 Outdoors & adventure
  'Climb a tree as high as you can safely go and take a selfie',
  'Roll down a grassy hill',
  'Jump in the biggest pile of leaves or snow you can find',
  'Mud slide. Find mud. Slide.',
  'Build a sandcastle, then stomp it like Godzilla',
  'Run barefoot across a field',
  'Lie in the rain for a full minute',
  'Snowball fight (or water balloon fight if it\'s summer)',
  'Hike to the highest point you can reach today and shout from the top',
  'Swing as high as you can on a swing set and jump off',
  'Make a snow angel – or a mud angel – in whatever is on the ground',
  'Pick up 10 pieces of litter in a park, like a hero',
  'Do a cartwheel on the beach',
  'Hang from the monkey bars for a whole minute',
  'Skip stones until one skips five times',
  'Howl at the moon tonight',
  'Catch a bug and give it a name',
  'Climb a hill and roll a giant snowball or rock down it (nobody below!)',
  'Hug a tree for 30 seconds. Really hug it.',
  'Jump across a stream. Film the landing, dry or not.',
  'Walk through a field of long grass like you\'re in a movie',
  'Go down a kids\' slide head first',
  'Find a hill and sprint down it screaming',
  'Have a picnic on the roof of a car (parked, engine off)',
  'Make a mud mask and wear it for 10 minutes',
  'Run into the sea until a wave knocks you over',
  'Go outside right now and do 50 star jumps',
  'Race a friend up a hill',
  'Spin until you fall over on soft grass',
  'Build a fort out of sticks big enough to sit in',
  'Do yoga in the middle of a field',
  'Dig a hole big enough to sit in',
  'Walk through a stream in your shoes',
  'Catch raindrops or snowflakes in your mouth',
  'Stand on a rock and strike a lion king pose',
  'Have a mud fight',
  'Sprint across the beach and belly-slide into the shallows',
  'Pitch a tent in the living room or garden and sleep in it',
  'Find a hill, lie at the top, roll all the way down',
  'Take a cold dip in a river, lake or sea – 10 seconds minimum',

  // 💪 Body challenges
  '50 push-ups. Today. Film the last 10.',
  'Hold a plank for 2 minutes',
  'Do a handstand against a wall for 30 seconds',
  'Wall sit for 90 seconds',
  'Run up and down the stairs 10 times',
  '100 squats before dinner',
  'Hop on one foot for 2 minutes without stopping',
  'Crab walk across a room',
  'Try to touch your toes with your tongue out, pushing a little further every try',
  'Do 20 burpees in a public place',
  'Spin around 20 times then try to walk a straight line',
  'Bear crawl around the block',
  'Pull-ups until you can\'t: show the number',
  'Duck walk through the whole house',
  'Hold a wheelbarrow with a friend holding your legs for 100 steps',
  'Jump rope 100 times without a miss',
  'Do a cartwheel. If you can\'t, do a terrible one.',
  'Balance a book on your head and walk up the stairs',
  'Stand on one leg with eyes closed for 60 seconds',
  'Do the splits (or your best attempt – pain face included)',
  'Pillow fight until you\'re out of breath',
  'Sprint 100 metres as fast as you can and film the finish face',
  'Hold a bridge pose for a minute',
  'Walk on your hands as far as you can (with a spotter)',
  'Hula hoop for 2 minutes straight',
  'Hold a squat while a friend sits on your knees',
  'Do 10 push-ups with a friend on your back',
  'Try to do a backflip onto a bed or trampoline',
  'Climb a rope, a pole or a doorframe',
  'Run a mile right now. No training. Go.',
  'Roll down the stairs… on your bum, one step at a time',
  'Limbo under a broom held as low as it goes',
  'Do 30 sit-ups with a friend holding your feet, singing the whole time',
  'Hold a plank while a friend puts things on your back',
  'Jump as high as you can and touch something you\'ve never touched',

  // 🤡 Looks & costume
  'Wear a full costume to the shops: dinosaur, banana, whatever you\'ve got',
  'Let a friend give you a ridiculous face paint and keep it on all day',
  'Draw a mustache on yourself in permanent-ish marker and go out',
  'Put your pants on your head and wear them as a hat in public',
  'Wear socks on your hands for an hour',
  'Tape your nose up like a pig and go order a coffee',
  'Wear a bin bag as a dress or cape to the corner shop',
  'Slick your hair back with jam',
  'Wear your clothes backwards and go for a walk',
  'Draw glasses on your face and wear them with pride',
  'Make a hat out of a plastic bowl and wear it out',
  'Cover your face in stickers',
  'Wear a mask of your own face (print it or draw it)',
  'Make a beard out of cotton wool and go out',
  'Put on every single hat you own at once',
  'Wear a towel as a turban and a robe all day',
  'Let a friend pick your outfit from a thrift store for $10',
  'Wear mismatched shoes all day',
  'Go out with one eyebrow drawn thicker than the other',
  'Paint your face like a cat and visit a pet shop',
  'Wear oven gloves for an hour and try to do normal stuff',
  'Tape a cardboard sign to your back that says "poke me"',
  'Wear a crown made of foil to dinner',
  'Draw a six-pack on your stomach and show it off',
  'Wear a onesie to the supermarket',
  'Make a wig out of mop strings',
  'Wear swim fins to the shops',
  'Wrap your head in a scarf like a mummy and ask for directions',
  'Wear every ring, necklace and bracelet you own at once',
  'Put a sock on your nose and go for a walk',
  'Go out in full pyjamas and slippers',
  'Wear a cape and refuse to explain why',
  'Draw tattoos all over your arms with marker',
  'Get a friend to give you a mullet with a hair clip and hairspray',
  'Wear a giant bow on your head all day',

  // 🗣️ Talking to people
  'Ask a stranger for their best dad joke',
  'Tell a shop worker they\'re doing an amazing job, with a bow',
  'Ask a stranger to arm wrestle',
  'Sing happy birthday to someone whose birthday it isn\'t',
  'Ask for a high five from someone in a suit',
  'Give a dramatic motivational speech to a queue of people',
  'Ask a stranger what their favourite dinosaur is',
  'Propose to a friend in public with a ring pop',
  'Ask someone to rate your dance moves out of 10',
  'Call a friend and talk only in song lyrics',
  'Tell a stranger a secret (a made-up one)',
  'Ask a shop assistant for "the usual"',
  'Order your food in rhymes',
  'Ask a random person to be your best friend. Shake on it.',
  'Give a stranger a flower you picked',
  'Ask a group of people to do a group photo with you',
  'Speak only in whispers for an hour, even in a shop',
  'Tell a joke to a bus driver',
  'Ask someone to teach you one word in another language',
  'Thank a stranger for "everything"',
  'Challenge a stranger to rock paper scissors',
  'Ask someone to help you find a pet… that doesn\'t exist',
  'Have a full conversation with a dog',
  'Ask a stranger what you should name your left foot',
  'Compliment someone\'s shoes in the most over-the-top way possible',
  'Ask someone to check if your tag is sticking out, then say thanks and give them a sticker',
  'Call a family member and only say "yes" and "no"',
  'Introduce yourself to someone with a made-up name and a backstory',
  'Ask a stranger to recommend a song, then play it right there',
  'Get someone to say "cheese" with you in a photo',

  // 🎨 Creative chaos
  'Paint with your feet',
  'Make a music video in the shower (clothes on)',
  'Build a fort and refuse to leave it for an hour',
  'Draw a portrait of a friend using only ketchup',
  'Make a full music video with a broom as a guitar',
  'Write a rap about your lunch and perform it',
  'Make a sculpture out of everything in your fridge',
  'Recreate a famous movie scene in your kitchen',
  'Make a stop-motion with toys and your sandwich',
  'Do a fake weather report from your window',
  'Make a costume out of cardboard in 10 minutes and wear it out',
  'Film a dramatic trailer for your day',
  'Make a mural on your face with lipstick',
  'Do an interpretive dance of your morning',
  'Build a slide out of your mattress and the stairs',
  'Make the loudest instrument you can out of kitchen stuff',
  'Sculpt a friend\'s face out of mashed potatoes',
  'Draw a full comic strip about your pet in 5 minutes',
  'Make a lip-sync video with your reflection as the backup dancer',
  'Build a Rube Goldberg machine that pours a glass of water',
  'Make a dress out of newspaper and wear it',
  'Paint a picture with a toothbrush',
  'Make up a handshake with 10 moves and teach it to someone',
  'Cover a whole wall in sticky notes and write a message',
  'Make a sock puppet and interview someone with it',
  'Direct a 10-second horror movie starring a potato',
  'Decorate your bike or car with balloons and ride around',
  'Make a crown out of candy and wear it',
  'Do a magic trick for a stranger (bad tricks count)',
  'Draw a mustache on 10 things in your house',
  'Make an obstacle course in your living room and run it',
  'Spell a word with your body with friends',
  'Make a trampoline dance routine',
  'Write a love letter to your fridge and read it out loud',
  'Make a giant paper airplane and launch it from somewhere high (and safe)',

  // 🌙 Home chaos & night
  'Pillow fight in the dark',
  'Eat dinner under the table',
  'Sleep on the trampoline or balcony tonight (blanket allowed)',
  'Run a lap around your house at midnight. Barefoot.',
  'Have a dance party in the kitchen with the lights off and torches',
  'Hide and seek at night with the lights off',
  'Make a bed out of couch cushions on the floor and sleep there',
  'Do 100 jumping jacks before you\'re allowed to go to bed',
  'Go outside and stargaze lying on the roof of a car',
  'Make pancakes at midnight and eat them in bed',
  'Go for a walk at 5am and take a photo of the sunrise',
  'Have a midnight snack picnic on the floor with candles (fake ones!)',
  'Howl like a wolf out the window tonight',
  'Do a scary story night with a torch under your chin',
  'Sleep with your head at the foot of the bed',
  'Build a blanket fort big enough for 3 people',
  'Brush your teeth with your eyes closed, no mess allowed',
  'Wear a sleeping bag like a worm and race a friend',
  'Make breakfast for your whole house before anyone wakes up',
  'Do a lap of the block in your pyjamas',
  'Sit in the bath fully clothed and read',
  'Clean your room in 10 minutes flat. Before and after photos.',
  'Make a bed on the trampoline and watch the stars',
  'Do a silent disco in your room with the window open',
  'Stand in the garden at night and sing one whole song',
  'Have a pillow pancake stack contest on your head',
  'Move your bed to a different room for the night',
  'Shower in the dark',
  'Eat an entire meal with your non-dominant hand',
  'Build a tower of every pillow in the house and knock it down',
  'Nap in the bathtub (empty, with a pillow)',
  'Sleep in a tent in the living room',
  'Do a cartwheel in every room of the house',
  'Spend the whole evening only walking backwards',
  'Make a cup of tea for every person in your house and deliver it like a butler',
];

// A new dare starts every day at 10:00 UTC (6am in New York) – the same moment for everyone.
// The database uses the same rule (see supabase/migrations/20261028000000_daily_dare.sql).
const NEW_DARE_HOUR_UTC = 10;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Today's dare day, like "2026-10-28".
export function todayDareDay(now = Date.now()): string {
  return new Date(now - NEW_DARE_HOUR_UTC * HOUR).toISOString().slice(0, 10);
}

export type Dare = {
  number: number;
  text: string;
  // Set when a community idea ran that day: the @username of whoever suggested it.
  author?: string;
};

// The dare for a given day: a community dare if one ran, otherwise its number in the list and the text.
export function dareFor(day: string): Dare {
  const daysSince1970 = Math.round(Date.parse(`${day}T00:00:00Z`) / DAY);
  const index = ((daysSince1970 % DARES.length) + DARES.length) % DARES.length;
  const override = overrides.get(day);
  if (override) return { number: index + 1, text: override.text, author: override.author };
  return { number: index + 1, text: DARES[index] };
}

// The same, for screens: redraws when a community dare for that day shows up.
export function useDare(day: string): Dare {
  // Subscribing here makes the screen redraw whenever an override arrives.
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return dareFor(day);
}

// When the next dare starts after the given dare day (in milliseconds since 1970).
export function nextDareAt(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) + DAY + NEW_DARE_HOUR_UTC * HOUR;
}

// "5h 03m 12s"
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

// Everyone's posts for one day's dare that you're allowed to see, newest first.
// (Private accounts only show up for their friends – the database makes sure of that.)
export async function fetchDarePosts(day: string): Promise<PostWithAuthor[]> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, group_hold, author:profiles!posts_user_id_fkey(*)')
    .eq('dare_day', day)
    .order('created_at', { ascending: false })
    .limit(120);
  if (error) throw error;
  return (data ?? []) as PostWithAuthor[];
}

// Have I already done today's dare? Checked whenever `enabled` turns on. `null` = still checking.
export function useDareDone(me: string, enabled: boolean): boolean | null {
  const [done, setDone] = useState<{ day: string; done: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const day = todayDareDay();
    supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', me)
      .eq('dare_day', day)
      .then(({ count, error }) => {
        if (!error) setDone({ day, done: (count ?? 0) > 0 });
      });
  }, [me, enabled]);
  return done?.day === todayDareDay() ? done.done : null;
}
