import { File, Paths } from 'expo-file-system';
import { useCallback, useState } from 'react';

import { usePlus } from './plus';

// ---------------------------------------------------------------------------
// Moving chat backgrounds (Peekaboo+ ⭐) – which one you picked for each chat.
//
// The choice is kept in a tiny file on this phone only, so only you see it. It's a list like
// { "<friend id>": "night", "group:<group id>": "candy" }.
// ---------------------------------------------------------------------------

const BACKGROUNDS_FILE = 'peekaboo-chat-backgrounds.json';

// The saved choices, read from the file the first time they're needed.
let saved: Record<string, string> | null = null;

function readSaved(): Record<string, string> {
  if (saved) return saved;
  saved = {};
  try {
    const file = new File(Paths.document, BACKGROUNDS_FILE);
    if (file.exists) {
      const parsed: unknown = JSON.parse(file.textSync());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') saved[key] = value;
        }
      }
    }
  } catch {
    // nothing saved yet (or the file was broken) – start fresh
  }
  return saved;
}

// The name a chat is saved under: a 1-on-1 chat by your friend's id, a group chat by "group:<id>".
export function friendChatKey(friendId: string): string {
  return friendId;
}

export function groupChatKey(groupId: string): string {
  return `group:${groupId}`;
}

// The background saved for a chat, or null for none.
export function savedChatBackground(chatKey: string): string | null {
  return readSaved()[chatKey] ?? null;
}

// Save (or clear, with null) the background for a chat.
export async function saveChatBackground(chatKey: string, backgroundId: string | null): Promise<void> {
  const all = { ...readSaved() };
  if (backgroundId) all[chatKey] = backgroundId;
  else delete all[chatKey];
  saved = all;
  const file = new File(Paths.document, BACKGROUNDS_FILE);
  if (!file.exists) file.create();
  await file.write(JSON.stringify(all));
}

// For a chat screen: the background you picked, the one to actually show (only with Peekaboo+), and a way to
// change it.
export function useChatBackground(chatKey: string) {
  const plus = usePlus();
  const [picked, setPicked] = useState<string | null>(() => savedChatBackground(chatKey));

  const choose = useCallback(
    async (backgroundId: string | null) => {
      setPicked(backgroundId);
      try {
        await saveChatBackground(chatKey, backgroundId);
      } catch {
        // couldn't save it – it still shows until you leave the chat
      }
    },
    [chatKey],
  );

  return { picked, shown: plus ? picked : null, plus, choose };
}
