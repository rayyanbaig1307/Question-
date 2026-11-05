import { useMe } from './auth';

// ---------------------------------------------------------------------------
// Peekaboo+ ⭐ – who has it.
//
// For now (while Peekaboo+ is being tested) it's switched on only for the testers below, so the owner can try
// every Plus feature inside the app before it's for sale. When payments go live this will also check the
// server (public.plus_members, written by the RevenueCat webhook) and RevenueCat on the phone.
// ---------------------------------------------------------------------------

// The owner's account (@coolname).
const TESTERS = new Set(['d3614487-2fa7-477c-8b64-be66ce1f5f3f']);

export function hasPlus(userId: string | null | undefined): boolean {
  return !!userId && TESTERS.has(userId);
}

// True when the person using the app has Peekaboo+.
export function usePlus(): boolean {
  const { userId } = useMe();
  return hasPlus(userId);
}
