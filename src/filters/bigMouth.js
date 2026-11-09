import { LIPS_OUTER, bbox, clamp } from '../landmarks.js';
import { warpRegion } from '../fx.js';

// Open wide and your mouth balloons to cartoon proportions.
export default {
  id: 'big-mouth',
  name: 'Big Mouth',
  hint: 'Open wide',
  emoji: '😃',

  trigger(f) {
    const b = f.blend;
    return clamp(Math.max(b.jawOpen || 0, (b.mouthSmileLeft || 0) * 0.5 + (b.mouthSmileRight || 0) * 0.5) * 1.3);
  },

  draw(f) {
    const { ctx, video, pts, m, smooth, state, dt } = f;
    const open = smooth.get('open', this.trigger(f), 0.3);

    // Spring for a bouncy inflate.
    state.s ??= 1; state.v ??= 0;
    const target = 1.1 + open * 0.95;
    state.v += (target - state.s) * 120 * dt - state.v * 10 * dt;
    state.s += state.v * dt;
    const s = Math.max(1, state.s);

    const lips = bbox(pts, LIPS_OUTER, 0.45);
    // Keep the region roughly elliptical/wide so the feather looks natural.
    const w = Math.max(lips.w, m.mouthW * 1.9);
    const h = Math.max(lips.h, m.mouthW * 1.1);
    const region = { x: lips.cx - w / 2, y: lips.cy - h / 2, w, h };

    // Slight anchor shift so the mouth grows downward more than upward.
    warpRegion(ctx, video, region, {
      sx: s, sy: s,
      anchor: { x: lips.cx, y: lips.cy - h * 0.15 * (s - 1) },
      feather: 0.42, slot: 0,
    });
  },
};
