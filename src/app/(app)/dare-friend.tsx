import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { sendDareTo } from '@/lib/chat';
import { checkClean } from '@/lib/cleanWords';
import { checkDare } from '@/lib/dareSafety';
import { friendlyError } from '@/lib/errors';
import { fetchFriends } from '@/lib/friends';
import { inviteFriends } from '@/lib/invite';
import type { Profile } from '@/lib/types';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

const MAX_LENGTH = 200;

// A few ideas to tap if you can't think of one (they fill the box, you can still change them).
const IDEAS = [
  'Sing the chorus of your favourite song out loud in public',
  'Call your mum and tell her your best joke',
  'Do 20 push-ups right now',
  'Wear your clothes inside out for an hour',
  'Order your next drink in your best accent',
  'Text your crush "hey" with no context',
  'Post your oldest photo on your story',
];

// Write your own dare and send it to one or more friends – any time, as many as you like.
// Each friend gets it in their chat with you, with a "Do it" button that sends the proof back to you.
export default function DareFriend() {
  const { to } = useLocalSearchParams<{ to?: string }>();
  const { userId, profile } = useMe();
  const { showToast } = useOverlays();
  const [text, setText] = useState('');
  const [friends, setFriends] = useState<Profile[] | null>(null);
  const [picked, setPicked] = useState<string[]>(to ? [to] : []);
  const [busy, setBusy] = useState(false);
  const dare = text.trim();

  useEffect(() => {
    fetchFriends(userId)
      .then(setFriends)
      .catch(() => setFriends([]));
  }, [userId]);

  const toggle = (id: string) => {
    Haptics.selectionAsync();
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  };

  async function send() {
    if (!dare || picked.length === 0 || busy) return;
    const notAllowed = checkClean(dare, 'content') ?? checkDare(dare);
    if (notAllowed) {
      Alert.alert('Dare not sent', notAllowed);
      return;
    }
    setBusy(true);
    try {
      await sendDareTo(userId, picked, dare);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const names = (friends ?? []).filter((f) => picked.includes(f.id)).map((f) => f.display_name || f.username);
      showToast(`Dare sent to ${names.length <= 2 ? names.join(' & ') : `${names.length} friends`} 😈`);
      router.back();
    } catch (error) {
      Alert.alert('Dare not sent', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  const sendLabel =
    picked.length === 0 ? 'Pick who to dare' : picked.length === 1 ? 'Send dare 😈' : `Send to ${picked.length} friends 😈`;

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Dare a friend" />
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.step}>1 · Write your dare</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="I dare you to…"
            placeholderTextColor={colors.textFaint}
            keyboardAppearance={keyboardAppearance}
            selectionColor={colors.accent}
            multiline
            maxLength={MAX_LENGTH}
            style={styles.input}
          />
          <View style={styles.underInput}>
            <Text style={styles.hint}>Keep it fun and safe – nothing dangerous, illegal or mean.</Text>
            <Text style={styles.hint}>
              {dare.length}/{MAX_LENGTH}
            </Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.ideas} keyboardShouldPersistTaps="handled">
            {IDEAS.map((idea) => (
              <Pressable key={idea} onPress={() => setText(idea)} style={styles.idea} accessibilityLabel={`Use idea: ${idea}`}>
                <Text style={styles.ideaText} numberOfLines={1}>
                  💡 {idea}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.step}>2 · Who are you daring?</Text>
          {friends === null ? (
            <ActivityIndicator color={colors.accent} />
          ) : friends.length === 0 ? (
            <View style={styles.noFriends}>
              <Text style={styles.hint}>Add some friends first – then dare them.</Text>
              <Button title="Invite friends" icon="paper-plane" small onPress={() => inviteFriends(profile?.username)} />
            </View>
          ) : (
            <View style={styles.friends}>
              {friends.map((friend) => {
                const on = picked.includes(friend.id);
                const name = friend.display_name || friend.username;
                return (
                  <Pressable
                    key={friend.id}
                    onPress={() => toggle(friend.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={[styles.friend, on && styles.friendOn]}>
                    <Avatar path={friend.avatar_path} name={name} size={40} />
                    <Text style={styles.friendName} numberOfLines={1}>
                      {name}
                    </Text>
                    <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? colors.pink : colors.textFaint} />
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
        <View style={styles.footer}>
          <Button title={sendLabel} icon="flame" onPress={send} loading={busy} disabled={!dare || picked.length === 0} />
        </View>
      </KeyboardAvoidingView>
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
    paddingBottom: space.xxl,
  },
  step: {
    ...font.label,
    textTransform: 'uppercase',
    marginTop: space.sm,
  },
  input: {
    minHeight: 100,
    maxHeight: 180,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    padding: space.md,
    textAlignVertical: 'top',
  },
  underInput: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  hint: {
    ...font.small,
  },
  ideas: {
    gap: space.sm,
    paddingVertical: space.xs,
  },
  idea: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    maxWidth: 280,
  },
  ideaText: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
  },
  noFriends: {
    gap: space.sm,
    alignItems: 'flex-start',
  },
  friends: {
    gap: space.sm,
  },
  friend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.sm,
    paddingRight: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  friendOn: {
    borderColor: colors.pink,
  },
  friendName: {
    ...font.body,
    flex: 1,
    fontWeight: '700',
  },
  footer: {
    padding: space.lg,
    paddingBottom: space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
});
