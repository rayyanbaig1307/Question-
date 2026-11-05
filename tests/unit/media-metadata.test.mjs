import { expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

function pngWithTrack(track) {
  const note = Buffer.from('peekaboo-eyes\0' + JSON.stringify(track));
  const png = Buffer.alloc(41 + note.length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(note.length, 33);
  png.write('tEXt', 37);
  note.copy(png, 41);
  return png;
}
const valid = { v: 1, w: 390, h: 844, step: 125, sticker: 'googly-eyes', frames: [[[10, 20, 1000, 0]], [[30, 40, 1000, 0]]] };
function loader(bytes) {
  const fetch = vi.fn(async (_url, options) => {
    const [, from, to] = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
    const part = bytes.subarray(+from, +to + 1);
    return { ok: true, status: 206, arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  });
  return { eye: loadLibrary('eyeTrack', { globals: { fetch } }), fetch };
}

it.each([
  { ...valid, frames: ['not-a-frame'] },
  { ...valid, frames: [null] },
  { ...valid, frames: [[['not', 'numbers', 1000, 0]]] },
  { ...valid, frames: [[{ length: 4 }]] },
  { ...valid, frames: Array.from({ length: 10_000 }, () => []) },
  { ...valid, frames: [Array.from({ length: 100 }, () => [1, 1, 1000, 0])] },
  { ...valid, w: 0 },
  { ...valid, h: -1 },
  { ...valid, step: '125' },
])('rejects hostile sticker metadata before the video player uses it', async (track) => {
  const { eye } = loader(pngWithTrack(track));
  expect(await eye.readTrack('https://test.invalid/overlay.png')).toBeNull();
});

it('refuses an oversized note before asking the network for its claimed body', async () => {
  const bytes = pngWithTrack(valid);
  bytes.writeUInt32BE(0xffffffff, 33);
  const { eye, fetch } = loader(bytes);
  expect(await eye.readTrack('https://test.invalid/huge.png')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reads legitimate eye animation and interpolates between frames', async () => {
  const { eye } = loader(pngWithTrack(valid));
  const track = await eye.readTrack('https://test.invalid/good.png');
  expect(track).toEqual(valid);
  expect(eye.eyesAt(track, 62.5)).toEqual([{ x: 20, y: 30, scale: 1, rotation: 0 }]);
});
