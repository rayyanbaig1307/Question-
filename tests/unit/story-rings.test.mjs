import { expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// The shared list of who has a story (src/lib/storyRings.ts), with a stand-in clock and stand-in story loads.
function setup() {
  const clock = { now: 1_000_000 };
  const loads = [];
  const fetchStoryRings = vi.fn((me) => new Promise((resolve, reject) => loads.push({ me, resolve, reject })));
  const lib = loadLibrary('storyRings', {
    mocks: {
      './stories': { fetchStoryRings },
      react: { useEffect() {}, useSyncExternalStore: (_subscribe, read) => read() },
    },
    globals: { Date: { now: () => clock.now } },
  });
  return { lib, clock, loads, fetchStoryRings };
}
const ring = (id, { allSeen = false, closeFriends = false, stories = 1 } = {}) => ({
  author: { id }, stories: Array.from({ length: stories }, (_, n) => ({ id: `${id}-${n}` })), allSeen, closeFriends,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const plain = (value) => JSON.parse(JSON.stringify(value));

it('turns the story rings into badges: yours and friends\', watched or not, close friends, never an empty ring', () => {
  const { lib } = setup();
  const badges = lib.badgesFromRings({ mine: ring('me'), friends: [ring('bob', { allSeen: true }), ring('cara', { closeFriends: true }), ring('dan', { stories: 0 })] });
  expect(plain([...badges])).toEqual([
    ['me', { allSeen: false, closeFriends: false }],
    ['bob', { allSeen: true, closeFriends: false }],
    ['cara', { allSeen: false, closeFriends: true }],
  ]);
});

it('Home\'s list is shared at once; a picture asks again only after 30 seconds (or when forced)', async () => {
  const { lib, clock, loads, fetchStoryRings } = setup();
  lib.setStoryRings('me', { mine: null, friends: [ring('bob')] });
  expect(plain(lib.useStoryBadge('me', 'bob'))).toEqual({ allSeen: false, closeFriends: false });
  expect(lib.useStoryBadge('me', 'cara')).toBe(null);
  await lib.refreshStoryBadges('me');
  expect(fetchStoryRings).not.toHaveBeenCalled();
  clock.now += 31_000;
  const again = lib.refreshStoryBadges('me');
  expect(lib.refreshStoryBadges('me')).toBe(again);  // pictures showing at the same moment share one load
  expect(fetchStoryRings).toHaveBeenCalledTimes(1);
  loads[0].resolve({ mine: null, friends: [ring('bob', { allSeen: true })] });
  await again;
  expect(lib.useStoryBadge('me', 'bob').allSeen).toBe(true);
  const forced = lib.refreshStoryBadges('me', true);
  expect(fetchStoryRings).toHaveBeenCalledTimes(2);
  loads[1].resolve({ mine: null, friends: [] });
  await forced;
  expect(lib.useStoryBadge('me', 'bob')).toBe(null);
});

it('a slow older answer never brings back a ring that a newer answer took away', async () => {
  const { lib, loads } = setup();
  const older = lib.refreshStoryBadges('me');
  const newer = lib.refreshStoryBadges('me', true); // e.g. you just closed a story and Bob deleted his
  loads[1].resolve({ mine: null, friends: [] });
  await newer;
  loads[0].resolve({ mine: null, friends: [ring('bob')] });
  await older;
  expect(lib.useStoryBadge('me', 'bob')).toBe(null);
});

it('a failed load keeps the rings already shown', async () => {
  const { lib, clock, loads } = setup();
  lib.setStoryRings('me', { mine: null, friends: [ring('bob')] });
  clock.now += 31_000;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failed = lib.refreshStoryBadges('me');
  loads[0].reject(new Error('Network request failed'));
  await failed;
  warn.mockRestore();
  expect(lib.useStoryBadge('me', 'bob')).not.toBe(null);
});

it('another account never sees the previous account\'s rings, not even from a load that was still on its way', async () => {
  const { lib, loads } = setup();
  const first = lib.refreshStoryBadges('alice');
  lib.refreshStoryBadges('zed');
  expect(lib.useStoryBadge('zed', 'bob')).toBe(null);
  loads[0].resolve({ mine: null, friends: [ring('bob')] });
  await first;
  await flush();
  expect(lib.useStoryBadge('zed', 'bob')).toBe(null);
  expect(lib.useStoryBadge('alice', 'bob')).toBe(null);
  loads[1].resolve({ mine: null, friends: [ring('cara')] });
  await flush();
  expect(lib.useStoryBadge('zed', 'cara')).not.toBe(null);
});
