# The Peekaboo+ "Galaxy" app icon (owner's ask, 5 Nov): the real logo eyes on deep space with a glowing Milky
# Way band (pink/purple core, blue-teal edges, a dark dust lane) and stars (tiny ones bunched along the band,
# scattered ones, and seven twinkling stars with sparkle crosses). Same eyes, gold sparkle, size and position as
# the other icons in scripts/make-plus-icons.py (on the Peekaboo+ branch); a soft glow keeps the eyes clear.
#
# Run from the project folder:  python3 scripts/make-galaxy-icon.py   (needs Pillow + numpy)
# Writes design/galaxy-icon/fx-galaxy.png (1024 × 1024, no see-through parts) and fx-galaxy-preview.png (180 × 180).
# Run without a folder, it also writes assets/icons/fx-galaxy.png and assets/icons/preview/fx-galaxy.png.
# App icons live inside the app: a new app build is needed (not an over-the-air update).
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1] if len(sys.argv) > 1 else f'{repo}/design/galaxy-icon'
SIZE = 1024
NAVY = (30, 20, 55)
WHITE = (255, 255, 255)
SCALE = 639 / 527
EYES_X = 195
EYES_Y = 336 - 148 * SCALE
yy, xx = np.mgrid[0:SIZE, 0:SIZE] / (SIZE - 1)


def mix(a, b, t):
    t = np.asarray(t, float)[..., None]
    return np.asarray(a, float) * (1 - t) + np.asarray(b, float) * t


def add(img, colour, amount):
    """Light added on top (like light in the sky), not painted over."""
    return img + np.asarray(colour, float) * np.asarray(amount, float)[..., None]


def noise(seed, octaves=6, base=4, falloff=0.55):
    """Soft cloudy noise 0–1 (several layers of blurred random dots)."""
    rng = np.random.default_rng(seed)
    total = np.zeros((SIZE, SIZE))
    amp, weight = 1.0, 0.0
    for o in range(octaves):
        n = base * 2 ** o
        small = Image.fromarray((rng.random((n, n)) * 255).astype(np.uint8))
        total += np.asarray(small.resize((SIZE, SIZE), Image.BICUBIC), float) / 255 * amp
        weight += amp
        amp *= falloff
    total /= weight
    return np.clip((total - total.min()) / (total.max() - total.min()), 0, 1)


# ---- Background: deep space ------------------------------------------------------------------------------
img = mix((16, 8, 38), (4, 3, 14), (xx * 0.4 + yy * 0.6))

# ---- The Milky Way: a glowing band from bottom-left to top-right, behind the eyes ------------------------
# Distance across the band (0 = its middle), with a gentle curve and wobbly edges.
along = (xx - yy * -1.0)  # runs along the band
ux, uy = 0.78, -0.62      # band direction (bottom-left → top-right)
nx, ny = -uy, ux          # across the band
cx, cy = 0.5, 0.52
t_along = (xx - cx) * ux + (yy - cy) * uy
across = (xx - cx) * nx + (yy - cy) * ny + 0.08 * t_along ** 2  # slight bow
clouds = noise(3)
fine = noise(9, octaves=7, base=8, falloff=0.6)
width = 0.13 + 0.05 * (clouds - 0.5)
core = np.exp(-(across ** 2) / (2 * (width * 0.45) ** 2))
halo = np.exp(-(across ** 2) / (2 * width ** 2))
wide = np.exp(-(across ** 2) / (2 * (width * 2.2) ** 2))
fade_ends = np.clip(1.15 - np.abs(t_along) * 0.9, 0, 1)  # dimmer towards the corners

texture = 0.45 + 0.75 * clouds * (0.6 + 0.4 * fine)
img = add(img, (70, 30, 120), wide * 0.55 * fade_ends)                       # violet haze
img = add(img, (190, 60, 170), halo * texture * 0.55 * fade_ends)            # magenta clouds
img = add(img, (60, 120, 230), halo * (1 - clouds) * 0.35 * fade_ends)       # blue clouds
img = add(img, (255, 205, 235), core * texture ** 1.6 * 0.75 * fade_ends)    # bright warm core
edge_clouds = noise(31, octaves=5, base=5)
img = add(img, (40, 175, 230), np.clip(halo - core, 0, 1) * edge_clouds * 0.32 * fade_ends)  # blue-teal edges
# Dust lane: a darker wobbly stripe running along the middle of the band.
lane_pos = across - 0.015 - 0.03 * (noise(21, octaves=4, base=3) - 0.5)
lane = np.exp(-(lane_pos ** 2) / (2 * 0.02 ** 2)) * (0.3 + 0.7 * noise(22, octaves=6, base=6) * (0.6 + 0.4 * fine))
img = img * (1 - 0.72 * lane[..., None] * fade_ends[..., None])
# A couple of soft nebula glows for colour.
for x, y, r, c, s in ((0.18, 0.82, 0.16, (230, 70, 160), 0.35), (0.84, 0.2, 0.14, (90, 150, 255), 0.3),
                      (0.62, 0.38, 0.10, (255, 120, 200), 0.18)):
    img = add(img, c, np.exp(-(((xx - x) ** 2 + (yy - y) ** 2) / (2 * r ** 2))) * s)

# ---- Stars ---------------------------------------------------------------------------------------------
rng = np.random.default_rng(7)
band_strength = np.clip(halo * fade_ends, 0, 1)


def draw_stars(count, size, alpha, colour, in_band, seed, soft=0.0):
    r = np.random.default_rng(seed)
    big = Image.new('L', (SIZE * 3, SIZE * 3), 0)
    d = ImageDraw.Draw(big)
    placed = 0
    while placed < count:
        x, y = r.uniform(0, 1, 2)
        p = band_strength[int(y * (SIZE - 1)), int(x * (SIZE - 1))]
        if in_band and r.random() > p ** 0.7:
            continue
        rad = r.uniform(*size) * 3 / 2
        a = int(255 * r.uniform(*alpha))
        X, Y = x * SIZE * 3, y * SIZE * 3
        d.ellipse((X - rad, Y - rad, X + rad, Y + rad), fill=a)
        placed += 1
    mask = np.asarray(big.resize((SIZE, SIZE), Image.LANCZOS), float) / 255
    if soft:
        mask = np.clip(mask + np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(soft)), float) / 255 * 1.6, 0, 1)
    return mix(img, colour, mask)


img = draw_stars(700, (0.5, 1.1), (0.25, 0.8), (255, 255, 255), False, 11)        # far stars everywhere
img = draw_stars(1600, (0.5, 1.2), (0.3, 0.95), (255, 240, 250), True, 12)       # dense stars in the band
img = draw_stars(120, (1.2, 2.2), (0.6, 1.0), (235, 240, 255), False, 13, soft=3)  # brighter stars

# Twinkling stars with four sparkle lines (kept away from the eyes in the middle).
twinkles = [(0.11, 0.14, 1.0, (255, 255, 255)), (0.88, 0.62, 0.85, (200, 225, 255)), (0.20, 0.62, 0.7, (255, 225, 245)),
            (0.58, 0.90, 0.8, (255, 255, 255)), (0.93, 0.92, 0.6, (255, 236, 200)), (0.40, 0.10, 0.65, (210, 230, 255)),
            (0.07, 0.42, 0.55, (255, 255, 255))]
for x, y, s, c in twinkles:
    dx, dy = (xx - x) * SIZE, (yy - y) * SIZE
    length = 15 * s
    spike = (np.exp(-(dy ** 2) / (2 * 1.6 ** 2)) * np.exp(-(dx ** 2) / (2 * length ** 2)) +
             np.exp(-(dx ** 2) / (2 * 1.6 ** 2)) * np.exp(-(dy ** 2) / (2 * length ** 2)))
    glow_dot = np.exp(-(dx ** 2 + dy ** 2) / (2 * (6 * s) ** 2))
    halo_dot = np.exp(-(dx ** 2 + dy ** 2) / (2 * (16 * s) ** 2)) * 0.35
    img = mix(img, c, np.clip(spike * 0.95 + glow_dot + halo_dot, 0, 1))

img = np.clip(img, 0, 255)

# ---- The eyes (same recolouring and placement as make-plus-icons.py) -------------------------------------
eyes_src = Image.open(f'{repo}/assets/images/logo-eyes.png').convert('RGBA')
E = np.asarray(eyes_src, float)
alpha = E[..., 3] / 255
rgb = E[..., :3]
lum = rgb.mean(2)
dark = np.clip((249 - lum) / (249 - float(np.mean(NAVY))), 0, 1)
solid_dark = Image.fromarray((((alpha > 0.5) & (dark > 0.5)) * 255).astype(np.uint8))
filled = solid_dark.copy()
ImageDraw.floodfill(filled, (8, 320), 128)
outline_core = np.asarray(filled) == 128
pupil_core = (np.asarray(solid_dark) == 255) & ~outline_core


def grow(mask, px):
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(px * 2 + 1))) > 127


outline_area = grow(outline_core, 3)
pupil_area = grow(pupil_core, 3) & ~outline_area
H, W = alpha.shape
sparkle_area = (np.arange(H)[:, None] < 140) & (np.arange(W)[None, :] > 380) & (alpha > 0)
outline_area &= ~sparkle_area
pupil_area &= ~sparkle_area
eyes_only_alpha = alpha * ~sparkle_area


def recolour(outline=NAVY, pupils=NAVY, sparkle=WHITE):
    o = rgb.copy()
    t = dark[..., None]
    for area, colour in ((outline_area, outline), (pupil_area, pupils)):
        shift = (np.asarray(colour, float) - np.asarray(NAVY, float)) * t
        o[area] = (rgb + shift)[area]
    o[sparkle_area] = np.asarray(sparkle, float)
    return np.dstack([np.clip(o, 0, 255), alpha])


def place(layer_rgba):
    im = Image.fromarray(np.dstack([layer_rgba[..., :3], layer_rgba[..., 3:] * 255]).astype(np.uint8), 'RGBA')
    w, h = round(im.width * SCALE), round(im.height * SCALE)
    im = im.resize((w, h), Image.LANCZOS)
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(im, (EYES_X, round(EYES_Y)))
    return np.asarray(canvas, float)


def place_mask(mask):
    return place(np.dstack([np.zeros(mask.shape + (3,)), mask]))[..., 3] / 255


def blur(mask, radius):
    return np.asarray(Image.fromarray(np.clip(mask * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)), float) / 255


EYES_MASK = place_mask(eyes_only_alpha)
SPARKLE_MASK = place_mask(alpha * sparkle_area)
GOLD_SPARKLE = (255, 225, 77)

# A soft dark backing and a pale starlight glow round the eyes, so they stand out from the busy sky.
img = mix(img, (6, 3, 18), np.clip(blur(EYES_MASK, 26) * 0.75, 0, 1))
img = mix(img, (190, 160, 255), np.clip(blur(EYES_MASK, 40) * 0.38 - EYES_MASK, 0, 1))
img = mix(img, GOLD_SPARKLE, np.clip(blur(SPARKLE_MASK, 18) * 0.7, 0, 1))
layer = place(recolour(sparkle=GOLD_SPARKLE))
a = layer[..., 3:] / 255
img = img * (1 - a) + layer[..., :3] * a

icon = Image.fromarray(np.clip(img + 0.5, 0, 255).astype(np.uint8), 'RGB')
os.makedirs(out, exist_ok=True)
icon.save(f'{out}/fx-galaxy.png', optimize=True)
icon.resize((180, 180), Image.LANCZOS).save(f'{out}/fx-galaxy-preview.png', optimize=True)
# Without a folder given, also update the app's own icon files (assets/icons/…).
if len(sys.argv) <= 1:
    icon.save(f'{repo}/assets/icons/fx-galaxy.png', optimize=True)
    icon.resize((180, 180), Image.LANCZOS).save(f'{repo}/assets/icons/preview/fx-galaxy.png', optimize=True)
print('saved', f'{out}/fx-galaxy.png')
