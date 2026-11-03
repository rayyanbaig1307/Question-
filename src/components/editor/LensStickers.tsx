import { StyleSheet, Text, View } from 'react-native';

// ---------------------------------------------------------------------------
// The face lenses' drawings: Glam (makeup) and Peekaboo Pup. Peekaboo's own designs, drawn with plain shapes.
// Each one is laid out around the point between the eyes, for a face whose eyes are D points apart.
// The lens camera puts that point on each face and scales it to the real eye distance.
// ---------------------------------------------------------------------------

export const LENS_EYE_DISTANCE = 76;
const D = LENS_EYE_DISTANCE;

// The size of each drawing's box (the point between the eyes is its exact middle).
export const LENS_BOX = {
  'lens-makeup': { width: D * 3, height: D * 3.6 },
  'lens-pup': { width: D * 3.6, height: D * 4 },
} as const;

export type LensStickerId = keyof typeof LENS_BOX;

export function LensSticker({ id }: { id: string }) {
  if (id === 'lens-makeup') return <Glam />;
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

// A soft round blush: a few see-through circles inside each other, so the edge fades out.
function Blush({ style }: { style: object }) {
  return (
    <View style={style}>
      {[1, 0.75, 0.5].map((size) => (
        <View
          key={size}
          style={[
            StyleSheet.absoluteFill,
            styles.round,
            { margin: `${((1 - size) / 2) * 100}%`, backgroundColor: 'rgba(255, 95, 150, 0.16)' },
          ]}
        />
      ))}
    </View>
  );
}

// 💄 Glam: rosy blush, a glossy pink lip, little eyeliner wings and a couple of sparkles.
function Glam() {
  const box = LENS_BOX['lens-makeup'];
  const lipW = D * 0.95;
  const lipH = D * 0.34;
  return (
    <View style={{ width: box.width, height: box.height }}>
      <Blush style={at(box, -0.72, 0.68, D * 0.85, D * 0.62)} />
      <Blush style={at(box, 0.72, 0.68, D * 0.85, D * 0.62)} />
      {/* Eyeliner wings at the outer corner of each eye */}
      <View style={[at(box, -0.74, -0.07, D * 0.26, D * 0.06), styles.wing, { transform: [{ rotateZ: '24deg' }] }]} />
      <View style={[at(box, 0.74, -0.07, D * 0.26, D * 0.06), styles.wing, { transform: [{ rotateZ: '-24deg' }] }]} />
      {/* Lips: a soft pink tint with a little shine */}
      <View style={[at(box, 0, 1.42, lipW, lipH), styles.round, { backgroundColor: 'rgba(224, 36, 94, 0.42)' }]}>
        <View style={[styles.round, styles.lipShine, { width: lipW * 0.28, height: lipH * 0.22, left: lipW * 0.52, top: lipH * 0.18 }]} />
      </View>
      <Text style={[at(box, -1.15, -0.75, D * 0.4, D * 0.4), styles.sparkle, { fontSize: D * 0.28 }]}>✨</Text>
      <Text style={[at(box, 1.2, -0.55, D * 0.4, D * 0.4), styles.sparkle, { fontSize: D * 0.22 }]}>💗</Text>
    </View>
  );
}

// 🐶 Peekaboo Pup: pastel lavender floppy ears with pink insides, a round pink button nose with a shine,
// and purple freckles. (Peekaboo's own pup – not a copy of anyone else's dog.)
function Pup() {
  const box = LENS_BOX['lens-pup'];
  const earW = D * 0.95;
  const earH = D * 1.45;
  const ear = (side: -1 | 1) => (
    <View
      style={[
        // Floppy ears hanging down the sides of the head, the bottoms swinging a little outwards.
        at(box, side * 1.3, -0.65, earW, earH),
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
      <View style={[at(box, 0, 0.78, noseW, noseH), styles.round, styles.nose]}>
        <View style={[styles.round, styles.noseShine, { width: noseW * 0.3, height: noseH * 0.28, left: noseW * 0.2, top: noseH * 0.14 }]} />
      </View>
      {[
        [-0.62, 0.95],
        [-0.82, 0.78],
        [-0.55, 0.72],
        [0.62, 0.95],
        [0.82, 0.78],
        [0.55, 0.72],
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
