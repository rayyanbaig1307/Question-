// The password rule, in one place: at least 8 characters, with at least one letter and one number.
// (The username sign-up function on the server – supabase/functions/username-auth – checks the same thing.)
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HINT = 'At least 8 characters, with a letter and a number';

// Why this password isn't allowed, or null when it's fine.
export function checkPassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!/[a-zA-Z]/.test(password)) return 'Add at least one letter.';
  if (!/[0-9]/.test(password)) return 'Add at least one number.';
  if (password.length > 72) return 'Keep it under 72 characters.';
  return null;
}
