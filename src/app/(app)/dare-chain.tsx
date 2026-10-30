import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { dareFriends, fetchDareChain, inviteToDare, MAX_DARES_PER_DAY } from '@/lib/dareChain';
import { dareFor, todayDareDay } from '@/lib/dares';
import { friendlyError } from '@/lib/errors';
import { fetchFriends } from '@/lib/friends';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// Right after you've done today's dare: dare up to 3 friends. They get 24 hours.
export default function DareChain() {
  const { post } = useLocalSearchParams<{ post?: string }>();
  const { userId, profile } = useMe();
  const { showToast } = useOverlays();
  const dare = dareFor(todayDareDay());
  const [friends, setFriends] = useState<Profile[] | null>(null);
  // Friends you already dared today (can't be dared twice).
  const [alreadyDared, setAlreadyDared] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    Promise.all([fetchFriends(userId), fetchDareChain(userId, todayDareDay())])
      .then(([loaded, chain]) => {
        setAlreadyDared(new Set(chain.sent.map((n) => n.to_user)));
        setFriends(loaded);
      })
      .catch(() => setFriends([]));
  }, [userId]);

  const left = MAX_DARES_PER_DAY - alreadyDared.size;

  function toggle(id: string) {
    Haptics.selectionAsync();
    setPicked((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      if (current.length >= left) return current;
      return [...current, id];
    });
  }

  async function send() {
    setSending(true);
    try {
      const count = await dareFriends(picked, post ?? null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(count > 0 ? `😈 Dared ${count} friend${count === 1 ? '' : 's'} – they have 24 hours` : 'Those friends already did the dare');
      router.back();
    } catch (error) {
      Alert.alert('Could not send the dare', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Dare your friends 😈" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.dareLabel}>🎯 TODAY&apos;S DARE</Text>
          <Text style={styles.dareText}>{dare.text}</Text>
          <Text style={styles.explain}>
            You did it. Now dare up to {MAX_DARES_PER_DAY} friends – they get a notification and 24 hours to do it too.
            {left < MAX_DARES_PER_DAY ? ` (${left} left today)` : ''}
          </Text>
        </View>

        {friends === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : friends.length === 0 ? (
          <Text style={styles.none}>No friends on Peekaboo yet – dare someone who isn&apos;t on here below.</Text>
        ) : (
          friends.map((friend) => {
            const done = alreadyDared.has(friend.id);
            const selected = picked.includes(friend.id);
            return (
              <Pressable
                key={friend.id}
                disabled={done || left === 0}
                onPress={() => toggle(friend.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: done }}
                style={({ pressed }) => [styles.friend, selected && styles.friendOn, pressed && styles.pressed, done && styles.friendDone]}>
                <Avatar path={friend.avatar_path} name={friend.display_name || friend.username} size={40} />
                <View style={styles.names}>
                  <Text style={styles.name}>{friend.display_name || friend.username}</Text>
                  <Text style={styles.username}>{done ? 'Already dared today 😈' : `@${friend.username}`}</Text>
                </View>
                <Ionicons
                  name={done ? 'checkmark-done' : selected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={28}
                  color={done ? colors.textFaint : selected ? colors.pink : colors.textFaint}
                />
              </Pressable>
            );
          })
        )}

        <Button
          title={picked.length > 0 ? `Dare ${picked.length} friend${picked.length === 1 ? '' : 's'} 😈` : 'Pick friends to dare'}
          icon="flame"
          disabled={picked.length === 0}
          loading={sending}
          onPress={send}
        />
        <Button
          title="Dare someone who isn't on Peekaboo"
          icon="paper-plane"
          variant="secondary"
          onPress={() => inviteToDare(profile?.username)}
        />
        <Button title="Skip for now" variant="plain" onPress={() => router.back()} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.sm,
    paddingBottom: space.xxl * 2,
  },
  loading: {
    marginVertical: space.xl,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    marginBottom: space.md,
  },
  dareLabel: {
    ...font.label,
    color: colors.pink,
  },
  dareText: {
    ...font.heading,
  },
  explain: {
    ...font.small,
    fontSize: 14,
    lineHeight: 20,
  },
  none: {
    ...font.small,
    textAlign: 'center',
    marginVertical: space.lg,
  },
  friend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  friendOn: {
    borderColor: colors.pink,
  },
  friendDone: {
    opacity: 0.55,
  },
  pressed: {
    backgroundColor: colors.cardPressed,
  },
  names: {
    flex: 1,
  },
  name: {
    ...font.body,
    fontWeight: '800',
  },
  username: {
    ...font.small,
  },
});
