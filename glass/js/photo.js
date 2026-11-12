// A "post" drawn in code: friends on a rooftop at golden hour, phones up. Used on the glass phone's screen
// and in the hold-to-reveal demo.

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function drawPhoto(ctx, w, h, variant = 0) {
  const r = rng(7 + variant * 31);
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  const skies = [
    ['#5b2bd9', '#ff4f9a', '#ffb35c', '#ffd98a'],
    ['#2a1a6e', '#8a4dff', '#ff6fae', '#ffc27a'],
    ['#1e8fff', '#5cc8ff', '#ffd1ec', '#ffe9b0'],
    ['#12062e', '#5a1fa8', '#ff3d8e', '#ff9f5a'],
    ['#ff3d8e', '#ff7ab8', '#ffc2dc', '#fff0c2'],
    ['#3b1fd1', '#38b6ff', '#9ff0ff', '#fff4d6'],
  ][variant % 6];
  skies.forEach((c, i) => sky.addColorStop([0, 0.4, 0.7, 1][i], c));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // sun
  const sx = w * (variant % 2 === 0 ? 0.68 : 0.3), sy = h * (0.42 + (variant % 3) * 0.05), sr = w * 0.2;
  const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 2.6);
  sun.addColorStop(0, 'rgba(255,250,225,1)');
  sun.addColorStop(0.22, 'rgba(255,236,170,0.95)');
  sun.addColorStop(0.45, 'rgba(255,170,120,0.35)');
  sun.addColorStop(1, 'rgba(255,120,140,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);

  // soft clouds
  for (let i = 0; i < 7; i++) {
    const cx = r() * w, cy = h * (0.1 + r() * 0.35), cw = w * (0.25 + r() * 0.35);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cw);
    g.addColorStop(0, 'rgba(255,214,234,0.55)');
    g.addColorStop(1, 'rgba(255,214,234,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, cw, cw * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // city skyline
  ctx.fillStyle = 'rgba(70,30,110,0.55)';
  let x = 0;
  while (x < w) {
    const bw = w * (0.05 + r() * 0.08), bh = h * (0.08 + r() * 0.16);
    ctx.fillRect(x, h * 0.62 - bh, bw, bh + h);
    x += bw + w * 0.006;
  }
  ctx.fillStyle = 'rgba(45,18,80,0.75)';
  x = -w * 0.02;
  while (x < w) {
    const bw = w * (0.06 + r() * 0.1), bh = h * (0.04 + r() * 0.12);
    ctx.fillRect(x, h * 0.68 - bh, bw, bh + h);
    // little lit windows
    ctx.fillStyle = 'rgba(255,214,140,0.7)';
    for (let k = 0; k < 6; k++) if (r() > 0.5) ctx.fillRect(x + r() * bw * 0.8, h * 0.68 - bh + r() * bh, w * 0.008, w * 0.012);
    ctx.fillStyle = 'rgba(45,18,80,0.75)';
    x += bw + w * 0.01;
  }

  // rooftop
  const roof = ctx.createLinearGradient(0, h * 0.7, 0, h);
  roof.addColorStop(0, '#3a1a5c');
  roof.addColorStop(1, '#1b1028');
  ctx.fillStyle = roof;
  ctx.fillRect(0, h * 0.7, w, h * 0.3);
  // string lights
  ctx.strokeStyle = 'rgba(255,240,200,0.35)';
  ctx.lineWidth = w * 0.004;
  ctx.beginPath();
  ctx.moveTo(-w * 0.05, h * 0.36);
  ctx.quadraticCurveTo(w * 0.5, h * 0.48, w * 1.05, h * 0.34);
  ctx.stroke();
  for (let i = 0; i < 13; i++) {
    const t = i / 12, lx = -w * 0.05 + t * w * 1.1;
    const ly = (1 - t) * (1 - t) * h * 0.36 + 2 * (1 - t) * t * h * 0.48 + t * t * h * 0.34;
    const g = ctx.createRadialGradient(lx, ly + w * 0.012, 0, lx, ly + w * 0.012, w * 0.05);
    g.addColorStop(0, 'rgba(255,246,210,1)');
    g.addColorStop(0.2, 'rgba(255,214,140,0.8)');
    g.addColorStop(1, 'rgba(255,180,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(lx - w * 0.05, ly - w * 0.04, w * 0.1, w * 0.1);
  }

  // three friends, backlit
  const people = [
    [[0.22, 0.86, 1.0, '#2a1240'], [0.5, 0.82, 1.12, '#2f1648'], [0.78, 0.87, 0.98, '#26103a']],
    [[0.3, 0.84, 1.08, '#2a1240'], [0.66, 0.85, 1.02, '#2f1648']],
    [[0.5, 0.84, 1.3, '#241046']],
    [[0.26, 0.86, 1.05, '#1a0a30'], [0.72, 0.83, 1.15, '#200c3a']],
    [[0.35, 0.85, 1.1, '#3a1452'], [0.62, 0.86, 1.0, '#33104a'], [0.86, 0.88, 0.9, '#2c0e40']],
    [[0.58, 0.83, 1.2, '#1c1450']],
  ][variant % 6];
  for (const [px, py, s, c] of people) {
    const cx = w * px, base = h * py, u = w * 0.11 * s;
    ctx.fillStyle = c;
    // body
    roundRect(ctx, cx - u * 0.95, base - u * 0.6, u * 1.9, h, u * 0.8);
    ctx.fill();
    // head
    ctx.beginPath();
    ctx.arc(cx, base - u * 1.12, u * 0.58, 0, Math.PI * 2);
    ctx.fill();
    // rim light from the sun
    ctx.strokeStyle = 'rgba(255,200,150,0.7)';
    ctx.lineWidth = w * 0.006;
    ctx.beginPath();
    ctx.arc(cx, base - u * 1.12, u * 0.58, -Math.PI * 0.95, -Math.PI * 0.2);
    ctx.stroke();
    // an arm up with a peace sign
    ctx.fillStyle = c;
    ctx.save();
    ctx.translate(cx + u * 0.8, base - u * 0.4);
    ctx.rotate(-0.35);
    roundRect(ctx, -u * 0.17, -u * 1.7, u * 0.34, u * 1.8, u * 0.17);
    ctx.fill();
    roundRect(ctx, -u * 0.2, -u * 2.25, u * 0.13, u * 0.6, u * 0.07);
    ctx.fill();
    roundRect(ctx, u * 0.04, -u * 2.2, u * 0.13, u * 0.58, u * 0.07);
    ctx.fill();
    ctx.restore();
  }

  // confetti sparkles
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = ['#fff', '#ffe08a', '#ff9ccc', '#b9a2ff'][i % 4];
    ctx.globalAlpha = 0.5 + r() * 0.5;
    const cx = r() * w, cy = r() * h * 0.65, s = w * (0.004 + r() * 0.007);
    ctx.beginPath();
    ctx.arc(cx, cy, s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // a touch of film grain
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 14;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

export { roundRect };
