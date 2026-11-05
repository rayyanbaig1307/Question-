import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { FormScreen } from '@/components/FormScreen';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/lib/auth';
import { checkClean } from '@/lib/cleanWords';
import { friendlyError } from '@/lib/errors';
import { acceptLegal, hasAcceptedAnyTerms, TERMS_VERSION } from '@/lib/legal';
import { checkUsernameFormat, cleanUsername, isUsernameAvailable, updateMyProfile, USERNAME_RULES } from '@/lib/profiles';
import { madeWithAppleOrGoogle, sharedName } from '@/lib/socialAuth';
import { colors, font, radius, space } from '@/theme';

// ---------------------------------------------------------------------------
// Someone who just made their account with Apple or Google picks a username and name, and agrees to the
// Terms – once. Until then they only see this screen. (The database gave them a stand-in username like
// "user3f9a1c" so the account works straight away.)
// ---------------------------------------------------------------------------

// Does the logged-in person still need the setup screen? null while checking.
// If the check doesn't work (no internet?) or takes too long, `failed` is true: the app then shows "Couldn't check – Try again"
// instead of the app or the setup form. It never skips setup on an error. It also tries again by itself
// when you come back to the app.
export type SetupCheck = { failed: boolean; checking: boolean; retry: () => void };

// How long the check may take before we stop waiting and show "Couldn't check – Try again".
const SETUP_CHECK_TIME_LIMIT_MS = 15_000;

export function useNeedsSetup(): [boolean | null, () => void, SetupCheck] {
  const { session, userId, profile, refreshProfile } = useAuth();
  // The answer, and whose account it's about (so a different login is checked again).
  const [answer, setAnswer] = useState<{ user: string; needed: boolean; failed: boolean } | null>(null);
  // Goes up by one for every new try; `retrying` shows a spinner on "Try again".
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const social = madeWithAppleOrGoogle(session?.user.app_metadata?.provider);
  // The setup form needs your profile (so the username you already have counts as yours, not "taken").
  const haveProfile = useRef(false);
  const reloadProfile = useRef(refreshProfile);
  useEffect(() => {
    haveProfile.current = !!profile;
    reloadProfile.current = refreshProfile;
  }, [profile, refreshProfile]);

  useEffect(() => {
    if (!userId || !social) return;
    let cancelled = false;
    let answered = false;
    // Taking too long counts as "couldn't check" (a request can hang forever on Android). If the real answer
    // still comes later, it wins.
    const timer = setTimeout(() => {
      if (cancelled || answered) return;
      setAnswer({ user: userId, needed: true, failed: true });
      setRetrying(false);
    }, SETUP_CHECK_TIME_LIMIT_MS);
    (async () => {
      if (await hasAcceptedAnyTerms(userId)) return { needed: false, failed: false };
      const loaded = haveProfile.current || !!(await reloadProfile.current());
      return { needed: true, failed: !loaded };
    })()
      // A failed check must not skip the name, age and Terms confirmations.
      .catch(() => ({ needed: true, failed: true }))
      .then((result) => {
        answered = true;
        clearTimeout(timer);
        if (cancelled) return;
        setAnswer({ user: userId, ...result });
        setRetrying(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, social, attempt]);

  const current = userId && social && answer?.user === userId ? answer : null;
  const failed = current?.failed ?? false;
  const retry = useCallback(() => {
    setRetrying(true);
    setAttempt((count) => count + 1);
  }, []);

  // The check failed: try again by itself as soon as you come back to the app.
  useEffect(() => {
    if (!failed) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') retry();
    });
    return () => subscription.remove();
  }, [failed, retry]);

  const needed = !userId || !social ? false : current ? current.needed : null;
  return [needed, () => userId && setAnswer({ user: userId, needed: false, failed: false }), { failed, checking: retrying, retry }];
}

// A stand-in username from the database ("user" + 6 letters/numbers) isn't worth showing as a suggestion.
const STAND_IN = /^user[0-9a-f]{6,12}$/;

export function ProfileSetup({ onDone }: { onDone: () => void }) {
  const { userId, profile, setProfile, signOut } = useAuth();
  // null = not typed in yet, so what we already know is shown (the name Apple/Google shared, or the profile's).
  const [typedName, setName] = useState<string | null>(null);
  const [typedUsername, setUsername] = useState<string | null>(null);
  const name = typedName ?? sharedName ?? (profile && !STAND_IN.test(profile.display_name) ? profile.display_name : '');
  const username = typedUsername ?? (profile && !STAND_IN.test(profile.username) ? profile.username : '');
  const [oldEnough, setOldEnough] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<{ name: string; free: boolean } | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const leaving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Check if the username is free, a moment after you stop typing. (The one you already have counts as free.)
  const isMine = username === profile?.username;
  useEffect(() => {
    if (!username || isMine || checkUsernameFormat(username)) return;
    const timer = setTimeout(() => {
      isUsernameAvailable(username)
        .then((free) => setAvailability({ name: username, free }))
        .catch(() => {});
    }, 450);
    return () => clearTimeout(timer);
  }, [username, isMine]);

  const usernameFormatError = username ? checkUsernameFormat(username) : null;
  const usernameTaken = !isMine && availability?.name === username && !availability.free;
  const usernameFree = isMine || (availability?.name === username && availability.free);

  const problems = {
    // Your name may swear but can't have slurs; your @username can't have either.
    name: name.trim() ? checkClean(name, 'content') : 'Type your name.',
    username: !username
      ? 'Pick a username.'
      : (usernameFormatError ?? (usernameTaken ? 'Taken! Try another one.' : checkClean(username, 'name'))),
    age: oldEnough ? null : 'You need to be 13 or older to use Peekaboo.',
    terms: agreed ? null : 'Please agree to the Terms to use Peekaboo.',
  };

  async function finish() {
    if (working.current || leaving.current) return;
    setTried(true);
    setError(null);
    if (!userId || Object.values(problems).some(Boolean)) return;
    working.current = true;
    setBusy(true);
    try {
      if (!isMine && !(await isUsernameAvailable(username))) {
        setAvailability({ name: username, free: false });
        return;
      }
      if (!mounted.current || leaving.current) return;
      const updated = await updateMyProfile(userId, { username, display_name: name.trim() });
      if (!mounted.current || leaving.current) return;
      setProfile(updated);
      // Agreeing is the last step: it's also how the app knows setup is done.
      await acceptLegal('terms', TERMS_VERSION);
      if (!mounted.current || leaving.current) return;
      onDone();
    } catch (setupError) {
      setError(friendlyError(setupError));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function cancelSetup() {
    if (!mounted.current) return;
    leaving.current = true;
    try {
      await signOut(userId ?? undefined);
    } catch (logoutError) {
      leaving.current = false;
      if (mounted.current) setError(friendlyError(logoutError));
    }
  }

  return (
    <FormScreen title="Almost there! 🎉" subtitle="Pick how your friends find you." onBack={cancelSetup}>
      <TextField
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="What friends call you"
        maxLength={40}
        autoComplete="name"
        textContentType="name"
        error={tried ? problems.name : null}
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

      <Pressable style={styles.checkRow} onPress={() => setOldEnough(!oldEnough)} accessibilityRole="checkbox">
        <View style={[styles.checkbox, oldEnough && styles.checkboxOn]}>
          {oldEnough ? <Ionicons name="checkmark" size={18} color={colors.onAccent} /> : null}
        </View>
        <Text style={styles.checkText}>I&apos;m 13 or older</Text>
      </Pressable>
      {tried && problems.age ? <Text style={styles.error}>{problems.age}</Text> : null}

      <View style={styles.checkRow}>
        <Pressable
          onPress={() => setAgreed(!agreed)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agreed }}
          hitSlop={8}>
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
          <Text
            style={styles.link}
            onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'dare-rules' } })}>
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
      <Button title="Let's go!" icon="sparkles" onPress={finish} loading={busy} />
      <Button title="Cancel and log out" variant="plain" onPress={cancelSetup} />
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
