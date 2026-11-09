import { LM, clamp, lerp } from '../landmarks.js';
import { heartPath, Particles } from '../fx.js';

// Big glossy hearts over your eyes, rosy blush, and when you blow a kiss a
// stream of little hearts floats up from your lips.
export default {
  id: 'heart-eyes',
  name: 'Heart Eyes',
  hint: 'Blow a kiss',
  emoji: '😘',

  trigger(f) {
    const b = f.blend;
    return clamp(Math.max(b.mouthPucker || 0, b.mouthFunnel || 0) * 1.3);
  },

  draw(f) {
    const { ctx, pts, m, smooth, state, dt, t } = f;
    const kiss = smooth.get('kiss', f.level, 0.3);
    state.parts ??= new Particles(200);
    state.beat ??= 0;
    state.cool ??= 0;

    // Heartbeat: quick double thump.
    state.beat += dt * (1.6 + kiss * 1.2);
    const ph = state.beat % 1;
    const thump = Math.max(0, Math.sin(ph * Math.PI * 2) ** 8) + 0.6 * Math.max(0, Math.sin((ph - 0.15) * Math.PI * 2) ** 8);
    const scale = 1 + thump * 0.09 + kiss * 0.12;

    // Blush on cheeks.
    for (const i of [LM.leftCheekBlush, LM.rightCheekBlush]) {
      const p = pts[i];
      const r = m.width * 0.13;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, `rgba(255,105,180,${0.45 + kiss * 0.3})`);
      g.addColorStop(1, 'rgba(255,105,180,0)');
      ctx.fillStyle = g;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      // Anime-style blush strokes.
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${0.5 + kiss * 0.4})`;
      ctx.lineWidth = Math.max(1.5, m.width * 0.008);
      ctx.lineCap = 'round';
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(p.x + k * r * 0.28 - r * 0.12, p.y + r * 0.22);
        ctx.lineTo(p.x + k * r * 0.28 + r * 0.12, p.y - r * 0.22);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Hearts over the eyes.
    for (const e of [{ c: m.lEye, w: m.lEyeW }, { c: m.rEye, w: m.rEyeW }]) {
      const s = e.w * 0.95 * scale;
      ctx.save();
      ctx.translate(e.c.x, e.c.y + s * 0.1);
      ctx.rotate(m.roll);
      ctx.shadowColor = 'rgba(255,79,216,0.8)';
      ctx.shadowBlur = s * 0.6;
      const g = ctx.createRadialGradient(-s * 0.3, -s * 0.5, s * 0.1, 0, 0, s * 1.4);
      g.addColorStop(0, '#ff9ad5');
      g.addColorStop(0.45, '#ff3fa4');
      g.addColorStop(1, '#c2186f');
      heartPath(ctx, 0, 0, s);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;
      // Gloss.
      ctx.beginPath();
      ctx.ellipse(-s * 0.45, -s * 0.5, s * 0.28, s * 0.16, -0.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fill();
      ctx.restore();
    }

    // Kiss → floating hearts from the lips.
    state.cool -= dt;
    if (kiss > 0.4 && state.cool <= 0) {
      state.cool = lerp(0.16, 0.05, kiss);
      const mouth = m.mouth;
      const dir = Math.random() < 0.5 ? -1 : 1;
      state.parts.spawn({
        x: mouth.x + (Math.random() - 0.5) * m.mouthW * 0.5,
        y: mouth.y,
        vx: (Math.random() * 0.4 + 0.3) * m.width * dir * 0.9 + (Math.random() - 0.5) * m.width * 0.4,
        vy: -m.height * (0.5 + Math.random() * 0.6),
        ay: -m.height * 0.25,
        ax: -dir * m.width * 0.35,
        size: m.width * (0.05 + Math.random() * 0.07),
        rot: (Math.random() - 0.5) * 0.6,
        vr: (Math.random() - 0.5) * 2,
        life: 1.4 + Math.random() * 0.8,
        hue: Math.random() < 0.3 ? '#ff7cc4' : '#ff3fa4',
      });
    }
    state.parts.step(dt);
    for (const p of state.parts.items) {
      const k = 1 - p.age / p.life;
      ctx.save();
      ctx.globalAlpha = Math.min(1, k * 1.5);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      heartPath(ctx, 0, 0, p.size * (0.7 + 0.3 * Math.sin(p.age * 12)));
      ctx.fillStyle = p.hue;
      ctx.shadowColor = 'rgba(255,79,216,0.7)';
      ctx.shadowBlur = p.size;
      ctx.fill();
      ctx.restore();
    }
  },
};
