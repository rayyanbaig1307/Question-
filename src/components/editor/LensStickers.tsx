import { StyleSheet, View } from 'react-native';

// ---------------------------------------------------------------------------
// The Peekaboo Pup lens drawing (Peekaboo's own design, drawn with plain shapes). Glam and Glow are painted
// onto the photo along the real face outlines instead (lib/lensPhoto.ts).
// Each one is laid out around the point between the eyes, for a face whose eyes are D points apart.
// The lens camera puts that point on each face and scales it to the real eye distance.
// ---------------------------------------------------------------------------

export const LENS_EYE_DISTANCE = 76;
const D = LENS_EYE_DISTANCE;

// The size of each drawing's box (the point between the eyes is its exact middle).
export const LENS_BOX = {
  'lens-pup': { width: D * 3.8, height: D * 4.6 },
} as const;

export type LensStickerId = keyof typeof LENS_BOX;

export function LensSticker({ id }: { id: string }) {
  if (id === 'lens-pup') return <Pup />;
  return null;
}

// Something placed at (x, y) from the point between the eyes (in face units, D = 1).
function at(box: { width: number; height: number }, x: number, y: number, width: number, height: number) {
  return {
    position: 'absolute' as const,
    left: box.width / 2 + x * D - width / 2,
    top: box.height / 2 + y * D - height / 2,
    width,
    height,
  };
}

// 🐶 Peekaboo Pup: pastel lavender floppy ears with pink insides, a round pink button nose with a shine,
// and purple freckles. (Peekaboo's own pup – not a copy of anyone else's dog.)
function Pup() {
  const box = LENS_BOX['lens-pup'];
  const earW = D * 1.05;
  const earH = D * 1.6;
  const ear = (side: -1 | 1) => (
    <View
      style={[
        // Floppy ears on the top corners of the head, hanging down with the bottoms swinging outwards.
        at(box, side * 1.15, -1.3, earW, earH),
        styles.ear,
        {
          borderTopLeftRadius: earW * 0.35,
          borderTopRightRadius: earW * 0.35,
          borderBottomLeftRadius: earW * 0.5,
          borderBottomRightRadius: earW * 0.5,
          transform: [{ rotateZ: `${side * -16}deg` }],
        },
      ]}>
      <View style={[styles.earInside, { borderRadius: earW * 0.35, margin: earW * 0.16, marginTop: earW * 0.3 }]} />
    </View>
  );
  const noseW = D * 0.48;
  const noseH = D * 0.34;
  return (
    <View style={{ width: box.width, height: box.height }}>
      {ear(-1)}
      {ear(1)}
      <View style={[at(box, 0, 0.62, noseW, noseH), styles.round, styles.nose]}>
        <View style={[styles.round, styles.noseShine, { width: noseW * 0.3, height: noseH * 0.28, left: noseW * 0.2, top: noseH * 0.14 }]} />
      </View>
      {[
        [-0.58, 0.8],
        [-0.78, 0.66],
        [-0.52, 0.6],
        [0.58, 0.8],
        [0.78, 0.66],
        [0.52, 0.6],
      ].map(([x, y]) => (
        <View key={`${x}-${y}`} style={[at(box, x, y, D * 0.07, D * 0.07), styles.round, styles.freckle]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  round: {
    borderRadius: 999,
  },
  wing: {
    backgroundColor: 'rgba(25, 12, 30, 0.85)',
    borderRadius: 4,
  },
  lipShine: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  sparkle: {
    textAlign: 'center',
  },
  ear: {
    backgroundColor: '#B79CFF',
    borderWidth: 3,
    borderColor: '#8B5CFF',
  },
  earInside: {
    flex: 1,
    backgroundColor: '#FFB3D1',
  },
  nose: {
    backgroundColor: '#FF4F9A',
    borderWidth: 2,
    borderColor: '#C2185B',
  },
  noseShine: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
  },
  freckle: {
    backgroundColor: 'rgba(139, 92, 255, 0.75)',
  },
});
