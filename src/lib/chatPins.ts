import { File, Paths } from 'expo-file-system';
import { useCallback, useSyncExternalStore } from 'react';

import { useMe } from './auth';
import { usePlus } from './plus';

// ---------------------------------------------------------------------------
// Pinned chats (Peekaboo+ ⭐): up to 3 friends or groups that stay at the top of Chat.
//
// The pins are kept in a tiny file on this phone only, one list per account, like
// { "<your user id>": ["friend:<id>", "group:<id>"] }. The order of the list is the order on screen.
// Without Plus the pins are kept but not shown, so they come back if you get Plus again.
// ---------------------------------------------------------------------------

export const MAX_PINS = 3;

const PINS_FILE = 'peekaboo-chat-pins.json';

// The name a chat is pinned under.
export function pinKeyForFriend(friendId: string): string {
  return `friend:${friendId}`;
}

export function pinKeyForGroup(groupId: string): string {
  return `group:${groupId}`;
}

// What happened when you tapped "Pin to top" / "Unpin".
export type PinResult = 'pinned' | 'unpinned' | 'full' | 'needs-plus';

// Pins or unpins one chat in a list of pins. A new pin goes to the end (below the ones you pinned before).
// `stillThere` says whether a pinned chat still exists (a friend you unfriended, a group you left); pins
// that are gone don't use up one of your 3 places, and they're cleared out when you pin something new.
export function togglePin(
  pins: string[],
  key: string,
  stillThere: (key: string) => boolean = () => true,
): { pins: string[]; result: 'pinned' | 'unpinned' | 'full' } {
  if (pins.includes(key)) return { pins: pins.filter((pin) => pin !== key), result: 'unpinned' };
  const kept = pins.filter(stillThere);
  if (kept.length >= MAX_PINS) return { pins, result: 'full' };
  return { pins: [...kept, key], result: 'pinned' };
}

// Puts pinned items first, in pin order. Everything else keeps its order below them.
export function sortByPins<T>(items: T[], keyOf: (item: T) => string, pins: string[]): T[] {
  if (pins.length === 0) return items;
  const place = (item: T) => {
    const index = pins.indexOf(keyOf(item));
    return index === -1 ? pins.length : index;
  };
  // Array sort keeps equal items in their old order, so unpinned chats stay as they were.
  return [...items].sort((a, b) => place(a) - place(b));
}

// Every account's pins, read from the file the first time they're needed.
let saved: Record<string, string[]> | null = null;
const watchers = new Set<() => void>();

function readSaved(): Record<string, string[]> {
  if (saved) return saved;
  saved = {};
  try {
    const file = new File(Paths.document, PINS_FILE);
    if (file.exists) {
      const parsed: unknown = JSON.parse(file.textSync());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [account, list] of Object.entries(parsed)) {
          if (Array.isArray(list)) {
            saved[account] = list.filter((pin): pin is string => typeof pin === 'string').slice(0, MAX_PINS);
          }
        }
      }
    }
  } catch {
    // nothing saved yet (or the file was broken) – start fresh
  }
  return saved;
}

const NO_PINS: string[] = [];

// The pins saved for one account (an empty list when there are none).
export function savedPins(userId: string | null | undefined): string[] {
  if (!userId) return NO_PINS;
  return readSaved()[userId] ?? NO_PINS;
}

async function savePins(userId: string, pins: string[]): Promise<void> {
  const all = { ...readSaved() };
  if (pins.length > 0) all[userId] = pins;
  else delete all[userId];
  saved = all;
  watchers.forEach((watcher) => watcher());
  const file = new File(Paths.document, PINS_FILE);
  if (!file.exists) file.create();
  await file.write(JSON.stringify(all));
}

function watch(watcher: () => void) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

// For the Chat list: your pins (only with Peekaboo+), and a way to pin or unpin a chat.
export function useChatPins() {
  const { userId } = useMe();
  const plus = usePlus();
  const pins = useSyncExternalStore(watch, () => savedPins(userId));

  const toggle = useCallback(
    async (key: string, stillThere?: (key: string) => boolean): Promise<PinResult> => {
      if (!plus || !userId) return 'needs-plus';
      const change = togglePin(savedPins(userId), key, stillThere);
      if (change.result !== 'full') {
        try {
          await savePins(userId, change.pins);
        } catch (error) {
          // Couldn't write the file: the pin still shows until the app is closed.
          console.warn('Could not save pinned chats', error);
        }
      }
      return change.result;
    },
    [plus, userId],
  );

  return { pins: plus ? pins : NO_PINS, plus, toggle };
}
