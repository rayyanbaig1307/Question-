import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { resizePhoto } from '@/lib/media';
import { createPost, createStory } from '@/lib/posts';
import { colors, font, radius, space } from '@/theme';

// "Send to…": choose where your photo goes.
export default function Share() {
  const { uri } = useLocalSearchParams<{ uri: string }>();
  const { userId } = useMe();
  const { showToast } = useOverlays();

  const [toStory, setToStory] = useState(true);
  const [toProfile, setToProfile] = useState(false);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  // Remember what already worked, so trying again doesn't post twice.
  const [done, setDone] = useState({ story: false, profile: false });

  async function send() {
    setBusy(true);
    try {
      const photo = await resizePhoto(uri, 1080);
      if (toStory && !done.story) {
        await createStory(userId, photo);
        setDone((current) => ({ ...current, story: true }));
      }
      if (toProfile && !done.profile) {
        await createPost(userId, photo, caption);
        setDone((current) => ({ ...current, profile: true }));
      }
      showToast(
        toStory && toProfile
          ? 'Shared to your story and profile! 🎉'
          : toStory
            ? 'Added to your story! ✨'
            : 'Posted to your profile! 🎉',
      );
      router.dismissTo('/');
    } catch (error) {
      Alert.alert('Could not send', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton icon="chevron-back" label="Back" background={colors.card} onPress={() => router.back()} />
        <Text style={styles.title}>Send to…</Text>
        <View style={styles.headerSpacer} />
      </View>

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

          <View style={styles.friends}>
            <Text style={styles.friendsTitle}>👯 Friends</Text>
            <Text style={styles.friendsText}>
              Sending snaps straight to friends arrives with the Chat step.
            </Text>
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Button
            title="Send"
            icon="send"
            onPress={send}
            loading={busy}
            disabled={!toStory && !toProfile}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
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
        color={selected ? colors.yellow : colors.textFaint}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  headerSpacer: {
    width: 44,
  },
  title: {
    ...font.heading,
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
  optionSelected: {
    borderColor: colors.yellow,
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
  friends: {
    marginTop: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    gap: space.xs,
  },
  friendsTitle: {
    ...font.body,
    fontWeight: '800',
  },
  friendsText: {
    ...font.small,
  },
  footer: {
    padding: space.lg,
  },
});
