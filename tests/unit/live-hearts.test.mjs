import { expect, it } from 'vitest';

import { loadTs } from './liveLoad.mjs';

// Hearts ❤️ (lib/liveHearts.ts): viewers batch their taps and send them to the host only (never to everyone:
// every message names its sender, even a hidden viewer); the host adds them up with a per-person cap and
// sends the sum on; everyone draws only what really comes from the host, at most 8 a second.

const h = loadTs('src/lib/liveHearts.ts', {});
const bytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const HOST = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

it('loads nothing (pure)', () => {
  const required = [];
  loadTs('src/lib/liveHearts.ts', {}, { required });
  expect(required).toEqual([]);
});

it('a count is plain ASCII digits, and only clean numbers in range are read', () => {
  expect([...h.encodeHearts(7)]).toEqual([0x37]);
  expect([...h.encodeHearts(50)]).toEqual([0x35, 0x30]);
  expect(h.decodeHearts(bytes('7'), 9)).toBe(7);
  expect(h.decodeHearts(bytes('50'), 50)).toBe(50);
  for (const bad of ['0', '10', '05', 'a', '', '1x', '-1', '9.5', '123']) expect(h.decodeHearts(bytes(bad), 9), bad).toBe(null);
  expect(h.decodeHearts(bytes('51'), 50)).toBe(null);
  expect(h.decodeHearts(null, 9)).toBe(null);
  expect(h.decodeHearts(undefined, 9)).toBe(null);
  expect(h.HEART_TOPIC).toBe('heart');
  expect(h.HEARTS_TOPIC).toBe('hearts');
});

it('a viewer sends at most one message per 400 ms, 1–9 hearts each', () => {
  const sender = new h.HeartSender();
  expect(sender.take(0)).toBe(0);
  expect(sender.waitMs(0)).toBe(null);
  sender.tap();
  sender.tap();
  expect(sender.take(1000)).toBe(2);
  sender.tap();
  expect(sender.take(1200)).toBe(0); // too soon
  expect(sender.waitMs(1200)).toBe(200);
  expect(sender.take(1400)).toBe(1);
  // A flood: at most 9 in one message, the rest dropped.
  for (let i = 0; i < 30; i++) sender.tap();
  expect(sender.pending).toBe(9);
  expect(sender.take(2000)).toBe(9);
  expect(sender.take(3000)).toBe(0);
});

it('the host adds up viewers\' hearts, at most 20 a second from one person, and sends them on in 1–50s', () => {
  const host = new h.HeartCollector(HOST);
  expect(host.receive('heart', VIEWER, bytes('9'), 1000)).toBe(9);
  expect(host.receive('heart', VIEWER, bytes('9'), 1100)).toBe(9);
  expect(host.receive('heart', VIEWER, bytes('9'), 1200)).toBe(2); // 20 a second
  expect(host.receive('heart', VIEWER, bytes('9'), 1900)).toBe(0);
  expect(host.receive('heart', OTHER, bytes('5'), 1900)).toBe(5); // someone else has their own 20
  expect(host.receive('heart', VIEWER, bytes('3'), 2000)).toBe(3); // a new second
  expect(host.total).toBe(28);
  expect(host.take()).toBe(28);
  expect(host.take()).toBe(0);
  // Over 50 waiting: 50 now, the rest next time.
  for (let s = 0; s < 4; s++) {
    host.receive('heart', VIEWER, bytes('9'), 10_000 + s * 1000);
    host.receive('heart', VIEWER, bytes('9'), 10_000 + s * 1000);
  }
  expect(host.take()).toBe(50);
  expect(host.take()).toBe(22);
  expect(host.total).toBe(100);
});

it('the host ignores anything that isn\'t a clean "heart" from someone else', () => {
  const host = new h.HeartCollector(HOST);
  expect(host.receive('hearts', VIEWER, bytes('5'), 0)).toBe(0); // wrong topic
  expect(host.receive('chat', VIEWER, bytes('5'), 0)).toBe(0);
  expect(host.receive(undefined, VIEWER, bytes('5'), 0)).toBe(0);
  expect(host.receive('heart', undefined, bytes('5'), 0)).toBe(0); // no sender
  expect(host.receive('heart', HOST, bytes('5'), 0)).toBe(0); // "from" the host itself
  expect(host.receive('heart', VIEWER, bytes('10'), 0)).toBe(0); // more than 9
  expect(host.receive('heart', VIEWER, bytes('<script>'), 0)).toBe(0);
  expect(host.total).toBe(0);
  // The host's own taps count and are sent on.
  host.tap();
  expect(host.total).toBe(1);
  expect(host.take()).toBe(1);
});

it('the host\'s total stops at 1,000,000 (what the server keeps)', () => {
  const host = new h.HeartCollector(HOST);
  for (let s = 0; s < 60_000; s++) {
    host.receive('heart', VIEWER, bytes('9'), s * 1000);
    host.receive('heart', VIEWER, bytes('9'), s * 1000);
  }
  expect(host.total).toBe(1_000_000);
});

it('everyone draws only "hearts" that come from the host', () => {
  expect(h.heartsFromHost('hearts', HOST, bytes('12'), HOST)).toBe(12);
  expect(h.heartsFromHost('hearts', VIEWER, bytes('12'), HOST)).toBe(0); // not the host
  expect(h.heartsFromHost('hearts', undefined, bytes('12'), HOST)).toBe(0);
  expect(h.heartsFromHost('heart', HOST, bytes('5'), HOST)).toBe(0); // wrong topic
  expect(h.heartsFromHost('hearts', HOST, bytes('51'), HOST)).toBe(0); // too many
  expect(h.heartsFromHost('hearts', HOST, bytes('12'), '')).toBe(0);
});

it('at most 8 hearts are drawn a second', () => {
  const limit = new h.HeartDrawLimit();
  expect(limit.take(5, 1000)).toBe(5);
  expect(limit.take(5, 1500)).toBe(3);
  expect(limit.take(5, 1999)).toBe(0);
  expect(limit.take(50, 2000)).toBe(8);
  expect(h.DRAW_MAX_PER_SECOND).toBe(8);
});
