// The daylight ground: white on white, with liquid-glass drops that bend it, peepholes of colour inside them,
// and the caustic light they throw. Coordinates are CSS pixels with the origin at the top left.

export const groundVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

export const groundFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 uView;        // viewport size in CSS px
  uniform float uTime;
  uniform float uScroll;     // smoothed scroll in CSS px
  uniform vec4 uDrops[12];   // x, y, radius, wobble seed
  uniform int uCount;
  uniform sampler2D uWord;   // the word "peekaboo" (red = sharp letters)
  uniform vec4 uWordRect;    // x, y, w, h on the page (CSS px, at scroll 0)
  uniform vec4 uPhone;       // phone shadow box on screen: x, y, w, h (CSS px), w = 0 when hidden
  uniform float uPhoneTilt;
  uniform sampler2D uPosts;  // a wall of friends' posts hidden under the white
  uniform float uPostsScale; // CSS px covered by one copy of the wall

  const vec3 LIGHT = normalize(vec3(-0.55, -0.7, 0.9)); // from the top left, y points down

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return v;
  }

  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  // Signed distance to the merged drops (negative inside).
  float drops(vec2 p) {
    float d = 1e5;
    for (int i = 0; i < 12; i++) {
      if (i >= uCount) break;
      vec4 c = uDrops[i];
      vec2 v = p - c.xy;
      float a = atan(v.y, v.x);
      float wob = sin(a * 3.0 + uTime * 0.9 + c.w) * 0.035 + sin(a * 5.0 - uTime * 1.3 + c.w * 2.0) * 0.018;
      float di = length(v) - c.z * (1.0 + wob);
      d = smin(d, di, max(28.0, c.z * 0.55));
    }
    return d;
  }

  float wordAt(vec2 page, float bias) {
    vec2 uv = (page - uWordRect.xy) / uWordRect.zw;
    if (uv.x < -0.05 || uv.x > 1.05 || uv.y < -0.2 || uv.y > 1.2) return 0.0;
    return texture2D(uWord, vec2(uv.x, 1.0 - uv.y), bias).r;
  }

  // The colour hidden under the white: what you see through a drop.
  vec3 palette(float x) {
    vec3 c0 = vec3(1.00, 0.22, 0.55); // pink
    vec3 c1 = vec3(0.56, 0.28, 1.00); // purple
    vec3 c2 = vec3(0.24, 0.62, 1.00); // blue
    vec3 c3 = vec3(0.98, 0.36, 0.78); // magenta
    vec3 c4 = vec3(1.00, 0.55, 0.30); // warm orange
    x = fract(x) * 5.0;
    if (x < 1.0) return mix(c0, c1, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return mix(c1, c2, smoothstep(1.0, 2.0, x));
    if (x < 3.0) return mix(c2, c3, smoothstep(2.0, 3.0, x));
    if (x < 4.0) return mix(c3, c4, smoothstep(3.0, 4.0, x));
    return mix(c4, c0, smoothstep(4.0, 5.0, x));
  }

  vec3 colorWorld(vec2 p) {
    float m = min(uView.x, uView.y);
    vec2 q = p / m;
    vec2 w = vec2(fbm(q * 1.4 + uTime * 0.04), fbm(q * 1.4 - uTime * 0.035 + 9.0));
    float v = q.x * 0.32 + q.y * 0.22 + w.x * 0.9 + uTime * 0.018 + uScroll / m * 0.08;
    vec3 col = palette(v);
    col = mix(col, palette(v + 0.27), smoothstep(0.35, 0.75, w.y) * 0.55);
    // under the white: everyone's posts, drifting slowly. A drop is a peephole onto them.
    vec2 wall = (p + vec2(uTime * 9.0, uScroll * 0.55 + uTime * 4.0)) / uPostsScale;
    vec3 post = texture2D(uPosts, wall).rgb;
    col = mix(col, post * 1.2 + 0.1, 0.55);
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.25);
    // soft light blooms in the colour
    col += vec3(1.0, 0.95, 0.9) * pow(fbm(q * 2.2 + w * 1.5 + uTime * 0.05), 3.0) * 0.35;
    // the letters glow white-hot where the colour shows through
    vec2 page = p + vec2(0.0, uScroll);
    float wm = wordAt(page, 0.0);
    float glow = wordAt(page, 4.5);
    // the letters show as deep ink with a glossy edge where the colour shows through
    vec3 ink = vec3(0.16, 0.04, 0.32) + col * 0.3;
    col = mix(col, ink, smoothstep(0.35, 0.65, wm) * 0.92);
    col += (glow - wm) * 0.12;
    return col;
  }

  vec3 ground(vec2 p) {
    float m = min(uView.x, uView.y);
    vec2 page = p + vec2(0.0, uScroll);
    // daylight white, a touch warmer at the top and cooler low down
    vec3 col = mix(vec3(0.972, 0.968, 0.958), vec3(0.935, 0.938, 0.952), smoothstep(0.0, 1.0, p.y / uView.y));
    col *= 1.0 - 0.06 * smoothstep(0.55, 1.25, length((p - uView * 0.5) / uView));

    // the giant word: white letters on white ground, lit like a studio product
    float wm = wordAt(page, 0.0);
    if (wm > 0.002 || wordAt(page + vec2(-26.0, -38.0), 3.0) > 0.002) {
      float px = uWordRect.z / 3072.0;
      float gx = wordAt(page + vec2(px * 1.6, 0.0), 0.6) - wordAt(page - vec2(px * 1.6, 0.0), 0.6);
      float gy = wordAt(page + vec2(0.0, px * 1.6), 0.6) - wordAt(page - vec2(0.0, px * 1.6), 0.6);
      float shadow = wordAt(page + vec2(-26.0, -38.0), 4.6);
      float contact = wordAt(page + vec2(-4.0, -6.0), 2.2);
      col *= 1.0 - shadow * 0.075 - contact * 0.06 * (1.0 - wm);
      vec3 letter = vec3(0.995, 0.995, 0.993);
      float rim = clamp(dot(normalize(vec3(-gx, -gy, 0.35)), LIGHT), -1.0, 1.0);
      letter += rim * 0.035;
      letter -= max(-rim, 0.0) * 0.05;
      col = mix(col, letter, smoothstep(0.3, 0.7, wm));
    }
    return col;
  }

  void main() {
    vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uView;
    float m = min(uView.x, uView.y);

    float d = drops(p);
    vec3 col;

    if (d < 1.5) {
      // inside a drop: a clear glass lens. Work out its surface from the distance field.
      float W = clamp(m * 0.07, 34.0, 90.0);
      // the glass surface: a dome that rises steeply at the edge and flattens on top
      float x = clamp(-d / W, 0.0, 1.0);
      float h = sqrt(max(1.0 - (1.0 - x) * (1.0 - x), 0.0));
      // its slope, measured a few pixels apart so the centre of a small drop stays smooth
      float e = 3.0;
      float hx1 = sqrt(max(1.0 - pow(1.0 - clamp(-drops(p + vec2(e, 0.0)) / W, 0.0, 1.0), 2.0), 0.0));
      float hx0 = sqrt(max(1.0 - pow(1.0 - clamp(-drops(p - vec2(e, 0.0)) / W, 0.0, 1.0), 2.0), 0.0));
      float hy1 = sqrt(max(1.0 - pow(1.0 - clamp(-drops(p + vec2(0.0, e)) / W, 0.0, 1.0), 2.0), 0.0));
      float hy0 = sqrt(max(1.0 - pow(1.0 - clamp(-drops(p - vec2(0.0, e)) / W, 0.0, 1.0), 2.0), 0.0));
      vec2 g = -vec2(hx1 - hx0, hy1 - hy0) / (2.0 * e) * W;
      vec3 n = normalize(vec3(g * 0.9, 1.0));

      // refraction with a little colour split, like real glass
      float T = W * 0.75 * (0.25 + h * 0.6);
      vec3 I = vec3(0.0, 0.0, -1.0);
      vec3 rr = refract(I, n, 1.0 / 1.43);
      vec3 rg = refract(I, n, 1.0 / 1.46);
      vec3 rb = refract(I, n, 1.0 / 1.49);
      vec2 base = p;
      vec3 seen;
      seen.r = colorWorld(base + rr.xy / max(-rr.z, 0.2) * T).r;
      seen.g = colorWorld(base + rg.xy / max(-rg.z, 0.2) * T).g;
      seen.b = colorWorld(base + rb.xy / max(-rb.z, 0.2) * T).b;

      float fres = pow(1.0 - n.z, 2.2);
      col = seen;
      // glass edges look dark where light bends away (and pick up the white around them)
      col = mix(col, vec3(0.16, 0.13, 0.22), clamp(fres * 0.75, 0.0, 0.62));
      col = mix(col, ground(p + g * 18.0), smoothstep(0.55, 1.0, fres) * 0.45);
      // inner light: brighter on the far side, where the lens gathers it
      float inner = pow(clamp(dot(-n.xy, -LIGHT.xy) * 0.5 + 0.5, 0.0, 1.0), 3.0) * (1.0 - x);
      col += inner * 0.35;
      // the sharp studio highlights
      vec3 H = normalize(LIGHT * vec3(1.0, 1.0, 1.0) + vec3(0.0, 0.0, 1.0));
      float spec = pow(max(dot(n, normalize(vec3(-LIGHT.xy, LIGHT.z) * vec3(-1.0, -1.0, 1.0) + vec3(0, 0, 1))), 0.0), 140.0);
      spec = pow(max(dot(n, normalize(vec3(-0.42, -0.55, 1.0))), 0.0), 160.0) * 1.6;
      spec += pow(max(dot(n, normalize(vec3(-0.6, -0.75, 0.6))), 0.0), 18.0) * 0.18;
      float back = pow(max(dot(n, normalize(vec3(0.55, 0.7, 0.55))), 0.0), 26.0) * 0.45;
      // a studio softbox reflected in the glass: a soft window shape up and to the left
      vec2 sb = n.xy - vec2(-0.32, -0.42);
      float box = smoothstep(0.2, 0.08, max(abs(sb.x) * 0.9, abs(sb.y) * 1.6)) * smoothstep(0.98, 0.7, n.z);
      col = mix(col, vec3(1.0), box * 0.55);
      // the rim catches the white room around it
      col = mix(col, vec3(0.97, 0.97, 0.99), smoothstep(0.35, 0.9, fres) * 0.35);
      col += spec + back;
      // keep the edge crisp
      col = mix(col, ground(p), smoothstep(-1.2, 1.5, d));
    } else {
      col = ground(p);
    }

    // ---- light the drops throw on the ground (outside the drops)
    if (d > -2.0) {
      vec2 sh = vec2(-0.32, -0.46) * clamp(m * 0.07, 22.0, 60.0);
      float dq = drops(p + sh);
      float W = clamp(m * 0.07, 34.0, 90.0);
      float shadow = smoothstep(W * 0.9, -W * 0.4, dq) * (1.0 - smoothstep(-W * 0.4, -W * 1.2, dq));
      // light bunches up into bright lines inside the shadow; split into colours at the edge
      float shimmer = 0.65 + 0.35 * sin(fbm((p + sh) * 0.018 + uTime * 0.25) * 12.0 + uTime * 0.8);
      float cr = exp(-pow((drops(p + sh * 1.00) + W * 0.30) / (W * 0.16), 2.0));
      float cg = exp(-pow((drops(p + sh * 1.05) + W * 0.30) / (W * 0.16), 2.0));
      float cb = exp(-pow((drops(p + sh * 1.11) + W * 0.30) / (W * 0.16), 2.0));
      float core = smoothstep(0.0, -W * 1.4, dq) * 0.55;
      vec3 tint = mix(vec3(1.0), colorWorld(p + sh * 2.0), 0.45);
      float outside = smoothstep(-1.0, 2.0, d);
      col *= 1.0 - shadow * 0.07 * outside;
      vec3 caustic = vec3(cr, cg, cb) * shimmer * 0.32 + core * shimmer * 0.22;
      col = mix(col, col + caustic * tint, outside);
    }

    // ---- the glass phone's own shadow and light on the ground
    if (uPhone.z > 0.0) {
      vec2 c = uPhone.xy + uPhone.zw * 0.5 + vec2(uPhone.z * 0.16, uPhone.w * 0.07);
      vec2 b = uPhone.zw * vec2(0.42, 0.44);
      vec2 qd = abs(p - c) - b + uPhone.z * 0.22;
      float rd = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - uPhone.z * 0.22;
      float soft = smoothstep(uPhone.z * 0.35, -uPhone.z * 0.2, rd);
      col *= 1.0 - soft * 0.085;
      float band = exp(-pow((rd + uPhone.z * 0.1) / (uPhone.z * 0.05), 2.0));
      col += band * 0.06 * mix(vec3(1.0), colorWorld(p), 0.5);
    }

    // a little grain so the white never bands
    col += (hash(p + fract(uTime)) - 0.5) / 255.0 * 1.5;
    gl_FragColor = vec4(col, 1.0);
  }
`;
