import { useEffect, useState, type RefObject } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FRAME_PLACEMENT } from '@/lib/frameAccess';
import { formatWarpLine, type WarpStats } from '@/lib/lensDiagnostics';

import { axesMatrix, compareMatrices, placeShot, type ViewAxes } from './frameMatrix';

// ---------------------------------------------------------------------------
// The small readout line for the 4 stretchy filters, just under the top buttons. Only on the `testing` update
// channel (SoftGlowCamera decides), only while a stretchy filter is on. What each part means is at the top of
// lib/lensDiagnostics.ts. It is drawn on the camera layer, not on the photo: the photo is made from the camera's
// own file, so it never has this line in it.
//
// It reads FrameFeed's counts twice a second and works out the placing itself, with the same functions the
// drawing thread uses (frameMatrix.ts). It is its own small component, so only it re-draws.
// ---------------------------------------------------------------------------

const EVERY_MS = 500;

export function WarpDiagnostics({ stats, axes, viewSize, setups, facing }: {
  stats: RefObject<WarpStats | null>;
  axes: RefObject<ViewAxes | null>;
  viewSize: RefObject<{ width: number; height: number }>;
  setups: RefObject<number>;
  facing: 'front' | 'back';
}) {
  const insets = useSafeAreaInsets();
  const [line, setLine] = useState('…');

  useEffect(() => {
    const timer = setInterval(() => {
      try {
        const s = stats.current;
        const view = viewSize.current;
        const front = facing === 'front';
        const read = (key: keyof WarpStats) => (s ? s[key].getDirty() : 0);
        const w = read('w');
        const h = read('h');
        const shot = { w, h, turn: read('turn'), mirror: read('mirror') === 1, front };
        const converter = axes.current;
        const placed = placeShot(shot, view.width, view.height, converter, FRAME_PLACEMENT);
        const mc = converter && converter.front === front ? axesMatrix(converter, w, h) : null;
        setLine(
          formatWarpLine({
            w,
            h,
            label: read('label'),
            turn: placed.turn,
            mirror: placed.mirror,
            how: placed.how,
            agree: mc ? compareMatrices(placed.m, mc, w, h) : null,
            fpsX10: read('fpsX10'),
            view,
            late: read('late'),
            gap: read('gap'),
            drop: read('drop'),
            oob: read('oob'),
            err: read('camErr') + read('uiErr'),
            dark: read('dark'),
            cfg: setups.current,
          }),
        );
      } catch (error) {
        setLine(`readout failed: ${String(error)}`);
      }
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [stats, axes, viewSize, setups, facing]);

  return (
    <View pointerEvents="none" style={[styles.row, { top: insets.top + 50 }]}>
      <Text style={styles.text} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    left: 12,
    right: 12,
    alignItems: 'flex-start',
  },
  text: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    overflow: 'hidden',
    paddingVertical: 3,
    paddingHorizontal: 6,
  },
});
