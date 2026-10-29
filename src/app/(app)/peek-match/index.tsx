import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { fetchMyDating, isComplete, MIN_PHOTOS, type MyDating } from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import {
  AgeCheckNotSetUp,
  checkAge,
  fetchPeekMatchStatus,
  joinPeekMatch,
  leavePeekMatch,
  setBirthday,
  setDatingHidden,
  startAgeCheck,
  type PeekMatchStatus,
} from '@/lib/peekMatch';
import { colors, font, gradients, radius, space } from '@/theme';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const SAFETY = [
  ['🔞', 'Adults only. We check your age with your ID and a quick selfie.'],
  ['🙈', "Totally separate. Daters can't see your friends, stories, posts or where you are."],
  ['📍', 'Only a rough distance like "5 km away" – never your exact spot.'],
  ['🚩', 'Block, report or unmatch anyone, any time.'],
  ['🗑️', 'Hide your dating profile or leave whenever you like. Leaving deletes your dating stuff.'],
] as const;

// Peek Match home: the 18+ steps (birthday → age check → turn it on), then your Peek Match settings.
export default function PeekMatch() {
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const [status, setStatus] = useState<PeekMatchStatus | null>(null);
  const [notSetUp, setNotSetUp] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    () =>
      fetchPeekMatchStatus(userId)
        .then(setStatus)
        .catch(() => setStatus((current) => current ?? { ageCheck: null, member: null })),
    [userId],
  );

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  // Ask Stripe how the age check went (e.g. when you come back to the app from the check).
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
        await reload();
      } catch (error) {
        if (error instanceof AgeCheckNotSetUp) setNotSetUp(true);
        else if (!quiet) Alert.alert('Could not check', friendlyError(error));
      }
    },
    [reload, showToast],
  );

  const pending = status?.ageCheck?.check_state === 'pending';
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

  async function beginAgeCheck() {
    setBusy(true);
    try {
      const url = await startAgeCheck();
      if (url) await Linking.openURL(url);
      await reload();
    } catch (error) {
      if (error instanceof AgeCheckNotSetUp) setNotSetUp(true);
      else Alert.alert('Could not start the age check', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function turnOn() {
    setBusy(true);
    try {
      await joinPeekMatch();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast('Peek Match is on 💘');
      await reload();
    } catch (error) {
      Alert.alert('Could not turn on Peek Match', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  function confirmLeave() {
    Alert.alert(
      'Leave Peek Match?',
      'This deletes your dating profile, photos, likes, matches and chats for good. The rest of Peekaboo stays the same.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave and delete',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await leavePeekMatch();
              showToast('You left Peek Match – your dating stuff is deleted');
              await reload();
            } catch (error) {
              Alert.alert('Could not leave', friendlyError(error));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  async function toggleHidden(hide: boolean) {
    try {
      await setDatingHidden(hide);
      showToast(hide ? 'Your dating profile is hidden 🙈' : 'Your dating profile is showing again 👀');
      await reload();
    } catch (error) {
      Alert.alert('Something went wrong', friendlyError(error));
    }
  }

  const ageCheck = status?.ageCheck ?? null;
  let body;
  if (status === null) {
    body = <ActivityIndicator color={colors.accent} style={styles.loading} />;
  } else if (ageCheck?.blocked) {
    body = (
      <EmptyState
        emoji="🔞"
        title="Peek Match is for adults only"
        message="You need to be 18 or older to use Peek Match. The rest of Peekaboo is all yours! 💜"
      />
    );
  } else if (!ageCheck) {
    body = <BirthdayStep onSaved={reload} />;
  } else if (ageCheck.check_state !== 'verified') {
    body = (
      <View style={styles.card}>
        <Text style={styles.step}>Step 2 of 2</Text>
        <Text style={styles.cardTitle}>Check your age 🪪</Text>
        <Text style={styles.cardText}>
          Stripe (a trusted company that checks IDs for lots of apps) looks at your ID and a quick selfie. It takes
          about 2 minutes. Stripe only tells Peekaboo your date of birth – we never see or keep your ID photo.
        </Text>
        {ageCheck.check_state === 'failed' ? (
          <Text style={styles.problem}>
            That didn&apos;t work{ageCheck.check_error ? `: ${ageCheck.check_error}` : ''}. Try again with a clear
            photo of your ID in good light.
          </Text>
        ) : null}
        {notSetUp ? (
          <Text style={styles.problem}>
            Age checks aren&apos;t switched on yet – the app owner still needs to connect Stripe. Check back soon!
          </Text>
        ) : null}
        {ageCheck.check_state === 'pending' ? (
          <>
            <Text style={styles.cardText}>Finished the steps on the Stripe page? Tap below to see if you passed.</Text>
            <Button title="I'm done – check now" icon="checkmark-circle" loading={busy} onPress={() => askStripe(false)} />
            <Button title="Start the check again" variant="secondary" disabled={busy} onPress={beginAgeCheck} />
          </>
        ) : (
          <Button
            title={ageCheck.check_state === 'failed' ? 'Try again' : 'Check my age'}
            icon="id-card"
            loading={busy}
            onPress={beginAgeCheck}
          />
        )}
      </View>
    );
  } else if (!status.member) {
    body = (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>You&apos;re verified ✅</Text>
        <Text style={styles.cardText}>Peek Match is off. Turn it on whenever you&apos;re ready.</Text>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Peek Match</Text>
          <Switch
            value={false}
            disabled={busy}
            onValueChange={(on) => {
              if (on) turnOn();
            }}
            trackColor={{ true: colors.pink, false: colors.border }}
            thumbColor={colors.white}
          />
        </View>
      </View>
    );
  } else {
    body = (
      <>
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
          <Text style={styles.heroTitle}>Peek Match is on 💘</Text>
          <Text style={styles.heroText}>
            Look at one person at a time, like a photo or an answer, or skip. Matching is coming in the next update.
          </Text>
        </LinearGradient>
        <ProfileCard me={userId} hidden={status.member.hidden} />
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.switchLabel}>Hide my dating profile</Text>
              <Text style={styles.cardText}>Nobody new sees you. Your matches and chats stay.</Text>
            </View>
            <Switch
              value={status.member.hidden}
              onValueChange={toggleHidden}
              trackColor={{ true: colors.pink, false: colors.border }}
              thumbColor={colors.white}
            />
          </View>
        </View>
        <Button title="Leave Peek Match" icon="exit" variant="secondary" disabled={busy} onPress={confirmLeave} />
      </>
    );
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Peek Match 💘" />
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {status && !ageCheck?.blocked && !status.member ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Dating, the Peekaboo way · 18+</Text>
              {SAFETY.map(([emoji, text]) => (
                <View key={emoji} style={styles.safetyRow}>
                  <Text style={styles.safetyEmoji}>{emoji}</Text>
                  <Text style={styles.cardText}>{text}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {body}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// Your dating profile at a glance: is it ready to be shown, and what's missing.
function ProfileCard({ me, hidden }: { me: string; hidden: boolean }) {
  const [mine, setMine] = useState<MyDating | null>(null);
  useFocusEffect(
    useCallback(() => {
      fetchMyDating(me)
        .then(setMine)
        .catch(() => {});
    }, [me]),
  );
  const missing = mine
    ? [
        !mine.profile && 'the basics',
        mine.photos.length < MIN_PHOTOS && `${MIN_PHOTOS - mine.photos.length} more photo${MIN_PHOTOS - mine.photos.length === 1 ? '' : 's'}`,
        mine.prompts.length < 3 && 'your 3 prompts',
      ].filter((item): item is string => !!item)
    : [];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>My dating profile</Text>
      {mine === null ? (
        <ActivityIndicator color={colors.accent} />
      ) : isComplete(mine) ? (
        <Text style={styles.cardText}>
          ✅ {mine.profile?.name} · {mine.photos.length} photos · 3 prompts{' '}
          {hidden ? '· 🙈 hidden right now' : '· ready to be seen'}
        </Text>
      ) : (
        <Text style={styles.problem}>Not finished yet – add {missing.join(', ')}.</Text>
      )}
      {mine && isComplete(mine) && !hidden ? (
        <Button title="Start peeking 💘" icon="heart" onPress={() => router.push('/peek-match/discover')} />
      ) : null}
      <Button
        title={mine?.profile ? 'Edit my dating profile' : 'Make my dating profile'}
        icon="create"
        variant={mine && isComplete(mine) ? 'secondary' : 'primary'}
        onPress={() => router.push('/peek-match/profile')}
      />
    </View>
  );
}

// Step 1: your birthday. It's saved once and can't be changed.
function BirthdayStep({ onSaved }: { onSaved: () => void }) {
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [saving, setSaving] = useState(false);

  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  const date = new Date(y, m - 1, d);
  const valid =
    year.length === 4 && d >= 1 && m >= 1 && m <= 12 && date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;

  function confirm() {
    if (!valid) return;
    Alert.alert(`Is ${d} ${MONTHS[m - 1]} ${y} right?`, "You can't change your birthday later, and the age check will compare it with your ID.", [
      { text: 'Fix it', style: 'cancel' },
      { text: "Yes, that's right", onPress: save },
    ]);
  }

  async function save() {
    setSaving(true);
    try {
      const pad = (n: number) => String(n).padStart(2, '0');
      await setBirthday(`${y}-${pad(m)}-${pad(d)}`);
      onSaved();
    } catch (error) {
      Alert.alert('Could not save your birthday', friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.step}>Step 1 of 2</Text>
      <Text style={styles.cardTitle}>When&apos;s your birthday? 🎂</Text>
      <View style={styles.dateRow}>
        <DateBox label="Day" value={day} onChange={setDay} max={2} placeholder="DD" />
        <DateBox label="Month" value={month} onChange={setMonth} max={2} placeholder="MM" />
        <DateBox label="Year" value={year} onChange={setYear} max={4} placeholder="YYYY" wide />
      </View>
      <Button title="Continue" icon="arrow-forward" disabled={!valid} loading={saving} onPress={confirm} />
    </View>
  );
}

function DateBox({ label, value, onChange, max, placeholder, wide = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  placeholder: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.dateBox, wide && styles.dateBoxWide]}>
      <Text style={styles.dateLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(text) => onChange(text.replace(/[^0-9]/g, '').slice(0, max))}
        keyboardType="number-pad"
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        keyboardAppearance="dark"
        selectionColor={colors.accent}
        maxLength={max}
        style={styles.dateInput}
        accessibilityLabel={`Birthday ${label.toLowerCase()}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xxl,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
    paddingBottom: space.xxl * 2,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  step: {
    ...font.label,
    color: colors.pink,
    textTransform: 'uppercase',
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
  safetyRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
  },
  safetyEmoji: {
    fontSize: 18,
  },
  hero: {
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  heroTitle: {
    ...font.heading,
    color: colors.white,
  },
  heroText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  switchLabel: {
    ...font.body,
    fontWeight: '800',
  },
  dateRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  dateBox: {
    flex: 1,
    gap: space.xs,
  },
  dateBoxWide: {
    flex: 1.5,
  },
  dateLabel: {
    ...font.label,
  },
  dateInput: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
  },
});
