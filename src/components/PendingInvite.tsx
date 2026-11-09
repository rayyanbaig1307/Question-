import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { readPendingInvite } from '@/lib/invite';

// An invite link you opened before you were in the app (for example before logging in or signing up) is kept
// on the phone for up to 7 days. Once you're in (after setting up your profile), this opens it – once.
// You still have to tap "Add" yourself: nothing happens by itself. The invite screen forgets the saved
// invite when you've dealt with it.
export function PendingInvite() {
  const pathname = usePathname();
  const where = useRef(pathname);
  useEffect(() => {
    where.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    readPendingInvite()
      .then((code) => {
        // Already looking at an invite (the link opened it directly): don't open it twice.
        if (cancelled || !code || where.current.startsWith('/invite')) return;
        router.push(`/invite/${code}`);
      })
      .catch((error) => console.warn('Could not open your invite', error));
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
