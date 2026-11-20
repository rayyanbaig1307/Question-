import type * as Native from './LiveStage';

// ---------------------------------------------------------------------------
// The website version of LiveStage.tsx: lives never run on the web, so this loads nothing (LiveKit must never
// get into the website bundle) and shows nothing. Same names as LiveStage.tsx.
// ---------------------------------------------------------------------------

export type Facing = Native.Facing;
export type StageEvents = Native.StageEvents;
export type StageHandle = Native.StageHandle;

export const AUDIO_STOP_GRACE_MS = 1500;

export function setUpLiveKitOnce(): void {}
export async function startLiveAudio(): Promise<void> {}
export async function stopLiveAudio(): Promise<void> {}
export async function resumeLiveAudio(): Promise<void> {}

export function createStage(_events: StageEvents): StageHandle {
  const nothing = async () => {};
  return {
    connect: async () => {
      throw new Error("Lives aren't on the web.");
    },
    publish: nothing,
    unpublish: nothing,
    flip: nothing,
    setMic: nothing,
    setCamera: nothing,
    sendHearts: nothing,
    broadcastHearts: nothing,
    disconnect: nothing,
    subscribe: () => () => {},
    room: () => null,
    facing: () => 'front',
    identity: () => null,
  };
}

export function StageView(_props: Parameters<typeof Native.StageView>[0]) {
  return null;
}

// Type check only: the web version must have every name the phone version has.
type Same = { [K in keyof typeof Native]: unknown };
const _same: Same = { setUpLiveKitOnce, startLiveAudio, stopLiveAudio, resumeLiveAudio, createStage, StageView, AUDIO_STOP_GRACE_MS };
void _same;
