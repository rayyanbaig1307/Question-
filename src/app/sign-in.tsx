import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { FormScreen } from '@/components/FormScreen';
import { TextField } from '@/components/TextField';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { logInWithUsername } from '@/lib/usernameAuth';
import { colors, space } from '@/theme';

// Log in with your email or your username.
export default function SignIn() {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logIn() {
    const typed = login.trim();
    if (!typed || !password) {
      setError('Type your email or username, and your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Has an @ in the middle → an email; otherwise it's a username (a leading @ is fine).
      if (/^[^@\s]+@[^@\s]+$/.test(typed)) {
        const { error: loginError } = await supabase.auth.signInWithPassword({ email: typed, password });
        if (loginError) throw loginError;
      } else {
        await logInWithUsername(typed, password);
      }
      // On success the app switches to the camera by itself.
    } catch (loginError) {
      setError(friendlyError(loginError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormScreen title="Welcome back! 👋" subtitle="Log in to see what your friends are up to.">
      <TextField
        label="Email or username"
        value={login}
        onChangeText={setLogin}
        placeholder="you@example.com or coolname"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        keyboardType="email-address"
        textContentType="username"
        returnKeyType="next"
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="Your password"
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={logIn}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Log in" onPress={logIn} loading={busy} style={styles.button} />
      <Button title="New here? Create an account" variant="plain" onPress={() => router.replace('/sign-up')} />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  error: {
    color: colors.red,
    fontWeight: '700',
    fontSize: 15,
    textAlign: 'center',
  },
  button: {
    marginTop: space.sm,
  },
});
