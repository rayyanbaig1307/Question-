import { useEvent, useEventListener } from 'expo';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

export type VideoClipProps = {
  uri: string;
  // Still picture shown until the video is ready.
  posterUri?: string | null;
  // The text and stickers that were added, shown on top.
  overlayUri?: string | null;
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
