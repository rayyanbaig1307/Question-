import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { DareRulesSheet } from '@/components/DareRulesSheet';
import { useOverlays } from '@/components/Overlays';
import { PostPreview } from '@/components/PostPreview';
import { ScreenHeader } from '@/components/ScreenHeader';
import { StoryPreview } from '@/components/StoryPreview';
import { VideoClip } from '@/components/VideoClipSafe';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { sendSnap } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchFriends } from '@/lib/friends';
import { resizePhoto, type Capture } from '@/lib/media';
import { todayDareDay, useDare } from '@/lib/dares';
import { lateLabel } from '@/lib/drop';
import { useDareRulesAccepted } from '@/lib/legal';
import { postMystery } from '@/lib/guess';
import { createPost } from '@/lib/posts';
import { createStory } from '@/lib/stories';
import type { Audience, Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// "Send to…": choose where your photo goes – your story, your profile, and/or friends as a peek.
export default function Share() {
  // `to` is set when you came from a chat: that friend is already ticked.
  // `dare` is set when you're doing the Daily Dare: "Today's dare" is already ticked.
  // `drop` is set when you're posting your Peekaboo drop: "Today's drop" is already ticked.
  // `guess` is set when you came from Guess Who: "Guess Who" is already ticked.
  // `video` is '1' for a video; `overlay` is its text/sticker layer (if any).
  const { uri, video, overlay, to, dare, drop, guess, forfeit } = useLocalSearchParams<{
    uri: string;
    video?: string;
    overlay?: string;
    to?: string;
    dare?: string;
    drop?: string;
    guess?: string;
    forfeit?: string;
  }>();
  const isVideo = video === '1';
  const fromDare = dare === '1';
  const fromDrop = drop === '1';
  const fromGuess = guess === '1';
  // `forfeit` is the forfeit you're paying with this photo.
  const fromForfeit = !!forfeit;
  const { userId, profile } = useMe();
  const { showToast } = useOverlays();
  // "Post to my profile" first shows how the post will look, with the caption still editable.
  const [previewOpen, setPreviewOpen] = useState(false);
  // "My Story" first shows the story full screen, with Edit (back to the editor) or Share to story.
  const [storyPreviewOpen, setStoryPreviewOpen] = useState(false);
  const [storyChecked, setStoryChecked] = useState(false);
  const insets = useSafeAreaInsets();
  const todaysDare = useDare(todayDareDay());
  // Dares, drops and forfeits need the one-time "Before your first dare" agreement.
  const dareRules = useDareRulesAccepted(userId);
  const [rulesOpen, setRulesOpen] = useState(false);

  const [toStory, setToStory] = useState(!to && !fromDare && !fromDrop && !fromGuess && !fromForfeit);
  const [toForfeit, setToForfeit] = useState(fromForfeit);
  // Guess Who goes nowhere else (otherwise the same photo on your story would give you away).
  const [toGuess, setToGuess] = useState(fromGuess);
  // Your story and profile post: for everyone, or just your close friends.
  const [audience, setAudience] = useState<Audience>('everyone');
  const [toProfile, setToProfile] = useState(false);
  const [toDare, setToDare] = useState(fromDare);
  const [toDrop, setToDrop] = useState(fromDrop);
  const [caption, setCaption] = useState('');
  const [friends, setFriends] = useState<Profile[] | null>(null);
  const [picked, setPicked] = useState<string[]>(to ? [to] : []);
  const [busy, setBusy] = useState(false);
  // Remember what already worked, so trying again doesn't send twice.
  const [done, setDone] = useState({ story: false, profile: false, snaps: false, post: false, guess: false });

  useEffect(() => {
    fetchFriends(userId)
      .then(setFriends)
      .catch(() => setFriends([]));
  }, [userId]);

  const toggleFriend = (id: string) => {
    setToGuess(false);
    setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  // Picking anything else turns Guess Who off, and picking Guess Who turns everything else off.
  const toggle = (set: (on: boolean) => void, on: boolean) => {
    setToGuess(false);
    set(on);
  };
  function toggleGuess() {
    if (toGuess) {
      setToGuess(false);
      return;
    }
    setToGuess(true);
    setToStory(false);
    setToProfile(false);
    setToDare(false);
    setToDrop(false);
    setPicked([]);
  }

  const nothingPicked = !toStory && !toProfile && !toDare && !toDrop && !toGuess && !toForfeit && picked.length === 0;
  // A dare, drop or forfeit photo is a post on your profile too, so "Post to my profile" isn't needed then.
  const postToProfile = toProfile && !toDare && !toDrop && !toForfeit;

  async function send(storyOk = storyChecked) {
    if ((toDare || toDrop || toForfeit) && !dareRules.accepted) {
      setRulesOpen(true);
      return;
    }
    if (toStory && !done.story && !storyOk) {
      setStoryPreviewOpen(true);
      return;
    }
    if (postToProfile && !done.profile) {
      setPreviewOpen(true);
      return;
    }
    await sendNow();
  }

  // From the story preview: carry on (the profile-post preview comes next if that's picked too).
  function shareStory() {
    setStoryChecked(true);
    setStoryPreviewOpen(false);
    // Let the story preview slide away before anything else opens.
    setTimeout(() => send(true), Platform.OS === 'ios' ? 500 : 250);
  }

  // From the story preview: back to the editor, with your text and stickers as you left them.
  function editStory() {
    setStoryPreviewOpen(false);
    setTimeout(() => router.back(), Platform.OS === 'ios' ? 500 : 250);
  }

  async function sendNow() {
    setPreviewOpen(false);
    setBusy(true);
    try {
      // Photos are shrunk first so they upload quickly; videos were already recorded small.
      const photo: Capture = isVideo
        ? { kind: 'video', uri, overlayUri: overlay ?? null }
        : { kind: 'photo', uri: await resizePhoto(uri, 1080) };
      if (toGuess && !done.guess) {
        await postMystery(userId, photo, caption);
        setDone((current) => ({ ...current, guess: true }));
      }
      if (picked.length > 0 && !done.snaps) {
        await sendSnap(userId, picked, photo);
        setDone((current) => ({ ...current, snaps: true }));
      }
      if (toStory && !done.story) {
        await createStory(userId, photo, audience);
        setDone((current) => ({ ...current, story: true }));
      }
      if (postToProfile && !done.profile) {
        await createPost(userId, photo, caption, { audience });
        setDone((current) => ({ ...current, profile: true }));
      }
      // One post can be your drop, your dare answer, or both.
      let dropLate: number | null = null;
      let darePostId: string | null = null;
      if ((toDare || toDrop || toForfeit) && !done.post) {
        const post = await createPost(userId, photo, caption, {
          dare: toDare,
          drop: toDrop,
          forfeit: toForfeit && forfeit ? forfeit : undefined,
        });
        dropLate = post.drop_late_seconds;
        if (toDare) darePostId = post.id;
        setDone((current) => ({ ...current, post: true }));
      }
      // A happy little buzz: it's sent!
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(
        toForfeit
          ? 'Forfeit paid 💀✅ Respect.'
          : toGuess
          ? "Guess Who posted 🕵️ Let's see who figures it out!"
          : toDrop && dropLate !== null
          ? lateLabel(dropLate).onTime
            ? 'Drop posted · On time! 👀🔥'
            : `Drop posted · ${lateLabel(dropLate).text}`
          : toDare
            ? 'Dare done! 🎯🔥'
            : successMessage(picked.length, toStory, postToProfile),
      );
      // After your drop: to Home, where your friends' drops just unlocked.
      // Otherwise back to the Dare screen, the chat you came from, or the camera.
      if (toGuess) router.dismissTo('/guess');
      else if (fromForfeit) router.dismissTo('/dare');
      else if (fromDrop) router.dismissTo({ pathname: '/', params: { page: 'home' } });
      else router.dismissTo(fromDare ? '/dare' : to ? `/chat/${to}` : '/');
      // You did the dare: now dare your friends (they get 24 hours).
      if (toDare && darePostId) router.push({ pathname: '/dare-chain', params: { post: darePostId } });
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
          <View>
            {isVideo ? (
              <VideoClip uri={uri} overlayUri={overlay} playing muted loop style={styles.preview} />
            ) : (
              <Image source={{ uri }} style={styles.preview} resizeMode="cover" />
            )}
            {/* Back to the editor (text, stickers, filters stay as you left them) */}
            <Pressable style={styles.editChip} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Edit photo">
              <Ionicons name="pencil" size={14} color={colors.white} />
              <Text style={styles.editChipText}>Edit</Text>
            </Pressable>
          </View>

          {fromDrop ? (
            <Option
              emoji="👀"
              title="Today's Peekaboo drop"
              subtitle="Unlocks your friends' drops · on your profile and Home"
              selected={toDrop}
              onPress={() => toggle(setToDrop, !toDrop)}
            />
          ) : null}
          {fromForfeit ? (
            <Option
              emoji="💀"
              title="Pay my forfeit"
              subtitle="Goes on your profile with a 💀 tag · the friend who picked it gets told"
              selected={toForfeit}
              onPress={() => toggle(setToForfeit, !toForfeit)}
            />
          ) : null}
          <Option
            emoji="🎯"
            title="Today's dare"
            subtitle={`"${todaysDare.text}" · everyone sees it on the Dare page`}
            selected={toDare}
            onPress={() => toggle(setToDare, !toDare)}
          />
          <Option
            emoji="✨"
            title="My Story"
            subtitle="Friends can see it for 24 hours"
            selected={toStory}
            onPress={() => toggle(setToStory, !toStory)}
          />
          <Option
            emoji="🕵️"
            title="Guess Who"
            subtitle="Posted without your name – friends guess who it was (24 hours)"
            selected={toGuess}
            onPress={toggleGuess}
          />
          {toDare || toDrop || toForfeit ? null : (
            <Option
              emoji="🖼️"
              title="Post to my profile"
              subtitle="Stays on your profile grid"
              selected={toProfile}
              onPress={() => toggle(setToProfile, !toProfile)}
            />
          )}
          {toStory || postToProfile ? (
            <View style={styles.audience}>
              <Text style={styles.audienceLabel}>Who can see your {toStory && postToProfile ? 'story and post' : toStory ? 'story' : 'post'}?</Text>
              <View style={styles.audienceRow}>
                {(['everyone', 'close_friends'] as const).map((choice) => (
                  <Pressable
                    key={choice}
                    onPress={() => setAudience(choice)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: audience === choice }}
                    style={[styles.audienceChip, audience === choice && (choice === 'close_friends' ? styles.closeOn : styles.everyoneOn)]}>
                    <Text style={[styles.audienceText, audience === choice && styles.audienceTextOn]}>
                      {choice === 'everyone' ? '🌍 Everyone' : '⭐ Close friends'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {postToProfile || toDare || toDrop || toGuess || toForfeit ? (
            <TextField
              label="Caption"
              value={caption}
              onChangeText={setCaption}
              placeholder={toGuess ? 'A hint… (optional – careful, don\'t give yourself away! 🤫)' : 'Write a caption… (optional)'}
              maxLength={toGuess ? 200 : 300}
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
          <Button title="Send" icon="send" onPress={() => send()} loading={busy} disabled={nothingPicked} />
        </View>
      </KeyboardAvoidingView>
      <Modal visible={previewOpen} transparent animationType="slide" onRequestClose={() => setPreviewOpen(false)}>
        <KeyboardAvoidingView style={styles.previewBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.previewSheet, { paddingBottom: insets.bottom + space.lg }]}>
            <Text style={styles.previewTitle}>This is how it&apos;ll look on your profile</Text>
            <PostPreview
              uri={isVideo ? null : uri}
              isVideo={isVideo}
              caption={caption}
              name={profile?.display_name || profile?.username || 'You'}
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
            <Button title="Post" icon="send" onPress={sendNow} loading={busy} />
            <Pressable onPress={() => setPreviewOpen(false)} style={styles.keepEditing} accessibilityRole="button">
              <Text style={styles.keepEditingText}>Keep editing</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <StoryPreview
        visible={storyPreviewOpen}
        uri={uri}
        isVideo={isVideo}
        overlayUri={overlay}
        audience={audience}
        avatarPath={profile?.avatar_path}
        name={profile?.display_name || profile?.username || 'You'}
        busy={busy}
        onEdit={editStory}
        onShare={shareStory}
        onClose={() => setStoryPreviewOpen(false)}
      />
      <DareRulesSheet
        visible={rulesOpen}
        onClose={() => setRulesOpen(false)}
        onAccept={async () => {
          await dareRules.accept();
          setRulesOpen(false);
        }}
      />
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
  editChip: {
    position: 'absolute',
    top: space.sm,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  editChipText: {
    ...font.small,
    color: colors.white,
    fontWeight: '800',
  },
  previewBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  previewSheet: {
    gap: space.md,
    padding: space.lg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  previewTitle: {
    ...font.heading,
    textAlign: 'center',
  },
  keepEditing: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  keepEditingText: {
    ...font.body,
    color: colors.textMuted,
    fontWeight: '700',
  },
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
  audience: {
    gap: space.sm,
  },
  audienceLabel: {
    ...font.label,
    marginLeft: space.xs,
  },
  audienceRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  audienceChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  everyoneOn: {
    borderColor: colors.accent,
  },
  closeOn: {
    borderColor: colors.green,
  },
  audienceText: {
    ...font.body,
    fontWeight: '800',
    color: colors.textMuted,
  },
  audienceTextOn: {
    color: colors.text,
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
