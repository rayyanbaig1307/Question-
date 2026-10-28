import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { sendSnap } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchFriends } from '@/lib/friends';
import { resizePhoto } from '@/lib/media';
import { createPost } from '@/lib/posts';
import { createStory } from '@/lib/stories';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// "Send to…": choose where your photo goes – your story, your profile, and/or friends as a peek.
export default function Share() {
  // `to` is set when you came from a chat: that friend is already ticked.
  const { uri, to } = useLocalSearchParams<{ uri: string; to?: string }>();
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const insets = useSafeAreaInsets();

  const [toStory, setToStory] = useState(!to);
  const [toProfile, setToProfile] = useState(false);
  const [caption, setCaption] = useState('');
  const [friends, setFriends] = useState<Profile[] | null>(null);
  const [picked, setPicked] = useState<string[]>(to ? [to] : []);
  const [busy, setBusy] = useState(false);
  // Remember what already worked, so trying again doesn't send twice.
  const [done, setDone] = useState({ story: false, profile: false, snaps: false });

  useEffect(() => {
    fetchFriends(userId)
      .then(setFriends)
      .catch(() => setFriends([]));
  }, [userId]);

  const toggleFriend = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const nothingPicked = !toStory && !toProfile && picked.length === 0;

  async function send() {
    setBusy(true);
    try {
      const photo = await resizePhoto(uri, 1080);
      if (picked.length > 0 && !done.snaps) {
        await sendSnap(userId, picked, photo);
        setDone((current) => ({ ...current, snaps: true }));
      }
      if (toStory && !done.story) {
        await createStory(userId, photo);
        setDone((current) => ({ ...current, story: true }));
      }
      if (toProfile && !done.profile) {
        await createPost(userId, photo, caption);
        setDone((current) => ({ ...current, profile: true }));
      }
      showToast(successMessage(picked.length, toStory, toProfile));
      // Back to the chat you came from, or to the camera.
      router.dismissTo(to ? `/chat/${to}` : '/');
    } catch (error) {
      Alert.alert('Could not send', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Send to…" />

      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Image source={{ uri }} style={styles.preview} resizeMode="cover" />

          <Option
            emoji="✨"
            title="My Story"
            subtitle="Friends can see it for 24 hours"
            selected={toStory}
            onPress={() => setToStory(!toStory)}
          />
          <Option
            emoji="🖼️"
            title="Post to my profile"
            subtitle="Stays on your profile grid"
            selected={toProfile}
            onPress={() => setToProfile(!toProfile)}
          />
          {toProfile ? (
            <TextField
              label="Caption"
              value={caption}
              onChangeText={setCaption}
              placeholder="Write a caption… (optional)"
              maxLength={300}
              multiline
            />
          ) : null}

          <Text style={styles.sectionTitle}>💌 Send as a peek</Text>
          {friends === null ? null : friends.length === 0 ? (
            <View style={styles.noFriends}>
              <Text style={styles.noFriendsText}>Add friends to send them peeks – photos that disappear once opened.</Text>
            </View>
          ) : (
            friends.map((friend) => {
              const selected = picked.includes(friend.id);
              return (
                <Pressable
                  key={friend.id}
                  onPress={() => toggleFriend(friend.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  style={({ pressed }) => [styles.friend, selected && styles.optionSelected, pressed && styles.optionPressed]}>
                  <Avatar path={friend.avatar_path} name={friend.display_name || friend.username} size={40} />
                  <View style={styles.optionText}>
                    <Text style={styles.optionTitle}>{friend.display_name || friend.username}</Text>
                    <Text style={styles.optionSubtitle}>@{friend.username}</Text>
                  </View>
                  <Ionicons
                    name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                    size={28}
                    color={selected ? colors.accent : colors.textFaint}
                  />
                </Pressable>
              );
            })
          )}
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + space.lg }]}>
          <Button title="Send" icon="send" onPress={send} loading={busy} disabled={nothingPicked} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function successMessage(friendCount: number, toStory: boolean, toProfile: boolean): string {
  const places = [
    friendCount > 0 ? (friendCount === 1 ? '1 friend' : `${friendCount} friends`) : null,
    toStory ? 'your story' : null,
    toProfile ? 'your profile' : null,
  ].filter((place): place is string => place !== null);
  if (places.length === 1 && friendCount > 0) return `Peek sent to ${places[0]}! 💌`;
  // "a", "a and b", "a, b and c"
  const list = places.length > 1 ? `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}` : places[0];
  return `Shared to ${list}! 🎉`;
}

function Option({ emoji, title, subtitle, selected, onPress }: {
  emoji: string;
  title: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.optionPressed]}>
      <Text style={styles.optionEmoji}>{emoji}</Text>
      <View style={styles.optionText}>
        <Text style={styles.optionTitle}>{title}</Text>
        <Text style={styles.optionSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons
        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
        size={28}
        color={selected ? colors.accent : colors.textFaint}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.md,
  },
  preview: {
    alignSelf: 'center',
    width: 140,
    height: 250,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: space.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  friend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionSelected: {
    borderColor: colors.accent,
  },
  optionPressed: {
    backgroundColor: colors.cardPressed,
  },
  optionEmoji: {
    fontSize: 28,
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    ...font.body,
    fontWeight: '800',
  },
  optionSubtitle: {
    ...font.small,
  },
  sectionTitle: {
    ...font.label,
    marginTop: space.md,
    marginLeft: space.xs,
  },
  noFriends: {
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  noFriendsText: {
    ...font.small,
  },
  footer: {
    padding: space.lg,
  },
});
