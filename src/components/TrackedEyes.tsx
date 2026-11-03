import { useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { SpecialSticker } from '@/components/editor/SpecialSticker';
import { eyesAt, PAIR_HEIGHT, PAIR_WIDTH, type EyeTrack } from '@/lib/eyeTrack';

type Spot = { on: boolean; x: number; y: number; scale: number; rotation: number };
const HIDDEN: Spot = { on: false, x: 0, y: 0, scale: 1, rotation: 0 };

// Googly eyes that follow the faces in a playing video (see lib/eyeTrack.ts). `time()` says where the video is
// (seconds). The eyes sit on the video exactly like the sticker layer picture does (same fit).
export function TrackedEyes({ track, time, contentFit = 'cover' }: {
  track: EyeTrack;
  time: () => number;
  contentFit?: 'cover' | 'contain';
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const faces = Math.min(4, track.frames[0]?.length ?? 0);
  const spots = [useSharedValue<Spot>(HIDDEN), useSharedValue<Spot>(HIDDEN), useSharedValue<Spot>(HIDDEN), useSharedValue<Spot>(HIDDEN)];

  useEffect(() => {
    if (!box.width || !box.height) return;
    // Fit the editor's screen into this box the same way the sticker layer picture is fitted.
    const k = contentFit === 'cover' ? Math.max(box.width / track.w, box.height / track.h) : Math.min(box.width / track.w, box.height / track.h);
    const dx = (box.width - track.w * k) / 2;
    const dy = (box.height - track.h * k) / 2;
    let frame = 0;
    const tick = () => {
      let seconds = 0;
      try {
        seconds = time();
      } catch {
        // The player is gone (the screen is closing).
        return;
      }
      eyesAt(track, seconds * 1000).forEach((eye, i) => {
        if (i >= 4) return;
        spots[i].set(eye ? { on: true, x: eye.x * k + dx, y: eye.y * k + dy, scale: eye.scale * k, rotation: eye.rotation } : HIDDEN);
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The shared values never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, time, contentFit, box.width, box.height]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((now) => (now.width === width && now.height === height ? now : { width, height }));
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.clip]} pointerEvents="none" onLayout={onLayout}>
      {spots.slice(0, faces).map((spot, i) => (
        <EyesOnFace key={i} spot={spot} sticker={track.sticker} />
      ))}
    </View>
  );
}

function EyesOnFace({ spot, sticker }: { spot: SharedValue<Spot>; sticker: string }) {
  const place = useAnimatedStyle(() => {
    const s = spot.get();
    return {
      opacity: s.on ? 1 : 0,
      transform: [
        { translateX: s.x - PAIR_WIDTH / 2 },
        { translateY: s.y - PAIR_HEIGHT / 2 },
        { rotateZ: `${s.rotation}rad` },
        { scale: s.scale },
      ],
    };
  });
  return (
    <Animated.View style={[styles.pair, place]}>
      <SpecialSticker id={sticker} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  pair: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: PAIR_WIDTH,
    height: PAIR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
