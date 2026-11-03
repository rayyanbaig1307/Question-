import { BlurMask, Canvas, Circle, Group, Path, RadialGradient, vec } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';

import { blushSpot, linerPath, lipsPath, smoothPath } from '@/lib/facePaths';
import type { FaceShape } from '@/lib/faceLens';

// The live preview of Glam and Glow, drawn over the camera along the real face outlines.
// (The finished photo gets the full version, blended into the skin – see lib/lensPhoto.ts.)
// Only loaded where Skia exists (the app download).
export function LiveLook({ shapes, look }: { shapes: FaceShape[]; look: 'makeup' | 'glow' }) {
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {shapes.map((shape) => (look === 'glow' ? <Glow key={shape.key} shape={shape} /> : <Glam key={shape.key} shape={shape} />))}
    </Canvas>
  );
}

function Glow({ shape }: { shape: FaceShape }) {
  const face = smoothPath(shape.face, true);
  if (!face) return null;
  return (
    <Path path={face} color="rgba(255, 236, 226, 0.2)">
      <BlurMask blur={shape.width * 0.08} style="normal" />
    </Path>
  );
}

function Glam({ shape }: { shape: FaceShape }) {
  const lips = lipsPath(shape);
  const leftOuter = (shape.leftEye[0]?.x ?? 0) < (shape.rightEye[0]?.x ?? 0);
  const liners = [linerPath(shape.leftEye, leftOuter, shape.width), linerPath(shape.rightEye, !leftOuter, shape.width)];
  const r = shape.width * 0.17;
  return (
    <Group>
      {(['left', 'right'] as const).map((side) => {
        const spot = blushSpot(shape, side);
        if (!spot) return null;
        return (
          <Circle key={side} cx={spot.x} cy={spot.y} r={r}>
            <RadialGradient c={vec(spot.x, spot.y)} r={r} colors={['rgba(240, 80, 120, 0.3)', 'rgba(240, 80, 120, 0)']} />
          </Circle>
        );
      })}
      {lips ? (
        <Path path={lips} color="rgba(200, 30, 80, 0.36)">
          <BlurMask blur={shape.width * 0.006} style="normal" />
        </Path>
      ) : null}
      {liners.map((path, index) =>
        path ? (
          <Path
            key={index}
            path={path}
            style="stroke"
            strokeWidth={shape.width * 0.009}
            strokeCap="round"
            color="rgba(25, 12, 20, 0.7)"
          />
        ) : null,
      )}
    </Group>
  );
}
