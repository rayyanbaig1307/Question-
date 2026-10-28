import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FormScreen } from '@/components/FormScreen';
import { TextField } from '@/components/TextField';
import { friendlyError } from '@/lib/errors';
import { checkUsernameFormat, cleanUsername, isUsernameAvailable, USERNAME_RULES } from '@/lib/profiles';
import { supabase } from '@/lib/supabase';
import { colors, font, radius, space } from '@/theme';

export default function SignUp() {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [oldEnough, setOldEnough] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const [availability, setAvailability] = useState<{ name: string; free: boolean } | null>(null);

  // Check if the username is free, a moment after you stop typing.
  useEffect(() => {
    if (!username || checkUsernameFormat(username)) return;
    const timer = setTimeout(() => {
      isUsernameAvailable(username)
        .then((free) => setAvailability({ name: username, free }))
        .catch(() => {});
    }, 450);
    return () => clearTimeout(timer);
  }, [username]);

  const usernameFormatError = username ? checkUsernameFormat(username) : null;
  const usernameTaken = availability?.name === username && !availability.free;
  const usernameFree = availability?.name === username && availability.free;

  const problems = {
    username: !username ? 'Pick a username.' : (usernameFormatError ?? (usernameTaken ? 'Taken! Try another one.' : null)),
    email: /^\S+@\S+\.\S+$/.test(email.trim()) ? null : 'Type a real email address.',
    password: password.length >= 6 ? null : 'Use at least 6 characters.',
    age: oldEnough ? null : 'You need to be 13 or older to use Peekaboo.',
  };

  async function createAccount() {
    setTried(true);
    setError(null);
    if (Object.values(problems).some(Boolean)) return;

    setBusy(true);
    try {
      if (!(await isUsernameAvailable(username))) {
        setAvailability({ name: username, free: false });
        return;
      }
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { username, display_name: name.trim() || username } },
      });
      if (signUpError) throw signUpError;
      // With "Confirm email" turned off you're logged in right away and the app opens.
      // With it on, you first need to tap the link in the email.
      if (!data.session) setCheckEmail(true);
    } catch (signUpError) {
      setError(friendlyError(signUpError));
    } finally {
      setBusy(false);
    }
  }

  if (checkEmail) {
    return (
      <FormScreen title="Check your email 📬">
        <EmptyState
          emoji="💌"
          title={`We sent a link to ${email.trim()}`}
          message="Tap the link in that email to confirm your account, then come back and log in."
        />
        <Button title="Go to log in" onPress={() => router.replace('/sign-in')} />
      </FormScreen>
    );
  }

  return (
    <FormScreen title="Join Peekaboo 🎉" subtitle="It takes 20 seconds. Promise.">
      <TextField
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="What friends call you"
        maxLength={40}
        autoComplete="name"
        textContentType="name"
      />
      <TextField
        label="Username"
        prefix="@"
        value={username}
        onChangeText={(text) => setUsername(cleanUsername(text))}
        placeholder="coolname"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username-new"
        error={tried || usernameFormatError || usernameTaken ? problems.username : null}
        hint={usernameFree ? `✅ @${username} is free!` : USERNAME_RULES}
      />
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        error={tried ? problems.email : null}
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="At least 6 characters"
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        error={tried ? problems.password : null}
      />

      <Pressable style={styles.checkRow} onPress={() => setOldEnough(!oldEnough)} accessibilityRole="checkbox">
        <View style={[styles.checkbox, oldEnough && styles.checkboxOn]}>
          {oldEnough ? <Ionicons name="checkmark" size={18} color={colors.black} /> : null}
        </View>
        <Text style={styles.checkText}>I&apos;m 13 or older</Text>
      </Pressable>
      {tried && problems.age ? <Text style={styles.error}>{problems.age}</Text> : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Let's go!" icon="sparkles" onPress={createAccount} loading={busy} />
      <Button title="Already have an account? Log in" variant="plain" onPress={() => router.replace('/sign-in')} />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.xs,
  },
  checkbox: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: colors.yellow,
    borderColor: colors.yellow,
  },
  checkText: {
    ...font.body,
    fontWeight: '700',
  },
  error: {
    color: colors.red,
    fontWeight: '700',
    fontSize: 15,
    textAlign: 'center',
  },
});
