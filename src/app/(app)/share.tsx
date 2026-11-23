import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { DareRulesSheet } from '@/components/DareRulesSheet';
import { DropRewindOption } from '@/components/DropRewindOption';
import { PostPreview } from '@/components/PostPreview';
import { ScreenHeader } from '@/components/ScreenHeader';
import { StoryPreview } from '@/components/StoryPreview';
import { VideoClip } from '@/components/VideoClipSafe';
import { TextField } from '@/components/TextField';
import { useNoRestartWhileOpen } from '@/lib/appUpdates';
import { useMe } from '@/lib/auth';
import { checkClean } from '@/lib/cleanWords';
import { cachedFriends, fetchFriends } from '@/lib/friends';
import type { Capture } from '@/lib/media';
import { todayDareDay, useDare } from '@/lib/dares';
import { useDareRulesAccepted } from '@/lib/legal';
import { dropSendingKey, queueShare, useDropSending, type SharePlan } from '@/lib/outbox';
import { fetchPlusAllowances, type PlusAllowances } from '@/lib/plusExtras';
import { discardUpload, markUsed, prepareUpload, type Prepared, type UploadFolder } from '@/lib/preupload';
import type { Audience, Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// "Send to…": choose where your photo goes – your story, your profile, and/or friends as a peek.
// Kept simple: "Post it" (story / profile) and "Send to friends". Dare, drop, forfeit and Guess Who only show up
// when you took the photo for one of those (from the camera's mode bubbles or the Dare page).
//
// Instant: the photo starts uploading the moment this screen opens (lib/preupload.ts), and Send hands everything to
// the outbox (lib/outbox.ts) and closes the screen at once. A "Sending…" banner and a toast say how it went.
export default function Share() {
  // `to` is set when you came from a chat: that friend is already ticked.
  // `dare` is set when you're doing the Daily Dare: "Today's dare" is already ticked.
  // `drop` is set when you're posting your Peekaboo drop: "Today's drop" is already ticked.
  // `guess` is set when you came from Guess Who: "Guess Who" is already ticked.
  // `video` is '1' for a video; `overlay` is its text/sticker layer (if any).
  // `pick` is 'friends' when you came to pick friends (Main Character Mode's Send): My Story isn't ticked then.
  const { uri, video, overlay, to, dare, drop, guess, forfeit, pick } = useLocalSearchParams<{
    uri: string;
    video?: string;
    overlay?: string;
    to?: string;
    dare?: string;
    drop?: string;
    guess?: string;
    forfeit?: string;
    pick?: string;
  }>();
  const isVideo = video === '1';
  const fromDare = dare === '1';
  const fromDrop = drop === '1';
  const fromGuess = guess === '1';
  // `forfeit` is the forfeit you're paying with this photo.
  const fromForfeit = !!forfeit;
  const { userId, profile } = useMe();
  // No restart for a new app version while you're choosing where it goes.
  useNoRestartWhileOpen();
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

  const [toStory, setToStory] = useState(!to && !fromDare && !fromDrop && !fromGuess && !fromForfeit && pick !== 'friends');
  const [toForfeit, setToForfeit] = useState(fromForfeit);
  // Guess Who goes nowhere else (otherwise the same photo on your story would give you away).
  const [toGuess, setToGuess] = useState(fromGuess);
  // Your story and profile post: for everyone, or just your close friends.
  const [audience, setAudience] = useState<Audience>('everyone');
  const [toProfile, setToProfile] = useState(false);
  const [toDare, setToDare] = useState(fromDare);
  // Your drop from a moment ago is still on its way: this photo doesn't start as a second drop (there's only one
  // drop a day, and a second one could even be saved before the first).
  const dropSending = useDropSending(userId);
  const [toDrop, setToDrop] = useState(fromDrop && !dropSending);
  // ⏰ Peekaboo+ drop rewind: post a late drop without the "late" label (once a week). `rewindInfo` stays null
  // when the server doesn't have it yet, and then the choice isn't shown.
  const [rewind, setRewind] = useState(false);
  const [rewindInfo, setRewindInfo] = useState<PlusAllowances | null>(null);
  const [caption, setCaption] = useState('');
  // Your friends: the list from earlier straight away (if there is one), then a fresh one.
  const [friends, setFriends] = useState<Profile[] | null>(() => cachedFriends(userId));
  const [picked, setPicked] = useState<string[]>(to ? [to] : []);
  // Only while the "did you agree to the dare rules?" check is still waiting for the server (at most 20 seconds).
  const [checkingRules, setCheckingRules] = useState(false);
  // Sent: Send does nothing more (a second tap can arrive before the screen closes).
  const sent = useRef(false);
  // The dare rules were just agreed to (or the server said so) for this send.
  const rulesOk = useRef(false);

  useEffect(() => {
    fetchFriends(userId)
      .then(setFriends)
      .catch(() => setFriends((current) => current ?? []));
  }, [userId]);

  // 📤 The early upload: starts now, while you pick where it goes. Into the folder it most likely needs (a drop,
  // dare or forfeit → posts, with the drop's blurry preview; Guess Who → its own folder; a peek → snaps; else your
  // story). Leaving without sending throws it away; sending hands it to the outbox.
  const capture = useMemo<Capture>(
    () => (isVideo ? { kind: 'video', uri, overlayUri: overlay ?? null } : { kind: 'photo', uri }),
    [isVideo, uri, overlay],
  );
  const folder: UploadFolder =
    fromDrop || fromDare || fromForfeit ? 'posts' : fromGuess ? 'mystery' : to || pick === 'friends' ? 'snaps' : 'stories';
  const early = useRef<Prepared | null>(null);
  useEffect(() => {
    const upload = prepareUpload(userId, capture, folder, { blur: fromDrop });
    early.current = upload;
    return () => {
      if (!sent.current) discardUpload(upload);
      if (early.current === upload) early.current = null;
    };
  }, [userId, capture, folder, fromDrop]);

  useEffect(() => {
    if (!fromDrop) return;
    let cancelled = false;
    fetchPlusAllowances()
      .then((info) => !cancelled && setRewindInfo(info))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fromDrop]);

  const toggleFriend = (id: string) => {
    setToGuess(false);
    setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  // (From the Guess Who camera nothing else can be picked, so picking anything just clears Guess Who.)
  const toggle = (set: (on: boolean) => void, on: boolean) => {
    setToGuess(false);
    set(on);
  };

  const nothingPicked = !toStory && !toProfile && !toDare && !toDrop && !toGuess && !toForfeit && picked.length === 0;
  // A dare, drop or forfeit photo is a post on your profile too, so "Post to my profile" isn't needed then.
  const postToProfile = toProfile && !toDare && !toDrop && !toForfeit;

  // Your drop is still on its way: a second drop isn't sent (only one drop a day). Says so, and gives true.
  function dropStillSending(): boolean {
    if (!toDrop || !dropSendingKey(userId)) return false;
    Alert.alert(
      'Your drop is still on its way',
      "Wait until it's posted – there's only one drop a day. Or untick \"Today's drop\" to send this photo somewhere else.",
    );
    return true;
  }

  async function send(storyOk = storyChecked) {
    if (sent.current || dropStillSending()) return;
    const notAllowed = checkClean(caption, 'content');
    if (notAllowed) {
      Alert.alert('Caption not allowed', notAllowed);
      return;
    }
    // Dares, drops and forfeits need the one-time "Before your first dare" agreement. Someone this phone knows has
    // agreed goes straight on; otherwise the check is waited for (never the sheet just because it's still asking).
    if ((toDare || toDrop || toForfeit) && dareRules.accepted !== true && !rulesOk.current) {
      setCheckingRules(true);
      let agreed = false;
      try {
        agreed = await dareRules.ensure();
      } catch {
        agreed = false;
      } finally {
        setCheckingRules(false);
      }
      if (!agreed) {
        setRulesOpen(true);
        return;
      }
      rulesOk.current = true;
    }
    if (toStory && !storyOk) {
      setStoryPreviewOpen(true);
      return;
    }
    if (postToProfile) {
      setPreviewOpen(true);
      return;
    }
    sendNow();
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

  // Hands everything to the outbox and leaves at once. The drop, dare or forfeit post is saved first (the server
  // stamps On time / Late when it's saved); the toasts and the "Sending…" banner say how it went.
  function sendNow() {
    // A second tap can arrive before the screen closes.
    if (sent.current || nothingPicked || dropStillSending()) return;
    // The caption can change in the preview, so check the final text too.
    const notAllowed = checkClean(caption, 'content');
    if (notAllowed) {
      Alert.alert('Caption not allowed', notAllowed);
      return;
    }
    const upload = early.current;
    if (!upload) return;
    sent.current = true;
    const names = Object.fromEntries(picked.map((id) => [id, friendName(id)]));
    const plan: SharePlan = {
      friendIds: toGuess ? [] : picked,
      names,
      story: toStory && !toGuess,
      profile: postToProfile,
      guess: toGuess,
      caption,
      audience,
      post:
        toDare || toDrop || toForfeit
          ? { dare: toDare, drop: toDrop, rewind: toDrop && rewind, ...(toForfeit && forfeit ? { forfeit } : {}) }
          : null,
    };
    const { postId, postJob } = queueShare(userId, plan, upload);
    markUsed(upload);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const leave = () => {
      // After your drop: to Home, where your friends' drops unlock as soon as it's saved.
      // Otherwise back to the Dare screen, the chat you came from, or the camera.
      if (toGuess) router.dismissTo('/guess');
      else if (fromForfeit) router.dismissTo('/dare');
      else if (fromDrop) router.dismissTo({ pathname: '/', params: { page: 'home' } });
      else router.dismissTo(fromDare ? '/dare' : to ? `/chat/${to}` : '/');
      // You did the dare: now dare your friends (they get 24 hours). It waits for your post to be saved.
      if (toDare && postId) router.push({ pathname: '/dare-chain', params: { post: postId, ...(postJob ? { job: postJob } : {}) } });
    };
    if (previewOpen || storyPreviewOpen) {
      // Let the preview slide away first.
      setPreviewOpen(false);
      setStoryPreviewOpen(false);
      setTimeout(leave, 350);
    } else {
      leave();
    }
  }

  // What the Send button will do, in plain words ("Send to My Story + Sam").
  const friendName = (id: string) => {
    const friend = friends?.find((f) => f.id === id);
    return friend ? friend.display_name || friend.username : '1 friend';
  };
  const places = [
    toForfeit ? 'my forfeit' : null,
    toDrop ? 'my drop' : null,
    toDare ? "today's dare" : null,
    toGuess ? 'Guess Who' : null,
    toStory ? 'My Story' : null,
    postToProfile ? 'my profile' : null,
    picked.length === 1 ? friendName(picked[0]) : picked.length > 1 ? `${picked.length} friends` : null,
  ].filter((place): place is string => place !== null);
  const sendTitle = fromGuess
    ? 'Post my Guess Who 🕵️'
    : places.length === 0
      ? 'Pick where it goes'
      : `Send to ${places.length <= 2 ? places.join(' + ') : `${places[0]} + ${places.length - 1} more`}`;

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Send to…" />

      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Your photo, a one-line "what to do", and Edit (back to the editor – text and stickers stay). */}
          <View style={styles.intro}>
            {isVideo ? (
              <VideoClip uri={uri} overlayUri={overlay} playing muted loop style={styles.preview} />
            ) : (
              <Image source={{ uri }} style={styles.preview} resizeMode="cover" />
            )}
            <View style={styles.introText}>
              <Text style={styles.introTitle}>Where should it go?</Text>
              <Text style={styles.introHint}>Tap the places you want, then tap the button at the bottom.</Text>
              <Button title="Edit" icon="pencil" variant="secondary" small onPress={() => router.back()} style={styles.editButton} />
            </View>
          </View>

          <Text style={styles.sectionTitle}>📣 Post it</Text>
          {fromDrop ? (
            <Option
              emoji="👀"
              title="Today's drop"
              subtitle={dropSending ? 'Your drop is still on its way…' : "Unlocks everyone's drops"}
              selected={toDrop}
              onPress={() => toggle(setToDrop, !toDrop)}
            />
          ) : null}
          {fromDrop && toDrop && rewindInfo ? (
            <DropRewindOption allowances={rewindInfo} selected={rewind} onChange={setRewind} />
          ) : null}
          {fromForfeit ? (
            <Option
              emoji="💀"
              title="Pay my forfeit"
              subtitle="Goes on your profile – your friend gets told"
              selected={toForfeit}
              onPress={() => toggle(setToForfeit, !toForfeit)}
            />
          ) : null}
          {fromDare ? (
            <Option
              emoji="🎯"
              title="Today's dare"
              subtitle={`"${todaysDare.text}"`}
              selected={toDare}
              onPress={() => toggle(setToDare, !toDare)}
            />
          ) : null}
          {fromGuess ? (
            // From the Guess Who camera there's no choice: it only goes to the Guess Who page, with no name on it.
            <Option
              emoji="🕵️"
              title="Guess Who"
              subtitle="Posted with no name – friends have to guess it's you. Not on your story or profile."
              selected
              onPress={() => {}}
            />
          ) : (
            <Option
              emoji="✨"
              title="My Story"
              subtitle="Your friends see it for 24 hours"
              selected={toStory}
              onPress={() => toggle(setToStory, !toStory)}
            />
          )}
          {toDare || toDrop || toForfeit || fromGuess ? null : (
            <Option
              emoji="🖼️"
              title="My Profile"
              subtitle="Stays on your profile"
              selected={toProfile}
              onPress={() => toggle(setToProfile, !toProfile)}
            />
          )}
          {toStory || postToProfile || toDare || toDrop || toForfeit ? (
            <View style={styles.closeRow}>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>⭐ Close friends only</Text>
                <Text style={styles.optionSubtitle}>
                  {audience === 'close_friends' ? 'Only your close friends will see it' : 'Off – uses your account’s privacy setting'}
                </Text>
              </View>
              <Switch
                value={audience === 'close_friends'}
                onValueChange={(on) => setAudience(on ? 'close_friends' : 'everyone')}
                trackColor={{ true: colors.green, false: colors.border }}
                thumbColor={colors.white}
              />
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

          {toGuess ? null : (
            <>
              <Text style={styles.sectionTitle}>💌 Send to friends</Text>
              <Text style={styles.sectionHint}>Only they see it, and it disappears after they open it.</Text>
              {friends === null ? null : friends.length === 0 ? (
                <View style={styles.noFriends}>
                  <Text style={styles.noFriendsText}>No friends yet – add some to send them photos.</Text>
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
                      <Text style={[styles.optionTitle, styles.friendName]} numberOfLines={1}>
                        {friend.display_name || friend.username}
                      </Text>
                      <Ionicons
                        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                        size={28}
                        color={selected ? colors.accent : colors.textFaint}
                      />
                    </Pressable>
                  );
                })
              )}
            </>
          )}
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + space.lg }]}>
          <Button title={sendTitle} icon="send" onPress={() => send()} loading={checkingRules} disabled={nothingPicked} />
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
            <Button title="Post" icon="send" onPress={sendNow} />
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
        busy={false}
        onEdit={editStory}
        onShare={shareStory}
        onClose={() => setStoryPreviewOpen(false)}
      />
      <DareRulesSheet
        visible={rulesOpen}
        onClose={() => setRulesOpen(false)}
        onAccept={async () => {
          await dareRules.accept();
          rulesOk.current = true;
          setRulesOpen(false);
          // Agreed: the send carries on by itself (no second tap) – once the rules sheet has slid away, because
          // iPhones won't open the story preview (or close this screen) while another sheet is still closing.
          setTimeout(() => void send(), Platform.OS === 'ios' ? 500 : 250);
        }}
      />
    </View>
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
        <Text style={styles.optionSubtitle} numberOfLines={2}>
          {subtitle}
        </Text>
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
  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
  },
  introText: {
    flex: 1,
    gap: space.xs,
  },
  introTitle: {
    ...font.heading,
    fontSize: 22,
  },
  introHint: {
    ...font.small,
    lineHeight: 19,
  },
  editButton: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
  },
  preview: {
    width: 90,
    height: 160,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  option: {
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
    ...font.body,
    fontWeight: '900',
    fontSize: 17,
    marginTop: space.md,
    marginLeft: space.xs,
  },
  sectionHint: {
    ...font.small,
    marginTop: -space.sm,
    marginLeft: space.xs,
  },
  closeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  friendName: {
    flex: 1,
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
