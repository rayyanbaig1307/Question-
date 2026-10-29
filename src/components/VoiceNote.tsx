import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useMediaUrl } from '@/lib/media';
import { Audio, formatDuration, levelFromDecibels, MAX_VOICE_MS, MIN_VOICE_MS, toWaveform } from '@/lib/voice';
import { colors, font, radius, space } from '@/theme';

// Slide this far left while holding to cancel.
const CANCEL_DISTANCE = 90;

// Small mono recordings with sound levels switched on (for the waveform).
const VOICE_OPTIONS = Audio
  ? { ...Audio.RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64000, isMeteringEnabled: true }
  : null;

export type Recording = { uri: string; durationMs: number; waveform: number[] };

// The mic button in a chat: hold to record, let go to send, slide left to cancel.
// Only show this when `Audio` is there (see lib/voice.ts).
export function MicButton({ onRecorded, onHint }: {
  onRecorded: (recording: Recording) => void;
  onHint: (message: string) => void;
}) {
  // (Only rendered when Audio exists.)
  const recorder = Audio!.useAudioRecorder(VOICE_OPTIONS!);
  const phase = useRef<'idle' | 'starting' | 'recording'>('idle');
  const letGoEarly = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const levels = useRef<number[]>([]);
  const [live, setLive] = useState<{ ms: number; levels: number[] } | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function start() {
    if (!Audio || phase.current !== 'idle') return;
    phase.current = 'starting';
    letGoEarly.current = false;
    try {
      const permission = await Audio.getRecordingPermissionsAsync();
      if (!permission.granted) {
        const asked = await Audio.requestRecordingPermissionsAsync();
        phase.current = 'idle';
        if (!asked.granted) Alert.alert('Microphone needed 🎤', 'Allow the microphone for Peekaboo in your phone settings.');
        else onHint('Now hold the mic to record 🎤');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (letGoEarly.current) {
        phase.current = 'idle';
        await Audio.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        onHint('Hold the mic to record 🎤');
        return;
      }
      recorder.record();
      phase.current = 'recording';
      levels.current = [];
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setLive({ ms: 0, levels: [] });
      timer.current = setInterval(() => {
        const status = recorder.getStatus();
        levels.current.push(levelFromDecibels(status.metering));
        setLive({ ms: status.durationMillis, levels: levels.current.slice(-28) });
        if (status.durationMillis >= MAX_VOICE_MS) finish(false);
      }, 80);
    } catch (error) {
      phase.current = 'idle';
      console.warn('Could not start recording', error);
      Alert.alert('Could not record', 'Something went wrong with the microphone. Try again!');
    }
  }

  async function finish(cancel: boolean) {
    if (phase.current === 'starting') {
      letGoEarly.current = true;
      return;
    }
    if (phase.current !== 'recording' || !Audio) return;
    phase.current = 'idle';
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setLive(null);
    setCancelling(false);
    const durationMs = recorder.getStatus().durationMillis;
    try {
      await recorder.stop();
    } finally {
      // Back to normal so voice notes play through the speaker.
      await Audio.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    }
    if (cancel) {
      Haptics.selectionAsync();
      onHint('Voice note cancelled');
      return;
    }
    const uri = recorder.uri;
    if (!uri || durationMs < MIN_VOICE_MS) {
      onHint('Hold a bit longer to record 🎤');
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onRecorded({ uri, durationMs, waveform: toWaveform(levels.current) });
  }

  const hold = usePanGesture({
    minDistance: 0,
    activateAfterLongPress: 120,
    onActivate: () => {
      'worklet';
      scheduleOnRN(start);
    },
    onUpdate: (event) => {
      'worklet';
      scheduleOnRN(setCancelling, event.translationX < -CANCEL_DISTANCE);
    },
    onDeactivate: (event) => {
      'worklet';
      scheduleOnRN(finish, event.translationX < -CANCEL_DISTANCE);
    },
  });
  // A quick tap (not a hold) just explains what to do.
  const tap = useTapGesture({
    onActivate: () => {
      'worklet';
      scheduleOnRN(onHint, 'Hold the mic to record, let go to send 🎤');
    },
  });
  const gesture = useExclusiveGestures(hold, tap);

  return (
    <>
      {live ? (
        <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(120)} style={styles.recording}>
          <View style={styles.redDot} />
          <Text style={styles.recordingTime}>{formatDuration(live.ms)}</Text>
          <View style={styles.liveBars}>
            {live.levels.map((level, index) => (
              <View key={index} style={[styles.liveBar, { height: 4 + (level / 100) * 24 }]} />
            ))}
          </View>
          <Text style={[styles.cancelHint, cancelling && styles.cancelArmed]}>
            {cancelling ? 'Let go to cancel' : '‹ Slide to cancel'}
          </Text>
        </Animated.View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <View
          style={[styles.mic, live && styles.micRecording, cancelling && styles.micCancel]}
          accessibilityRole="button"
          accessibilityLabel="Hold to record a voice note">
          <Ionicons name={cancelling ? 'trash' : 'mic'} size={22} color={colors.white} />
        </View>
      </GestureDetector>
    </>
  );
}

// Only one voice note plays at a time.
let nowPlaying: { pause: () => void } | null = null;

// A voice note in the chat: play/pause, its waveform (filling in as it plays) and how long it is.
export function VoiceBubble({ path, durationMs, waveform, mine }: {
  path: string | null;
  durationMs: number;
  waveform: number[] | null;
  mine: boolean;
}) {
  if (!Audio) {
    return (
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={[styles.oldApp, mine && styles.textMine]}>
          🎤 Voice note ({formatDuration(durationMs)}) – update Peekaboo to play it
        </Text>
      </View>
    );
  }
  return <VoicePlayer path={path} durationMs={durationMs} waveform={waveform} mine={mine} />;
}

function VoicePlayer({ path, durationMs, waveform, mine }: {
  path: string | null;
  durationMs: number;
  waveform: number[] | null;
  mine: boolean;
}) {
  // (Only rendered when Audio exists.)
  const player = Audio!.useAudioPlayer(null);
  const status = Audio!.useAudioPlayerStatus(player);
  const url = useMediaUrl(path);
  const [loaded, setLoaded] = useState(false);

  const bars = waveform && waveform.length > 0 ? waveform : toWaveform([]);
  const total = status.duration > 0 ? status.duration * 1000 : durationMs;
  const progress = loaded && total > 0 ? Math.min(1, (status.currentTime * 1000) / total) : 0;
  const atEnd = status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.05);

  function toggle() {
    if (!url || !Audio) return;
    if (status.playing) {
      player.pause();
      return;
    }
    if (nowPlaying && nowPlaying !== player) {
      try {
        nowPlaying.pause();
      } catch {
        // that voice note is gone from the screen
      }
    }
    nowPlaying = player;
    Audio.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    if (!loaded) {
      player.replace({ uri: url });
      setLoaded(true);
    } else if (atEnd) {
      player.seekTo(0);
    }
    player.play();
  }

  const on = mine ? colors.white : colors.pink;
  const off = mine ? 'rgba(255,255,255,0.4)' : colors.border;

  return (
    <Pressable
      onPress={toggle}
      style={[styles.bubble, styles.player, mine ? styles.bubbleMine : styles.bubbleTheirs]}
      accessibilityRole="button"
      accessibilityLabel={status.playing ? 'Pause voice note' : 'Play voice note'}>
      <View style={[styles.play, { backgroundColor: mine ? colors.white : colors.pink }]}>
        <Ionicons
          name={status.playing ? 'pause' : 'play'}
          size={16}
          color={mine ? colors.purple : colors.white}
          style={status.playing ? undefined : styles.playIcon}
        />
      </View>
      <View style={styles.bars}>
        {bars.map((level, index) => (
          <View
            key={index}
            style={[
              styles.bar,
              { height: 4 + (level / 100) * 24, backgroundColor: index / bars.length < progress ? on : off },
            ]}
          />
        ))}
      </View>
      <Text style={[styles.duration, mine && styles.textMine]}>
        {formatDuration(status.playing || progress > 0 ? total - status.currentTime * 1000 : total)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mic: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.pink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micRecording: {
    backgroundColor: colors.red,
    transform: [{ scale: 1.25 }],
  },
  micCancel: {
    backgroundColor: colors.textFaint,
  },
  recording: {
    ...StyleSheet.absoluteFill,
    right: 60,
    left: space.md,
    top: space.sm,
    bottom: undefined,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: 22,
    backgroundColor: colors.card,
    zIndex: 2,
  },
  redDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.red,
  },
  recordingTime: {
    ...font.body,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  liveBars: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    overflow: 'hidden',
  },
  liveBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.pink,
  },
  cancelHint: {
    ...font.small,
    fontSize: 12,
  },
  cancelArmed: {
    color: colors.red,
    fontWeight: '800',
  },
  bubble: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
  },
  bubbleMine: {
    backgroundColor: colors.purple,
    borderBottomRightRadius: 6,
  },
  bubbleTheirs: {
    backgroundColor: colors.card,
    borderBottomLeftRadius: 6,
  },
  player: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 220,
  },
  play: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    marginLeft: 2,
  },
  bars: {
    flex: 1,
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  bar: {
    flex: 1,
    maxWidth: 3,
    borderRadius: 2,
  },
  duration: {
    ...font.small,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  textMine: {
    color: colors.white,
  },
  oldApp: {
    ...font.small,
  },
});
