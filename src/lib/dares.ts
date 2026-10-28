import { useEffect, useState } from 'react';

import { supabase } from './supabase';
import type { PostWithAuthor } from './types';

// One fun, safe dare per day. Everyone gets the same one, and the list starts over after 60 days.
export const DARES = [
  'Take a pic with the ugliest thing in your fridge',
  'Recreate a pose from one of your baby photos',
  'Show us your most chaotic drawer',
  'Your best "I just woke up" face',
  'Find something shaped like a heart',
  'Take a pic of your shoes from the weirdest angle',
  'Make a face that matches your mood today',
  'Show us your favorite mug or cup',
  'Build the tallest tower you can out of cups or books',
  'Take a selfie with a plant',
  'Snap the sky right now',
  'Give a fruit or veggie a face and introduce them',
  'Show us the last thing you ate',
  'Recreate a famous painting with stuff around you',
  'Find something in your favorite color',
  'Show us a pet, a stuffed animal, or a drawing of one',
  'Wear a sock as a hat',
  'Strike your most dramatic villain pose',
  'Snap the coziest spot in your home',
  'Make art out of snacks',
  'Take a pic of something older than you',
  'Write your name with your other hand',
  'Strike a superhero pose',
  'Find a cloud that looks like something',
  'Take a selfie in a reflection that isn\'t a mirror',
  'Show us the weirdest thing in your bag',
  'Do your best magazine cover look',
  'Snap a really cool shadow',
  'Make a tiny movie scene with toys or objects',
  'Take a pic with your favorite book or comic',
  'Your best surprised face 😮',
  'Make a crown out of paper and wear it',
  'Find three things that are the exact same color',
  'Show us your best hiding spot',
  'Draw a mustache on paper and wear it',
  'Snap the most colorful thing around you',
  'Recreate an emoji with your face',
  'Give an object googly eyes (or draw them on paper)',
  'Take a pic of your feet on something interesting',
  'Build a tiny fort for a toy or a snack',
  'Take a pic upside down',
  'Make a sign with your mood today and hold it up',
  'Find a funny-looking rock or leaf',
  'Show us your hair at its wildest',
  'Take a photo through something (a glass, a straw, a fork…)',
  'Line up 5 things from smallest to biggest',
  'Your best "no thoughts, head empty" face',
  'Take a pic of something that makes you happy',
  'Show us your favorite snack (no sharing 😤)',
  'Pose like a statue in a museum',
  'Find a letter of the alphabet hiding in the wild',
  'Find something perfectly symmetrical',
  'Make a hand shadow animal',
  'Snap the cutest thing you can find',
  'Recreate a famous movie poster',
  'Take a pic with your oldest piece of clothing',
  'Your best "I\'m totally not hiding something" face',
  'Turn something random into a phone and "call" us',
  'Find something that looks like a face',
  'Snap your favorite thing about today',
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

// The dare for a given day: its number in the list and the text.
export function dareFor(day: string): { number: number; text: string } {
  const daysSince1970 = Math.round(Date.parse(`${day}T00:00:00Z`) / DAY);
  const index = ((daysSince1970 % DARES.length) + DARES.length) % DARES.length;
  return { number: index + 1, text: DARES[index] };
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
    .select('*, author:profiles!posts_user_id_fkey(*)')
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
