import { FACE_OVAL, bbox, clamp } from '../landmarks.js';
import { offscreen, polyPath, warpRegion } from '../fx.js';

// Shrinks your whole face into the middle of a smooth, featureless head.
// Talking makes it even tinier (and it bobs with your jaw).
export default {
  id: 'tiny-face',
  name: 'Tiny Face',
  hint: 'Just talk',
  emoji: '🫥',

  trigger(f) {
    return clamp((f.blend.jawOpen || 0) * 2.2);
  },

  draw(f) {
    const { ctx, video, pts, m, smooth, state, t, dt } = f;
    const talk = smooth.get('talk', f.level, 0.4);
    state.energy ??= 0;
    state.energy = Math.max(talk, state.energy - dt * 0.8); // decays after you stop talking

    const face = bbox(pts, FACE_OVAL, 0.05);
    const ox = face.cx, oy = face.cy;

    // 1) Erase features: paint a blurred copy of the face region under an oval clip.
    const blur = Math.max(18, face.w * 0.12);
    const pad = blur * 3;
    const bw = face.w + pad * 2, bh = face.h + pad * 2;
    const off = offscreen(0, bw, bh);
    const o = off.getContext('2d');
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, off.width, off.height);
    o.filter = `blur(${blur}px)`;
    // Draw with the oval filled outward so the blur has no transparent border.
    o.drawImage(video, face.x - pad, face.y - pad, bw, bh, 0, 0, bw, bh);
    o.filter = 'none';

    ctx.save();
    polyPath(ctx, pts, FACE_OVAL, 1.04, ox, oy);
    ctx.clip();
    ctx.drawImage(off, pad, pad, face.w, face.h, face.x, face.y, face.w, face.h);
    // Soft inner shading so the "egg" still reads as a 3D head.
    const g = ctx.createRadialGradient(ox, oy - face.h * 0.1, face.w * 0.2, ox, oy, face.w * 0.75);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(face.x - 10, face.y - 10, face.w + 20, face.h + 20);
    ctx.restore();

    // 2) Draw the tiny face back in the centre.
    const base = 0.42 - state.energy * 0.14;
    const bob = Math.sin(t * 14) * 0.015 * state.energy;
    const s = base + bob;
    const inner = bbox(pts, FACE_OVAL, -0.05); // tighter crop (no hair/ears)
    const yShift = face.h * 0.04; // sit a touch below centre, like the reference
    warpRegion(ctx, video, inner, {
      sx: s, sy: s,
      at: { x: ox, y: oy + yShift },
      feather: 0.5, slot: 1,
    });
  },
};
