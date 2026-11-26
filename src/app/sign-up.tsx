import { router } from 'expo-router';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FormScreen } from '@/components/FormScreen';

// New accounts are made only with "Continue with Apple" (iPhone) or "Continue with Google" (Android) on the
// welcome screen, so every new account has a real Apple or Google ID behind it. There is no sign-up with an email
// or with just a username any more (switched off on 26 Nov 2026 – the server says no to username sign-ups too:
// supabase/functions/username-auth).
// This screen only opens where those buttons are missing (Expo Go and very old downloads), so instead of a form
// it says how to make an account, and offers Log in to people who already have one.
export default function SignUp() {
  return (
    <FormScreen title="Join Peekaboo 🎉" onBack={goBack}>
      <EmptyState
        emoji="📲"
        title="New accounts use Apple or Google"
        message="New accounts are made with the Apple or Google button now – get the newest Peekaboo to make one. No password needed."
      />
      <Button title="I already have an account" icon="log-in-outline" onPress={() => router.replace('/sign-in')} />
    </FormScreen>
  );
}

// Back to where you came from, or to the welcome screen when this screen was opened straight from a link.
function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/welcome');
}
