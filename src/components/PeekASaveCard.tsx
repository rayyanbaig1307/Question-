import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { friendlyError } from '@/lib/errors';
import { usePlus } from '@/lib/plus';
import {
  brokenStreakText,
  hoursLeft,
  peekASave,
  shortDate,
  type BrokenStreak,
  type PlusAllowances,
} from '@/lib/plusExtras';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// 🙈 Peek-a-Save: "Your 12-day streak with Ayaan broke 😱".
// Peekaboo+ members can bring it back (1 a month, within 24 hours). Everyone else gets "Save it with Peekaboo+ ⭐".
// The server checks everything again, so this button can't be cheated.
export function PeekASaveCard({ streak, friend, allowances, onSaved }: {
  streak: BrokenStreak;
  friend: Profile | null | undefined;
  allowances: PlusAllowances;
  // Called after it worked, so the screen can load the streaks again.
  onSaved: (restored: number) => void;
}) {
  const appPlus = usePlus();
  // The app may know about your Plus a moment before the server does (or the other way round).
  const plus = appPlus || allowances.plus;
  const { showToast } = useOverlays();
  const [busy, setBusy] = useState(false);
  const name = friend ? friend.display_name || friend.username : 'your friend';
  const noneLeft = allowances.savesLeft <= 0;

  function save() {
    if (busy) return;
    Alert.alert(
      'Use your Peek-a-Save? 🙈',
      `Your streak with ${name} comes back. You get 1 Peek-a-Save a month.`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: '🙈 Peek-a-Save',
          onPress: async () => {
            setBusy(true);
            try {
              const restored = await peekASave(streak.kind, streak.friend_id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              showToast(`🙈 Saved! Your ${restored} ${streak.kind === 'daily_dare' ? 'day' : 'dare'} streak with ${name} is back 🔥`);
              onSaved(restored);
            } catch (error) {
              Alert.alert('Could not save it', friendlyError(error));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <Avatar path={friend?.avatar_path} name={name} size={40} />
        <View style={styles.text}>
          <Text style={styles.title}>{brokenStreakText(streak, name)}</Text>
          <Text style={styles.hint}>
            {plus
              ? noneLeft
                ? `You've used this month's Peek-a-Save. Next one on ${shortDate(allowances.saveResetsAt)}.`
                : `Peek-a-Save brings it back · ${hoursLeft(streak.save_until)} · 1 left this month`
              : `Peekaboo+ members can bring it back · ${hoursLeft(streak.save_until)}`}
          </Text>
        </View>
      </View>
      {plus ? (
        <Button title="🙈 Peek-a-Save" variant="pink" small onPress={save} loading={busy} disabled={noneLeft} />
      ) : (
        <Button title="Save it with Peekaboo+ ⭐" variant="pink" small onPress={() => router.push('/plus')} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.pink,
    padding: space.md,
    gap: space.md,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...font.body,
    fontWeight: '800',
  },
  hint: {
    ...font.small,
  },
});
