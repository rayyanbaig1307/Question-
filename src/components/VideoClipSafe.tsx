import { requireOptionalNativeModule } from 'expo';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import type { VideoClip as VideoClipType, VideoClipProps } from './VideoClip';

// The video player is a native part of the app. Expo Go has it, but an app built before it was added doesn't –
// there we show the video's still picture instead, so nothing breaks.
const Real: typeof VideoClipType | null = requireOptionalNativeModule('ExpoVideo')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./VideoClip').VideoClip
  : null;

export function VideoClip(props: VideoClipProps) {
  if (Real) return <Real {...props} />;
  const fit = props.contentFit ?? 'cover';
  return (
    <View style={[styles.box, props.style]}>
      {props.posterUri ? <Image source={{ uri: props.posterUri }} style={StyleSheet.absoluteFill} contentFit={fit} /> : null}
      {props.overlayUri ? <Image source={{ uri: props.overlayUri }} style={StyleSheet.absoluteFill} contentFit={fit} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    overflow: 'hidden',
    backgroundColor: '#000',
  },
});
