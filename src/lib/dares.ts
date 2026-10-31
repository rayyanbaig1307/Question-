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
  'Text your crush "I had a dream about you last night" and screenshot what they say',
  'Let a friend send one message from your phone to anyone they pick (you get one veto)',
  'Call someone you haven\'t spoken to in a year and keep them talking for 2 minutes',
  'Post the most embarrassing photo in your camera roll to your story for an hour',
  'Send a voice note singing a love song chorus to the last person you texted',
  'Let a friend scroll your camera roll for 30 seconds – no grabbing the phone back',
  'Let a friend change your profile picture to anything they want for 24 hours',
  'Read your last 5 searches out loud on camera',
  'Confess something you\'ve never told this friend group – on camera',
  'Reply "you up?" to the 5th chat in your messages and screenshot the reply',
  'Rate everyone in the group chat out of 10 – honestly, in the chat',
  'Tell the group chat your biggest ick about each person in it',
  'Swap phones with a friend for an hour – no locking apps',
  'Sing a whole song out loud somewhere busy – no stopping halfway',
  'Do 2 minutes of stand-up for your friends, no notes',
  'Wear an outfit your friends pick out in public for an hour',
  'Order your food in a made-up accent and keep it up until you leave',
  'Let a friend write a word on your arm in marker and keep it on all day',
  'Do your best runway walk down a busy street, full attitude, friend filming',
  'Show your screen time report to the group – every app, no hiding',
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
