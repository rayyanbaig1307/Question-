import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { friendlyError } from '@/lib/errors';
import {
  Apple,
  APPLE_SIGN_IN_AVAILABLE,
  GOOGLE_SIGN_IN_AVAILABLE,
  signInWithApple,
  signInWithGoogle,
  SignInCancelled,
} from '@/lib/socialAuth';
import { colors, radius, space } from '@/theme';

// Can this phone make a new account (Sign in with Apple on iPhone, Sign in with Google on Android)?
export const SOCIAL_SIGN_IN_AVAILABLE = APPLE_SIGN_IN_AVAILABLE || GOOGLE_SIGN_IN_AVAILABLE;

// "Sign in with Apple" / "Continue with Google". The same button makes a new account or logs back in.
// Once it works the app opens by itself (and new people pick a username first).
export function SocialSignInButtons({ onDark = false }: { onDark?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingIn = useRef(false);

  async function run(signIn: () => Promise<void>) {
    if (signingIn.current) return;
    signingIn.current = true;
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (signInError) {
      if (!(signInError instanceof SignInCancelled)) setError(friendlyError(signInError));
    } finally {
      signingIn.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      {Apple ? (
        // Apple's own button (Apple's rules ask for it).
        <Apple.AppleAuthenticationButton
          buttonType={Apple.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={
            onDark ? Apple.AppleAuthenticationButtonStyle.WHITE : Apple.AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={radius.pill}
          style={[styles.apple, busy && styles.busy]}
          onPress={() => {
            if (!busy) run(signInWithApple);
          }}
        />
      ) : null}
      {GOOGLE_SIGN_IN_AVAILABLE ? (
        <Button
          title="Continue with Google"
          icon="logo-google"
          variant="secondary"
          loading={busy}
          style={onDark ? styles.googleOnDark : undefined}
          onPress={() => run(signInWithGoogle)}
        />
      ) : null}
      {error ? <Text style={[styles.error, onDark && styles.errorOnDark]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.md,
  },
  apple: {
    height: 56,
    width: '100%',
  },
  busy: {
    opacity: 0.5,
  },
  // The same see-through look as the other button on the welcome screen.
  googleOnDark: {
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  error: {
    color: colors.red,
    fontWeight: '700',
    fontSize: 15,
    textAlign: 'center',
  },
  errorOnDark: {
    color: '#FFFFFF',
  },
});
