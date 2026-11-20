// ---------------------------------------------------------------------------
// Hearts ❤️ in a live. Pure logic only (no LiveKit, no React), so the tests can run it.
//
// How hearts travel (LiveKit "data" messages, which may get lost – that's fine for hearts):
// - A viewer's taps are drawn at once on their own screen and sent to the HOST only, at most one message per
//   400 ms, topic 'heart', the text '1'–'9'. Never to everyone: every message names its sender, so hearts to
//   everyone would show hidden viewers who else is watching.
// - The host adds them up (at most 20 a second from one person) and every 500 ms sends the sum to everyone,
//   topic 'hearts', the text '1'–'50'. The host also keeps the total for the summary.
// - Everyone draws only 'hearts' messages that really come from the host, at most 8 hearts a second.
// - Nothing else that arrives is ever acted on.
// ---------------------------------------------------------------------------

export const HEART_TOPIC = 'heart'; // viewer → host
export const HEARTS_TOPIC = 'hearts'; // host → everyone
export const VIEWER_SEND_EVERY_MS = 400;
export const VIEWER_MAX_PER_MESSAGE = 9;
export const HOST_SEND_EVERY_MS = 500;
export const HOST_MAX_PER_MESSAGE = 50;
export const HOST_MAX_PER_SENDER_PER_SECOND = 20;
export const DRAW_MAX_PER_SECOND = 8;
export const HEARTS_TOTAL_MAX = 1_000_000;
// The most hearts the host keeps waiting to send on (more than this are only counted, not sent on).
const HOST_MAX_WAITING = 200;

// A whole number as plain ASCII digits ("12" → bytes 0x31 0x32). No TextEncoder needed.
export function encodeHearts(count: number): Uint8Array<ArrayBuffer> {
  const text = String(Math.max(0, Math.floor(count)));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

// Reads a message made by encodeHearts. Anything else (letters, a leading 0, too big, too long) → null.
export function decodeHearts(payload: Uint8Array | null | undefined, max: number): number | null {
  if (!payload || payload.length < 1 || payload.length > 2) return null;
  let value = 0;
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i];
    if (byte < 0x30 || byte > 0x39) return null;
    if (i === 0 && byte === 0x30) return null;
    value = value * 10 + (byte - 0x30);
  }
  return value >= 1 && value <= max ? value : null;
}

// A viewer's (or co-host's) taps, sent to the host in small batches.
export class HeartSender {
  private waiting = 0;
  private lastSent = -Infinity;

  // One tap. The heart is drawn on your own screen at once (that's up to the screen).
  tap(): void {
    // Taps beyond what one message can carry are dropped (nobody taps 20+ times a second for real).
    if (this.waiting < VIEWER_MAX_PER_MESSAGE) this.waiting += 1;
  }

  get pending(): number {
    return this.waiting;
  }

  // How many hearts to send now (1–9), or 0 when there's nothing to send or the last message was too recent.
  take(now: number): number {
    if (this.waiting <= 0 || now - this.lastSent < VIEWER_SEND_EVERY_MS) return 0;
    const count = Math.min(this.waiting, VIEWER_MAX_PER_MESSAGE);
    this.waiting = 0;
    this.lastSent = now;
    return count;
  }

  // When the next message may go (ms from `now`), or null when nothing is waiting.
  waitMs(now: number): number | null {
    if (this.waiting <= 0) return null;
    return Math.max(0, this.lastSent + VIEWER_SEND_EVERY_MS - now);
  }
}

// The host: adds up what viewers send, sends the sum on to everyone, and keeps the total.
export class HeartCollector {
  private waiting = 0;
  private sum = 0;
  private perSender = new Map<string, { second: number; count: number }>();

  constructor(private readonly hostId: string) {}

  get total(): number {
    return this.sum;
  }

  // A 'heart' message arrived. Returns how many hearts it counted (0 when it was ignored).
  receive(topic: string | undefined, senderIdentity: string | undefined, payload: Uint8Array | null | undefined, now: number): number {
    if (topic !== HEART_TOPIC || !senderIdentity || senderIdentity === this.hostId) return 0;
    const count = decodeHearts(payload, VIEWER_MAX_PER_MESSAGE);
    if (!count) return 0;
    const second = Math.floor(now / 1000);
    const seen = this.perSender.get(senderIdentity);
    const used = seen && seen.second === second ? seen.count : 0;
    const allowed = Math.max(0, Math.min(count, HOST_MAX_PER_SENDER_PER_SECOND - used));
    if (this.perSender.size > 500 && !seen) this.perSender.clear();
    this.perSender.set(senderIdentity, { second, count: used + allowed });
    if (!allowed) return 0;
    this.add(allowed);
    return allowed;
  }

  // The host's own taps count too (drawn on the host's screen and sent on to everyone).
  tap(): void {
    this.add(1);
  }

  private add(count: number) {
    this.sum = Math.min(HEARTS_TOTAL_MAX, this.sum + count);
    this.waiting = Math.min(HOST_MAX_WAITING, this.waiting + count);
  }

  // Call every 500 ms: how many hearts to send to everyone now (1–50), or 0.
  take(): number {
    if (this.waiting <= 0) return 0;
    const count = Math.min(this.waiting, HOST_MAX_PER_MESSAGE);
    this.waiting -= count;
    return count;
  }
}

// Everyone: is this a 'hearts' message from the host? Returns how many hearts it carries (0 = ignore it).
export function heartsFromHost(
  topic: string | undefined,
  senderIdentity: string | undefined,
  payload: Uint8Array | null | undefined,
  hostId: string,
): number {
  if (topic !== HEARTS_TOPIC || !senderIdentity || !hostId || senderIdentity !== hostId) return 0;
  return decodeHearts(payload, HOST_MAX_PER_MESSAGE) ?? 0;
}

// At most 8 hearts drawn a second, so a flood never slows the phone down. Extra hearts are just not drawn.
export class HeartDrawLimit {
  private second = -1;
  private drawn = 0;

  // How many of `count` hearts to draw now.
  take(count: number, now: number): number {
    const second = Math.floor(now / 1000);
    if (second !== this.second) {
      this.second = second;
      this.drawn = 0;
    }
    const allowed = Math.max(0, Math.min(Math.floor(count), DRAW_MAX_PER_SECOND - this.drawn));
    this.drawn += allowed;
    return allowed;
  }
}
