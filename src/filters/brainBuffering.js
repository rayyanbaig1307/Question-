import { LM, clamp } from '../landmarks.js';
import { label, seeded } from '../fx.js';

// A loading spinner hovers over your forehead. Hold perfectly still and your
// brain slowly buffers to 100%; move and it stalls (and may lose progress).
export default {
  id: 'brain-buffering',
  name: 'Brain Buffering',
  hint: 'Hold still',
  emoji: '🧠',

  trigger(f) {
    return f.state.progress ?? 0;
  },

  draw(f) {
    const { ctx, pts, m, state, dt, t } = f;
    state.progress ??= 0;
    state.px ??= m.nose.x; state.py ??= m.nose.y;
    state.motion ??= 0;
    state.spin ??= 0;
    state.flash ??= 0;

    // Motion in face-widths per second, smoothed.
    const v = Math.hypot(m.nose.x - state.px, m.nose.y - state.py) / Math.max(dt, 1e-3) / Math.max(m.width, 1);
    state.px = m.nose.x; state.py = m.nose.y;
    state.motion += (v - state.motion) * 0.35;

    const still = state.motion < 0.12;
    if (state.progress < 1) {
      if (still) {
        // Buffering gets slower the closer you are, like a real progress bar.
        const rate = 0.12 * (1.4 - state.progress);
        state.progress = clamp(state.progress + rate * dt);
        if (state.progress >= 1) state.flash = 1;
      } else {
        state.progress = clamp(state.progress - dt * 0.6 * Math.min(state.motion, 2));
      }
      state.spin += dt * (still ? 3.5 : 1.2);
    } else {
      // Loaded. Any big move reboots.
      if (state.motion > 0.6) { state.progress = 0; state.flash = 0; }
    }
    state.flash = Math.max(0, state.flash - dt * 1.2);

    const r = m.width * 0.16;
    const cx = m.forehead.x;
    const cy = m.forehead.y - r * 0.4;
    const pct = Math.round(state.progress * 100);
    const loaded = state.progress >= 1;
    const rnd = seeded(Math.floor(t * 6));

    ctx.save();
    ctx.shadowColor = 'rgba(177,76,255,0.9)';
    ctx.shadowBlur = r * 0.6;

    // Backing disc.
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,8,50,0.65)'; ctx.fill();

    // Segmented spinner ring.
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2 + state.spin;
      const a1 = a0 + (Math.PI * 2 / segs) * 0.6;
      const head = ((i / segs) + 0.0) % 1; // brightness falls off behind the head
      const alpha = loaded ? 1 : 0.25 + 0.75 * ((segs - i) / segs);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.82, a0, a1);
      ctx.lineWidth = r * 0.16;
      ctx.lineCap = 'round';
      ctx.strokeStyle = loaded ? `rgba(120,255,170,${alpha})` : `rgba(${200 + 55 * head},${140 + 60 * alpha},255,${alpha})`;
      ctx.stroke();
    }

    // Progress arc inside the ring.
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.58, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * state.progress);
    ctx.lineWidth = r * 0.07;
    ctx.strokeStyle = loaded ? '#7dffb0' : '#ff4fd8';
    ctx.stroke();

    // Drifting "data" squares around the ring.
    for (let i = 0; i < 8; i++) {
      const a = state.spin * 0.6 + i * (Math.PI * 2 / 8);
      const rad = r * (1.35 + 0.25 * Math.sin(t * 2 + i));
      const s = r * (0.07 + 0.06 * rnd());
      ctx.fillStyle = `rgba(${180 + 60 * rnd()},${60 + 120 * rnd()},255,${0.5 + 0.5 * rnd()})`;
      ctx.fillRect(cx + Math.cos(a) * rad - s / 2, cy + Math.sin(a) * rad - s / 2, s, s);
    }
    ctx.restore();

    label(f, loaded ? '✓' : `${pct}%`, cx, cy + r * 0.02, {
      size: r * (loaded ? 0.9 : 0.55),
      color: loaded ? '#7dffb0' : '#fff',
      shadow: 'rgba(0,0,0,0.6)',
    });

    const msg = loaded
      ? (state.flash > 0 ? 'BRAIN LOADED' : 'thought.exe running')
      : still ? 'buffering…' : 'MOVED! buffering stalled';
    label(f, msg, cx, cy + r * 1.35, {
      size: Math.max(11, r * 0.26),
      color: loaded ? '#7dffb0' : still ? '#e8d6ff' : '#ffb3b3',
      bg: 'rgba(0,0,0,0.5)',
      radius: 8,
    });

    if (state.flash > 0) {
      ctx.save();
      ctx.globalAlpha = state.flash * 0.35;
      ctx.fillStyle = '#9dffc8';
      ctx.fillRect(0, 0, f.W, f.H);
      ctx.restore();
    }
  },
};
