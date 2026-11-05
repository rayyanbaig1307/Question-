import { BlurMask, Canvas, Circle, FillType, Group, Path, useClock, usePathValue, type SkPathBuilder } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import { MESH } from '@/lib/faceMesh';

// ---------------------------------------------------------------------------
// "Soft Glow": a gentle beauty look drawn on top of the live camera, following the 478 face points.
// - a soft, warm glow over the skin (not over the eyes, brows or lips), feathered at the edges
// - a light blush on the cheeks (a little stronger when you smile)
// - slightly brighter eyes with a small catchlight (hidden while you blink)
// - three or four tiny sparkles that twinkle near the cheekbones and temples
// Everything is kept faint on purpose: it should look like good lighting, not like a cartoon.
//
// Note: this is drawn OVER the camera picture, so it can soften and brighten, but it can't truly blur the
// skin underneath (the camera picture isn't inside Skia). Real smoothing needs the camera frames drawn by
// Skia – see docs/FACE_MESH.md.
// ---------------------------------------------------------------------------

// One face, ready to draw: screen points (x0, y0, x1, y1, …), how closed each eye is, and how big the smile is.
export type GlowFace = { pts: number[]; blinkLeft: number; blinkRight: number; smile: number };

export const MAX_GLOW_FACES = 2;

// How strong each part is (0–1). Kept low so it stays natural.
const SKIN_GLOW = 0.13;
const BLUSH = 0.16;
const EYE_BRIGHT = 0.12;
const CATCHLIGHT = 0.5;
const SPARKLE = 0.75;

export function SoftGlowOverlay({ faces }: { faces: SharedValue<GlowFace[]> }) {
  const clock = useClock();
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: MAX_GLOW_FACES }, (_, index) => (
        <FaceGlow key={index} faces={faces} index={index} clock={clock} />
      ))}
    </Canvas>
  );
}

function FaceGlow({ faces, index, clock }: { faces: SharedValue<GlowFace[]>; index: number; clock: SharedValue<number> }) {
  // How wide the face is on screen; every size below follows it, so the look is the same near or far.
  const width = useDerivedValue(() => {
    const face = faces.value[index];
    if (!face) return 0;
    return distance(face.pts, MESH.leftFaceSide, MESH.rightFaceSide);
  });

  // The skin: the face outline with the eyes, brows and lips cut out (even-odd = holes stay empty).
  const skin = usePathValue((builder) => {
    'worklet';
    const face = faces.value[index];
    if (!face) return;
    builder.setFillType(FillType.EvenOdd);
    addSmoothLoop(builder, face.pts, MESH.faceOval, 0.97);
    addSmoothLoop(builder, face.pts, MESH.leftEye, 1.35);
    addSmoothLoop(builder, face.pts, MESH.rightEye, 1.35);
    addSmoothLoop(builder, face.pts, MESH.leftBrow, 1.25);
    addSmoothLoop(builder, face.pts, MESH.rightBrow, 1.25);
    addSmoothLoop(builder, face.pts, MESH.lips, 1.12);
  });
  const skinBlur = useDerivedValue(() => Math.max(2, width.value * 0.05));

  // Blush on the apples of the cheeks.
  const leftCheek = useDerivedValue(() => cheekSpot(faces.value[index], MESH.leftCheek, MESH.leftFaceSide));
  const rightCheek = useDerivedValue(() => cheekSpot(faces.value[index], MESH.rightCheek, MESH.rightFaceSide));
  const blushRadius = useDerivedValue(() => width.value * 0.11);
  const blushBlur = useDerivedValue(() => Math.max(2, width.value * 0.07));
  const blushOpacity = useDerivedValue(() => {
    const face = faces.value[index];
    return face ? BLUSH * (0.85 + 0.35 * face.smile) : 0;
  });

  // The eye openings, to keep the eye brightening inside the eyes.
  const eyes = usePathValue((builder) => {
    'worklet';
    const face = faces.value[index];
    if (!face) return;
    if (face.blinkLeft < 0.5) addSmoothLoop(builder, face.pts, MESH.leftEye, 1);
    if (face.blinkRight < 0.5) addSmoothLoop(builder, face.pts, MESH.rightEye, 1);
  });
  const leftIris = useDerivedValue(() => irisSpot(faces.value[index], MESH.leftIris, MESH.leftIrisEdge, faces.value[index]?.blinkLeft ?? 1));
  const rightIris = useDerivedValue(() => irisSpot(faces.value[index], MESH.rightIris, MESH.rightIrisEdge, faces.value[index]?.blinkRight ?? 1));
  const eyeBlur = useDerivedValue(() => Math.max(1, width.value * 0.012));

  // A few sparkles around the face.
  const sparkles = usePathValue((builder) => {
    'worklet';
    const face = faces.value[index];
    if (!face) return;
    const w = distance(face.pts, MESH.leftFaceSide, MESH.rightFaceSide);
    const t = clock.value / 1000;
    const spots = [MESH.leftTemple, MESH.rightCheekbone, MESH.leftCheekbone, MESH.rightTemple];
    for (let i = 0; i < spots.length; i++) {
      // Each one twinkles on its own rhythm and is sometimes gone, so they don't look stuck on.
      const twinkle = Math.max(0, Math.sin(t * (1.3 + i * 0.37) + i * 1.9));
      if (twinkle < 0.15) continue;
      const p = spots[i];
      // Nudge each sparkle a little outward and upward from its point.
      const nx = face.pts[MESH.noseTip * 2];
      const ny = face.pts[MESH.noseTip * 2 + 1];
      const px = face.pts[p * 2];
      const py = face.pts[p * 2 + 1];
      const x = px + (px - nx) * 0.18;
      const y = py + (py - ny) * 0.18 - w * 0.03;
      addSparkle(builder, x, y, w * 0.028 * twinkle);
    }
  });
  const sparkleBlur = useDerivedValue(() => Math.max(0.5, width.value * 0.003));

  // Skia wants separate animated numbers for each circle.
  const leftCheekX = useDerivedValue(() => leftCheek.value.x);
  const leftCheekY = useDerivedValue(() => leftCheek.value.y);
  const rightCheekX = useDerivedValue(() => rightCheek.value.x);
  const rightCheekY = useDerivedValue(() => rightCheek.value.y);
  const leftIrisX = useDerivedValue(() => leftIris.value.x);
  const leftIrisY = useDerivedValue(() => leftIris.value.y);
  const leftIrisR = useDerivedValue(() => leftIris.value.r);
  const rightIrisX = useDerivedValue(() => rightIris.value.x);
  const rightIrisY = useDerivedValue(() => rightIris.value.y);
  const rightIrisR = useDerivedValue(() => rightIris.value.r);
  const visible = useDerivedValue(() => (faces.value[index] ? 1 : 0));

  return (
    <Group opacity={visible}>
      {/* Skin glow: warm white, very faint, soft edges. */}
      <Path path={skin} color="#FFF1E8" opacity={SKIN_GLOW}>
        <BlurMask blur={skinBlur} style="normal" />
      </Path>
      {/* Blush */}
      <Group opacity={blushOpacity}>
        <Circle cx={leftCheekX} cy={leftCheekY} r={blushRadius} color="#FF7A8F">
          <BlurMask blur={blushBlur} style="normal" />
        </Circle>
        <Circle cx={rightCheekX} cy={rightCheekY} r={blushRadius} color="#FF7A8F">
          <BlurMask blur={blushBlur} style="normal" />
        </Circle>
      </Group>
      {/* Brighter eyes, only inside the open eyes. */}
      <Group clip={eyes}>
        <Path path={eyes} color="#FFFFFF" opacity={EYE_BRIGHT}>
          <BlurMask blur={eyeBlur} style="normal" />
        </Path>
        <Circle cx={leftIrisX} cy={leftIrisY} r={leftIrisR} color="#FFFFFF" opacity={CATCHLIGHT}>
          <BlurMask blur={eyeBlur} style="normal" />
        </Circle>
        <Circle cx={rightIrisX} cy={rightIrisY} r={rightIrisR} color="#FFFFFF" opacity={CATCHLIGHT}>
          <BlurMask blur={eyeBlur} style="normal" />
        </Circle>
      </Group>
      {/* Sparkles */}
      <Path path={sparkles} color="#FFFDF7" opacity={SPARKLE}>
        <BlurMask blur={sparkleBlur} style="solid" />
      </Path>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Little drawing helpers (they run on the drawing thread, hence 'worklet').
// ---------------------------------------------------------------------------

function distance(pts: number[], a: number, b: number) {
  'worklet';
  return Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]);
}

// A smooth closed shape through the given points, grown or shrunk around its middle by `scale`.
function addSmoothLoop(builder: SkPathBuilder, pts: number[], loop: readonly number[], scale: number) {
  'worklet';
  const n = loop.length;
  if (n < 3) return;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[loop[i] * 2];
    cy += pts[loop[i] * 2 + 1];
  }
  cx /= n;
  cy /= n;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    xs.push(cx + (pts[loop[i] * 2] - cx) * scale);
    ys.push(cy + (pts[loop[i] * 2 + 1] - cy) * scale);
  }
  // Curves through the midpoints, using each point as the bend – no sharp corners.
  builder.moveTo((xs[n - 1] + xs[0]) / 2, (ys[n - 1] + ys[0]) / 2);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    builder.quadTo(xs[i], ys[i], (xs[i] + xs[next]) / 2, (ys[i] + ys[next]) / 2);
  }
  builder.close();
}

// A four-pointed sparkle with thin, curved arms.
function addSparkle(builder: SkPathBuilder, x: number, y: number, size: number) {
  'worklet';
  if (size <= 0.5) return;
  const waist = size * 0.16;
  builder.moveTo(x, y - size);
  builder.quadTo(x + waist, y - waist, x + size, y);
  builder.quadTo(x + waist, y + waist, x, y + size);
  builder.quadTo(x - waist, y + waist, x - size, y);
  builder.quadTo(x - waist, y - waist, x, y - size);
  builder.close();
}

// Where the blush goes: the cheek point, pulled a little toward the side of the face (where blush sits).
function cheekSpot(face: GlowFace | undefined, cheek: number, side: number) {
  'worklet';
  if (!face) return { x: -1000, y: -1000 };
  const x = face.pts[cheek * 2] * 0.85 + face.pts[side * 2] * 0.15;
  const y = face.pts[cheek * 2 + 1] * 0.85 + face.pts[side * 2 + 1] * 0.15;
  return { x, y };
}

// The catchlight: a small light dot on the upper side of the iris, like a reflection of a window.
function irisSpot(face: GlowFace | undefined, iris: number, edge: number, blink: number) {
  'worklet';
  if (!face || blink >= 0.5) return { x: -1000, y: -1000, r: 0 };
  const cx = face.pts[iris * 2];
  const cy = face.pts[iris * 2 + 1];
  const radius = distance(face.pts, iris, edge);
  return { x: cx - radius * 0.3, y: cy - radius * 0.35, r: Math.max(0.8, radius * 0.22) };
}
