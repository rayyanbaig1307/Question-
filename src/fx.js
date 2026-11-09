// Shared drawing helpers used by the filters.
// All filter drawing happens in *video* pixel space. When the view is
// mirrored, the main context carries a horizontal flip; text helpers undo it.

const scratch = [];
/** Get (or grow) a reusable offscreen canvas. */
export function offscreen(slot, w, h) {
  let c = scratch[slot];
  if (!c) c = scratch[slot] = document.createElement('canvas');
  w = Math.max(1, Math.ceil(w));
  h = Math.max(1, Math.ceil(h));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

/** Draw text upright even when the frame is mirrored. */
export function label(f, text, x, y, opts = {}) {
  const { ctx, W, mirrored } = f;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const sx = mirrored ? W - x : x;
  ctx.translate(sx, y);
  if (opts.rotate) ctx.rotate(opts.rotate);
  ctx.font = opts.font || `900 ${opts.size || 24}px Inter, system-ui, sans-serif`;
  ctx.textAlign = opts.align || 'center';
  ctx.textBaseline = opts.baseline || 'middle';
  if (opts.bg) {
    const m = ctx.measureText(text);
    const pw = m.width + (opts.padX ?? 14) * 2;
    const ph = (opts.size || 24) * 1.5;
    let bx = -pw / 2;
    if (ctx.textAlign === 'left') bx = -(opts.padX ?? 14);
    if (ctx.textAlign === 'right') bx = -pw + (opts.padX ?? 14);
    ctx.fillStyle = opts.bg;
    roundRect(ctx, bx, -ph / 2, pw, ph, opts.radius ?? 6);
    ctx.fill();
  }
  if (opts.shadow) {
    ctx.shadowColor = opts.shadow;
    ctx.shadowBlur = opts.shadowBlur ?? 12;
  }
  if (opts.stroke) {
    ctx.lineWidth = opts.strokeWidth || 4;
    ctx.strokeStyle = opts.stroke;
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = opts.color || '#fff';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Trace a closed path through landmark points. */
export function polyPath(ctx, pts, indices, scale = 1, cx = 0, cy = 0) {
  ctx.beginPath();
  indices.forEach((i, k) => {
    const p = pts[i];
    const x = cx + (p.x - cx) * scale;
    const y = cy + (p.y - cy) * scale;
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
}

/**
 * Copy a rectangular region of `src`, scaled about its own centre
 * (or an explicit anchor) and feathered with a soft elliptical mask,
 * then composite it onto `ctx`.
 *
 * region: {x,y,w,h} in src pixel space.
 * sx, sy: scale factors. anchor: {x,y} fixed point in src space (default centre).
 * at: {x,y} optional destination centre (overrides anchor).
 * feather: 0..1 fraction of the radius that fades out.
 */
export function warpRegion(ctx, src, region, { sx = 1, sy = 1, anchor, at, feather = 0.35, slot = 0, pixelate = 0 } = {}) {
  const { x, y, w, h } = region;
  if (w < 2 || h < 2) return;
  const ax = anchor ? anchor.x : x + w / 2;
  const ay = anchor ? anchor.y : y + h / 2;
  const dw = w * sx, dh = h * sy;
  // `at` places the scaled copy's centre at an explicit point; otherwise the
  // anchor point stays fixed while the region scales around it.
  const dx = at ? at.x - dw / 2 : ax + (x - ax) * sx;
  const dy = at ? at.y - dh / 2 : ay + (y - ay) * sy;

  const off = offscreen(slot, dw, dh);
  const o = off.getContext('2d');
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalCompositeOperation = 'source-over';
  o.clearRect(0, 0, off.width, off.height);

  if (pixelate > 1) {
    const tiny = offscreen(slot + 10, Math.max(1, dw / pixelate), Math.max(1, dh / pixelate));
    const t = tiny.getContext('2d');
    t.imageSmoothingEnabled = true;
    t.clearRect(0, 0, tiny.width, tiny.height);
    t.drawImage(src, x, y, w, h, 0, 0, tiny.width, tiny.height);
    o.imageSmoothingEnabled = false;
    o.drawImage(tiny, 0, 0, tiny.width, tiny.height, 0, 0, dw, dh);
    o.imageSmoothingEnabled = true;
  } else {
    o.drawImage(src, x, y, w, h, 0, 0, dw, dh);
  }

  // Feathered elliptical alpha mask. The gradient is defined in a unit
  // space (centre 1,1 radius 1) and stretched to the ellipse by the transform.
  o.globalCompositeOperation = 'destination-in';
  const g = o.createRadialGradient(1, 1, 0, 1, 1, 1);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(Math.max(0, 1 - feather), 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  o.save();
  o.scale(dw / 2, dh / 2);
  o.fillStyle = g;
  o.fillRect(0, 0, 2, 2);
  o.restore();
  o.globalCompositeOperation = 'source-over';

  ctx.drawImage(off, dx, dy, dw, dh);
}

// ---- Shapes -------------------------------------------------------------

export function heartPath(ctx, x, y, s) {
  // s = half-width of the heart.
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.95);
  ctx.bezierCurveTo(x - s * 1.6, y - s * 0.15, x - s * 0.9, y - s * 1.2, x, y - s * 0.45);
  ctx.bezierCurveTo(x + s * 0.9, y - s * 1.2, x + s * 1.6, y - s * 0.15, x, y + s * 0.95);
  ctx.closePath();
}

export function starPath(ctx, x, y, r, points = 5, inner = 0.45) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * inner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Jagged lightning polyline from (x0,y0) toward (x1,y1). */
export function boltPath(ctx, x0, y0, x1, y1, segments = 6, jitter = 0.25, rnd = Math.random) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const j = (rnd() - 0.5) * 2 * jitter * len;
    ctx.lineTo(x0 + (x1 - x0) * t + nx * j, y0 + (y1 - y0) * t + ny * j);
  }
  ctx.lineTo(x1, y1);
}

/** Glossy sphere (used for googly eyes). */
export function sphere(ctx, x, y, r, color = '#fff') {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.7, color);
  g.addColorStop(1, '#bdb3c9');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}

// ---- Particles ------------------------------------------------------------

export class Particles {
  constructor(max = 400) {
    this.items = [];
    this.max = max;
  }
  spawn(p) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ life: 1, age: 0, vx: 0, vy: 0, ax: 0, ay: 0, rot: 0, vr: 0, ...p });
  }
  step(dt) {
    const keep = [];
    for (const p of this.items) {
      p.age += dt;
      p.vx += p.ax * dt;
      p.vy += p.ay * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.age < p.life) keep.push(p);
    }
    this.items = keep;
  }
  clear() { this.items.length = 0; }
}

/** Deterministic pseudo-random from a seed (for flicker that is stable per frame). */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
