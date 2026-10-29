import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { setupStyles } from '@/components/match/MatchSetup';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { fetchMyDating, isComplete, MIN_PHOTOS, type MyDating } from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import { fetchPeekMatchStatus, leavePeekMatch, setDatingHidden, type PeekMatchStatus } from '@/lib/peekMatch';
import { colors, font, space } from '@/theme';

// Peek Match settings (the ⚙ on the Match tab): your dating profile, hide it, or leave Peek Match.
export default function PeekMatchSettings() {
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const [status, setStatus] = useState<PeekMatchStatus | null>(null);
  const [mine, setMine] = useState<MyDating | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    () =>
      Promise.all([fetchPeekMatchStatus(userId), fetchMyDating(userId)])
        .then(([loadedStatus, loadedDating]) => {
          setStatus(loadedStatus);
          setMine(loadedDating);
        })
        .catch((error) => console.warn('Could not load Peek Match settings', error)),
    [userId],
  );

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  async function toggleHidden(hide: boolean) {
    try {
      await setDatingHidden(hide);
      showToast(hide ? 'Your dating profile is hidden 🙈' : 'Your dating profile is showing again 👀');
      await reload();
    } catch (error) {
      Alert.alert('Something went wrong', friendlyError(error));
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
              router.back();
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

  const member = status?.member ?? null;
  const photosLeft = mine ? MIN_PHOTOS - mine.photos.length : 0;
  const missing = mine
    ? [
        !mine.profile && 'the basics',
        photosLeft > 0 && `${photosLeft} more photo${photosLeft === 1 ? '' : 's'}`,
        mine.prompts.length < 3 && 'your 3 prompts',
      ].filter((item): item is string => !!item)
    : [];

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Peek Match settings" />
      {status === null || mine === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : !member ? (
        <View style={styles.content}>
          <Text style={setupStyles.cardText}>You&apos;re not in Peek Match right now – turn it on from the Match tab.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={setupStyles.card}>
            <Text style={setupStyles.cardTitle}>My dating profile</Text>
            {isComplete(mine) ? (
              <Text style={setupStyles.cardText}>
                ✅ {mine.profile?.name} · {mine.photos.length} photos · 3 prompts{' '}
                {member.hidden ? '· 🙈 hidden right now' : '· showing'}
              </Text>
            ) : (
              <Text style={setupStyles.problem}>Not finished yet – add {missing.join(', ')}.</Text>
            )}
            <Button
              title={mine.profile ? 'Edit my dating profile' : 'Make my dating profile'}
              icon="create"
              onPress={() => router.push('/peek-match/profile')}
            />
          </View>

          <View style={setupStyles.card}>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>Hide my dating profile</Text>
                <Text style={setupStyles.cardText}>Nobody new sees you. Your matches and chats stay.</Text>
              </View>
              <Switch
                value={member.hidden}
                onValueChange={toggleHidden}
                trackColor={{ true: colors.pink, false: colors.border }}
                thumbColor={colors.white}
              />
            </View>
          </View>

          <View style={setupStyles.card}>
            <Text style={setupStyles.cardTitle}>Staying safe 💜</Text>
            <Text style={setupStyles.cardText}>
              • Daters only see your dating profile – never your friends, stories, posts or where you are.{'\n'}• Only a
              rough distance is shown, like &quot;5 km away&quot;.{'\n'}• Use ••• on any profile or chat to report, block or
              unmatch.{'\n'}• Meeting up? Pick a busy public place and tell a friend where you&apos;ll be.
            </Text>
          </View>

          <Button title="Leave Peek Match" icon="exit" variant="secondary" loading={busy} onPress={confirmLeave} />
          <Text style={styles.note}>Leaving deletes your dating profile, photos, likes, matches and chats.</Text>
        </ScrollView>
      )}
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
  note: {
    ...font.small,
    textAlign: 'center',
  },
});
