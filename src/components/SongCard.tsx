import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import type { Song } from '@/lib/songs';
import { Audio, formatDuration } from '@/lib/voice';
import { colors, font, radius, space } from '@/theme';

// Only one song preview plays at a time.
let nowPlaying: { pause: () => void } | null = null;

// A song: cover art, name and artist, a ▶ for its 30-second preview, and a link to the full song.
export function SongCard({ song, right }: { song: Song; right?: ReactNode }) {
  return (
    <View style={styles.card}>
      <Image source={{ uri: song.artworkUrl }} style={styles.art} contentFit="cover" />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          🎵 {song.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {song.artist}
        </Text>
        <Pressable onPress={() => Linking.openURL(song.linkUrl)} hitSlop={6} accessibilityRole="link">
          <Text style={styles.link}>Full song on Apple Music ↗</Text>
        </Pressable>
      </View>
      {Audio ? <PreviewButton url={song.previewUrl} /> : null}
      {right}
    </View>
  );
}

// ▶ / ⏸ for the 30-second preview (shows the time left while playing). Only rendered when Audio exists.
export function PreviewButton({ url }: { url: string }) {
  const player = Audio!.useAudioPlayer(null);
  const status = Audio!.useAudioPlayerStatus(player);
  const [loaded, setLoaded] = useState<string | null>(null);
  const atEnd = status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.05);

  function toggle() {
    if (!Audio) return;
    if (status.playing) {
      player.pause();
      return;
    }
    if (nowPlaying && nowPlaying !== player) {
      try {
        nowPlaying.pause();
      } catch {
        // that preview is gone from the screen
      }
    }
    nowPlaying = player;
    Audio.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    if (loaded !== url) {
      player.replace({ uri: url });
      setLoaded(url);
    } else if (atEnd) {
      player.seekTo(0);
    }
    player.play();
  }

  return (
    <Bouncy
      style={styles.play}
      pressScale={0.85}
      onPress={toggle}
      accessibilityLabel={status.playing ? 'Pause preview' : 'Play a 30-second preview'}>
      <Ionicons name={status.playing ? 'pause' : 'play'} size={18} color={colors.white} style={status.playing ? undefined : styles.playIcon} />
      {status.playing && status.duration > 0 ? (
        <Text style={styles.left}>{formatDuration((status.duration - status.currentTime) * 1000)}</Text>
      ) : null}
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  art: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  text: {
    flex: 1,
    gap: 1,
  },
  title: {
    ...font.body,
    fontWeight: '800',
  },
  artist: {
    ...font.small,
  },
  link: {
    ...font.small,
    fontSize: 12,
    color: colors.pink,
    fontWeight: '800',
  },
  play: {
    minWidth: 40,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: space.sm,
    backgroundColor: colors.pink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    marginLeft: 2,
  },
  left: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
