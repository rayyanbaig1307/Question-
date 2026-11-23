import { NAME_NOT_ALLOWED, WORD_NOT_ALLOWED } from './cleanWords';

// Turns technical error messages into simple, friendly ones.
export function friendlyError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error ?? '');
  const lower = message.toLowerCase();

  // The server's word filter said no (error code 23514). It sends the same sentence the app shows.
  if (lower.includes(NAME_NOT_ALLOWED.toLowerCase())) return NAME_NOT_ALLOWED;
  if (lower.includes(WORD_NOT_ALLOWED.toLowerCase())) return WORD_NOT_ALLOWED;

  if (lower.includes('invalid login credentials')) {
    return "That email or password doesn't look right. Try again!";
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return 'There is already an account with this email. Try logging in instead.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Almost there! Open the email we sent you and tap the link, then log in.';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Whoa, too many tries! Wait a minute and try again.';
  }
  // A request that got no answer in time was given up (lib/timedFetch.ts): the same as no internet.
  // "fetch failed: …" is how the phone's own fetch (expo/fetch) says it couldn't reach the server at all
  // (no signal, the connection dropped, the request was cancelled).
  if (
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('fetch failed') ||
    lower.includes('aborterror') ||
    lower.includes('aborted') ||
    lower.includes('timed out')
  ) {
    return "Can't reach the internet. Check your connection and try again.";
  }
  if (lower.includes('profiles_username_key') || (lower.includes('duplicate') && lower.includes('username'))) {
    return 'That username is already taken. Try another one!';
  }
  if (lower.includes('profiles_username_format')) {
    return 'Usernames can only use lowercase letters, numbers, dots and underscores (3–20 characters).';
  }
  if (lower.includes('posts_one_drop_per_day')) {
    return "You've already posted today's Peekaboo drop. See you at tomorrow's! 👀";
  }
  if (lower.includes("drop hasn't happened yet")) {
    return "Today's Peekaboo drop hasn't happened yet – wait for the notification! 👀";
  }
  // The store said no because a file is over its size limit (30 MB).
  if (lower.includes('exceeded the maximum allowed size') || lower.includes('payload too large')) {
    return 'That file is too big to send (the most is 30 MB). Try a shorter video.';
  }
  if (lower.includes('row-level security')) {
    return "You don't have permission to do that.";
  }
  return message || 'Something went wrong. Please try again.';
}

// Did the server clearly refuse (rather than the answer getting lost)? The database's own errors carry a code
// (like "P0001" or "23505"), and a refusal comes with an HTTP status from 400 to 499. A request that got no
// answer (no signal, or given up after its time limit) has neither: status 0. A 5xx status without a code
// usually comes from a gateway that gave up waiting while the database may still have saved the change, so that
// doesn't count as a clear "no" either. `status` can be passed, or travel on the error itself.
export function isClearRefusal(error: { code?: string | null; status?: unknown } | null | undefined, status?: number): boolean {
  if (!error) return false;
  if (typeof error.code === 'string' && error.code !== '') return true;
  const answer = typeof status === 'number' ? status : Number(error.status);
  return Number.isFinite(answer) && answer >= 400 && answer < 500;
}

// A failed server answer as an Error that keeps its database code and HTTP status, so the outbox
// (lib/outbox.ts) can tell a clear "no" from a lost answer. The message stays the server's own.
export type ServerFailure = Error & { code?: string; status?: number; details?: string; hint?: string };

export function serverFailure(
  error: { message?: string | null; code?: string | null; details?: string | null; hint?: string | null },
  status?: number,
): ServerFailure {
  const failure = new Error(error.message || 'Something went wrong. Please try again.') as ServerFailure;
  if (error.code) failure.code = error.code;
  if (typeof status === 'number') failure.status = status;
  if (error.details) failure.details = error.details;
  if (error.hint) failure.hint = error.hint;
  return failure;
}
