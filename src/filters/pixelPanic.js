import { FACE_OVAL, bbox, clamp } from '../landmarks.js';
import { warpRegion, label, seeded } from '../fx.js';

// Raise your brows and your face corrupts: heavy pixelation, glitch slices
// that tear sideways, magenta data bars and a flashing ERROR tag.
export default {
  id: 'pixel-panic',
  name: 'Pixel Panic',
  hint: 'Raise your brows',
  emoji: '👾',

  trigger(f) {
    const b = f.blend;
    const brows = Math.max(b.browInnerUp || 0, ((b.browOuterUpLeft || 0) + (b.browOuterUpRight || 0)) / 2);
    return clamp(brows * 1.6);
  },

  draw(f) {
    const { ctx, video, pts, m, smooth, state, dt, t, W, H } = f;
    const panic = smooth.get('panic', this.trigger(f), 0.35);
    state.level ??= 0;
    state.level = clamp(state.level + (panic > 0.3 ? dt * 3 : -dt * 1.5));
    const lv = Math.max(panic, state.level);
    const rnd = seeded(Math.floor(t * 12));

    const face = bbox(pts, FACE_OVAL, 0.12);
    const px = 3 + lv * Math.max(10, face.w * 0.09);

    // Pixelated face.
    warpRegion(ctx, video, face, { pixelate: lv > 0.03 ? px : 0, feather: 0.3, slot: 0 });

    if (lv < 0.05) return;

    // Horizontal tear slices: strips of the face shoved left/right.
    const slices = Math.round(lv * 7);
    for (let i = 0; i < slices; i++) {
      const sy = face.y + rnd() * face.h;
      const sh = face.h * (0.03 + rnd() * 0.08);
      const shift = (rnd() - 0.5) * face.w * 0.35 * lv;
      ctx.drawImage(video, face.x, sy, face.w, sh, face.x + shift, sy, face.w, sh);
      // Colour-channel ghost.
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.5 * lv;
      ctx.fillStyle = rnd() < 0.5 ? '#ff00c8' : '#00e5ff';
      ctx.fillRect(face.x + shift * 1.4, sy, face.w, sh * 0.5);
      ctx.restore();
    }

    // Magenta data bars floating around the head.
    const bars = Math.round(4 + lv * 10);
    for (let i = 0; i < bars; i++) {
      if (rnd() > 0.75) continue;
      const bw = face.w * (0.08 + rnd() * 0.45);
      const bh = Math.max(3, face.h * (0.012 + rnd() * 0.02));
      const bx = face.x - face.w * 0.4 + rnd() * face.w * 1.8;
      const by = face.y - face.h * 0.2 + rnd() * face.h * 1.3;
      ctx.fillStyle = rnd() < 0.8 ? `rgba(225,29,255,${0.6 + 0.4 * rnd()})` : `rgba(0,229,255,${0.5 + 0.4 * rnd()})`;
      ctx.fillRect(bx, by, bw, bh);
    }

    // ERROR tag near the forehead, flickering.
    if (lv > 0.35 && Math.floor(t * 5) % 7 !== 3) {
      label(f, 'ERROR', m.forehead.x + m.width * 0.42, m.forehead.y + m.height * 0.02, {
        size: Math.max(12, m.width * 0.1),
        font: `900 ${Math.max(12, m.width * 0.1)}px "Courier New", monospace`,
        color: '#111',
        bg: '#fff',
        radius: 2,
        rotate: -0.12 + (rnd() - 0.5) * 0.04,
      });
    }

    // Occasional full-frame glitch line.
    if (rnd() < 0.2 * lv) {
      const y = rnd() * H;
      ctx.drawImage(video, 0, y, W, 6, (rnd() - 0.5) * 40 * lv, y, W, 6);
    }
  },
};
