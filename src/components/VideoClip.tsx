import { useEvent, useEventListener } from 'expo';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { TrackedEyes } from '@/components/TrackedEyes';
import { readTrack, type EyeTrack } from '@/lib/eyeTrack';

export type VideoClipProps = {
  uri: string;
  // Still picture shown until the video is ready.
  posterUri?: string | null;
  // The text and stickers that were added, shown on top.
  overlayUri?: string | null;
  // Googly eyes that follow the faces (from the googly lens). Normally read from the sticker layer picture;
  // the editor passes it in directly (null = none).
  eyeTrack?: EyeTrack | null;
  contentFit?: 'cover' | 'contain';
  playing: boolean;
  muted?: boolean;
  loop?: boolean;
  // Called with the video's length in seconds once it's loaded, and when it reaches the end.
  onDuration?: (seconds: number) => void;
  onEnd?: () => void;
  style?: StyleProp<ViewStyle>;
};

// Plays a short video (with its text/sticker layer on top). Use VideoClip from VideoClipSafe instead of this file.
export function VideoClip({
  uri,
  posterUri,
  overlayUri,
  eyeTrack,
  contentFit = 'cover',
  playing,
  muted = false,
  loop = true,
  onDuration,
  onEnd,
  style,
}: VideoClipProps) {
  const player = useVideoPlayer(uri, (created) => {
    created.loop = loop;
    created.muted = muted;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  useEffect(() => {
    if (playing) player.play();
    else player.pause();
  }, [player, playing]);

  useEffect(() => {
    setMuted(player, muted);
  }, [player, muted]);

  // Moving googly eyes hidden in the sticker layer picture (see lib/eyeTrack.ts).
  const [found, setFound] = useState<{ uri: string; track: EyeTrack | null } | null>(null);
  useEffect(() => {
    if (eyeTrack !== undefined || !overlayUri) return;
    let live = true;
    readTrack(overlayUri).then((track) => {
      if (live) setFound({ uri: overlayUri, track });
    });
    return () => {
      live = false;
    };
  }, [overlayUri, eyeTrack]);
  const track = eyeTrack !== undefined ? eyeTrack : found && found.uri === overlayUri ? found.track : null;
  const videoTime = useCallback(() => player.currentTime, [player]);

  useEventListener(player, 'sourceLoad', ({ duration }) => onDuration?.(duration));
  useEventListener(player, 'playToEnd', () => onEnd?.());

  return (
    <View style={[styles.box, style]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={contentFit} nativeControls={false} />
      {status !== 'readyToPlay' && posterUri ? (
        <Image source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit={contentFit} />
      ) : null}
      {overlayUri ? (
        <Image source={{ uri: overlayUri }} style={StyleSheet.absoluteFill} contentFit={contentFit} pointerEvents="none" />
      ) : null}
      {track ? <TrackedEyes track={track} time={videoTime} contentFit={contentFit} /> : null}
    </View>
  );
}

// The player is a native object that's meant to be changed after it's made (sound on/off).
function setMuted(player: VideoPlayer, muted: boolean) {
  player.muted = muted;
}

const styles = StyleSheet.create({
  box: {
    overflow: 'hidden',
    backgroundColor: '#000',
  },
});
