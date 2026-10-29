import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { friendlyError } from '@/lib/errors';
import { AgeCheckNotSetUp, checkAge, joinPeekMatch, startAgeCheck, type AgeCheck } from '@/lib/peekMatch';
import { colors, font, gradients, radius, space } from '@/theme';

const SAFETY = [
  ['🔞', 'Adults only. We check your age with your ID and a quick selfie.'],
  ['🙈', "Totally separate. Daters can't see your friends, stories, posts or where you are."],
  ['📍', 'Only a rough distance like "5 km away" – never your exact spot.'],
  ['🚩', 'Block, report or unmatch anyone, any time.'],
  ['🗑️', 'Hide your dating profile or leave whenever you like. Leaving deletes your dating stuff.'],
] as const;

// The big pink "Peek Match" welcome plus the safety promises.
export function MatchWelcome() {
  return (
    <>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
        <Text style={styles.heroEmoji}>💘</Text>
        <Text style={styles.heroTitle}>Peek Match</Text>
        <Text style={styles.heroText}>
          Dating, the Peekaboo way. See one person at a time, like a photo or an answer – like each other and
          it&apos;s a match!
        </Text>
      </LinearGradient>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Safe by design · 18+</Text>
        {SAFETY.map(([emoji, text]) => (
          <View key={emoji} style={styles.safetyRow}>
            <Text style={styles.safetyEmoji}>{emoji}</Text>
            <Text style={styles.cardText}>{text}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

// The ID + selfie age check (by Stripe). Opens Stripe's page, then checks the result when you come back.
export function AgeCheckCard({ ageCheck, onChanged }: { ageCheck: AgeCheck; onChanged: () => void }) {
  const { showToast } = useOverlays();
  const [notSetUp, setNotSetUp] = useState(false);
  const [busy, setBusy] = useState(false);

  const askStripe = useCallback(
    async (quiet: boolean) => {
      try {
        const result = await checkAge();
        if (result.state === 'verified' && !result.blocked) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          showToast("You're verified ✅");
        } else if (!quiet && result.state === 'pending') {
          showToast('Still checking – finish the steps on the Stripe page, then try again');
        }
        onChanged();
      } catch (error) {
        if (error instanceof AgeCheckNotSetUp) setNotSetUp(true);
        else if (!quiet) Alert.alert('Could not check', friendlyError(error));
      }
    },
    [onChanged, showToast],
  );

  // Coming back to the app from Stripe's page → see if the check passed.
  const pending = ageCheck.check_state === 'pending';
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && pendingRef.current) askStripe(true);
    });
    return () => subscription.remove();
  }, [askStripe]);

  async function begin() {
    setBusy(true);
    try {
      const url = await startAgeCheck();
      if (url) await Linking.openURL(url);
      onChanged();
    } catch (error) {
      if (error instanceof AgeCheckNotSetUp) setNotSetUp(true);
      else Alert.alert('Could not start the age check', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>One quick age check 🪪</Text>
      <Text style={styles.cardText}>
        Stripe (a trusted company that checks IDs for lots of apps) looks at your ID and a quick selfie. It takes
        about 2 minutes. Stripe only tells Peekaboo your date of birth – we never see or keep your ID photo.
      </Text>
      {ageCheck.check_state === 'failed' ? (
        <Text style={styles.problem}>
          That didn&apos;t work{ageCheck.check_error ? `: ${ageCheck.check_error}` : ''}. Try again with a clear photo
          of your ID in good light.
        </Text>
      ) : null}
      {notSetUp ? (
        <Text style={styles.problem}>
          Age checks aren&apos;t switched on yet – the app owner still needs to connect Stripe. Check back soon!
        </Text>
      ) : null}
      {pending ? (
        <>
          <Text style={styles.cardText}>Finished the steps on the Stripe page? Tap below to see if you passed.</Text>
          <Button title="I'm done – check now" icon="checkmark-circle" onPress={() => askStripe(false)} />
          <Button title="Start the check again" variant="secondary" loading={busy} onPress={begin} />
        </>
      ) : (
        <Button
          title={ageCheck.check_state === 'failed' ? 'Try again' : 'Check my age'}
          icon="id-card"
          loading={busy}
          onPress={begin}
        />
      )}
    </View>
  );
}

// Verified but not in yet: Peek Match stays off until you turn it on yourself.
export function TurnOnCard({ onChanged }: { onChanged: () => void }) {
  const { showToast } = useOverlays();
  const [busy, setBusy] = useState(false);

  async function turnOn() {
    setBusy(true);
    try {
      await joinPeekMatch();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast('Peek Match is on 💘');
      onChanged();
    } catch (error) {
      Alert.alert('Could not turn on Peek Match', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>You&apos;re verified ✅</Text>
      <Text style={styles.cardText}>Peek Match is off. Turn it on whenever you&apos;re ready – you can leave any time.</Text>
      <Button title="Turn on Peek Match" icon="heart" loading={busy} onPress={turnOn} />
    </View>
  );
}

export const setupStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  cardTitle: {
    ...font.heading,
  },
  cardText: {
    ...font.small,
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1,
  },
  problem: {
    ...font.small,
    fontSize: 14,
    color: colors.orange,
    fontWeight: '700',
  },
});

const styles = StyleSheet.create({
  ...setupStyles,
  hero: {
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    alignItems: 'center',
  },
  heroEmoji: {
    fontSize: 44,
  },
  heroTitle: {
    ...font.title,
    color: colors.white,
  },
  heroText: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 21,
    textAlign: 'center',
  },
  safetyRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
  },
  safetyEmoji: {
    fontSize: 18,
  },
});
