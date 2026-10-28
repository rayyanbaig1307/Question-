// Turns technical error messages into simple, friendly ones.
export function friendlyError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error ?? '');
  const lower = message.toLowerCase();

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
  if (lower.includes('network request failed') || lower.includes('failed to fetch')) {
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
  if (lower.includes('row-level security')) {
    return "You don't have permission to do that.";
  }
  return message || 'Something went wrong. Please try again.';
}
