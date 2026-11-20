import {
  AudioSession,
  isTrackReference,
  registerGlobals,
  RoomContext,
  setupIOSAudioManagement,
  useTracks,
  VideoTrack,
  type TrackReference,
} from '@livekit/react-native';
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalParticipant,
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';
import { useSyncExternalStore } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import {
  decodeHearts,
  encodeHearts,
  heartsFromHost,
  HEART_TOPIC,
  HEARTS_TOPIC,
  HOST_MAX_PER_MESSAGE,
  VIEWER_MAX_PER_MESSAGE,
} from '@/lib/liveHearts';
import type { StageDisconnectReason } from '@/lib/liveMachine';

// ---------------------------------------------------------------------------
// The live "stage": the ONLY file that loads LiveKit (@livekit/react-native, @livekit/react-native-webrtc
// through it, and livekit-client). It is only ever loaded by loadLiveStage() in lib/liveAccess.ts, after the
// phone was checked for LiveKit's native parts – on older downloads loading it would close the app.
// All the thinking (what to do when) is in lib/liveMachine.ts and lib/liveHearts.ts; this file just connects,
// sends the camera and microphone, shows the video and carries hearts.
// ---------------------------------------------------------------------------

// LiveKit's setup, once, the first time a live is used (never at app start).
let ready = false;
export function setUpLiveKitOnce(): void {
  if (ready) return;
  ready = true;
  // LiveKit swaps the app's own web-address helpers (URL) for its own copy. Ours (Expo's) do everything
  // LiveKit needs, so we keep ours: save them first (reading them also loads Expo's), put them back after.
  const keepURL = globalThis.URL;
  const keepSearch = globalThis.URLSearchParams;
  registerGlobals({ autoConfigureAudioSession: false }); // the WebRTC parts; no automatic sound takeover
  globalThis.URL = keepURL;
  globalThis.URLSearchParams = keepSearch;
}

// ---------------------------------------------------------------------------
// Sound, for every role (host, co-host and viewer). With the automatic sound setup off, nothing else sets the
// iPhone's sound mode for a live: without this a viewer may hear nothing with the silent switch on, and a
// co-host's microphone may not work. The setup is one for the whole app, so it is counted: started by the
// first open live connection and stopped (a moment after) the last one closes, so moving from watching to the
// stage and back never stops the sound in the middle.
// ---------------------------------------------------------------------------

export const AUDIO_STOP_GRACE_MS = 1500;
let audioUsers = 0;
let audioOn = false;
let undoIOS: (() => void) | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

export async function startLiveAudio(): Promise<void> {
  audioUsers += 1;
  if (stopTimer) {
    // A stop was waiting: the sound never went off, so there's nothing to start.
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (audioUsers > 1 || audioOn) return;
  audioOn = true;
  undoIOS = setupIOSAudioManagement(true); // does nothing off iOS
  await AudioSession.startAudioSession();
}

async function stopAudioNow(): Promise<void> {
  stopTimer = null;
  if (audioUsers > 0 || !audioOn) return;
  audioOn = false;
  try {
    await AudioSession.stopAudioSession();
  } finally {
    undoIOS?.();
    undoIOS = null;
  }
}

// Doesn't wait for the sound to stop (it stops AUDIO_STOP_GRACE_MS later, unless a live connects again).
export async function stopLiveAudio(): Promise<void> {
  if (audioUsers === 0) return;
  audioUsers -= 1;
  if (audioUsers > 0) return;
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    stopAudioNow().catch((error) => console.warn('Could not stop the live sound', error));
  }, AUDIO_STOP_GRACE_MS);
}

// After the app was in the background or a phone call: start the sound again (if a live is open).
export async function resumeLiveAudio(): Promise<void> {
  if (audioUsers > 0) await AudioSession.startAudioSession();
}

// ---------------------------------------------------------------------------
// The stage itself.
// ---------------------------------------------------------------------------

export type Facing = 'front' | 'back';

export type StageEvents = {
  // The host's user id: 'hearts' messages count only from them, and 'heart' messages only reach the host.
  hostId: string;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  // The connection ended ('client' = we closed it ourselves).
  onDisconnected?: (reason: StageDisconnectReason) => void;
  // Host only: a viewer sent 1–9 hearts (feed it to a HeartCollector).
  onHeartFromViewer?: (senderIdentity: string, count: number) => void;
  // Everyone: the host sent on 1–50 hearts (draw them, at most 8 a second: HeartDrawLimit).
  onHearts?: (count: number) => void;
  // Your own permission to send video/sound changed (false = the host took you off the stage).
  onPublishAllowed?: (allowed: boolean) => void;
  // The camera or microphone had a problem (or a phone call took the sound).
  onMediaError?: (error: unknown) => void;
};

export type StageHandle = {
  connect(url: string, token: string): Promise<void>;
  // Sends your camera and microphone (host and co-host only).
  publish(facing: Facing): Promise<void>;
  // Stops sending the camera and microphone.
  unpublish(): Promise<void>;
  flip(): Promise<void>;
  setMic(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  // Viewer (or co-host): hearts to the host only.
  sendHearts(count: number, hostId: string): Promise<void>;
  // Host: hearts to everyone.
  broadcastHearts(count: number): Promise<void>;
  // Closes the connection. `keepAudio`: you'll connect again right away (watching → stage → watching).
  disconnect(options?: { keepAudio?: boolean }): Promise<void>;
  // For StageView.
  subscribe(listener: () => void): () => void;
  room(): Room | null;
  facing(): Facing;
  identity(): string | null;
};

function reasonOf(reason: DisconnectReason | undefined): StageDisconnectReason {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return 'client';
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'duplicate';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'removed';
    case DisconnectReason.ROOM_DELETED:
      return 'room_deleted';
    default:
      return 'other';
  }
}

const facingMode = (facing: Facing) => (facing === 'front' ? 'user' : 'environment');

export function createStage(events: StageEvents): StageHandle {
  let current: Room | null = null;
  let facing: Facing = 'front';
  let audioHeld = false;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One listener failing must not stop the others.
      }
    }
  };
  const safely = (work: () => void) => {
    try {
      work();
    } catch (error) {
      console.warn('Live event handler failed', error);
    }
  };

  function watch(room: Room) {
    room
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (room !== current) return;
        current = null;
        tell();
        safely(() => events.onDisconnected?.(reasonOf(reason)));
      })
      .on(RoomEvent.Reconnecting, () => {
        if (room === current) safely(() => events.onReconnecting?.());
      })
      .on(RoomEvent.Reconnected, () => {
        if (room === current) safely(() => events.onReconnected?.());
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_before: unknown, participant: RemoteParticipant | LocalParticipant) => {
        if (room !== current || participant !== room.localParticipant) return;
        safely(() => events.onPublishAllowed?.(participant.permissions?.canPublish !== false));
      })
      .on(RoomEvent.MediaDevicesError, (error: Error) => {
        if (room === current) safely(() => events.onMediaError?.(error));
      })
      // The ONLY data listener. It checks the topic and who sent it; everything else is ignored. (No chat,
      // stream or RPC handlers are ever registered: viewers may send data, so nothing else may act on it.)
      .on(
        RoomEvent.DataReceived,
        (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string, _encryption?: unknown, participantIdentity?: string) => {
          if (room !== current) return;
          const sender = participantIdentity ?? participant?.identity;
          if (topic === HEARTS_TOPIC) {
            const count = heartsFromHost(topic, sender, payload, events.hostId);
            if (count > 0) safely(() => events.onHearts?.(count));
            return;
          }
          if (topic === HEART_TOPIC && room.localParticipant.identity === events.hostId && sender && sender !== events.hostId) {
            const count = decodeHearts(payload, VIEWER_MAX_PER_MESSAGE);
            if (count) safely(() => events.onHeartFromViewer?.(sender, count));
          }
        },
      );
  }

  async function closeRoom(room: Room | null) {
    if (!room) return;
    try {
      await room.disconnect();
    } catch {
      // Already gone.
    }
    room.removeAllListeners();
  }

  const handle: StageHandle = {
    async connect(url, token) {
      setUpLiveKitOnce();
      if (!audioHeld) {
        audioHeld = true;
        try {
          await startLiveAudio();
        } catch (error) {
          console.warn('Could not start the live sound', error);
        }
      }
      const old = current;
      current = null;
      await closeRoom(old);
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { facingMode: facingMode(facing), resolution: VideoPresets.h720.resolution },
      });
      current = room;
      watch(room);
      try {
        await room.connect(url, token);
      } catch (error) {
        // The sound stays counted until disconnect() (the screen calls it after a failed connect, or tries again).
        if (current === room) current = null;
        await closeRoom(room);
        tell();
        throw error;
      }
      if (current !== room) {
        // Disconnected while connecting.
        await closeRoom(room);
        return;
      }
      tell();
    },

    async publish(nextFacing) {
      const room = current;
      if (!room) throw new Error('Not connected');
      facing = nextFacing;
      tell();
      await room.localParticipant.setCameraEnabled(true, { facingMode: facingMode(facing), resolution: VideoPresets.h720.resolution });
      await room.localParticipant.setMicrophoneEnabled(true);
    },

    async unpublish() {
      const room = current;
      if (!room) return;
      const local = room.localParticipant;
      for (const publication of [...local.trackPublications.values()]) {
        if (!publication.track) continue;
        try {
          await local.unpublishTrack(publication.track, true);
        } catch (error) {
          console.warn('Could not stop sending a live track', error);
        }
      }
    },

    async flip() {
      facing = facing === 'front' ? 'back' : 'front';
      tell();
      const track = current?.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
      // Restarts the camera on the other side without telling everyone again (no renegotiation).
      if (track) await track.restartTrack({ facingMode: facingMode(facing), resolution: VideoPresets.h720.resolution });
    },

    async setMic(on) {
      await current?.localParticipant.setMicrophoneEnabled(on);
    },

    async setCamera(on) {
      await current?.localParticipant.setCameraEnabled(on, { facingMode: facingMode(facing), resolution: VideoPresets.h720.resolution });
    },

    async sendHearts(count, hostId) {
      const room = current;
      const n = Math.floor(count);
      if (!room || !hostId || !(n >= 1 && n <= VIEWER_MAX_PER_MESSAGE)) return;
      await room.localParticipant.publishData(encodeHearts(n), { reliable: false, topic: HEART_TOPIC, destinationIdentities: [hostId] });
    },

    async broadcastHearts(count) {
      const room = current;
      const n = Math.floor(count);
      if (!room || room.localParticipant.identity !== events.hostId || !(n >= 1 && n <= HOST_MAX_PER_MESSAGE)) return;
      await room.localParticipant.publishData(encodeHearts(n), { reliable: false, topic: HEARTS_TOPIC });
    },

    async disconnect(options) {
      const room = current;
      current = null;
      tell();
      await closeRoom(room);
      if (audioHeld && !options?.keepAudio) {
        audioHeld = false;
        await stopLiveAudio();
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    room: () => current,
    facing: () => facing,
    identity: () => current?.localParticipant.identity ?? null,
  };
  return handle;
}

// ---------------------------------------------------------------------------
// What viewers see: the host full screen, or the host on top and the co-host below. Only your own front
// camera is mirrored.
// ---------------------------------------------------------------------------

type StageViewProps = { stage: StageHandle; hostId: string; cohostId?: string | null; style?: ViewStyle };

export function StageView({ stage, hostId, cohostId, style }: StageViewProps) {
  const room = useSyncExternalStore(stage.subscribe, stage.room, stage.room);
  const facing = useSyncExternalStore(stage.subscribe, stage.facing, stage.facing);
  if (!room) return <View style={[styles.fill, style]} />;
  return (
    <RoomContext.Provider value={room}>
      <Tiles hostId={hostId} cohostId={cohostId ?? null} facing={facing} style={style} />
    </RoomContext.Provider>
  );
}

function Tiles({ hostId, cohostId, facing, style }: { hostId: string; cohostId: string | null; facing: Facing; style?: ViewStyle }) {
  const refs = useTracks([Track.Source.Camera]);
  const find = (identity: string | null): TrackReference | undefined =>
    identity ? refs.find((ref) => isTrackReference(ref) && ref.participant.identity === identity && !!ref.publication.track) : undefined;
  const host = find(hostId);
  const cohost = cohostId && cohostId !== hostId ? find(cohostId) : undefined;
  const mirror = (participant: Participant) => participant.isLocal && facing === 'front';
  return (
    <View style={[styles.fill, style]}>
      {host ? (
        <VideoTrack trackRef={host} objectFit="cover" style={styles.tile} mirror={mirror(host.participant)} />
      ) : (
        <View style={styles.tile} />
      )}
      {cohost ? <VideoTrack trackRef={cohost} objectFit="cover" style={styles.tile} mirror={mirror(cohost.participant)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  tile: { flex: 1 },
});
