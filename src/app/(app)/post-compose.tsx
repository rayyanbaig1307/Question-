import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { PostPreview } from '@/components/PostPreview';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { useMediaUrl } from '@/lib/media';
import { fetchPost, postFromStory, updatePostCaption } from '@/lib/posts';
import { fetchStory } from '@/lib/stories';
import type { Audience, Post, Story } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// Edit before it goes on your grid, or after it's already there:
// - /post-compose?story=<id>  one of your stories → a post on your profile (write a caption first)
// - /post-compose?post=<id>   change the caption of a post you've already posted
export default function PostCompose() {
  const { story: storyId, post: postId } = useLocalSearchParams<{ story?: string; post?: string }>();
  const { userId, profile } = useMe();
  const { showToast } = useOverlays();
  const insets = useSafeAreaInsets();
  const [item, setItem] = useState<Story | Post | null | undefined>(undefined);
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState<Audience>('everyone');
  const [busy, setBusy] = useState(false);
  const editing = !!postId;

  useEffect(() => {
    const load = postId ? fetchPost(postId) : storyId ? fetchStory(storyId) : Promise.resolve(null);
    load
      .then((found) => {
        // Only your own things can be edited or reposted.
        const mine = found && found.user_id === userId ? found : null;
        setItem(mine);
        if (mine && 'caption' in mine) setCaption(mine.caption ?? '');
        if (mine?.audience) setAudience(mine.audience);
      })
      .catch(() => setItem(null));
  }, [postId, storyId, userId]);

  // The preview shows the photo itself, or a video's still frame.
  const previewPath = item ? (item.media_type === 'video' ? item.poster_path : item.media_path) : null;
  const previewUrl = useMediaUrl(previewPath);
  const name = profile?.display_name || profile?.username || 'You';

  async function save() {
    if (!item) return;
    setBusy(true);
    try {
      if (editing) {
        await updatePostCaption(item.id, caption);
        showToast('Caption updated ✏️');
      } else {
        await postFromStory(userId, item as Story, caption, audience);
        showToast('Added to your profile 🖼️');
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (error) {
      Alert.alert(editing ? 'Could not save' : 'Could not post', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title={editing ? 'Edit post' : 'Add to my profile'} />
      {item === undefined ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : item === null ? (
        <Text style={styles.gone}>This isn&apos;t available any more.</Text>
      ) : (
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.hint}>This is how it&apos;ll look on your profile</Text>
            <PostPreview
              uri={previewUrl}
              isVideo={item.media_type === 'video'}
              caption={caption}
              name={name}
              avatarPath={profile?.avatar_path}
            />
            <TextField
              label="Caption"
              value={caption}
              onChangeText={setCaption}
              placeholder="Write a caption… (optional)"
              maxLength={300}
              multiline
            />
            {editing ? null : (
              <View style={styles.audience}>
                <Text style={styles.audienceLabel}>Who can see it?</Text>
                <View style={styles.audienceRow}>
                  {(['everyone', 'close_friends'] as const).map((choice) => (
                    <Pressable
                      key={choice}
                      onPress={() => setAudience(choice)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: audience === choice }}
                      style={[styles.chip, audience === choice && styles.chipOn]}>
                      <Text style={[styles.chipText, audience === choice && styles.chipTextOn]}>
                        {choice === 'everyone' ? '🌍 Everyone' : '⭐ Close friends'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
          <View style={[styles.footer, { paddingBottom: insets.bottom + space.lg }]}>
            <Button title={editing ? 'Save' : 'Post to my profile'} icon={editing ? 'checkmark' : 'add'} onPress={save} loading={busy} />
          </View>
        </KeyboardAvoidingView>
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
  gone: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: space.xxl,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
  },
  hint: {
    ...font.small,
    color: colors.textMuted,
    textAlign: 'center',
  },
  audience: {
    gap: space.sm,
  },
  audienceLabel: {
    ...font.small,
    color: colors.textMuted,
    fontWeight: '700',
  },
  audienceRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  chipOn: {
    backgroundColor: colors.accent,
  },
  chipText: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
  },
  chipTextOn: {
    color: colors.white,
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
});
