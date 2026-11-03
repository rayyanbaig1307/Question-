import { requireOptionalNativeModule } from 'expo';
import { File } from 'expo-file-system';
import { TurboModuleRegistry } from 'react-native';

// ---------------------------------------------------------------------------
// Googly eyes that follow your face in a VIDEO.
//
// After you record with the googly lens, the editor looks for faces in the video, a few times every second,
// and writes down where the eyes are ("the eye track"). When the video plays – in the editor, in a story,
// in a peek – the googly eyes move along that track, in step with the video.
//
// The track travels inside the video's sticker layer picture (the see-through PNG shown on top of every
// video), as a small hidden note in the file. So it goes everywhere that picture goes, with no new database
// fields. Copies of the app without this just don't see the moving eyes.
// ---------------------------------------------------------------------------

// The googly-eyes sticker is two 70-point eyes with a 6-point gap: 146 × 70, eye centres 76 apart.
export const PAIR_WIDTH = 146;
export const PAIR_HEIGHT = 70;
const PAIR_EYE_DISTANCE = 76;
const MAX_FACES = 4;
// Look about 8 times a second (a bit less often for long videos, so it doesn't take ages).
const MIN_STEP_MS = 125;
const MAX_LOOKS = 150;
// A face that goes missing for a moment (a blink, a quick turn) keeps its eyes for up to this many looks.
const GAP_FILL = 4;

// One pair of eyes at one moment: [x, y, size × 1000, tilt × 1000]. x and y are points on the editor's screen.
export type EyeSpot = [number, number, number, number];
export type EyeTrack = {
  v: 1;
  // The size of the screen the video was edited on (the sticker layer's size, in points).
  w: number;
  h: number;
  // Time between looks (milliseconds).
  step: number;
  sticker: string;
  // frames[look][face] – a spot, or 0 when that face isn't there at that moment.
  frames: (EyeSpot | 0)[][];
};

const Thumbnails: typeof import('expo-video-thumbnails') | null = requireOptionalNativeModule('ExpoVideoThumbnails')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-video-thumbnails')
  : null;

// Finding faces in a still picture needs the face tracker from the app download (not Expo Go).
export const CAN_TRACK_EYES = (() => {
  try {
    if (!Thumbnails || !TurboModuleRegistry.get('NitroModules')) return false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    return NitroModules.hasHybridObject('FaceDetectorFactory') && NitroModules.hasHybridObject('ImageFaceDetectorFactory');
  } catch {
    return false;
  }
})();

type Pt = { x: number; y: number };
type FaceLike = { bounds: { x: number; y: number; width: number; height: number }; landmarks?: { LEFT_EYE?: Pt; RIGHT_EYE?: Pt } };

// Looks through the video for faces and writes down where the eyes are. `screen` is the editor's size (the
// video fills it, cut to fit like on the camera). Returns null if it can't, or if there were no faces at all.
export async function trackEyes(
  videoUri: string,
  seconds: number,
  screen: { width: number; height: number },
  sticker: string,
  onProgress?: (done: number) => void,
  cancelled?: () => boolean,
): Promise<EyeTrack | null> {
  if (!CAN_TRACK_EYES || !Thumbnails || !(seconds > 0)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createImageFaceDetector } = require('react-native-vision-camera-face-detector') as typeof import('react-native-vision-camera-face-detector');
  const detector = createImageFaceDetector({ performanceMode: 'fast', runLandmarks: true });

  const total = Math.round(seconds * 1000);
  const step = Math.max(MIN_STEP_MS, Math.ceil(total / MAX_LOOKS));
  const looks = Math.floor(total / step) + 1;
  const frames: (EyeSpot | 0)[][] = [];
  let lastKey = '';
  let found = false;

  for (let look = 0; look < looks; look += 1) {
    if (cancelled?.()) return null;
    let spots: EyeSpot[] = [];
    let key = '';
    try {
      // The very end of a video sometimes has no picture, so the last look is a little before it.
      const time = Math.min(look * step, Math.max(0, total - 60));
      const thumb = await Thumbnails.getThumbnailAsync(videoUri, { time, quality: 0.6 });
      const faces = detector.detectFaces(thumb.uri) as FaceLike[];
      try {
        new File(thumb.uri).delete();
      } catch {
        // Only a temporary picture – fine if it stays.
      }
      spots = faces.slice(0, MAX_FACES).map((face) => spotOf(face, thumb.width, thumb.height, screen));
      key = spots.map((spot) => spot.join(',')).join(';');
    } catch {
      // Couldn't look at this moment – the gap gets filled in below.
      frames.push([]);
      continue;
    }
    // Some phones only give the nearest "key" picture, so the same picture comes back again and again.
    // Then it's not a real new look: leave it empty, and the eyes glide between the real ones.
    if (key && key === lastKey) {
      frames.push([]);
    } else {
      frames.push(matchFaces(frames, spots));
      if (spots.length > 0) found = true;
    }
    lastKey = key;
    onProgress?.((look + 1) / looks);
    // Give the screen a moment to update between looks.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (!found) return null;
  const width = Math.max(1, ...frames.map((row) => row.length));
  const filled = fillGaps(frames.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? 0)));
  return { v: 1, w: Math.round(screen.width), h: Math.round(screen.height), step, sticker, frames: filled };
}

// Where the eyes are on one face, in screen points (the video is cut to fill the screen).
function spotOf(face: FaceLike, imageWidth: number, imageHeight: number, screen: { width: number; height: number }): EyeSpot {
  const k = Math.max(screen.width / imageWidth, screen.height / imageHeight);
  const dx = (screen.width - imageWidth * k) / 2;
  const dy = (screen.height - imageHeight * k) / 2;
  const map = (p: Pt) => ({ x: p.x * k + dx, y: p.y * k + dy });
  const box = face.bounds;
  const one = map(face.landmarks?.LEFT_EYE ?? { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 });
  const two = map(face.landmarks?.RIGHT_EYE ?? { x: box.x + box.width * 0.7, y: box.y + box.height * 0.4 });
  // Measured left to right on screen, so the eyes are never upside down.
  const [left, right] = one.x <= two.x ? [one, two] : [two, one];
  const distance = Math.hypot(right.x - left.x, right.y - left.y) || box.width * k * 0.4;
  return [
    Math.round((left.x + right.x) / 2),
    Math.round((left.y + right.y) / 2),
    Math.round(Math.max(0.2, distance / PAIR_EYE_DISTANCE) * 1000),
    Math.round(Math.atan2(right.y - left.y, right.x - left.x) * 1000),
  ];
}

// Keep each face in the same place in the list from one look to the next (the closest one to where it was).
function matchFaces(frames: (EyeSpot | 0)[][], spots: EyeSpot[]): (EyeSpot | 0)[] {
  // The last place each face was seen.
  const last: (EyeSpot | null)[] = [];
  for (let i = frames.length - 1; i >= 0 && i >= frames.length - 8; i -= 1) {
    frames[i].forEach((spot, index) => {
      if (spot && !last[index]) last[index] = spot;
    });
  }
  const row: (EyeSpot | 0)[] = Array.from({ length: Math.max(last.length, 0) }, () => 0);
  const left = [...spots];
  last.forEach((before, index) => {
    if (!before || left.length === 0) return;
    let best = 0;
    left.forEach((spot, i) => {
      if (Math.hypot(spot[0] - before[0], spot[1] - before[1]) < Math.hypot(left[best][0] - before[0], left[best][1] - before[1])) best = i;
    });
    row[index] = left.splice(best, 1)[0];
  });
  for (const spot of left) {
    const free = row.findIndex((slot) => slot === 0);
    if (free >= 0) row[free] = spot;
    else if (row.length < MAX_FACES) row.push(spot);
  }
  return row;
}

// A face missing for a few looks in a row: draw a straight line between where it was before and after.
function fillGaps(frames: (EyeSpot | 0)[][]): (EyeSpot | 0)[][] {
  const width = frames[0]?.length ?? 0;
  for (let face = 0; face < width; face += 1) {
    let lastSeen = -1;
    frames.forEach((row, look) => {
      const spot = row[face];
      if (!spot) return;
      const gap = look - lastSeen - 1;
      if (lastSeen >= 0 && gap > 0 && gap <= GAP_FILL) {
        const from = frames[lastSeen][face] as EyeSpot;
        for (let g = 1; g <= gap; g += 1) {
          const t = g / (gap + 1);
          frames[lastSeen + g][face] = from.map((value, i) => Math.round(value + (spot[i] - value) * t)) as EyeSpot;
        }
      }
      lastSeen = look;
    });
  }
  return frames;
}

// Where each face's eyes are at a moment of the video (milliseconds), gliding smoothly between looks.
export function eyesAt(track: EyeTrack, ms: number): ({ x: number; y: number; scale: number; rotation: number } | null)[] {
  const at = Math.max(0, ms / track.step);
  const i = Math.min(track.frames.length - 1, Math.floor(at));
  const j = Math.min(track.frames.length - 1, i + 1);
  const t = Math.min(1, at - i);
  const a = track.frames[i] ?? [];
  const b = track.frames[j] ?? [];
  return a.map((spot, face) => {
    const next = b[face];
    if (!spot) return null;
    const end = next || spot;
    const mix = (k: number) => spot[k] + (end[k] - spot[k]) * t;
    return { x: mix(0), y: mix(1), scale: mix(2) / 1000, rotation: mix(3) / 1000 };
  });
}

// ---------------------------------------------------------------------------
// Hiding the track inside the sticker layer picture (a PNG "text note" right after the picture's header).
// ---------------------------------------------------------------------------

const KEYWORD = 'peekaboo-eyes';

// Adds the track to a PNG file and returns the new file.
export async function addTrackToPng(pngUri: string, track: EyeTrack): Promise<string> {
  pngUri = asFileUri(pngUri);
  const png = new Uint8Array(await new File(pngUri).arrayBuffer());
  // The header chunk ends at byte 33 (8-byte signature + 25-byte IHDR chunk).
  if (png.length < 33 || !isPng(png)) return pngUri;
  const text = encodeAscii(`${KEYWORD}\0${JSON.stringify(track)}`);
  const chunk = new Uint8Array(12 + text.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, text.length);
  chunk.set(encodeAscii('tEXt'), 4);
  chunk.set(text, 8);
  view.setUint32(8 + text.length, crc32(chunk.subarray(4, 8 + text.length)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, 33), 0);
  out.set(chunk, 33);
  out.set(png.subarray(33), 33 + chunk.length);
  const file = new File(pngUri.replace(/\.png$/i, '') + '-eyes.png');
  if (file.exists) file.delete();
  await file.write(out);
  return file.uri;
}

// Reads the track back out of a sticker layer picture (a phone file or a web link). null if it has none.
const cache = new Map<string, Promise<EyeTrack | null>>();
export function readTrack(uri: string): Promise<EyeTrack | null> {
  let found = cache.get(uri);
  if (!found) {
    found = loadTrack(uri).catch(() => null);
    cache.set(uri, found);
    if (cache.size > 60) cache.delete(cache.keys().next().value as string);
  }
  return found;
}

async function loadTrack(uri: string): Promise<EyeTrack | null> {
  const local = !/^https?:/i.test(uri);
  // Web links: just the start of the file (the note sits right after the header), not the whole picture.
  const head = local ? new Uint8Array(await new File(asFileUri(uri)).arrayBuffer()) : await fetchBytes(uri, 0, 1023);
  if (head.length < 41 || !isPng(head)) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const length = view.getUint32(33);
  if (decodeAscii(head.subarray(37, 41)) !== 'tEXt') return null;
  // Is it our note? (The keyword comes first.)
  const keyEnd = 41 + KEYWORD.length;
  if (head.length > keyEnd && decodeAscii(head.subarray(41, keyEnd)) !== KEYWORD) return null;
  const body = head.length >= 41 + length ? head.subarray(41, 41 + length) : await fetchBytes(uri, 41, 41 + length - 1);
  const text = decodeAscii(body);
  if (!text.startsWith(`${KEYWORD}\0`)) return null;
  const track = JSON.parse(text.slice(KEYWORD.length + 1)) as EyeTrack;
  return track?.v === 1 && Array.isArray(track.frames) && track.step > 0 ? track : null;
}

async function fetchBytes(url: string, from: number, to: number): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A server that ignores "just this part" sends the whole file – then cut out the part we wanted.
  return response.status === 206 ? bytes : bytes.subarray(from, to + 1);
}

// Some phones give a plain path ("/data/…") instead of a file:// link.
function asFileUri(uri: string): string {
  return uri.startsWith('/') ? `file://${uri}` : uri;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((value, i) => bytes[i] === value);
}

// The track is plain letters and numbers, so one byte per character is enough.
function encodeAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function decodeAscii(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return out;
}

// The checksum every PNG chunk ends with.
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
