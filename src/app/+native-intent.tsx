import AsyncStorage from '@react-native-async-storage/async-storage';

import { inviteCodeFromUrl, PENDING_INVITE_KEY, pendingInviteToSave } from '@/lib/inviteCode';

// Every link that opens the app passes through here first – even before you're logged in.
// Only invite links (peekaboo://invite/<code>) are touched: the code is saved on the phone, so it isn't lost
// if you still have to log in or sign up first (components/PendingInvite.tsx opens it once you're in), and
// the app goes to /invite/<code>. Every other link is passed on exactly as it came.
// Nothing in here may ever throw: a crash here would stop the app from opening.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | Promise<string> {
  let code: string | null = null;
  try {
    code = inviteCodeFromUrl(path);
  } catch {
    return path;
  }
  if (!code) return path;
  const destination = `/invite/${code}`;
  return saveInvite(code).then(
    () => destination,
    () => destination,
  );
}

// Saves the invite, but never makes the app wait more than a moment for it.
function saveInvite(code: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    try {
      AsyncStorage.setItem(PENDING_INVITE_KEY, pendingInviteToSave(code, Date.now()))
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
