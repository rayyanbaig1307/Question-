import { LM, clamp } from '../landmarks.js';
import { Particles } from '../fx.js';

// Squint and the waterworks start: fountains of cartoon tears gush from
// both eyes, with droplets that splash off your cheeks.
export default {
  id: 'crybaby',
  name: 'Crybaby',
  hint: 'Squint for tears',
  emoji: '😭',

  trigger(f) {
    const b = f.blend;
    const squint = ((b.eyeSquintLeft || 0) + (b.eyeSquintRight || 0)) / 2;
    const blink = ((b.eyeBlinkLeft || 0) + (b.eyeBlinkRight || 0)) / 2;
    // Squinting *or* scrunching shut, but not a quick blink (handled by smoothing).
    return clamp(Math.max(squint * 1.4, blink * 0.9 - 0.1));
  },

  draw(f) {
    const { ctx, pts, m, smooth, state, dt, t } = f;
    const cry = smooth.get('cry', this.trigger(f), 0.18);
    state.parts ??= new Particles(500);
    state.streams ??= [];

    const eyes = [
      { p: pts[LM.leftEyeBottom], out: pts[LM.leftEyeOuter], dir: -1 },
      { p: pts[LM.rightEyeBottom], out: pts[LM.rightEyeOuter], dir: 1 },
    ];
    const g = m.height * 3.2; // gravity in px/s²

    if (cry > 0.12) {
      const n = Math.ceil(cry * 7);
      for (const e of eyes) {
        for (let i = 0; i < n; i++) {
          const spread = (Math.random() - 0.5) * 0.9;
          const speed = m.height * (0.9 + cry * 1.6) * (0.7 + Math.random() * 0.6);
          state.parts.spawn({
            x: e.p.x + (Math.random() - 0.5) * m.lEyeW * 0.6,
            y: e.p.y,
            vx: e.dir * speed * (0.35 + Math.random() * 0.35) + spread * speed * 0.25,
            vy: -speed * (0.1 + Math.random() * 0.3),
            ay: g,
            r: m.width * (0.018 + Math.random() * 0.03) * (0.6 + cry * 0.6),
            life: 0.9 + Math.random() * 0.5,
          });
        }
      }
    }
    state.parts.step(dt);

    ctx.save();
    for (const p of state.parts.items) {
      const k = 1 - p.age / p.life;
      const ang = Math.atan2(p.vy, p.vx) + Math.PI / 2;
      const stretch = clamp(Math.hypot(p.vx, p.vy) / (m.height * 2), 0, 1.2);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      ctx.scale(1, 1 + stretch);
      const grad = ctx.createRadialGradient(-p.r * 0.3, -p.r * 0.3, p.r * 0.1, 0, 0, p.r);
      grad.addColorStop(0, `rgba(230,246,255,${0.95 * k + 0.05})`);
      grad.addColorStop(0.6, `rgba(90,180,255,${0.9 * k + 0.1})`);
      grad.addColorStop(1, `rgba(30,110,230,${0.85 * k})`);
      ctx.fillStyle = grad;
      // Teardrop: circle with a pointed top.
      ctx.beginPath();
      ctx.moveTo(0, -p.r * 1.6);
      ctx.quadraticCurveTo(p.r * 1.05, -p.r * 0.2, 0, p.r);
      ctx.quadraticCurveTo(-p.r * 1.05, -p.r * 0.2, 0, -p.r * 1.6);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // Puffy wet under-eye glow and trembling lower lip tint while crying.
    if (cry > 0.1) {
      ctx.save();
      ctx.globalAlpha = cry * 0.35;
      for (const e of eyes) {
        const rg = ctx.createRadialGradient(e.p.x, e.p.y + m.lEyeW * 0.3, 0, e.p.x, e.p.y + m.lEyeW * 0.3, m.lEyeW * 0.9);
        rg.addColorStop(0, 'rgba(255,120,140,0.9)');
        rg.addColorStop(1, 'rgba(255,120,140,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(e.p.x - m.lEyeW, e.p.y - m.lEyeW * 0.4, m.lEyeW * 2, m.lEyeW * 1.6);
      }
      ctx.restore();
    }
  },
};
