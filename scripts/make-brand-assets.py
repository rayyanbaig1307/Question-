# Turns the owner's two logo pictures (icon + wordmark, both on a pink→purple gradient) into every file the app
# needs. The eyes/sparkle and the wordmark are lifted off the gradient so they can sit on any background.
# Run from the project folder:  python3 scripts/make-brand-assets.py [preview-folder]   (needs Pillow + numpy)
# Sources: assets/brand/logo-source.webp (the icon) and assets/brand/wordmark-source.webp (the banner).
import os
import sys
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = f'{repo}/assets/brand'
out = sys.argv[1] if len(sys.argv) > 1 else None
NAVY = np.array([30, 20, 55], float)
WHITE = np.array([249, 249, 251], float)

def lift(rgb):
    """RGB uint8 array on a gradient → RGBA float array with the gradient removed (shadow too)."""
    a = rgb.astype(float)
    mx, mn = a.max(2), a.min(2)
    chroma = mx - mn
    core = ((mn > 170) & (chroma < 45)) | ((mx < 110) & (chroma < 60)) | ((chroma < 30) & (mn > 90) & (mn < 200))
    m = Image.fromarray((core * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))          # drop specks
    core = np.asarray(m) > 127
    near = np.asarray(m.filter(ImageFilter.MaxFilter(7))) > 127                      # core + 3px band
    far = np.asarray(m.filter(ImageFilter.MaxFilter(21))) > 127                      # keep bg samples away
    # Local background colour: blur the background-only pixels (normalised convolution).
    keep = (~far).astype(np.float32)
    def box(ch, r):
        # a fast box blur with running sums (3 passes ≈ a gaussian)
        for axis in (0, 1):
            c = np.cumsum(np.pad(ch, [(r + 1, r) if ax == axis else (0, 0) for ax in (0, 1)], mode='edge'), axis=axis)
            ch = (np.take(c, range(2 * r + 1, c.shape[axis]), axis=axis) - np.take(c, range(0, c.shape[axis] - 2 * r - 1), axis=axis)) / (2 * r + 1)
        return ch
    def blur(ch, r):
        x = ch.astype(np.float64)
        for _ in range(3):
            x = box(x, r)
        return x
    # Local background colour, from nearby background pixels; in narrow gaps (between the eyes, inside letters)
    # there are none nearby, so fall back to wider and wider looks around.
    bg = np.zeros(a.shape, float)
    todo = np.ones(a.shape[:2], bool)
    for r in (10, 40, 160):
        w = blur(keep, r)
        est = np.stack([blur(a[..., c] * keep, r) / np.maximum(w, 1e-9) for c in range(3)], 2)
        ok = todo & (w > 0.08)
        bg[ok] = est[ok]
        todo &= ~ok
    bg[todo] = est[todo]
    lum = a.mean(2)
    bglum = bg.mean(2)
    fg = np.where((lum > bglum)[..., None], WHITE, NAVY)
    dist = np.linalg.norm(a - bg, axis=2)
    span = np.linalg.norm(fg - bg, axis=2) + 1e-6
    alpha = np.clip(dist / span, 0, 1)
    band = near & ~core
    rgba = np.zeros(a.shape[:2] + (4,), float)
    rgba[core, :3] = a[core]
    rgba[core, 3] = 1
    rgba[band, :3] = fg[band]
    rgba[band, 3] = alpha[band]
    return rgba, core

def to_img(rgba):
    x = rgba.copy()
    x[..., 3] *= 255
    return Image.fromarray(np.clip(x, 0, 255).astype(np.uint8), 'RGBA')

def bbox(alpha):
    ys, xs = np.where(alpha > 0.02)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

# ---- the icon --------------------------------------------------------------------------------------------
icon = Image.open(f'{src}/logo-source.webp').convert('RGB')
arr = np.asarray(icon)
glyph, core = lift(arr)
eyes = to_img(glyph)
x0, y0, x1, y1 = bbox(glyph[..., 3])
print('glyph bbox', (x0, y0, x1, y1))

# iOS icon: the picture as it is (square, no transparency)
icon.resize((1024, 1024), Image.LANCZOS).save(f'{repo}/assets/images/icon.png')

# Android background: the gradient alone (a smooth fit to the pixels away from the eyes and their shadow)
H, W = arr.shape[:2]
yy, xx = np.mgrid[0:H, 0:W]
u, v = xx / W, yy / H
sample = ~np.asarray(Image.fromarray((core * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(61))) > 0
sample &= ~((xx > 280) & (xx < 1720) & (yy > 1300) & (yy < 1800))   # the soft shadow under the eyes
feats = lambda u, v: np.stack([np.ones_like(u), u, v, u * u, u * v, v * v, u ** 3, v ** 3, u * u * v, u * v * v], -1)
F = feats(u[sample][::7], v[sample][::7])
coef = np.linalg.lstsq(F, arr[sample][::7].astype(float), rcond=None)[0]
print('gradient fit error', np.abs(F @ coef - arr[sample][::7]).mean().round(2))
g = np.mgrid[0:1024, 0:1024]
G = feats(g[1] / 1024, g[0] / 1024) @ coef
Image.fromarray(np.clip(G, 0, 255).astype(np.uint8)).save(f'{repo}/assets/images/android-icon-background.png')

# Android foreground: eyes + sparkle inside the safe circle (the launcher may crop to a circle)
def place(layer, size, k, cx=None, cy=None):
    """Scale the 2000-px layer by k and centre it on a size×size transparent canvas."""
    s = layer.resize((round(2000 * k), round(2000 * k)), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(s, (round(size / 2 - s.width / 2), round(size / 2 - s.height / 2)))
    return canvas
# farthest point of the glyph from the centre must stay inside the 66% safe circle
far = max(np.hypot(x - 1000, y - 1000) for x, y in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)])
k = (1024 * 72 / 108 / 2) * 0.95 / far
print('android glyph scale', round(k, 3))
place(eyes, 1024, k).save(f'{repo}/assets/images/android-icon-foreground.png')

# Android monochrome + notification icon: the light parts (eye whites, highlights, sparkle) in white
light = glyph.copy()
bright = (glyph[..., :3].mean(2) > 150)
light[..., :3] = 255
light[..., 3] = glyph[..., 3] * bright
mono = to_img(light)
place(mono, 1024, k).save(f'{repo}/assets/images/android-icon-monochrome.png')
# notification: fill ~80% of a 96px square
crop = mono.crop((x0, y0, x1, y1))
n = Image.new('RGBA', (96, 96), (0, 0, 0, 0))
scale = 78 / max(crop.size)
c = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.LANCZOS)
n.alpha_composite(c, ((96 - c.width) // 2, (96 - c.height) // 2))
n.save(f'{repo}/assets/images/notification-icon.png')

# ---- the wordmark ----------------------------------------------------------------------------------------
banner = np.asarray(Image.open(f'{src}/wordmark-source.webp').convert('RGB'))[:, 480:]   # skip the little tile on the left
wm, wcore = lift(banner)
bx0, by0, bx1, by1 = bbox(wm[..., 3])
pad = 12
wm = wm[max(0, by0 - pad):by1 + pad, max(0, bx0 - pad):bx1 + pad]
print('wordmark size', wm.shape[1], wm.shape[0])
white_wm = to_img(wm)
# letters only (left of the eyes) in navy, for light backgrounds
dark_cols = np.where((wm[..., 3] > 0.5) & (wm[..., :3].mean(2) < 100))[1]
eyes_start = dark_cols.min() - 6
navy_wm = wm.copy()
letters = (np.arange(wm.shape[1])[None, :] < eyes_start) & (wm[..., 3] > 0)
navy_wm[letters, :3] = NAVY
navy_img = to_img(navy_wm)
for name, img in [('wordmark-white', white_wm), ('wordmark-navy', navy_img)]:
    h = 240
    img.resize((round(img.width * h / img.height), h), Image.LANCZOS).save(f'{repo}/assets/images/{name}.png')
print('wordmark aspect', round(white_wm.width / white_wm.height, 4))

# ---- splash: rounded icon tile + the wordmark under it, on a see-through background -------------------------
tile = icon.resize((600, 600), Image.LANCZOS).convert('RGBA')
mask = Image.new('L', (600, 600), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, 599, 599), radius=135, fill=255)
tile.putalpha(mask)
wmk = white_wm.resize((760, round(760 * white_wm.height / white_wm.width)), Image.LANCZOS)
splash = Image.new('RGBA', (800, 600 + 70 + wmk.height), (0, 0, 0, 0))
splash.alpha_composite(tile, (100, 0))
splash.alpha_composite(wmk, (20, 670))
splash.save(f'{repo}/assets/images/splash-icon.png')
print('splash size', splash.size)

# favicon: the icon with rounded corners
fav = icon.resize((256, 256), Image.LANCZOS).convert('RGBA')
fm = Image.new('L', (256, 256), 0)
ImageDraw.Draw(fm).rounded_rectangle((0, 0, 255, 255), radius=58, fill=255)
fav.putalpha(fm)
fav.save(f'{repo}/assets/images/favicon.png')

# the eyes alone, for the welcome screen
eyes.crop((x0, y0, x1, y1)).resize((600, round(600 * (y1 - y0) / (x1 - x0))), Image.LANCZOS).save(f'{repo}/assets/images/logo-eyes.png')

# a preview sheet to eyeball everything (only when a folder is given)
if not out:
    sys.exit(0)
sheet = Image.new('RGB', (1800, 1150), (11, 11, 16))
d = ImageDraw.Draw(sheet)
sheet.paste(Image.open(f'{repo}/assets/images/icon.png').resize((300, 300)), (40, 40))
bgp = Image.open(f'{repo}/assets/images/android-icon-background.png').resize((300, 300)).convert('RGBA')
bgp.alpha_composite(Image.open(f'{repo}/assets/images/android-icon-foreground.png').resize((300, 300)))
cm = Image.new('L', (300, 300), 0); ImageDraw.Draw(cm).ellipse((50, 50, 250, 250), fill=255)
circ = Image.new('RGB', (300, 300), (11, 11, 16)); circ.paste(bgp.convert('RGB'), mask=cm)
sheet.paste(circ, (380, 40))
mono_p = Image.new('RGB', (300, 300), (60, 60, 80)); mono_p.paste((230, 230, 240), mask=Image.open(f'{repo}/assets/images/android-icon-monochrome.png').resize((300, 300)).split()[3])
sheet.paste(mono_p, (720, 40))
sp = Image.open(f'{repo}/assets/images/splash-icon.png'); sp = sp.resize((300, round(300 * sp.height / sp.width)))
sheet.paste(sp, (1060, 40), sp)
light = Image.new('RGB', (1720, 260), (255, 248, 252))
nv = Image.open(f'{repo}/assets/images/wordmark-navy.png'); nv = nv.resize((round(nv.width * 120 / nv.height), 120)); light.paste(nv, (40, 70), nv)
ey = Image.open(f'{repo}/assets/images/logo-eyes.png'); ey = ey.resize((round(ey.width * 180 / ey.height), 180)); light.paste(ey, (1300, 40), ey)
sheet.paste(light, (40, 400))
ww = Image.open(f'{repo}/assets/images/wordmark-white.png'); ww = ww.resize((round(ww.width * 120 / ww.height), 120)); sheet.paste(ww, (80, 720), ww)
nt = Image.open(f'{repo}/assets/images/notification-icon.png').resize((96, 96)); nb = Image.new('RGB', (96, 96), (80, 80, 90)); nb.paste((255, 255, 255), mask=nt.split()[3]); sheet.paste(nb.resize((192, 192)), (1300, 720))
ey2 = ey.resize((ey.width, ey.height)); sheet.paste(ey2, (1500, 720), ey2)
for text, pos in [('iOS icon', (40, 350)), ('Android (circle launcher)', (380, 350)), ('Android themed icon', (720, 350)), ('Splash (dark bg)', (1060, 350)), ('Light mode wordmark + eyes', (40, 665)), ('Dark mode wordmark', (80, 850)), ('Notification icon', (1300, 920)), ('Welcome screen eyes', (1500, 920))]:
    d.text(pos, text, fill=(200, 200, 210))
sheet.save(f'{out}/preview.png')
