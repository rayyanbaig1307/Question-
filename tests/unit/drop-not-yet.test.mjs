import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// From midnight until today's drop goes off, nobody can post a drop: yesterday's is over and today's hasn't
// happened. dropNotYetAt (src/lib/drop.ts) says when today's goes off in that time, so a friend's locked drop shows
// "⏰ Today's drop is at 5:13 PM" instead of an "Open camera" button that only led to "Your drop didn't post"
// (the owner's screenshot, 26 Nov, 2:32 AM).
const drop = loadLibrary('drop', { mocks: { react: { useEffect() {}, useState: (start) => [typeof start === 'function' ? start() : start, () => {}], useSyncExternalStore: (_s, get) => get(), useMemo: (make) => make() } } });

it('gives the time of today\'s drop only before it has gone off', () => {
  const day = '2026-11-26';
  const at = drop.dropAt(day);
  const midnight = new Date(2026, 10, 26, 0, 0);
  const halfPast2 = new Date(2026, 10, 26, 2, 32);
  const clock = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  expect(drop.dropNotYetAt(midnight)).toBe(clock);
  expect(drop.dropNotYetAt(halfPast2)).toBe(clock);
  expect(drop.dropNotYetAt(new Date(at.getTime() - 1000))).toBe(clock);
  // Live, then late: the camera button is back.
  expect(drop.dropNotYetAt(at)).toBeNull();
  expect(drop.dropNotYetAt(new Date(at.getTime() + 60 * 60 * 1000))).toBeNull();
  expect(drop.dropNotYetAt(new Date(2026, 10, 26, 23, 59))).toBeNull();
});
