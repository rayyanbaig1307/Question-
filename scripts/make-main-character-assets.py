# Main Character Mode 🌆: turns the owner's character and scene pictures into the art the app uses
# (docs/MAIN_CHARACTER.md, docs/FACE_MESH.md "Main Character Mode").
#
# Run from the project folder (needs Pillow + numpy; cutting a face hole also needs mediapipe):
#
#   python3 scripts/make-main-character-assets.py bundle <art-folder>
#     The art that comes inside the iPhone app. <art-folder> holds
#       characters/<name>.png   – a character with its painted face, see-through round it (1520 × 2688 or any 9:16-ish)
#       backgrounds/<name>.png  – a scene
#     for every name in CHARACTERS and SCENES below. Writes assets/main-character/characters/<name>.webp,
#     assets/main-character/backgrounds/<name>.webp, src/lib/mainCharacter/art.generated.ios.ts (the list the
#     iPhone app uses) and src/lib/mainCharacter/art.generated.ts (the empty list Android and web get), and prints
#     the HOLE numbers for src/lib/mainCharacter/config.ts.
#
#   python3 scripts/make-main-character-assets.py online <picture> <out-folder> [--scene]
#     One new picture for the online library. Writes <name>.webp (1080 × 1920, at most 1.5 MB) and, for a
#     character, <name>.json (where the face goes). The owner uploads both into Supabase → Storage →
#     main-character → characters/ (or backgrounds/ with --scene). The file name becomes the name people see.
#     A character with a painted face gets its hole cut here; one that already has a see-through face hole is
#     measured the way the app would (the Python copy of src/lib/mainCharacter/holeFinder.ts below).
#
# The face points come from the app's own face model (modules/face-mesh/assets/face_landmarker.task).
# Every picture is written from fresh pixels with nothing else in the file, so no file data from the sources
# (the art tool's job id, colour profiles, camera data) gets into the app or the bucket.
# tests/unit/main-character-assets.test.mjs checks the bundled files.
import json
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = f'{repo}/modules/face-mesh/assets/face_landmarker.task'
ASSETS = f'{repo}/assets/main-character'
LIB = f'{repo}/src/lib/mainCharacter'
CONFIG = f'{LIB}/config.ts'

POSTER_W, POSTER_H = 1080, 1920      # every picture is made exactly this size (the poster)
SMALL_W, SMALL_H = 270, 480          # the app looks for a face hole in a copy this small (analyseArt.ts)

# The art that comes inside the app, in the order people meet it. Each character starts on its own scene.
CHARACTERS = [
    ('street-boss', 'neon-street'),
    ('getaway-driver', 'coast-highway'),
    ('beach-hustler', 'beach-drive'),
    ('night-rider', 'rooftop'),
    ('rich-mogul', 'marina'),
    ('mall-cop', 'mall-plaza'),
]
SCENES = ['beach-drive', 'neon-street', 'marina', 'rooftop', 'coast-highway', 'mall-plaza']

# MediaPipe's face outline, in order round the face: from the top of the forehead (10) to the picture's right,
# down to the chin (152), up the picture's left side and back. That is clockwise on screen.
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
        149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
CHEEKS = [50, 280, 205, 425]         # the painted skin colour is read round these 4 cheek points
EYE_A = (33, 133)                    # the corners of one eye – its middle is where the app lines your eye up
EYE_B = (263, 362)                   # the corners of the other eye
NOSE, CHIN, FOREHEAD = 1, 152, 10
FACE_SIDES = (234, 454)              # face width = the distance between these two

# The same numbers as holeFinder.ts.
SEE_THROUGH = 128
RAYS = 36
RAY_STEP = 0.25
SOLID = 250
RING = 1.25
MIN_SKIN = 200
SKIN_CR = (135, 215)     # wider than the usual photo range: painted sunset light makes skin much redder
SKIN_CB = (70, 135)
NO_TONE = [200, 150, 120]
WEBP_CHUNKS = {b'VP8 ', b'VP8L', b'VP8X', b'ALPH'}   # picture data only – nothing else may be in a file


def fail(message):
    print(f'❌ {message}')
    sys.exit(1)


def name_from_slug(slug):
    """'street-boss' → 'Street Boss' (the same rule as nameFromSlug in holeFinder.ts)."""
    return ' '.join(word[0].upper() + word[1:] for word in slug.split('-') if word)


def slug_from_file(file):
    """'Street Boss.PNG' → 'street-boss' (the same rule as slugFromFile in holeFinder.ts). None if unusable."""
    name = file.replace('\\', '/').split('/')[-1]
    dot = name.rfind('.')
    if dot <= 0 or name[dot + 1:].lower() not in ('webp', 'png', 'jpg', 'jpeg', 'json'):
        return None
    slug = name[:dot].lower()
    slug = re.sub(r'[\s_]+', '-', slug)
    slug = re.sub(r'[^a-z0-9-]', '', slug)
    slug = re.sub(r'-+', '-', slug).strip('-')
    return slug if 1 <= len(slug) <= 40 else None


def config_numbers(name):
    """Reads one `export const NAME = { a: 1, b: 2 }` group of numbers from config.ts, so both sides use the same."""
    text = open(CONFIG, encoding='utf8').read()
    found = re.search(r'export const ' + name + r' = \{([^}]*)\}', text)
    if not found:
        fail(f'{name} is missing from {CONFIG}')
    return {key: float(value) for key, value in re.findall(r'(\w+):\s*(-?[\d.]+)', found.group(1))}


def config_number(name):
    found = re.search(r'export const ' + name + r' = ([\d_]+);', open(CONFIG, encoding='utf8').read())
    if not found:
        fail(f'{name} is missing from {CONFIG}')
    return int(found.group(1).replace('_', ''))


def round_half_up(value):
    """Math.round for the positive numbers used here (Python's round() would go to the even number on .5)."""
    return int(np.floor(value + 0.5))


def median(values):
    """The middle value; for an even count the two middle ones averaged and rounded (as holeFinder.ts)."""
    ordered = np.sort(np.asarray(values, dtype=np.int64))
    half = len(ordered) // 2
    return int(ordered[half]) if len(ordered) % 2 == 1 else round_half_up((ordered[half - 1] + ordered[half]) / 2)


def looks_like_skin(r, g, b):
    """Warm (more red than green, more green than blue) and in the YCbCr skin range, not too dark (as holeFinder.ts)."""
    r, g, b = (np.asarray(v, dtype=np.float64) for v in (r, g, b))
    light = 0.299 * r + 0.587 * g + 0.114 * b
    blue = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    red = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return ((r > g) & (g > b) & (red >= SKIN_CR[0]) & (red <= SKIN_CR[1]) & (blue >= SKIN_CB[0]) & (blue <= SKIN_CB[1])
            & (light > 40))


# ---------------------------------------------------------------------------------------------------------------
# Pictures in and out
# ---------------------------------------------------------------------------------------------------------------

def cover_crop(w, h, aspect=POSTER_W / POSTER_H):
    """The biggest centred part of a w × h picture with the poster's shape (x, y, width, height)."""
    if w / h > aspect:
        cw = h * aspect
        return (w - cw) / 2, 0.0, cw, float(h)
    ch = w / aspect
    return 0.0, (h - ch) / 2, float(w), ch


def to_poster(im):
    """Centre crop to 9:16 and resize to 1080 × 1920."""
    x, y, cw, ch = cover_crop(*im.size)
    return im.resize((POSTER_W, POSTER_H), Image.LANCZOS, box=(x, y, x + cw, y + ch))


def small_copy(poster):
    """The 270 × 480 copy the app looks for the hole in (pixels as numbers, not premultiplied)."""
    return np.array(poster.convert('RGBA').resize((SMALL_W, SMALL_H), Image.BOX))


def fresh(im):
    """A new picture with only the pixels: no text, profiles or camera data come along from the source file."""
    return Image.frombytes(im.mode, im.size, im.tobytes())


def webp_chunks(path):
    """The chunk names and the VP8X flags of a WebP file (raises if it isn't a clean, whole WebP file)."""
    data = open(path, 'rb').read()
    if data[:4] != b'RIFF' or data[8:12] != b'WEBP' or int.from_bytes(data[4:8], 'little') + 8 != len(data):
        raise ValueError(f'{path} is not a whole WebP file')
    names, flags, at = [], 0, 12
    while at < len(data):
        name, size = data[at:at + 4], int.from_bytes(data[at + 4:at + 8], 'little')
        if name == b'VP8X':
            flags = data[at + 8]
        names.append(name)
        at += 8 + size + (size & 1)
    if at != len(data):
        raise ValueError(f'{path} has broken chunks')
    return names, flags


def save_webp(im, path, max_bytes):
    """WebP quality 80 (lower only if it must, to stay under max_bytes); characters keep a perfect see-through edge."""
    im = fresh(im)
    for quality in (80, 75, 70, 65, 60, 55, 50):
        options = {'quality': quality, 'method': 6}
        if im.mode == 'RGBA':
            options['alpha_quality'] = 100
        im.save(path, 'WEBP', **options)
        if os.path.getsize(path) <= max_bytes:
            break
    else:
        fail(f'{path} is still over {max_bytes} bytes')
    names, flags = webp_chunks(path)
    if not set(names) <= WEBP_CHUNKS or flags & 0x2E:   # 0x20 colour profile, 0x08 EXIF, 0x04 XMP, 0x02 animation
        fail(f'{path} has more than picture data in it: {names}')
    return os.path.getsize(path)


# ---------------------------------------------------------------------------------------------------------------
# A painted face: find it, read its skin colour, cut the hole, measure where the face goes
# ---------------------------------------------------------------------------------------------------------------

def face_points(im):
    """MediaPipe's 478 face points on a painted face, in the picture's own pixels. None if no face is found."""
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
    except ImportError:
        fail('Cutting a face hole needs mediapipe (pip install mediapipe).')
    flat = Image.new('RGBA', im.size, (128, 128, 128, 255))     # see-through parts on plain grey
    flat.alpha_composite(im)
    rgb = np.ascontiguousarray(np.array(flat.convert('RGB')))
    options = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=MODEL), num_faces=1,
                                           running_mode=vision.RunningMode.IMAGE)
    finder = vision.FaceLandmarker.create_from_options(options)
    try:
        found = finder.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    finally:
        finder.close()
    if not found.face_landmarks:
        return None
    w, h = im.size
    return np.array([[p.x * w, p.y * h] for p in found.face_landmarks[0]])


def cheek_tone(im, points):
    """The painted skin colour: the middle value of the solid pixels within 2 % of the face width round the 4
    cheek points (read before the hole is cut). Collar, hair and hat never get near these."""
    pixels = np.array(im)
    face_w = np.linalg.norm(points[FACE_SIDES[1]] - points[FACE_SIDES[0]])
    reach = 0.02 * face_w
    found = []
    for index in CHEEKS:
        cx, cy = points[index]
        x0, x1 = int(np.floor(cx - reach)), int(np.ceil(cx + reach)) + 1
        y0, y1 = int(np.floor(cy - reach)), int(np.ceil(cy + reach)) + 1
        part = pixels[max(0, y0):y1, max(0, x0):x1]
        ys, xs = np.mgrid[max(0, y0):max(0, y0) + part.shape[0], max(0, x0):max(0, x0) + part.shape[1]]
        near = ((xs + 0.5 - cx) ** 2 + (ys + 0.5 - cy) ** 2 <= reach ** 2) & (part[..., 3] > SOLID)
        found.append(part[near][:, :3])
    found = np.concatenate(found)
    if len(found) < 20:
        return None
    return [median(found[:, c]) for c in range(3)]


def clockwise_on_screen(outline):
    x, y = outline[:, 0], outline[:, 1]
    return float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)) > 0     # y points down on screen


def cut_face_hole(im, points):
    """The see-through hole where your face goes: the face outline pulled in 4 % (so the character's own hairline,
    ears and jaw frame your face), its top lowered 6 % (the painted hairline stays), with a soft edge of 2.5 % of
    the face width. Returns the cut picture and the hole's outline (picture pixels, from the top, clockwise)."""
    oval = points[OVAL]
    middle = oval.mean(axis=0)
    hole = middle + (oval - middle) * 0.96
    hole[:, 1] = np.where(hole[:, 1] < middle[1], hole[:, 1] + (middle[1] - hole[:, 1]) * 0.06, hole[:, 1])
    if not clockwise_on_screen(hole):
        hole = np.vstack([hole[:1], hole[1:][::-1]])
    face_w = np.linalg.norm(points[FACE_SIDES[1]] - points[FACE_SIDES[0]])
    soft = max(2.0, float(face_w) * 0.025)
    w, h = im.size
    big = 4                                                             # drawn 4× bigger, then shrunk: smooth edge
    mask = Image.new('L', (w * big, h * big), 0)
    ImageDraw.Draw(mask).polygon([(x * big, y * big) for x, y in hole], fill=255)
    mask = mask.resize((w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(soft / 2))
    alpha = np.array(im.getchannel('A')).astype(np.float32) * (1 - np.array(mask).astype(np.float32) / 255)
    cut = im.copy()
    cut.putalpha(Image.fromarray(alpha.clip(0, 255).round().astype(np.uint8)))
    return cut, hole


def character_from_painted_face(im, label):
    """A character with a painted face → (the 1080 × 1920 picture with its hole, its anchors in art 0–1)."""
    im = im.convert('RGBA')
    points = face_points(im)
    if points is None:
        fail(f'{label}: no face found on the picture.')
    tone = cheek_tone(im, points)
    if tone is None or not looks_like_skin(*tone):
        fail(f'{label}: the cheeks don\'t look like skin ({tone}). Check the picture (or the cheek points).')
    cut, hole = cut_face_hole(im, points)
    x, y, cw, ch = cover_crop(*im.size)

    def art(p):
        return [round(float((p[0] - x) / cw), 5) + 0.0, round(float((p[1] - y) / ch), 5) + 0.0]

    eye_a = (points[EYE_A[0]] + points[EYE_A[1]]) / 2       # eye middles: between the corners, not the irises
    eye_b = (points[EYE_B[0]] + points[EYE_B[1]]) / 2       # (irises move with the gaze)
    if eye_a[0] > eye_b[0]:
        eye_a, eye_b = eye_b, eye_a
    face_w = np.linalg.norm(points[FACE_SIDES[1]] - points[FACE_SIDES[0]])
    anchors = {
        'eyes': [art(eye_a), art(eye_b)],
        'nose': art(points[NOSE]),
        'chin': art(points[CHIN]),
        'forehead': art(points[FOREHEAD]),
        'hole': [art(p) for p in hole],
        'faceWidth': round(float(face_w / cw), 5),
        'skinTone': [int(v) for v in tone],
        'toneSure': True,
    }
    return to_poster(cut), anchors


# ---------------------------------------------------------------------------------------------------------------
# The Python copy of src/lib/mainCharacter/holeFinder.ts (findFaceHole, holeLooksRight, skinToneAround,
# anchorsFromHole). Same steps and numbers – change both together.
# ---------------------------------------------------------------------------------------------------------------

def find_face_hole(rgba):
    h, w = rgba.shape[:2]
    alpha = rgba[..., 3].astype(np.float64)
    state = (rgba[..., 3] < SEE_THROUGH).astype(np.uint8).ravel().tolist()   # 1 = see-through, not looked at

    def spread(start, mark):
        size = sum_x = sum_y = 0
        left, top, right, bottom = w, h, -1, -1
        waiting = [start]
        state[start] = mark
        while waiting:
            i = waiting.pop()
            x, y = i % w, i // w
            size += 1
            sum_x += x
            sum_y += y
            left, right, top, bottom = min(left, x), max(right, x), min(top, y), max(bottom, y)
            for j, ok in ((i - 1, x > 0), (i + 1, x < w - 1), (i - w, y > 0), (i + w, y < h - 1)):
                if ok and state[j] == 1:
                    state[j] = mark
                    waiting.append(j)
        return {'size': size, 'sum_x': sum_x, 'sum_y': sum_y, 'left': left, 'top': top, 'right': right, 'bottom': bottom}

    for x in range(w):
        for i in (x, (h - 1) * w + x):
            if state[i] == 1:
                spread(i, 2)
    for y in range(h):
        for i in (y * w, y * w + w - 1):
            if state[i] == 1:
                spread(i, 2)
    best = None
    for i in range(w * h):
        if state[i] == 1:
            area = spread(i, 3)
            if best is None or area['size'] > best['size']:
                best = area
    if best is None:
        return None
    mid_x = best['sum_x'] / best['size'] + 0.5
    mid_y = best['sum_y'] / best['size'] + 0.5
    if alpha[int(np.floor(mid_y)), int(np.floor(mid_x))] >= SEE_THROUGH:
        return None

    def alpha_of(x, y):
        return alpha[min(h - 1, max(0, y)), min(w - 1, max(0, x))]

    def alpha_at(px, py):
        fx, fy = px - 0.5, py - 0.5
        ix, iy = int(np.floor(fx)), int(np.floor(fy))
        tx, ty = fx - ix, fy - iy
        upper = alpha_of(ix, iy) * (1 - tx) + alpha_of(ix + 1, iy) * tx
        lower = alpha_of(ix, iy + 1) * (1 - tx) + alpha_of(ix + 1, iy + 1) * tx
        return upper * (1 - ty) + lower * ty

    points = []
    for k in range(RAYS):
        turn = k * 2 * np.pi / RAYS
        dx, dy = np.sin(turn), -np.cos(turn)
        t, before, edge = 0.0, alpha_at(mid_x, mid_y), -1.0
        while t < w + h:
            nxt = t + RAY_STEP
            px, py = mid_x + dx * nxt, mid_y + dy * nxt
            if px < 0 or py < 0 or px > w or py > h:
                edge = t
                break
            a = alpha_at(px, py)
            if a >= SEE_THROUGH:
                part = (SEE_THROUGH - before) / (a - before) if a > before else 1
                edge = t + min(1, max(0, part)) * RAY_STEP
                break
            before, t = a, nxt
        if edge < 0:
            edge = t
        points += [(mid_x + dx * edge) / w, (mid_y + dy * edge) / h]
    box_w = best['right'] - best['left'] + 1
    box_h = best['bottom'] - best['top'] + 1
    return {'points': points, 'box': {'x': best['left'] / w, 'y': best['top'] / h, 'w': box_w / w, 'h': box_h / h},
            'fill': best['size'] / (box_w * box_h)}


def hole_looks_right(shape, check):
    box = shape['box']
    aspect = box['w'] * 9 / (box['h'] * 16)
    middle_x, middle_y = box['x'] + box['w'] / 2, box['y'] + box['h'] / 2
    return (len(shape['points']) == RAYS * 2
            and check['minWidth'] <= box['w'] <= check['maxWidth']
            and check['minAspect'] <= aspect <= check['maxAspect']
            and check['minFill'] <= shape['fill'] <= check['maxFill']
            and check['minX'] <= middle_x <= check['maxX']
            and middle_y < check['maxY'])


def inside(outline, px, py):
    """Even-odd test, for many points at once (outline: N × 2 pixels)."""
    yes = np.zeros(np.shape(px), bool)
    j = len(outline) - 1
    for i in range(len(outline)):
        (xi, yi), (xj, yj) = outline[i], outline[j]
        if yi != yj:
            crosses = ((yi > py) != (yj > py)) & (px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            yes ^= crosses
        j = i
    return yes


def skin_tone_around(rgba, shape):
    h, w = rgba.shape[:2]
    hole = np.array(shape['points'], float).reshape(-1, 2) * [w, h]
    middle = hole.mean(axis=0)
    outer = middle + (hole - middle) * RING
    x0, x1 = max(0, int(np.floor(outer[:, 0].min()))), min(w - 1, int(np.ceil(outer[:, 0].max())))
    y0, y1 = max(0, int(np.floor(outer[:, 1].min()))), min(h - 1, int(np.ceil(outer[:, 1].max())))
    ys, xs = np.mgrid[y0:y1 + 1, x0:x1 + 1]
    part = rgba[y0:y1 + 1, x0:x1 + 1]
    px, py = xs + 0.5, ys + 0.5
    ring = (part[..., 3] > SOLID) & inside(outer, px, py) & ~inside(hole, px, py)
    colours = part[ring][:, :3].astype(np.int64)            # row by row, left to right (as holeFinder.ts)
    skin = colours[looks_like_skin(colours[:, 0], colours[:, 1], colours[:, 2])] if len(colours) else colours
    if len(skin) >= MIN_SKIN:
        lightness = skin @ np.array([299, 587, 114])
        lit = skin[np.argsort(lightness, kind='stable')[len(skin) // 2:]]      # the brighter half
        return [median(lit[:, c]) for c in range(3)], True
    if len(colours):
        return [median(colours[:, c]) for c in range(3)], False
    return list(NO_TONE), False


def anchors_from_hole(shape, tone, sure, guess):
    box = shape['box']
    middle = box['x'] + box['w'] / 2
    eye_y = box['y'] + guess['eyeY'] * box['h']
    r5 = lambda v: round(float(v), 5) + 0.0
    return {
        'eyes': [[r5(middle - guess['eyeHalf'] * box['w']), r5(eye_y)], [r5(middle + guess['eyeHalf'] * box['w']), r5(eye_y)]],
        'nose': [r5(middle), r5(box['y'] + guess['noseY'] * box['h'])],
        'chin': [r5(middle), r5(box['y'] + guess['chinY'] * box['h'])],
        'forehead': [r5(middle), r5(box['y'] + guess['foreheadY'] * box['h'])],
        'hole': [[r5(shape['points'][i]), r5(shape['points'][i + 1])] for i in range(0, len(shape['points']), 2)],
        'faceWidth': r5(guess['faceWidth'] * box['w']),
        'skinTone': [int(v) for v in tone],
        'toneSure': bool(sure),
    }


def fit_hole_numbers(found):
    """The HOLE numbers from all the bundled characters (found = [(shape, anchors)]). The eye and forehead numbers
    are the ones that keep the worst character's miss smallest (that is what the parity test checks: within 5 %
    of the hole width); nose, chin and face width are plain averages. Returns the numbers and the worst misses."""
    def hole_width(anchors):
        xs = [p[0] for p in anchors['hole']]
        return (max(xs) - min(xs)) * POSTER_W

    eye_y = np.round(np.arange(0.15, 0.45, 0.001), 3)[:, None]
    eye_half = np.round(np.arange(0.12, 0.32, 0.001), 3)[None, :]
    forehead_y = np.round(np.arange(-0.25, 0.1, 0.001), 3)
    worst_eye = np.zeros((eye_y.size, eye_half.size))
    worst_forehead = np.zeros(forehead_y.size)
    for shape, anchors in found:
        box, width = shape['box'], hole_width(anchors)
        middle = box['x'] + box['w'] / 2
        for side, (ax, ay) in zip((-1, 1), anchors['eyes']):
            dx = (middle + side * eye_half * box['w'] - ax) * POSTER_W
            dy = (box['y'] + eye_y * box['h'] - ay) * POSTER_H
            worst_eye = np.maximum(worst_eye, np.hypot(dx, dy) / width)
        fx, fy = anchors['forehead']
        worst_forehead = np.maximum(worst_forehead, np.hypot((middle - fx) * POSTER_W,
                                                             (box['y'] + forehead_y * box['h'] - fy) * POSTER_H) / width)
    i, j = np.unravel_index(np.argmin(worst_eye), worst_eye.shape)
    k = int(np.argmin(worst_forehead))
    each = [hole_numbers(shape, anchors) for shape, anchors in found]
    fit = {
        'eyeY': float(eye_y[i, 0]),
        'eyeHalf': float(eye_half[0, j]),
        'noseY': float(np.mean([n['noseY'] for n in each])),
        'chinY': float(np.mean([n['chinY'] for n in each])),
        'foreheadY': float(forehead_y[k]),
        'faceWidth': float(np.mean([n['faceWidth'] for n in each])),
    }
    return fit, float(worst_eye[i, j]), float(worst_forehead[k])


def hole_numbers(shape, anchors):
    """The HOLE numbers for one character: where its measured face points sit in the box the app finds."""
    box = shape['box']
    (ax, ay), (bx, by) = anchors['eyes']
    return {
        'eyeY': ((ay + by) / 2 - box['y']) / box['h'],
        'eyeHalf': abs(bx - ax) / 2 / box['w'],
        'noseY': (anchors['nose'][1] - box['y']) / box['h'],
        'chinY': (anchors['chin'][1] - box['y']) / box['h'],
        'foreheadY': (anchors['forehead'][1] - box['y']) / box['h'],
        'faceWidth': anchors['faceWidth'] / box['w'],
    }


# ---------------------------------------------------------------------------------------------------------------
# The TypeScript lists
# ---------------------------------------------------------------------------------------------------------------

HEADER = """// Made by scripts/make-main-character-assets.py – don't change by hand.
// The Main Character art that comes inside the app (docs/FACE_MESH.md, "Main Character Mode"). iPhone only:
// art.generated.ts (the empty list) is what Android and web get, so their updates don't carry these pictures.
"""
TYPES = """import type { ArtAnchors } from './types';

export type BundledCharacter = { slug: string; name: string; image: number; scene: string; anchors: ArtAnchors };
export type BundledScene = { slug: string; name: string; image: number };
"""


def ts_number(v):
    text = f'{round(float(v), 5) + 0.0:.5f}'.rstrip('0')
    return text[:-1] if text.endswith('.') else text


def ts_point(p):
    return f'[{ts_number(p[0])}, {ts_number(p[1])}]'


def ts_character(slug, scene, a):
    hole_lines = [', '.join(ts_point(p) for p in a['hole'][i:i + 6]) for i in range(0, len(a['hole']), 6)]
    hole = ',\n'.join(f'        {line}' for line in hole_lines)
    return (
        '  {\n'
        f"    slug: '{slug}', name: '{name_from_slug(slug)}', scene: '{scene}',\n"
        f"    image: require('../../../assets/main-character/characters/{slug}.webp'),\n"
        '    anchors: {\n'
        f"      eyes: [{ts_point(a['eyes'][0])}, {ts_point(a['eyes'][1])}],\n"
        f"      nose: {ts_point(a['nose'])}, chin: {ts_point(a['chin'])}, forehead: {ts_point(a['forehead'])},\n"
        f'      hole: [\n{hole},\n      ],\n'
        f"      faceWidth: {ts_number(a['faceWidth'])}, skinTone: [{', '.join(str(v) for v in a['skinTone'])}], "
        f"toneSure: {'true' if a['toneSure'] else 'false'},\n"
        '    },\n'
        '  },\n'
    )


def write_lists(characters):
    ios = HEADER + TYPES + '\nexport const BUNDLED_CHARACTERS: BundledCharacter[] = [\n'
    ios += ''.join(ts_character(slug, scene, anchors) for slug, scene, anchors in characters)
    ios += '];\n\nexport const BUNDLED_SCENES: BundledScene[] = [\n'
    for slug in SCENES:
        ios += (f"  {{ slug: '{slug}', name: '{name_from_slug(slug)}', "
                f"image: require('../../../assets/main-character/backgrounds/{slug}.webp') }},\n")
    ios += '];\n'
    empty = (HEADER + '// This is the empty list.\n' + TYPES
             + '\nexport const BUNDLED_CHARACTERS: BundledCharacter[] = [];\n'
             + '\nexport const BUNDLED_SCENES: BundledScene[] = [];\n')
    with open(f'{LIB}/art.generated.ios.ts', 'w', encoding='utf8', newline='\n') as f:
        f.write(ios)
    with open(f'{LIB}/art.generated.ts', 'w', encoding='utf8', newline='\n') as f:
        f.write(empty)


# ---------------------------------------------------------------------------------------------------------------
# The two steps
# ---------------------------------------------------------------------------------------------------------------

def bundle(folder):
    max_bytes = config_number('MAX_ART_BYTES')
    check = config_numbers('HOLE_CHECK')
    for sub in ('characters', 'backgrounds'):
        os.makedirs(f'{ASSETS}/{sub}', exist_ok=True)
    wanted = {('characters', f'{slug}.webp') for slug, _ in CHARACTERS} | {('backgrounds', f'{slug}.webp') for slug in SCENES}
    for sub in ('characters', 'backgrounds'):
        for old in os.listdir(f'{ASSETS}/{sub}'):
            if (sub, old) not in wanted:
                os.remove(f'{ASSETS}/{sub}/{old}')                     # a renamed or dropped picture

    made, numbers, shapes, total = [], [], [], 0
    for slug, scene in CHARACTERS:
        source = f'{folder}/characters/{slug}.png'
        if not os.path.exists(source):
            fail(f'missing {source}')
        with Image.open(source) as im:
            poster, anchors = character_from_painted_face(im, slug)
        size = save_webp(poster, f'{ASSETS}/characters/{slug}.webp', max_bytes)
        total += size
        shape = find_face_hole(small_copy(poster))                      # what the app itself would find
        if shape is None:
            fail(f'{slug}: the app could not find the face hole')
        hole = hole_numbers(shape, anchors)
        numbers.append(hole)
        shapes.append(shape)
        box = shape['box']
        print(f"{slug:15} {size // 1024:4} KB  tone {anchors['skinTone']}  hole {box['w']:.3f} × {box['h']:.3f} "
              f"of the picture, shape {box['w'] * 9 / (box['h'] * 16):.3f}, fill {shape['fill']:.3f}, middle "
              f"{box['x'] + box['w'] / 2:.3f}, {box['y'] + box['h'] / 2:.3f}"
              f"{'' if hole_looks_right(shape, check) else '   ⚠️ outside HOLE_CHECK'}")
        made.append((slug, scene, anchors))
    for slug in SCENES:
        source = f'{folder}/backgrounds/{slug}.png'
        if not os.path.exists(source):
            fail(f'missing {source}')
        with Image.open(source) as im:
            size = save_webp(to_poster(im.convert('RGB')), f'{ASSETS}/backgrounds/{slug}.webp', max_bytes)
        total += size
        print(f'{slug:15} {size // 1024:4} KB  (scene)')
    write_lists(made)

    print(f'\n✅ {len(CHARACTERS)} characters + {len(SCENES)} scenes, {total / 1048576:.2f} MB, and both art.generated files.')
    print('\nHOLE numbers per character (eye middles, nose, chin, forehead and face width, measured in the box the app finds):')
    keys = ['eyeY', 'eyeHalf', 'noseY', 'chinY', 'foreheadY', 'faceWidth']
    for (slug, _), hole in zip(CHARACTERS, numbers):
        print(f'  {slug:15} ' + '  '.join(f'{k} {hole[k]:.3f}' for k in keys))
    fit, eye_miss, forehead_miss = fit_hole_numbers([(shape, anchors) for shape, (_, _, anchors) in zip(shapes, made)])
    print('\nPut this line into src/lib/mainCharacter/config.ts (if it changed):')
    print('export const HOLE = { ' + ', '.join(f'{k}: {fit[k]:.3f}' for k in keys) + ' };')
    print(f'With these, the worst guess is {eye_miss * 100:.1f} % of the hole width off for an eye and '
          f'{forehead_miss * 100:.1f} % for the forehead (tests/unit/main-character-parity.test.mjs allows 5 %).')

    def spread(values):
        return f'{min(values):.3f}–{max(values):.3f}'
    boxes = [shape['box'] for shape in shapes]
    print('\nThe holes the app finds (HOLE_CHECK in config.ts must sit a little outside all of these):')
    print(f"  width {spread([b['w'] for b in boxes])}, shape {spread([b['w'] * 9 / (b['h'] * 16) for b in boxes])}, "
          f"fill {spread([shape['fill'] for shape in shapes])}, middle x {spread([b['x'] + b['w'] / 2 for b in boxes])}, "
          f"middle y {spread([b['y'] + b['h'] / 2 for b in boxes])}")
    if not all(hole_looks_right(shape, check) for shape in shapes):
        print('⚠️  At least one bundled hole is outside HOLE_CHECK: the app would skip it if it came from the bucket.')


def online(picture, out_folder, scene):
    max_bytes = config_number('MAX_ART_BYTES')
    slug = slug_from_file(os.path.basename(picture))
    if slug is None or os.path.splitext(picture)[1].lower() == '.json':
        fail(f'{picture}: the file name has to give a name of 1–40 letters, numbers or dashes.')
    os.makedirs(out_folder, exist_ok=True)
    with Image.open(picture) as im:
        im.load()
        if scene:
            size = save_webp(to_poster(im.convert('RGB')), f'{out_folder}/{slug}.webp', max_bytes)
            print(f'✅ scene "{name_from_slug(slug)}": {out_folder}/{slug}.webp ({size // 1024} KB)')
            print('   Upload it into Supabase → Storage → main-character → backgrounds/.')
            return
        im = im.convert('RGBA')
    if not (np.array(im.getchannel('A')) < SEE_THROUGH).any():
        fail(f'{picture}: a character needs a see-through background (a PNG or WebP with transparency).')
    poster = to_poster(im)
    small = small_copy(poster)
    shape = find_face_hole(small)
    if shape is not None and hole_looks_right(shape, config_numbers('HOLE_CHECK')):
        # It already has a face hole: measure it the way the app would.
        tone, sure = skin_tone_around(small, shape)
        anchors = anchors_from_hole(shape, tone, sure, config_numbers('HOLE'))
        how = 'its own face hole, measured'
    else:
        poster, anchors = character_from_painted_face(im, slug)
        how = 'painted face, hole cut'
    size = save_webp(poster, f'{out_folder}/{slug}.webp', max_bytes)
    with open(f'{out_folder}/{slug}.json', 'w', encoding='utf8', newline='\n') as f:
        json.dump(anchors, f, separators=(',', ':'))
    print(f'✅ character "{name_from_slug(slug)}" ({how}): {out_folder}/{slug}.webp ({size // 1024} KB) '
          f'and {out_folder}/{slug}.json')
    print(f"   skin {anchors['skinTone']}{'' if anchors['toneSure'] else ' (not sure: no skin colour pull)'}")
    print('   Upload both into Supabase → Storage → main-character → characters/.')


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == 'bundle':
        bundle(args[1])
    elif len(args) in (3, 4) and args[0] == 'online' and (len(args) == 3 or args[3] == '--scene'):
        online(args[1], args[2], len(args) == 4)
    else:
        print('Use:\n  python3 scripts/make-main-character-assets.py bundle <art-folder>\n'
              '  python3 scripts/make-main-character-assets.py online <picture> <out-folder> [--scene]')
        sys.exit(2)
