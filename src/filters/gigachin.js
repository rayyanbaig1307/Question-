import { LM, clamp } from '../landmarks.js';
import { warpRegion, label } from '../fx.js';

// Pout to grow an enormous chin. The lower face stretches downward,
// anchored at the lip line so the mouth stays put.
export default {
  id: 'gigachin',
  name: 'Gigachin',
  hint: 'Pout to power up',
  emoji: '🗿',

  trigger(f) {
    const b = f.blend;
    return clamp(Math.max(b.mouthPucker || 0, (b.mouthFunnel || 0) * 0.8) * 1.3);
  },

  draw(f) {
    const { ctx, video, pts, m, smooth, state, dt, t } = f;
    const pout = smooth.get('pout', f.level, 0.25);

    // "Power" charges while pouting and drains when you relax.
    state.power ??= 0;
    state.power = clamp(state.power + (pout > 0.35 ? dt * 0.9 : -dt * 1.4));
    const grow = 0.15 + state.power * 0.6; // extra chin length, as a fraction of region height

    // Region starts just under the lower lip so the mouth itself is untouched.
    const lipY = pts[LM.lowerLipBottom].y;
    const chinY = pts[LM.chin].y;
    const gap = chinY - lipY;
    const regionH = gap * 1.15;
    const regionW = m.width * 0.8;
    const region = { x: m.chin.x - regionW / 2, y: lipY + gap * 0.08, w: regionW, h: regionH };

    // Jaw also widens slightly for that chiselled look.
    warpRegion(ctx, video, region, {
      sx: 1 + state.power * 0.15,
      sy: 1 + grow,
      anchor: { x: region.x + region.w / 2, y: region.y },
      feather: 0.3,
      slot: 0,
    });

    // Chiselled highlight along the new chin.
    const newChinY = region.y + region.h * (1 + grow);
    ctx.save();
    ctx.globalAlpha = 0.25 * state.power;
    const g = ctx.createLinearGradient(0, lipY, 0, newChinY);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(m.chin.x, newChinY - regionW * 0.12, regionW * 0.25, regionW * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Power meter.
    if (state.power > 0.02) {
      const pct = Math.round(state.power * 100);
      label(f, pct >= 100 ? 'GIGACHIN' : `CHIN POWER ${pct}%`, m.center.x, pts[LM.foreheadTop].y - m.height * 0.12, {
        size: Math.max(14, m.width * 0.09),
        color: pct >= 100 ? '#ffe36b' : '#fff',
        bg: 'rgba(138,43,226,0.75)',
        shadow: 'rgba(225,29,255,0.8)',
        rotate: Math.sin(t * 30) * 0.03 * (pct >= 100 ? 1 : 0),
      });
    }
  },
};
