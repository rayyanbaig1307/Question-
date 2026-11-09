import { LM, clamp } from '../landmarks.js';
import { sphere } from '../fx.js';

// Giant googly eyes that pop when you raise your brows. The pupils follow
// your real gaze (iris landmarks) and wobble with head movement.
export default {
  id: 'peekaboo-eyes',
  name: 'Peekaboo Eyes',
  hint: 'Raise your brows',
  emoji: '👀',

  trigger(f) {
    const b = f.blend;
    const raw = Math.max(b.browInnerUp || 0, ((b.browOuterUpLeft || 0) + (b.browOuterUpRight || 0)) / 2);
    return clamp(raw * 1.6);
  },

  draw(f) {
    const { ctx, pts, m, smooth, state, dt } = f;
    const t = smooth.get('brow', f.level, 0.3);

    // Spring the size so it "pops".
    state.size ??= 0;
    state.vel ??= 0;
    const target = 0.55 + t * 1.15; // eye radius relative to eye width
    const k = 140, d = 11;
    state.vel += (target - state.size) * k * dt - state.vel * d * dt;
    state.size += state.vel * dt;

    // Googly wobble driven by head velocity.
    state.px ??= m.nose.x; state.py ??= m.nose.y;
    state.wx ??= 0; state.wy ??= 0; state.wvx ??= 0; state.wvy ??= 0;
    const hvx = (m.nose.x - state.px) / Math.max(dt, 1e-3);
    const hvy = (m.nose.y - state.py) / Math.max(dt, 1e-3);
    state.px = m.nose.x; state.py = m.nose.y;
    state.wvx += (-state.wx * 60 - state.wvx * 6 - hvx * 0.8) * dt;
    state.wvy += (-state.wy * 60 - state.wvy * 6 - hvy * 0.8) * dt;
    state.wx += state.wvx * dt;
    state.wy += state.wvy * dt;

    const eyes = [
      { c: m.lEye, w: m.lEyeW, iris: pts[LM.leftIris], dir: -1 },
      { c: m.rEye, w: m.rEyeW, iris: pts[LM.rightIris], dir: 1 },
    ];

    for (const e of eyes) {
      const R = e.w * state.size + e.w * 0.3;
      // Eyes sit slightly outward so they read as bulging out of the sockets.
      const cx = e.c.x + e.dir * R * 0.12 * t;
      const cy = e.c.y - R * 0.18 * t;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = R * 0.5;
      ctx.shadowOffsetY = R * 0.2;
      sphere(ctx, cx, cy, R, '#f4f0fa');
      ctx.restore();

      // Pupil follows real gaze plus wobble, clamped inside the sphere.
      let gx = (e.iris.x - e.c.x) / Math.max(e.w, 1) * 1.8;
      let gy = (e.iris.y - e.c.y) / Math.max(e.w, 1) * 1.8;
      const wob = Math.min(0.5, Math.hypot(state.wx, state.wy) / (R * 2));
      gx += clamp(state.wx / (R * 2), -0.5, 0.5) * 0.8;
      gy += clamp(state.wy / (R * 2), -0.5, 0.5) * 0.8;
      const gl = Math.hypot(gx, gy);
      const maxOff = 0.45;
      if (gl > maxOff) { gx *= maxOff / gl; gy *= maxOff / gl; }

      const ir = R * 0.48;
      const ix = cx + gx * R, iy = cy + gy * R;
      const ig = ctx.createRadialGradient(ix, iy, ir * 0.1, ix, iy, ir);
      ig.addColorStop(0, '#c47cff');
      ig.addColorStop(0.6, '#8a2be2');
      ig.addColorStop(1, '#4b0f8e');
      ctx.beginPath(); ctx.arc(ix, iy, ir, 0, Math.PI * 2);
      ctx.fillStyle = ig; ctx.fill();

      ctx.beginPath(); ctx.arc(ix, iy, ir * 0.48 + wob * ir * 0.1, 0, Math.PI * 2);
      ctx.fillStyle = '#120618'; ctx.fill();

      ctx.beginPath(); ctx.arc(ix - ir * 0.3, iy - ir * 0.35, ir * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
      ctx.beginPath(); ctx.arc(ix + ir * 0.25, iy + ir * 0.3, ir * 0.08, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fill();
    }
  },
};
