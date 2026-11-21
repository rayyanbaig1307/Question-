import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { StatusBar } from 'expo-status-bar';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge, SafeScreen } from '@/components/SafeEdge';
import { VideoClip } from '@/components/VideoClipSafe';
import { ZoomableImage } from '@/components/ZoomableImage';
import { useMe } from '@/lib/auth';
import { canReplay, fetchMessage, getSnapUrl, isChatPhoto, openSnap, replaySnap, setSnapSaved } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import {
  canUnsaveGroupSnap,
  fetchGroupMessage,
  fetchGroupSnapOpens,
  forgetGroupSnapUnshown,
  groupSnapScreenshot,
  groupSnapUnshown,
  noteGroupSnapUnshown,
  openGroupSnap,
  replayGroupSnap,
  setGroupSnapSaved,
} from '@/lib/groupChat';
import { fetchProfile } from '@/lib/profiles';
import { useScreenshotDetector, useScreenshotNotice } from '@/lib/screenshots';
import type { Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';

const SECONDS = 10;
// A video peek plays to its end (videos can be up to 30 seconds, or 60 with Peekaboo+).
const MAX_VIDEO_SECONDS = 60;
// After a pause the timer gives you at least this long, so a report picked from the ⋯ menu (which starts a
// moment after the menu closes) isn't cut off by the peek closing. You get this extra time only once per peek,
// so opening and closing the menu again and again can't keep the peek on screen.
const MIN_LEFT_MS = 1000;

// first = opening it for the first time, replay = your one replay, saved = saved in the chat (no time limit).
type Mode = 'first' | 'replay' | 'saved';

// 👀 Group snaps are opened FIRST (the server then lets you download them for 5 minutes, on this phone) and downloaded
// after – the other way round from a one-on-one peek. If the download fails, or you go back while it's downloading,
// the view isn't wasted: tapping it again within a few minutes shows it without using up your replay (the chat then
// says "Tap to view"; see UNSHOWN_RETRY_MS in src/lib/groupChat.ts). The chat's clock moves every 15 seconds, so a
// tap here gets half a minute more than the chat shows – still well inside the server's 5 minutes.
const UNSHOWN_EXTRA_MS = 30 * 1000;

type State =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'error' }
  // `other` = the other person in the chat (who gets told about screenshots).
  | {
      kind: 'showing';
      url: string;
      // Video peeks: their still picture and text/sticker layer.
      video: { posterUrl: string | null; overlayUrl: string | null } | null;
      sender: Profile | null;
      mode: Mode;
      // The other person in a one-on-one chat (told about screenshots); null in a group chat.
      other: string | null;
      // A photo picked from Photos in a one-on-one chat (it never disappears: no timer, no Save button).
      photo: boolean;
      // Whether the Save / Saved button shows (a group snap someone else saved: only they or the sender can unsave).
      canToggleSave: boolean;
    };

// Shows a peek (a photo sent in chat) for 10 seconds. You get one replay afterwards,
// and a peek that's saved in the chat can be opened any time.
export default function SnapViewer() {
  // `group=1`: a snap in a group chat (a group_messages row); otherwise a peek in a one-on-one chat.
  const { id, group } = useLocalSearchParams<{ id: string; group?: string }>();
  const inGroup = group === '1';
  // What it's called on screen (once it's loaded, a photo picked from Photos is called a photo: see shownWord).
  const word = inGroup ? 'snap' : 'peek';
  const { userId } = useMe();
  const { showToast, showOptions } = useOverlays();
  const { report } = useSafetyActions();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // paused = the ⋯ menu is open: the timer waits and the peek is covered.
  // reporting = you're reporting it: the timer stops for good and the peek stays covered.
  const [paused, setPaused] = useState(false);
  const [reporting, setReporting] = useState(false);
  const progress = useSharedValue(0);
  // Whether this peek already got its one bit of extra time after a pause (see MIN_LEFT_MS).
  const extraGiven = useRef(false);
  // Pinch-zoom on the photo: whether it's zoomed in, and when that last changed.
  const zoomRef = useRef({ zoomed: false, at: 0 });

  useEffect(() => {
    let cancelled = false;
    // 👀 A snap in a group chat.
    async function loadGroupSnap() {
      const message = await fetchGroupMessage(id);
      if (cancelled) return;
      if (!message || message.kind !== 'snap' || !message.media_path) {
        setState({ kind: 'gone' });
        return;
      }
      let mode: Mode;
      if (message.saved_at) {
        // Saved in the chat: a normal photo for everyone in the group (and always yours to see if you sent it).
        // Opening it only notes that you've seen it; whether you may see it is up to the download below.
        mode = 'saved';
        if (message.sender_id !== userId) await openGroupSnap(message.id).catch(() => false);
      } else if (message.sender_id === userId) {
        // Your own snap (not saved): like a peek you sent, you don't open it again.
        setState({ kind: 'gone' });
        return;
      } else {
        const unshown = groupSnapUnshown(userId, message.id, Date.now(), UNSHOWN_EXTRA_MS);
        if (unshown) {
          // Opened a moment ago on this phone but never shown: the server still lets you download it.
          mode = unshown;
        } else {
          const opens = await fetchGroupSnapOpens([message.id]);
          const mine = opens.get(message.id)?.find((open) => open.user_id === userId);
          if (cancelled) return;
          if (mine && mine.replayed_at) {
            setState({ kind: 'gone' });
            return;
          }
          mode = mine ? 'replay' : 'first';
          // The server decides (24 hours, joined after it was sent, removed from the group…).
          const allowed = mode === 'first' ? await openGroupSnap(message.id) : await replayGroupSnap(message.id);
          if (!allowed) {
            if (!cancelled) setState({ kind: 'gone' });
            return;
          }
          noteGroupSnapUnshown(userId, message.id, mode);
        }
      }
      // You may have gone back meanwhile: it stays ready for a few minutes (see UNSHOWN_RETRY_MS).
      if (cancelled) return;
      // A one-minute link, never the chat's longer-lasting ones.
      const url = await getSnapUrl(message.media_path);
      const isVideo = message.media_type === 'video';
      const posterUrl = isVideo && message.poster_path ? await getSnapUrl(message.poster_path) : null;
      const overlayUrl = isVideo && message.overlay_path ? await getSnapUrl(message.overlay_path) : null;
      const ready = isVideo ? !!url && (!posterUrl || (await Image.prefetch(posterUrl, 'memory'))) : !!url && (await Image.prefetch(url, 'memory'));
      if (cancelled) return;
      if (!url || !ready) {
        setState({ kind: 'error' });
        return;
      }
      forgetGroupSnapUnshown(userId, message.id);
      const sender = await fetchProfile(message.sender_id).catch(() => null);
      if (cancelled) return;
      setSaved(mode === 'saved');
      setState({
        kind: 'showing',
        url,
        video: isVideo ? { posterUrl, overlayUrl } : null,
        sender,
        mode,
        other: null,
        photo: false,
        canToggleSave: mode !== 'saved' || canUnsaveGroupSnap(message, userId),
      });
    }
    (async () => {
      try {
        if (inGroup) {
          await loadGroupSnap();
          return;
        }
        const message = await fetchMessage(id);
        if (cancelled) return;
        if (!message || message.kind !== 'snap' || !message.media_path) {
          if (!cancelled) setState({ kind: 'gone' });
          return;
        }
        const inChat = message.sender_id === userId || message.recipient_id === userId;
        const mode: Mode | null =
          message.saved_at && inChat
            ? 'saved'
            : message.recipient_id === userId && !message.opened_at
              ? 'first'
              : canReplay(message, userId)
                ? 'replay'
                : null;
        if (!mode) {
          if (!cancelled) setState({ kind: 'gone' });
          return;
        }
        // Get the one-minute link and download the photo BEFORE using up the view or replay,
        // so a bad connection doesn't waste it.
        const url = await getSnapUrl(message.media_path);
        const isVideo = message.media_type === 'video';
        const posterUrl = isVideo && message.poster_path ? await getSnapUrl(message.poster_path) : null;
        const overlayUrl = isVideo && message.overlay_path ? await getSnapUrl(message.overlay_path) : null;
        const ready = isVideo ? !!url && (!posterUrl || (await Image.prefetch(posterUrl, 'memory'))) : !!url && (await Image.prefetch(url, 'memory'));
        // You may have gone back while the file was downloading. Keep its view for next time.
        if (cancelled) return;
        if (!url || !ready) {
          if (!cancelled) setState({ kind: 'error' });
          return;
        }
        // (A peek saved before you opened it still counts as opened now.)
        if (mode === 'first' || (message.recipient_id === userId && !message.opened_at)) await openSnap(message.id);
        if (mode === 'replay' && !(await replaySnap(message.id))) {
          if (!cancelled) setState({ kind: 'gone' });
          return;
        }
        const sender = await fetchProfile(message.sender_id).catch(() => null);
        if (!cancelled) {
          setSaved(mode === 'saved');
          const other = message.sender_id === userId ? message.recipient_id : message.sender_id;
          const photo = mode === 'saved' && isChatPhoto(message);
          setState({ kind: 'showing', url, video: isVideo ? { posterUrl, overlayUrl } : null, sender, mode, other, photo, canToggleSave: !photo });
        }
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, userId, inGroup]);

  // The timer runs unless the peek is saved (saving it stops the timer): 10 seconds for a photo, the video's
  // length for a video (it starts once the video has loaded). It waits while the ⋯ menu is open (the peek is
  // covered then), and stops for good once you report the peek.
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const isVideo = state.kind === 'showing' && state.video !== null;
  const seconds = isVideo ? Math.min(MAX_VIDEO_SECONDS, Math.max(1, videoSeconds ?? SECONDS)) : SECONDS;
  const counting = state.kind === 'showing' && !saved && !reporting && (!isVideo || videoSeconds !== null);
  const timed = counting && !paused;
  useEffect(() => {
    if (!timed) return;
    // Carry on from where the bar stopped (it starts empty, so the first run gets the full time).
    let left = Math.max(0, (1 - progress.get()) * seconds * 1000);
    // Almost out of time after a pause: you get 1 second – but only the first time.
    if (left < MIN_LEFT_MS && !extraGiven.current) {
      extraGiven.current = true;
      left = MIN_LEFT_MS;
    }
    progress.set(
      withTiming(1, { duration: left, easing: Easing.linear }, (finished) => {
        'worklet';
        if (finished) scheduleOnRN(close);
      }),
    );
    // Leaving early stops the timer, so it can't close some other screen later.
    return () => cancelAnimation(progress);
  }, [timed, progress, seconds]);

  // Screenshot it → they'll know. One-on-one: the other person in the chat (`other`; null in a group chat).
  useScreenshotNotice(userId, state.kind === 'showing' ? state.other : null, 'peek', state.kind === 'showing', () =>
    showToast('📸 They’ll see you took a screenshot'),
  );
  // 📸 A group snap: whoever sent it is told (once per snap). Not for a saved snap – that's a normal photo now.
  useScreenshotDetector(state.kind === 'showing' && inGroup && state.mode !== 'saved' && !saved, () => {
    groupSnapScreenshot(id)
      .then((told) => {
        if (told) showToast('📸 They’ll see you took a screenshot');
      })
      .catch((error) => console.warn('Could not send screenshot notice', error));
  });

  const barStyle = useAnimatedStyle(() => ({ width: `${(1 - progress.get()) * 100}%` }));

  async function toggleSaved() {
    setSaving(true);
    try {
      const done = inGroup ? await setGroupSnapSaved(id, !saved) : await setSnapSaved(id, !saved);
      if (!done) {
        Alert.alert(
          saved ? "Can't unsave this one" : "Can't save this one",
          inGroup
            ? saved
              ? 'Only whoever saved it, or whoever sent it, can unsave it.'
              : 'Snaps can only be saved up to a day after they were sent.'
            : 'Peeks can only be saved up to a day after they were opened.',
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(saved ? 'Unsaved – it will disappear' : inGroup ? 'Saved in chat 📌 Everyone in the group can open it again' : 'Saved in chat 📌');
      setSaved(!saved);
    } catch (error) {
      Alert.alert('Something went wrong', friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  if (state.kind !== 'showing') {
    return (
      <SafeScreen style={[styles.fill, styles.center]}>
        {state.kind === 'loading' ? (
          <>
            <ActivityIndicator color={colors.accent} size="large" />
            {/* One-on-one it could be a peek or a photo: that's only known once it's loaded. */}
            <Text style={styles.loadingText}>{inGroup ? 'Opening snap…' : 'Opening…'}</Text>
          </>
        ) : (
          <>
            <EmptyState
              emoji={state.kind === 'gone' ? '💨' : '📶'}
              title={state.kind === 'gone' ? `This ${word} is gone` : `Couldn't load the ${word}`}
              message={
                inGroup
                  ? state.kind === 'gone'
                    ? 'Snaps disappear after you open and replay them, or a day after they were sent. Tip: press and hold a snap in the chat to save it.'
                    : 'Check your connection and tap it again in the next few minutes – that still counts as your first look. After that (or if you close the app) it counts as your replay.'
                  : state.kind === 'gone'
                    ? 'Peeks disappear after you open and replay them. Tip: press and hold a peek in the chat to save it.'
                    : "Check your connection and try again – it hasn't been used up."
              }
            />
            <Button title="Back" variant="secondary" onPress={close} />
          </>
        )}
      </SafeScreen>
    );
  }

  const name = state.sender ? state.sender.display_name || state.sender.username : '';
  // What it's called now that it's loaded: a photo (or video) picked from Photos in a one-on-one chat is a normal
  // photo, not a peek – calling it a peek would say it disappears.
  const shownWord = state.photo ? (state.video ? 'video' : 'photo') : word;
  const ShownWord = shownWord.charAt(0).toUpperCase() + shownWord.slice(1);
  // Peeks from someone else can be reported (then you're offered to block them), like a message in the chat.
  const sender = state.sender && state.sender.id !== userId ? state.sender : null;
  // A tap closes the peek – but not while you're zoomed in, or right after pinching.
  function noteZoom(zoomed: boolean) {
    zoomRef.current = { zoomed, at: Date.now() };
  }
  function tapToClose() {
    if (!reporting && (zoomRef.current.zoomed || Date.now() - zoomRef.current.at < 400)) return;
    close();
  }
  function openMenu() {
    if (!sender) return;
    setPaused(true);
    showOptions({
      onClose: () => setPaused(false),
      options: [
        {
          label: `Report ${shownWord}`,
          onPress: () => {
            setReporting(true);
            report({ user: sender, contentType: inGroup ? 'group_message' : 'message', contentId: id });
          },
        },
      ],
    });
  }
  const label = state.photo ? (state.video ? 'Video 🎬' : 'Photo 📷') : saved ? 'Saved in chat 📌' : state.mode === 'replay' ? 'Replay 🔁' : null;

  return (
    <Pressable style={styles.fill} onPress={tapToClose} accessibilityLabel={`Close ${shownWord}`}>
      <StatusBar style="light" />
      {reporting ? null : state.video ? (
        <VideoClip
          uri={state.url}
          posterUri={state.video.posterUrl}
          overlayUri={state.video.overlayUrl}
          playing={!paused}
          loop={saved}
          onDuration={setVideoSeconds}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        // Pinch to zoom in (it springs back when you let go far enough out).
        <ZoomableImage
          uri={state.url}
          contentFit="cover"
          doubleTapZoom={false}
          onZoomChange={noteZoom}
          style={StyleSheet.absoluteFill}
        />
      )}
      {paused || reporting ? (
        // While the ⋯ menu is open or you report it, the peek is covered, so the menu can't be used to keep it on
        // screen. (While the menu is open the photo or video stays underneath, paused, so it carries on after.)
        <View style={[StyleSheet.absoluteFill, styles.center, styles.cover]}>
          <Text style={styles.coverTitle}>
            {reporting ? `${ShownWord} hidden while you report it 🚩` : `${ShownWord} hidden while the menu is open 🙈`}
          </Text>
          {reporting ? <Text style={styles.loadingText}>Tap anywhere to close.</Text> : null}
        </View>
      ) : null}
      <SafeEdge edge="top" style={styles.top}>
        <View style={[styles.track, !counting && styles.hidden]}>
          <Animated.View style={[styles.bar, barStyle]} />
        </View>
        <View style={styles.row}>
          <View style={styles.sender}>
            <Avatar path={state.sender?.avatar_path} name={name} size={32} />
            <View>
              <Text style={styles.senderName}>{name}</Text>
              {label ? <Text style={styles.label}>{label}</Text> : null}
            </View>
          </View>
          <View style={styles.actions}>
            {state.canToggleSave ? (
              <Bouncy
                style={[styles.save, saved && styles.saveOn]}
                pressScale={0.85}
                disabled={saving}
                onPress={toggleSaved}
                accessibilityRole="button"
                accessibilityLabel={saved ? 'Unsave' : 'Save in chat'}>
                <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={18} color={colors.white} />
                <Text style={styles.saveText}>{saved ? 'Saved' : 'Save'}</Text>
              </Bouncy>
            ) : null}
            {sender && !reporting ? (
              <Bouncy style={styles.more} pressScale={0.85} onPress={openMenu} accessibilityRole="button" accessibilityLabel="More options">
                <Ionicons name="ellipsis-horizontal" size={18} color={colors.white} />
              </Bouncy>
            ) : null}
          </View>
        </View>
      </SafeEdge>
    </Pressable>
  );
}

function close() {
  if (router.canGoBack()) router.back();
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.xl,
  },
  loadingText: {
    ...font.body,
    color: colors.textMuted,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    gap: space.md,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
    marginTop: space.sm,
  },
  bar: {
    height: 4,
    backgroundColor: colors.white,
  },
  hidden: {
    opacity: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sender: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  label: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  save: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  saveOn: {
    backgroundColor: colors.accent,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  more: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  cover: {
    backgroundColor: colors.black,
  },
  coverTitle: {
    ...font.body,
    color: colors.white,
    fontWeight: '800',
    textAlign: 'center',
  },
  saveText: {
    color: colors.onAccent,
    fontWeight: '800',
    fontSize: 14,
  },
  senderName: {
    ...font.body,
    color: colors.white,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
});
