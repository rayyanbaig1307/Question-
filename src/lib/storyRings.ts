import { useEffect, useSyncExternalStore } from 'react';

import { fetchStoryRings, type StoryRing } from './stories';

// Who has a story you can watch right now, for the ring around profile pictures (StoryAvatar). Shared by every
// screen: loaded once, then again when a screen with pictures opens (at most every 30 seconds), when Home loads
// its stories row, and when you close a story. Only your own story and your friends' stories count (the
// privacy rules don't show anyone else's), and never someone whose stories you hid.
export type StoryBadge = {
  allSeen: boolean; // you've watched all of them (grey ring)
  closeFriends: boolean; // has a close-friends story (green ring)
};

type Rings = { mine: StoryRing | null; friends: StoryRing[] };

const REFRESH_EVERY_MS = 30_000;
const EMPTY: Map<string, StoryBadge> = new Map();

let owner: string | null = null; // the account these badges belong to
let badges: Map<string, StoryBadge> = EMPTY;
let loadedAt = 0;
let loading: Promise<void> | null = null;
// Every load (and every list Home shares) gets the next number; an answer older than the one on screen is
// dropped, so a slow old answer never puts back rings that a newer one took away.
let requests = 0;
let shown = 0;
const listeners = new Set<() => void>();

function publish(me: string, next: Map<string, StoryBadge>, request: number) {
  if (request < shown) return;
  shown = request;
  owner = me;
  badges = next;
  loadedAt = Date.now();
  listeners.forEach((listener) => listener());
}

export function badgesFromRings(rings: Rings): Map<string, StoryBadge> {
  const next = new Map<string, StoryBadge>();
  for (const ring of [...(rings.mine ? [rings.mine] : []), ...rings.friends]) {
    if (ring.stories.length === 0) continue;
    next.set(ring.author.id, { allSeen: ring.allSeen, closeFriends: ring.closeFriends });
  }
  return next;
}

// Home already loads everyone's stories for its row: share them instead of asking again.
export function setStoryRings(me: string, rings: Rings) {
  publish(me, badgesFromRings(rings), ++requests);
}

// Load the badges again (only if they're older than 30 seconds, unless `force`). Never throws: on a failure the
// pictures keep the rings they had.
export function refreshStoryBadges(me: string, force = false): Promise<void> {
  if (!me) return Promise.resolve();
  if (owner !== me) {
    // A different account: forget the old one's badges straight away.
    publish(me, EMPTY, ++requests);
    loadedAt = 0;
    loading = null;
  }
  if (!force && Date.now() - loadedAt < REFRESH_EVERY_MS) return Promise.resolve();
  if (loading && !force) return loading;
  const number = ++requests;
  const request = fetchStoryRings(me)
    .then((rings) => {
      // Dropped if the account changed meanwhile (or a newer answer is already on screen).
      if (owner === me) publish(me, badgesFromRings(rings), number);
    })
    .catch((error) => console.warn('Could not check who has a story', error))
    .finally(() => {
      if (loading === request) loading = null;
    });
  loading = request;
  return request;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// This person's story badge (null: no story to watch). Checks for new stories when a picture first shows.
export function useStoryBadge(me: string, personId: string | null | undefined): StoryBadge | null {
  const current = useSyncExternalStore(subscribe, () => badges, () => badges);
  useEffect(() => {
    if (me) void refreshStoryBadges(me);
  }, [me]);
  if (!personId || owner !== me) return null;
  return current.get(personId) ?? null;
}
