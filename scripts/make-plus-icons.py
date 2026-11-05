# Makes the Peekaboo+ app icons: the real logo (the eyes + sparkle from assets/images/logo-eyes.png) in new
# colours, on new backgrounds. The looks match the drafts in docs/plus-icons/.
#
# Run from the project folder:  python3 scripts/make-plus-icons.py [preview-folder]   (needs Pillow + numpy)
#
# Writes:
#   assets/icons/<name>.png          1024 × 1024, no see-through parts – what the iPhone uses for the icon
#   assets/icons/preview/<name>.png  180 × 180 – the small pictures in the app's "App icon" screen
# "classic" is the normal app icon (assets/images/icon.png), copied as it is.
# With a preview folder, it also saves preview.png there: every icon side by side with its draft.
#
# After changing the icons, a new app build is needed (the icons live inside the app, not in an update).
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = f'{repo}/assets/icons'
preview_dir = f'{out_dir}/preview'
SIZE = 1024
PREVIEW = 180

NAVY = (30, 20, 55)
WHITE = (255, 255, 255)
PINK = (255, 61, 142)

# Where the eyes sit (same as the normal icon): the double eye outline is 639 px wide on the 1024 px icon.
# In logo-eyes.png that outline is 527 px wide and starts 148 px from the top (the sparkle is above it).
SCALE = 639 / 527
EYES_X = 195
EYES_Y = 336 - 148 * SCALE

# ---------------------------------------------------------------------------------------------------------
# Backgrounds. Every function returns a SIZE × SIZE × 3 float picture (0–255).
# ---------------------------------------------------------------------------------------------------------

yy, xx = np.mgrid[0:SIZE, 0:SIZE] / (SIZE - 1)


def mix(a, b, t):
    t = np.asarray(t, float)[..., None]
    return np.asarray(a, float) * (1 - t) + np.asarray(b, float) * t


def stops(points, t):
    """A colour fade through several colours. points = [(where 0–1, colour), …]."""
    t = np.clip(t, points[0][0], points[-1][0])
    out = np.zeros(t.shape + (3,))
    for (p0, c0), (p1, c1) in zip(points, points[1:]):
        inside = (t >= p0) & (t <= p1)
        f = (t[inside] - p0) / max(p1 - p0, 1e-9)
        out[inside] = mix(c0, c1, f)
    return out


def diagonal(top_left, bottom_right):
    """Top-left colour fading to bottom-right colour."""
    return mix(top_left, bottom_right, (xx + yy) / 2)


def glow(img, x, y, radius, colour, strength):
    """Adds a soft round light (or shade) at x, y (0–1)."""
    w = np.exp(-(((xx - x) ** 2 + (yy - y) ** 2) / (2 * radius ** 2))) * strength
    return mix(img, np.broadcast_to(np.asarray(colour, float), img.shape), w)


def specks(img, count, seed, colour, size=(1, 3), alpha=(0.4, 1.0), soft=0.0):
    """Little dots (stars, glitter). Drawn on a 3× bigger picture, then shrunk, so they are smooth."""
    rng = np.random.default_rng(seed)
    big = Image.new('L', (SIZE * 3, SIZE * 3), 0)
    d = ImageDraw.Draw(big)
    for _ in range(count):
        x, y = rng.uniform(0, SIZE * 3, 2)
        r = rng.uniform(*size) * 1.5
        a = int(255 * rng.uniform(*alpha))
        d.ellipse((x - r, y - r, x + r, y + r), fill=a)
    mask = big.resize((SIZE, SIZE), Image.LANCZOS)
    if soft:
        mask = Image.fromarray(np.clip(np.asarray(mask, float) + np.asarray(mask.filter(ImageFilter.GaussianBlur(soft)), float) * 1.5, 0, 255).astype(np.uint8))
    return mix(img, np.broadcast_to(np.asarray(colour, float), img.shape), np.asarray(mask, float) / 255)


def bg_dark_gold():
    img = diagonal((39, 28, 11), (11, 7, 4))
    return glow(img, 0.33, 0.05, 0.22, (60, 43, 16), 0.5)


def bg_midnight():
    return diagonal((62, 189, 253), (26, 37, 113))


def bg_mint():
    return diagonal((97, 235, 181), (11, 111, 90))


def bg_sunny():
    return diagonal((255, 226, 89), (255, 112, 26))


def bg_clean_white():
    return diagonal((254, 254, 254), (241, 235, 247))


def bg_all_black():
    img = diagonal((30, 24, 38), (8, 6, 12))
    return glow(img, 0.33, 0.05, 0.22, (44, 35, 54), 0.5)


def bg_cherry():
    return diagonal((254, 99, 119), (168, 14, 70))


def bg_sunset():
    # Peach at the top, pink in the middle, purple in the bottom-right corner.
    t = 0.75 * yy + 0.25 * xx
    return stops([(0, (255, 208, 109)), (0.33, (255, 135, 92)), (0.62, (255, 63, 140)), (1, (142, 76, 251))], t)


def bg_aurora():
    # Dark night sky with soft northern-lights colours.
    img = mix((30, 30, 80), (22, 22, 62), yy)
    img = glow(img, 0.10, 0.25, 0.20, (48, 175, 128), 0.95)
    img = glow(img, 0.82, 0.12, 0.22, (32, 100, 160), 0.85)
    img = glow(img, 0.50, 0.95, 0.24, (138, 84, 228), 0.95)
    img = glow(img, 1.00, 0.92, 0.16, (205, 62, 130), 0.75)
    img = glow(img, 0.00, 1.00, 0.18, (20, 20, 58), 0.8)
    return img


def bg_holo():
    # Pastel rainbow going round the middle (twice), like a holographic sticker, plus a glossy shine.
    angle = np.arctan2(yy - 0.5, xx - 0.5)  # -pi..pi, 0 = right, pi/2 = down
    t = ((angle - np.pi / 4) / np.pi) % 1.0  # 0 at bottom-right and top-left, two rounds
    colours = [(0, (200, 203, 255)), (0.2, (170, 242, 236)), (0.3, (194, 254, 220)), (0.5, (240, 246, 176)),
               (0.62, (255, 214, 193)), (0.75, (254, 183, 224)), (0.88, (205, 170, 248)), (1, (200, 203, 255))]
    img = stops(colours, t)
    # The shine: a soft white band across the top-left.
    band = np.exp(-(((xx + yy) - 0.55) ** 2) / (2 * 0.12 ** 2)) * 0.35
    return mix(img, (255, 255, 255), band)


def bg_neon():
    img = np.broadcast_to(np.asarray((11, 6, 19), float), (SIZE, SIZE, 3)).copy()
    return glow(img, 0.5, 0.55, 0.38, (34, 14, 50), 1.0)


def bg_ocean():
    pts = [(0, (126, 239, 255)), (0.3, (62, 187, 255)), (0.4, (53, 160, 247)), (0.6, (45, 95, 223)),
           (0.7, (41, 69, 203)), (0.8, (36, 52, 167)), (0.9, (31, 34, 131)), (1, (26, 20, 100))]
    return stops(pts, yy)


def bg_glitter_gold():
    # Shiny gold: light, dark and light again across the picture, with sparkly flecks.
    s = xx + yy
    img = stops([(0, (254, 236, 187)), (0.5, (244, 209, 139)), (0.8, (227, 167, 66)), (1.25, (186, 122, 32)),
                 (1.6, (210, 160, 70)), (2, (243, 206, 118))], s)
    img = specks(img, 2600, 7, (255, 246, 214), size=(0.8, 2.2), alpha=(0.25, 0.9))
    img = specks(img, 900, 8, (150, 95, 20), size=(0.8, 1.8), alpha=(0.15, 0.5))
    return img


def bg_candy():
    # Pink at the top to purple at the bottom, with light diagonal stripes.
    base = mix((222, 125, 181), (174, 109, 222), yy)
    stripe = (((xx + yy) * (SIZE - 1) / 133) % 1.0) < 0.45
    # Soft stripe edges: blur the stripe mask a little.
    m = Image.fromarray((stripe * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    lift = np.asarray(m, float)[..., None] / 255
    return base * (1 + 0.13 * lift)


def bg_galaxy():
    img = mix((14, 7, 32), (7, 4, 15), (xx + yy) / 2)
    img = glow(img, 0.35, 0.28, 0.28, (68, 34, 146), 0.95)
    img = glow(img, 0.70, 0.75, 0.22, (40, 16, 88), 0.6)
    img = specks(img, 420, 11, (255, 255, 255), size=(0.6, 1.6), alpha=(0.3, 0.95))
    img = specks(img, 40, 12, (255, 244, 220), size=(1.6, 2.6), alpha=(0.7, 1.0), soft=4)
    return img


# ---------------------------------------------------------------------------------------------------------
# The eyes: recolour the outline, the pupils and the sparkle of logo-eyes.png.
# ---------------------------------------------------------------------------------------------------------

eyes_src = Image.open(f'{repo}/assets/images/logo-eyes.png').convert('RGBA')
E = np.asarray(eyes_src, float)
alpha = E[..., 3] / 255
rgb = E[..., :3]
lum = rgb.mean(2)

# How dark each pixel is: 0 = eye white, 1 = navy. Mixed colours at the edges get values in between.
WHITE_LUM = 249
NAVY_LUM = float(np.mean(NAVY))
dark = np.clip((WHITE_LUM - lum) / (WHITE_LUM - NAVY_LUM), 0, 1)

solid_dark = Image.fromarray((((alpha > 0.5) & (dark > 0.5)) * 255).astype(np.uint8))
# The outline is the dark shape that goes round the outside; the pupils are the two dark shapes inside it.
outline_seed = (8, 320)
filled = solid_dark.copy()
ImageDraw.floodfill(filled, outline_seed, 128)
outline_core = np.asarray(filled) == 128
pupil_core = (np.asarray(solid_dark) == 255) & ~outline_core


def grow(mask, px):
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(px * 2 + 1))) > 127


outline_area = grow(outline_core, 3)
pupil_area = grow(pupil_core, 3) & ~outline_area
# The sparkle: the three little lines above the eyes.
H, W = alpha.shape
sparkle_area = (np.arange(H)[:, None] < 140) & (np.arange(W)[None, :] > 380) & (alpha > 0)
outline_area &= ~sparkle_area
pupil_area &= ~sparkle_area
# Everything except the sparkle (for the shadow and the neon glow).
eyes_only_alpha = alpha * ~sparkle_area


def recolour(outline=NAVY, pupils=NAVY, sparkle=WHITE):
    """The eyes as an RGBA float picture (0–1 alpha) with new colours."""
    out = rgb.copy()
    t = dark[..., None]
    for area, colour in ((outline_area, outline), (pupil_area, pupils)):
        shift = (np.asarray(colour, float) - np.asarray(NAVY, float)) * t
        out[area] = (rgb + shift)[area]
    out[sparkle_area] = np.asarray(sparkle, float)
    return np.dstack([np.clip(out, 0, 255), alpha])


def place(layer_rgba):
    """Scale the eyes layer and put it where the eyes sit on a SIZE × SIZE see-through picture."""
    img = Image.fromarray(np.dstack([layer_rgba[..., :3], layer_rgba[..., 3:] * 255]).astype(np.uint8), 'RGBA')
    w, h = round(img.width * SCALE), round(img.height * SCALE)
    img = img.resize((w, h), Image.LANCZOS)
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(img, (EYES_X, round(EYES_Y)))
    return np.asarray(canvas, float)


def place_mask(mask):
    m = np.dstack([np.zeros(mask.shape + (3,)), mask])
    return place(m)[..., 3] / 255


EYES_MASK = place_mask(eyes_only_alpha)
OUTLINE_MASK = place_mask(alpha * outline_area)
SPARKLE_MASK = place_mask(alpha * sparkle_area)


def blur(mask, radius):
    return np.asarray(Image.fromarray(np.clip(mask * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)), float) / 255


def shift_down(mask, px):
    out = np.zeros_like(mask)
    out[px:] = mask[:-px]
    return out


def drop_shadow(img, strength=0.3, colour=(20, 8, 40)):
    """A soft shadow under the eyes, like on the normal icon."""
    s = blur(shift_down(EYES_MASK, 26), 22) * strength
    return mix(img, colour, s)


def neon_glow(img, outline_colour, sparkle_colour):
    """A glow round the outline and the sparkle, like a neon sign."""
    for radius, power in ((40, 0.55), (16, 0.6), (6, 0.5)):
        img = mix(img, outline_colour, np.clip(blur(OUTLINE_MASK, radius) * power * 1.6, 0, 1))
        img = mix(img, sparkle_colour, np.clip(blur(SPARKLE_MASK, radius) * power * 1.4, 0, 1))
    return img


def compose(background, outline=NAVY, pupils=NAVY, sparkle=WHITE, shadow=0.3, shadow_colour=(20, 8, 40), neon=None):
    img = background
    if shadow:
        img = drop_shadow(img, shadow, shadow_colour)
    if neon:
        img = neon_glow(img, *neon)
    layer = place(recolour(outline, pupils, sparkle))
    a = layer[..., 3:] / 255
    img = img * (1 - a) + layer[..., :3] * a
    return Image.fromarray(np.clip(img + 0.5, 0, 255).astype(np.uint8), 'RGB')


GOLD = (232, 169, 58)
ICONS = {
    'dark-gold': lambda: compose(bg_dark_gold(), outline=GOLD, pupils=(27, 18, 5), sparkle=(242, 193, 78), shadow=0),
    'midnight': lambda: compose(bg_midnight(), shadow_colour=(10, 15, 60)),
    'mint': lambda: compose(bg_mint(), shadow_colour=(5, 50, 40)),
    'sunny': lambda: compose(bg_sunny(), shadow=0.25, shadow_colour=(130, 50, 10)),
    'clean-white': lambda: compose(bg_clean_white(), sparkle=PINK, shadow=0.16, shadow_colour=(60, 40, 90)),
    'all-black': lambda: compose(bg_all_black(), outline=PINK, sparkle=PINK, shadow=0),
    'cherry': lambda: compose(bg_cherry(), shadow_colour=(70, 0, 30)),
    'fx-sunset': lambda: compose(bg_sunset(), shadow=0.25, shadow_colour=(110, 20, 70)),
    'fx-aurora': lambda: compose(bg_aurora(), shadow_colour=(5, 5, 25)),
    'fx-holo': lambda: compose(bg_holo(), shadow=0.18, shadow_colour=(80, 70, 130)),
    'fx-neon': lambda: compose(bg_neon(), outline=PINK, sparkle=(56, 182, 255), shadow=0, neon=(PINK, (56, 182, 255))),
    'fx-ocean': lambda: compose(bg_ocean(), shadow_colour=(10, 10, 60)),
    'fx-glitter-gold': lambda: compose(bg_glitter_gold(), outline=(42, 26, 6), pupils=(42, 26, 6), shadow=0.25, shadow_colour=(90, 50, 5)),
    'fx-candy': lambda: compose(bg_candy(), shadow=0.25, shadow_colour=(80, 30, 110)),
    # 'fx-galaxy' (Milky Way + stars) is made by scripts/make-galaxy-icon.py, so this script leaves it alone.
}

os.makedirs(preview_dir, exist_ok=True)
made = {'classic': Image.open(f'{repo}/assets/images/icon.png').convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)}
for name, make in ICONS.items():
    made[name] = make()
for name, img in made.items():
    assert img.size == (SIZE, SIZE) and img.mode == 'RGB'
    img.save(f'{out_dir}/{name}.png', optimize=True)
    img.resize((PREVIEW, PREVIEW), Image.LANCZOS).save(f'{preview_dir}/{name}.png', optimize=True)
    print('made', name)

# A side-by-side sheet: our icon (left) and the draft (right), to check the look.
if len(sys.argv) > 1:
    names = list(made)
    cell = 300
    sheet = Image.new('RGB', (cell * 2 * 4 + 30, cell * ((len(names) + 3) // 4) + 10 * len(names)), (128, 128, 128))
    for i, name in enumerate(names):
        x = (i % 4) * (cell * 2 + 10)
        y = (i // 4) * (cell + 10)
        sheet.paste(made[name].resize((cell, cell), Image.LANCZOS), (x, y))
        draft = f'{repo}/docs/plus-icons/{name}.png'
        if os.path.exists(draft):
            sheet.paste(Image.open(draft).convert('RGB').resize((cell, cell)), (x + cell, y))
    sheet.save(f'{sys.argv[1]}/preview.png')
    print('preview sheet saved')
