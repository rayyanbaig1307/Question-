import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { loadTs } from './liveLoad.mjs';

// The live stage (components/live/LiveStage.tsx) with LiveKit replaced by stand-ins: LiveKit is set up once
// without its automatic sound takeover and the app keeps its own URL helpers; the sound is started once and
// stopped once for the host, the viewer and the co-host (watching → stage → watching never stops it in the
// middle); the camera, flip, hearts and LiveKit's events work as the design says.

const HOST = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const REASON = { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 };
const bytes = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const text = (data) => String.fromCharCode(...data);

function setup({ identity = VIEWER, failConnect = false } = {}) {
  const audio = [];
  const log = [];
  const rooms = [];
  const registered = [];
  const OriginalURL = function URL() {};
  const OriginalSearch = function URLSearchParams() {};
  const globals = { URL: OriginalURL, URLSearchParams: OriginalSearch };

  class FakeLocal {
    constructor() {
      this.identity = '';
      this.permissions = { canPublish: true };
      this.trackPublications = new Map();
    }
    async setCameraEnabled(on, options) {
      log.push(['camera', on, options?.facingMode, options?.resolution?.height]);
      if (on && !this.trackPublications.has('camera')) {
        const track = { kind: 'camera', restartTrack: async (o) => { log.push(['restart', o.facingMode]); } };
        this.trackPublications.set('camera', { track });
      }
    }
    async setMicrophoneEnabled(on) {
      log.push(['mic', on]);
      if (on && !this.trackPublications.has('mic')) this.trackPublications.set('mic', { track: { kind: 'mic' } });
    }
    getTrackPublication(source) {
      return source === 'camera' ? this.trackPublications.get('camera') : undefined;
    }
    async unpublishTrack(track, stop) {
      log.push(['unpublish', track.kind, stop]);
      for (const [key, pub] of this.trackPublications) if (pub.track === track) this.trackPublications.delete(key);
    }
    async publishData(data, options) {
      log.push(['data', text(data), JSON.parse(JSON.stringify(options))]);
    }
  }
  class FakeRoom {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.localParticipant = new FakeLocal();
      rooms.push(this);
    }
    on(event, fn) {
      (this.handlers[event] ??= []).push(fn);
      return this;
    }
    emit(event, ...args) {
      for (const fn of this.handlers[event] ?? []) fn(...args);
    }
    async connect(url, token) {
      log.push(['connect', url, token]);
      if (failConnect) throw new Error('could not connect');
      this.localParticipant.identity = identity;
    }
    async disconnect() {
      log.push(['room.disconnect']);
      this.emit('disconnected', REASON.CLIENT_INITIATED);
    }
    removeAllListeners() {
      this.handlers = {};
    }
  }

  const hearts = loadTs('src/lib/liveHearts.ts', {});
  const stageModule = loadTs('src/components/live/LiveStage.tsx', {
    '@livekit/react-native': {
      AudioSession: {
        startAudioSession: async () => { audio.push('start'); },
        stopAudioSession: async () => { audio.push('stop'); },
      },
      setupIOSAudioManagement: (preferSpeaker) => { audio.push(`setup:${preferSpeaker}`); return () => { audio.push('undo'); }; },
      registerGlobals: (options) => {
        registered.push(options);
        // Like the real one: it swaps the URL helpers for its own copy.
        globals.URL = function PolyfillURL() {};
        globals.URLSearchParams = function PolyfillSearch() {};
      },
      RoomContext: { Provider: 'RoomContext.Provider' },
      useTracks: () => [],
      VideoTrack: 'VideoTrack',
      isTrackReference: () => true,
    },
    'livekit-client': {
      DisconnectReason: REASON,
      Room: FakeRoom,
      RoomEvent: {
        Disconnected: 'disconnected', Reconnecting: 'reconnecting', Reconnected: 'reconnected',
        ParticipantPermissionsChanged: 'participantPermissionsChanged', MediaDevicesError: 'mediaDevicesError', DataReceived: 'dataReceived',
      },
      Track: { Source: { Camera: 'camera' } },
      VideoPresets: { h720: { resolution: { width: 1280, height: 720 } } },
    },
    react: { useSyncExternalStore: (_s, get) => get() },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    'react-native': { StyleSheet: { create: (v) => v }, View: 'View' },
    '@/lib/liveHearts': hearts,
  }, { globals });
  return { stage: stageModule, audio, log, rooms, registered, globals, OriginalURL, OriginalSearch };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it('loading the stage sets nothing up yet; the first connect does, once, keeping the app\'s own URL helpers', async () => {
  const t = setup();
  expect(t.registered).toEqual([]);
  expect(t.audio).toEqual([]);
  const stage = t.stage.createStage({ hostId: HOST });
  await stage.connect('wss://x.livekit.cloud', 'tok');
  expect(t.registered).toEqual([{ autoConfigureAudioSession: false }]);
  expect(t.globals.URL).toBe(t.OriginalURL);
  expect(t.globals.URLSearchParams).toBe(t.OriginalSearch);
  await stage.disconnect();
  await stage.connect('wss://x.livekit.cloud', 'tok2');
  t.stage.setUpLiveKitOnce();
  expect(t.registered).toHaveLength(1);
});

it('the room options and the viewer\'s sound: started once, stopped once (a moment after leaving)', async () => {
  const t = setup();
  const stage = t.stage.createStage({ hostId: HOST });
  await stage.connect('wss://x.livekit.cloud', 'tok');
  expect(t.rooms[0].options).toEqual({ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { facingMode: 'user', resolution: { width: 1280, height: 720 } } });
  expect(t.audio).toEqual(['setup:true', 'start']);
  expect(stage.identity()).toBe(VIEWER);
  await stage.disconnect();
  expect(t.log.at(-1)).toEqual(['room.disconnect']);
  expect(t.audio).toEqual(['setup:true', 'start']);
  await vi.advanceTimersByTimeAsync(t.stage.AUDIO_STOP_GRACE_MS);
  expect(t.audio).toEqual(['setup:true', 'start', 'stop', 'undo']);
  // Disconnecting again changes nothing.
  await stage.disconnect();
  await vi.runAllTimersAsync();
  expect(t.audio.filter((a) => a === 'stop')).toHaveLength(1);
});

it('the host: camera (front, 720p) and mic out, flip without republishing, stop sending, sound once', async () => {
  const t = setup({ identity: HOST });
  const stage = t.stage.createStage({ hostId: HOST });
  await stage.connect('wss://x', 'tok');
  await stage.publish('front');
  expect(t.log).toContainEqual(['camera', true, 'user', 720]);
  expect(t.log).toContainEqual(['mic', true]);
  expect(stage.facing()).toBe('front');
  await stage.flip();
  expect(t.log.at(-1)).toEqual(['restart', 'environment']);
  expect(stage.facing()).toBe('back');
  await stage.setMic(false);
  expect(t.log.at(-1)).toEqual(['mic', false]);
  await stage.setCamera(false);
  expect(t.log.at(-1)).toEqual(['camera', false, 'environment', 720]);
  await stage.unpublish();
  expect(t.log.filter((e) => e[0] === 'unpublish')).toEqual([['unpublish', 'camera', true], ['unpublish', 'mic', true]]);
  await stage.disconnect();
  await vi.runAllTimersAsync();
  expect(t.audio).toEqual(['setup:true', 'start', 'stop', 'undo']);
});

it('watching → on stage → watching keeps the sound on the whole time (started once, stopped once)', async () => {
  const t = setup();
  const stage = t.stage.createStage({ hostId: HOST });
  await stage.connect('wss://x', 'viewer-token');
  await stage.disconnect({ keepAudio: true });
  await vi.advanceTimersByTimeAsync(5000);
  await stage.connect('wss://x', 'cohost-token');
  await stage.publish('front');
  await stage.unpublish();
  await stage.disconnect({ keepAudio: true });
  await vi.advanceTimersByTimeAsync(5000);
  await stage.connect('wss://x', 'viewer-token-2');
  expect(t.audio).toEqual(['setup:true', 'start']);
  await stage.disconnect();
  await vi.runAllTimersAsync();
  expect(t.audio).toEqual(['setup:true', 'start', 'stop', 'undo']);
});

it('a plain disconnect and reconnect a moment later doesn\'t stop the sound in the middle either', async () => {
  const t = setup();
  const stage = t.stage.createStage({ hostId: HOST });
  await stage.connect('wss://x', 'a');
  await stage.disconnect();
  await vi.advanceTimersByTimeAsync(t.stage.AUDIO_STOP_GRACE_MS - 100);
  await stage.connect('wss://x', 'b');
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.audio).toEqual(['setup:true', 'start']);
  await stage.disconnect();
  await vi.runAllTimersAsync();
  expect(t.audio).toEqual(['setup:true', 'start', 'stop', 'undo']);
});

it('two stages open at once share one sound session', async () => {
  const t = setup();
  const a = t.stage.createStage({ hostId: HOST });
  const b = t.stage.createStage({ hostId: HOST });
  await a.connect('wss://x', 'a');
  await b.connect('wss://x', 'b');
  await a.disconnect();
  await vi.runAllTimersAsync();
  expect(t.audio).toEqual(['setup:true', 'start']);
  await b.disconnect();
  await vi.runAllTimersAsync();
  expect(t.audio).toEqual(['setup:true', 'start', 'stop', 'undo']);
});

it('a failed connect still stops the sound on disconnect (and can be tried again)', async () => {
  const t = setup({ failConnect: true });
  const stage = t.stage.createStage({ hostId: HOST });
  await expect(stage.connect('wss://x', 'tok')).rejects.toThrow('could not connect');
  expect(stage.room()).toBe(null);
  await expect(stage.connect('wss://x', 'tok')).rejects.toThrow();
  expect(t.audio).toEqual(['setup:true', 'start']);
  await stage.disconnect();
  await vi.runAllTimersAsync();
  expect(t.audio).toEqual(['setup:true', 'start', 'stop', 'undo']);
});

it('after the background, the sound is started again only while a live is open', async () => {
  const t = setup();
  await t.stage.resumeLiveAudio();
  expect(t.audio).toEqual([]);
  const stage = t.stage.createStage({ hostId: HOST });
  await stage.connect('wss://x', 'tok');
  await t.stage.resumeLiveAudio();
  expect(t.audio).toEqual(['setup:true', 'start', 'start']);
  await stage.disconnect();
});

it('LiveKit\'s events reach the screen with the design\'s names; our own disconnect isn\'t reported', async () => {
  const t = setup();
  const seen = [];
  const stage = t.stage.createStage({
    hostId: HOST,
    onDisconnected: (reason) => seen.push(['disconnected', reason]),
    onReconnecting: () => seen.push(['reconnecting']),
    onReconnected: () => seen.push(['reconnected']),
    onPublishAllowed: (allowed) => seen.push(['publish', allowed]),
    onMediaError: () => seen.push(['media']),
  });
  for (const [code, reason] of [[REASON.ROOM_DELETED, 'room_deleted'], [REASON.PARTICIPANT_REMOVED, 'removed'], [REASON.DUPLICATE_IDENTITY, 'duplicate'], [99, 'other'], [undefined, 'other']]) {
    await stage.connect('wss://x', 'tok');
    const room = t.rooms.at(-1);
    room.emit('reconnecting');
    room.emit('reconnected');
    room.localParticipant.permissions = { canPublish: false };
    room.emit('participantPermissionsChanged', undefined, room.localParticipant);
    room.emit('participantPermissionsChanged', undefined, { identity: 'someone-else', permissions: {} });
    room.emit('mediaDevicesError', new Error('mic'));
    room.emit('disconnected', code);
    expect(seen.splice(0)).toEqual([['reconnecting'], ['reconnected'], ['publish', false], ['media'], ['disconnected', reason]]);
    expect(stage.room()).toBe(null);
  }
  await stage.connect('wss://x', 'tok');
  await stage.disconnect();
  expect(seen).toEqual([]);
  // Events from an old room are ignored.
  const old = t.rooms.at(-1);
  await stage.connect('wss://x', 'tok');
  old.emit('reconnecting');
  expect(seen).toEqual([]);
});

it('hearts: only what the design allows is acted on', async () => {
  // The host's stage: viewers' hearts count (with the sender from the 6th argument, even for a hidden viewer).
  const h = setup({ identity: HOST });
  const got = [];
  const hostStage = h.stage.createStage({ hostId: HOST, onHeartFromViewer: (who, n) => got.push(['heart', who, n]), onHearts: (n) => got.push(['hearts', n]) });
  await hostStage.connect('wss://x', 'tok');
  const room = h.rooms[0];
  room.emit('dataReceived', bytes('3'), undefined, 1, 'heart', 0, VIEWER);
  room.emit('dataReceived', bytes('3'), { identity: VIEWER }, 1, 'heart', 0, undefined);
  room.emit('dataReceived', bytes('3'), undefined, 1, 'heart', 0, HOST); // "from" the host itself
  room.emit('dataReceived', bytes('12'), undefined, 1, 'heart', 0, VIEWER); // too many
  room.emit('dataReceived', bytes('3'), undefined, 1, 'chat', 0, VIEWER); // anything else
  room.emit('dataReceived', bytes('3'), undefined, 1, undefined, 0, VIEWER);
  expect(got).toEqual([['heart', VIEWER, 3], ['heart', VIEWER, 3]]);
  await hostStage.broadcastHearts(25);
  expect(h.log.at(-1)).toEqual(['data', '25', { reliable: false, topic: 'hearts' }]);
  await hostStage.broadcastHearts(51);
  await hostStage.broadcastHearts(0);
  expect(h.log.filter((e) => e[0] === 'data')).toHaveLength(1);

  // A viewer's stage: hearts go to the host only; only the host's "hearts" are drawn; viewers' "heart" ignored.
  const v = setup({ identity: VIEWER });
  const drawn = [];
  const viewerStage = v.stage.createStage({ hostId: HOST, onHeartFromViewer: () => drawn.push('wrong'), onHearts: (n) => drawn.push(n) });
  await viewerStage.connect('wss://x', 'tok');
  const vroom = v.rooms[0];
  vroom.emit('dataReceived', bytes('7'), undefined, 1, 'hearts', 0, HOST);
  vroom.emit('dataReceived', bytes('7'), undefined, 1, 'hearts', 0, VIEWER);
  vroom.emit('dataReceived', bytes('7'), undefined, 1, 'heart', 0, '33333333-3333-4333-8333-333333333333');
  expect(drawn).toEqual([7]);
  await viewerStage.sendHearts(4, HOST);
  expect(v.log.at(-1)).toEqual(['data', '4', { reliable: false, topic: 'heart', destinationIdentities: [HOST] }]);
  await viewerStage.sendHearts(10, HOST);
  await viewerStage.sendHearts(0, HOST);
  await viewerStage.sendHearts(2, '');
  await viewerStage.broadcastHearts(5); // not the host: never sent to everyone
  expect(v.log.filter((e) => e[0] === 'data')).toHaveLength(1);
});

it('the web twin shows nothing and loads nothing', async () => {
  const required = [];
  const web = loadTs('src/components/live/LiveStage.web.tsx', {}, { required });
  expect(required).toEqual([]);
  expect(web.StageView({ stage: null, hostId: HOST })).toBe(null);
  const stage = web.createStage({ hostId: HOST });
  await expect(stage.connect('wss://x', 't')).rejects.toThrow();
  expect(stage.room()).toBe(null);
});
