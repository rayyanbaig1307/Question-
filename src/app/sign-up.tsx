import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FormScreen } from '@/components/FormScreen';
import { TextField } from '@/components/TextField';
import { checkClean } from '@/lib/cleanWords';
import { friendlyError } from '@/lib/errors';
import { TERMS_VERSION } from '@/lib/legal';
import { checkPassword, PASSWORD_HINT } from '@/lib/password';
import { checkUsernameFormat, cleanUsername, isUsernameAvailable, USERNAME_RULES } from '@/lib/profiles';
import { supabase } from '@/lib/supabase';
import { signUpWithUsername } from '@/lib/usernameAuth';
import { colors, font, radius, space } from '@/theme';

export default function SignUp() {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  // Sign up with an email (recommended – you can get back in if you forget your password), or just a username.
  const [withEmail, setWithEmail] = useState(true);
  const [password, setPassword] = useState('');
  const [oldEnough, setOldEnough] = useState(false);
  // Ticking this is agreeing to the Terms (and the Privacy Policy, Guidelines and Dare Safety Rules they include).
  const [agreed, setAgreed] = useState(false);
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
    username: !username
      ? 'Pick a username.'
      : (usernameFormatError ?? (usernameTaken ? 'Taken! Try another one.' : checkClean(`${username} ${name}`, 'name'))),
    email: !withEmail || /^\S+@\S+\.\S+$/.test(email.trim()) ? null : 'Type a real email address.',
    password: checkPassword(password),
    age: oldEnough ? null : 'You need to be 13 or older to use Peekaboo.',
    terms: agreed ? null : 'Please agree to the Terms to make an account.',
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
      if (!withEmail) {
        // Just a username: you're logged in straight away and the app opens.
        await signUpWithUsername(username, password, name.trim() || username, TERMS_VERSION);
        return;
      }
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        // Which Terms you agreed to travels with the new account; the app records it once you're in.
        options: { data: { username, display_name: name.trim() || username, terms_version: TERMS_VERSION } },
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
      <View style={styles.choice}>
        {[
          { key: true, label: '📧 With email' },
          { key: false, label: '👤 Just a username' },
        ].map((option) => (
          <Pressable
            key={option.label}
            onPress={() => setWithEmail(option.key)}
            accessibilityRole="radio"
            accessibilityState={{ selected: withEmail === option.key }}
            style={[styles.choiceChip, withEmail === option.key && styles.choiceChipOn]}>
            <Text style={[styles.choiceText, withEmail === option.key && styles.choiceTextOn]}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
      {withEmail ? (
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
      ) : (
        <Text style={styles.warning}>
          ⚠️ No email means you log in with your username – but if you forget your password, there&apos;s no way to get
          your account back. Keep your password somewhere safe.
        </Text>
      )}
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder={PASSWORD_HINT}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        error={tried ? problems.password : null}
      />

      <Pressable style={styles.checkRow} onPress={() => setOldEnough(!oldEnough)} accessibilityRole="checkbox">
        <View style={[styles.checkbox, oldEnough && styles.checkboxOn]}>
          {oldEnough ? <Ionicons name="checkmark" size={18} color={colors.onAccent} /> : null}
        </View>
        <Text style={styles.checkText}>I&apos;m 13 or older</Text>
      </Pressable>
      {tried && problems.age ? <Text style={styles.error}>{problems.age}</Text> : null}

      <View style={styles.checkRow}>
        <Pressable onPress={() => setAgreed(!agreed)} accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} hitSlop={8}>
          <View style={[styles.checkbox, agreed && styles.checkboxOn]}>
            {agreed ? <Ionicons name="checkmark" size={18} color={colors.onAccent} /> : null}
          </View>
        </Pressable>
        <Text style={styles.checkSmall} onPress={() => setAgreed(!agreed)}>
          I agree to the{' '}
          <Text style={styles.link} onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'terms' } })}>
            Terms of Service
          </Text>{' '}
          (including the{' '}
          <Text style={styles.link} onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'dare-rules' } })}>
            Dare Safety Rules
          </Text>
          ) and the{' '}
          <Text style={styles.link} onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'privacy' } })}>
            Privacy Policy
          </Text>
          . If I&apos;m under 18, a parent or guardian agrees too.
        </Text>
      </View>
      {tried && problems.terms ? <Text style={styles.error}>{problems.terms}</Text> : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Let's go!" icon="sparkles" onPress={createAccount} loading={busy} />
      <Button title="Already have an account? Log in" variant="plain" onPress={() => router.replace('/sign-in')} />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  choice: {
    flexDirection: 'row',
    gap: space.sm,
  },
  choiceChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  choiceChipOn: {
    borderColor: colors.accent,
  },
  choiceText: {
    ...font.body,
    fontWeight: '800',
    color: colors.textMuted,
  },
  choiceTextOn: {
    color: colors.text,
  },
  warning: {
    ...font.small,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.md,
  },
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
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  checkText: {
    ...font.body,
    fontWeight: '700',
  },
  checkSmall: {
    ...font.small,
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
  },
  link: {
    color: colors.accent,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  error: {
    color: colors.red,
    fontWeight: '700',
    fontSize: 15,
    textAlign: 'center',
  },
});
