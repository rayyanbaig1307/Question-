import { LM, clamp } from '../landmarks.js';
import { boltPath, starPath, seeded, Particles } from '../fx.js';

// Open your mouth to unleash the aura: glowing eyes, a crackling halo of
// lightning around your head, orbiting stars and a purple screen bloom.
export default {
  id: 'aura-overload',
  name: 'Aura Overload',
  hint: 'Open your mouth',
  emoji: '⚡',

  trigger(f) {
    return clamp((f.blend.jawOpen || 0) * 1.5);
  },

  draw(f) {
    const { ctx, pts, m, smooth, state, dt, t, W, H } = f;
    const open = smooth.get('open', this.trigger(f), 0.25);
    state.charge ??= 0;
    // Charge builds while the mouth is open, lingers briefly after.
    state.charge = clamp(open > 0.15 ? state.charge + dt * 2.2 : state.charge - dt * 1.6);
    const a = 0.12 + state.charge * 0.88; // overall intensity, never fully off
    const rnd = seeded(Math.floor(t * 18)); // flicker at ~18 Hz
    const headR = m.width * 0.62;
    const hx = m.center.x, hy = m.center.y - m.height * 0.08;

    // Screen bloom / vignette.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const vg = ctx.createRadialGradient(hx, hy, headR * 0.8, hx, hy, Math.max(W, H) * 0.9);
    vg.addColorStop(0, `rgba(138,43,226,0)`);
    vg.addColorStop(1, `rgba(177,76,255,${0.55 * a})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Aura ring: pulsing glow around the head.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 1 + Math.sin(t * 9) * 0.05 * a;
    const ag = ctx.createRadialGradient(hx, hy, headR * 0.85 * pulse, hx, hy, headR * 1.35 * pulse);
    ag.addColorStop(0, `rgba(177,76,255,0)`);
    ag.addColorStop(0.35, `rgba(225,29,255,${0.45 * a})`);
    ag.addColorStop(1, `rgba(138,43,226,0)`);
    ctx.fillStyle = ag;
    ctx.fillRect(hx - headR * 2, hy - headR * 2, headR * 4, headR * 4);

    // Lightning bolts bursting outward.
    const bolts = Math.round(3 + state.charge * 11);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < bolts; i++) {
      if (rnd() > 0.5 + a * 0.5) continue; // flicker
      const ang = (i / bolts) * Math.PI * 2 + rnd() * 0.5 + t * 0.4;
      const r0 = headR * (0.7 + rnd() * 0.2);
      const r1 = headR * (1.1 + rnd() * 0.7 * a);
      const x0 = hx + Math.cos(ang) * r0, y0 = hy + Math.sin(ang) * r0 * 1.15;
      const x1 = hx + Math.cos(ang + (rnd() - 0.5) * 0.8) * r1, y1 = hy + Math.sin(ang + (rnd() - 0.5) * 0.8) * r1 * 1.15;
      ctx.shadowColor = '#e11dff';
      ctx.shadowBlur = m.width * 0.08;
      boltPath(ctx, x0, y0, x1, y1, 5 + Math.floor(rnd() * 4), 0.22, rnd);
      ctx.strokeStyle = `rgba(230,170,255,${0.9 * a})`;
      ctx.lineWidth = m.width * 0.016;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
      ctx.lineWidth = m.width * 0.006;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Orbiting stars.
    const stars = 7;
    for (let i = 0; i < stars; i++) {
      const ang = t * (0.9 + i * 0.07) + i * (Math.PI * 2 / stars);
      const rad = headR * (1.25 + 0.2 * Math.sin(t * 1.7 + i));
      const sx = hx + Math.cos(ang) * rad, sy = hy + Math.sin(ang) * rad * 1.1;
      const sr = m.width * (0.03 + 0.025 * Math.sin(t * 5 + i * 2)) * (0.5 + a);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(t * 2 + i);
      starPath(ctx, 0, 0, sr);
      ctx.fillStyle = `rgba(255,255,255,${0.6 + 0.4 * a})`;
      ctx.shadowColor = '#ff4fd8';
      ctx.shadowBlur = sr * 1.5;
      ctx.fill();
      ctx.restore();
    }

    // Glowing eyes.
    for (const e of [m.lEye, m.rEye]) {
      const er = m.lEyeW * (0.55 + 0.9 * a) * (1 + Math.sin(t * 20) * 0.05 * a);
      const eg = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, er);
      eg.addColorStop(0, `rgba(255,255,255,${0.95 * (0.3 + a)})`);
      eg.addColorStop(0.35, `rgba(221,160,255,${0.9 * (0.3 + a)})`);
      eg.addColorStop(1, 'rgba(138,43,226,0)');
      ctx.fillStyle = eg;
      ctx.beginPath(); ctx.arc(e.x, e.y, er, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
};
