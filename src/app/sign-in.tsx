import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { FormScreen } from '@/components/FormScreen';
import { TextField } from '@/components/TextField';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { colors, space } from '@/theme';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logIn() {
    if (!email.trim() || !password) {
      setError('Type your email and password first.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    // On success the app switches to the camera by itself.
    if (loginError) setError(friendlyError(loginError));
  }

  return (
    <FormScreen title="Welcome back! 👋" subtitle="Log in to see what your friends are up to.">
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
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
