import { AlphaType, ColorType, Skia, type SkImage } from '@shopify/react-native-skia';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { CommonResolutions, useFrameOutput, type CameraFrameOutput, type CameraOutput, type Frame, type FrameDroppedReason } from 'react-native-vision-camera';
import { createSynchronizable, scheduleOnUI, type Synchronizable } from 'react-native-worklets';

import {
  FRAME_DELAY,
  FRAME_ERROR_MIN,
  FRAME_ERROR_RATE,
  FRAME_ERROR_WINDOW_MS,
  FRAME_PATH,
  FRAME_PIXEL_FORMAT,
  markFramesBroken,
  STALE_MS,
} from '@/lib/frameAccess';
import { WARP_STAT_NAMES, type WarpStats } from '@/lib/lensDiagnostics';

import {
  errorVerdict,
  framesPerSecondX10,
  isStale,
  newFrameRate,
  newTurnVotes,
  nextFrameRate,
  probeDue,
  voteTurn,
  type FrameRate,
} from './feedLogic';
import { connectionTurn, iosShotTurn, MIRROR_FRONT, type FrameShot } from './frameMatrix';
import { warpEffects } from './warpEffects';

// ---------------------------------------------------------------------------
// Hands the camera's own pictures to the screen, for the 4 stretchy filters (🫥 🗿 😃 👾). The overlay
// (LensOverlay.tsx) then draws the whole camera picture itself, stretched, over the normal camera view.
//
// ONLY load this file when FRAME_ACCESS_AVAILABLE is true (lib/frameAccess.ts): it uses the camera's
// useFrameOutput, which needs react-native-vision-camera-worklets, and only the newest downloads have that.
// SoftGlowCamera.tsx loads it like this, the first time a stretchy filter is picked, so people who never pick
// one pay nothing:
//
//   const FrameFeed = FRAME_ACCESS_AVAILABLE ? require('./warp/FrameFeed').FrameFeed : null;
//
// Once there, it stays until the camera closes (adding or removing it restarts the camera's set-up, which
// flashes the picture). While another filter is on (or the camera page is away), `inUse` is false: the camera
// thread then hands every picture straight back, nothing is kept, and the drawing thread's check below is paused.
//
// How a picture travels (no copy on iPhone):
// - camera thread (onFrame): takes the picture's GPU buffer, puts it in the "mailbox" (one picture at a time,
//   the newest wins) and lets go of the one that was waiting, if the screen never took it;
// - drawing thread (every screen frame): takes the picture out of the mailbox, turns it into a Skia image and
//   keeps the last FRAME_DELAY + 1 of them; the oldest is shown, so the picture matches the face points
//   (they come a moment later than the picture). A picture that fails is skipped: the last good one stays;
// - no new picture: the last good one stays on screen for up to STALE_MS (1 s). After that nothing is shown,
//   so the normal camera view shows through.
// Only if most pictures fail for a while do the stretchy filters switch themselves off (until the app is closed).
//
// One FrameFeed is for one camera (selfie or back) for its whole life: SoftGlowCamera gives it a `key`, so
// flipping the camera while a stretchy filter is on throws this one away (with every picture it kept) and starts
// a new one for the other camera. Flipping while another filter is on keeps this one (its pictures aren't wanted,
// so they go straight back, and the camera is set up only once); it is swapped for the other camera's only when a
// stretchy filter is picked again. Why not one FrameFeed for both cameras: a picture can't say which camera it
// came from, and for a moment after a flip the old camera's pictures still come. Drawn with the other camera's
// turn, they would flash upside down. Each picture says itself whether it is mirrored and how it is turned.
//
// The readout on the testing channel (WarpDiagnostics.tsx) gets this FrameFeed's counts through `onStats`.
// ---------------------------------------------------------------------------

// A picture waiting in the mailbox: the camera's buffer (`ptr`, iPhone) or a copy (`image`, Android), its
// size, the camera's label for it (degrees) and when the camera took it (seconds, the camera's own clock).
type Mail = {
  ptr: bigint | null;
  image: SkImage | null;
  w: number;
  h: number;
  label: number;
  at: number;
};

const SHARE = FRAME_PATH === 'share';
// iPhone: the picture's turn comes from our own rule (frameMatrix.ts iosShotTurn), because the camera's label is
// wrong for the selfie camera. Android (switched off, WARPS_ON_ANDROID): the camera's label as it is – not yet
// checked on a phone.
const IOS = Platform.OS === 'ios';
// A camera picture counts as black when its middle is darker than this (0–255).
const DARK_LEVEL = 10;

// Lets go of a picture nobody will show (either kind). Runs on any thread.
function dropMail(mail: Mail | null) {
  'worklet';
  if (!mail) return;
  if (mail.ptr) Skia.NativeBuffer.Release(mail.ptr);
  else if (mail.image) mail.image.dispose();
}

// Takes the picture out of the mailbox (null if there is none). Any thread.
function takeMail(mailbox: Synchronizable<Mail | null>): Mail | null {
  'worklet';
  mailbox.lock();
  try {
    const mail = mailbox.getBlocking();
    if (mail) mailbox.setBlocking(null);
    return mail;
  } finally {
    mailbox.unlock();
  }
}

// Lets go of every kept picture. Drawing thread.
function dropRing(ring: FrameShot[]) {
  'worklet';
  for (const old of ring) {
    try {
      old.image.dispose();
    } catch {
      // Already gone.
    }
  }
}

// The pictures aren't wanted any more: lets go of `mail` (taken out of the mailbox, or null) and of every kept
// picture, shows nothing and starts the timing afresh. Drawing thread.
function forgetPictures(
  mail: Mail | null,
  ring: SharedValue<FrameShot[]>,
  shot: SharedValue<FrameShot | null>,
  lastAt: SharedValue<number>,
  rate: SharedValue<FrameRate>,
) {
  'worklet';
  try {
    dropMail(mail);
  } catch {
    // Nothing more to do.
  }
  if (ring.value.length > 0) {
    dropRing(ring.value);
    ring.value = [];
  }
  if (shot.value !== null) shot.set(null);
  if (lastAt.value !== 0) lastAt.value = 0;
  if (rate.value.last !== 0) rate.value = newFrameRate();
}

// Is the middle of this camera picture black? A tiny read-back from the graphics chip (the drawing thread waits
// for it), so only for the testing readout and only now and then (feedLogic.ts probeDue). null if it can't tell
// (that is not an error).
function looksDark(image: SkImage, w: number, h: number): boolean | null {
  'worklet';
  try {
    const pixels = image.readPixels(Math.max(0, Math.floor(w / 2) - 2), Math.max(0, Math.floor(h / 2) - 2), {
      width: 4,
      height: 4,
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Premul,
    });
    if (!pixels || pixels.length < 64) return null;
    let sum = 0;
    for (let i = 0; i < 64; i += 4) sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    return sum / 16 < DARK_LEVEL;
  } catch {
    return null;
  }
}

export function FrameFeed({ shot, onOutput, facing, inUse, onStats, probeDark = false }: {
  // Where the picture to show goes (read by LensOverlay.tsx). null = nothing to show.
  shot: SharedValue<FrameShot | null>;
  // Hands the camera output up to the camera (null when this goes away).
  onOutput: (output: CameraOutput | null) => void;
  // Which camera the pictures come from (never changes for one FrameFeed: see the top of this file).
  facing: 'front' | 'back';
  // True while a stretchy filter is on and the camera is showing. False: pictures go straight back, nothing is
  // kept and the drawing thread's check is paused.
  inUse: boolean;
  // Hands this FrameFeed's counts up for the testing readout (null when this goes away).
  onStats?: (stats: WarpStats | null) => void;
  // Testing readout only: check now and then whether the camera's pictures are black.
  probeDark?: boolean;
}) {
  // The selfie camera's pictures are drawn mirrored, like the normal camera view.
  const front = facing === 'front';
  const mirror = MIRROR_FRONT && front;
  // Shared between the camera thread, the drawing thread and the main thread.
  const box = useMemo(
    () => ({
      mailbox: createSynchronizable<Mail | null>(null),
      // False once this is going away: the camera thread stops taking pictures.
      wanted: createSynchronizable(true, { fixedType: true }),
      // The `inUse` and `probeDark` props, for the other threads.
      inUse: createSynchronizable(false, { fixedType: true }),
      probeDark: createSynchronizable(false, { fixedType: true }),
    }),
    [],
  );
  // The counts (lib/lensDiagnostics.ts): what the camera thread, the drawing thread and the main thread saw.
  const stats = useMemo(() => {
    const made = {} as WarpStats;
    for (const name of WARP_STAT_NAMES) made[name] = createSynchronizable(0, { fixedType: true });
    return made;
  }, []);
  // Drawing thread: the pictures kept (newest last), when the last one came, the camera's label as voted on,
  // how fast pictures come, when the last black check was, and whether one is due soon (the pictures (re)started).
  const ring = useSharedValue<FrameShot[]>([]);
  const lastAt = useSharedValue(0);
  const votes = useSharedValue(newTurnVotes());
  const rate = useSharedValue(newFrameRate());
  const lastProbe = useSharedValue(0);
  const probeSoon = useSharedValue(false);
  // The camera output, once it exists: the camera thread reads which way the phone is held from it.
  const [output, setOutput] = useState<CameraFrameOutput | null>(null);

  useEffect(() => {
    box.probeDark.setDirty(probeDark);
  }, [box, probeDark]);

  // Camera thread: one call for every camera picture. Must be quick and must always let go of the frame.
  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      // What we hold right now and must let go of if anything goes wrong: the camera's buffer (until it is in
      // a picture), then the picture (until it is in the mailbox).
      let buffer: { release: () => void } | null = null;
      let pending: Mail | null = null;
      try {
        // Not wanted right now (another filter is on, or this is going away): straight back to the camera.
        if (!box.wanted.getDirty() || !box.inUse.getDirty()) return;
        stats.attempts.setDirty(stats.attempts.getDirty() + 1);
        const native = frame.getNativeBuffer();
        buffer = native;
        const label = connectionTurn(frame.orientation, output ? output.outputOrientation : 'up');
        if (SHARE) {
          // The buffer is ours now (+1); whoever takes it out of the mailbox lets go of it.
          pending = { ptr: native.pointer, image: null, w: frame.width, h: frame.height, label, at: frame.timestamp };
          buffer = null;
        } else {
          // Android: the camera wants its buffer back soon, so make a copy and let go of the buffer at once.
          const texture = Skia.Image.MakeImageFromNativeBuffer(native.pointer);
          const copy = texture.makeNonTextureImage();
          texture.dispose();
          native.release();
          buffer = null;
          if (!copy) throw new Error('Could not copy the camera picture');
          pending = { ptr: null, image: copy, w: frame.width, h: frame.height, label, at: frame.timestamp };
        }
        let old: Mail | null = null;
        box.mailbox.lock();
        try {
          // Asked again here: if the pictures stopped being wanted meanwhile, the drawing thread may already have
          // emptied the mailbox for the last time, so nothing may go in any more.
          if (box.wanted.getDirty() && box.inUse.getDirty()) {
            old = box.mailbox.getBlocking();
            box.mailbox.setBlocking(pending);
            pending = null;
          }
        } finally {
          box.mailbox.unlock();
        }
        // The screen never took the one before: let go of it.
        dropMail(old);
      } catch {
        stats.camErr.setDirty(stats.camErr.getDirty() + 1);
      } finally {
        try {
          if (buffer) buffer.release();
          // Not in the mailbox (this is going away, or something failed): let go of it.
          dropMail(pending);
        } catch {
          stats.camErr.setDirty(stats.camErr.getDirty() + 1);
        }
        frame.dispose();
      }
    },
    [box, stats, output],
  );

  // Main thread: count the pictures the camera had to drop, by reason ('out-of-buffers' = it ran out of
  // pictures, which happens when pictures are held too long). For the testing readout.
  const onFrameDropped = useCallback(
    (reason: FrameDroppedReason) => {
      stats.drop.setDirty(stats.drop.getDirty() + 1);
      if (reason === 'out-of-buffers') stats.oob.setDirty(stats.oob.getDirty() + 1);
    },
    [stats],
  );

  const frameOutput = useFrameOutput({
    // iPhone: the camera's own YUV pictures (Skia reads them directly; lib/frameAccess.ts FRAME_PIXEL_FORMAT).
    // Android: whatever the camera uses.
    pixelFormat: IOS ? FRAME_PIXEL_FORMAT : 'native',
    // iOS 17+: pictures about the size of the screen (smaller and quicker). This is why iOS 17 is needed.
    enablePreviewSizedOutputBuffers: true,
    // Android only. Without a "resolution bias" this doesn't change the camera's format (the photo stays).
    targetResolution: CommonResolutions.HD_4_3,
    dropFramesWhileBusy: true,
    allowDeferredStart: true,
    // The camera never turns its pictures (that would cost a GPU pass and change their size when the phone
    // turns): frameMatrix.ts stands them up while drawing.
    enablePhysicalBufferRotation: false,
    onFrameDropped,
    onFrame,
  });

  // The camera thread reads the output (which way the phone is held), so give it the output once it exists
  // (this draws once more, straight away, with the output in onFrame).
  if (output !== frameOutput) setOutput(frameOutput);

  // Hand the output to the camera while this is on.
  useEffect(() => {
    onOutput(frameOutput);
    return () => onOutput(null);
  }, [frameOutput, onOutput]);

  // Hand the counts to the readout.
  useEffect(() => {
    onStats?.(stats);
    return () => onStats?.(null);
  }, [stats, onStats]);

  // Drawing thread, every screen frame while the pictures are wanted (paused otherwise, see below): take the
  // newest picture out of the mailbox.
  const frames = useFrameCallback((info) => {
    'worklet';
    const mail = takeMail(box.mailbox);
    const now = info.timestamp;
    if (!box.inUse.getDirty()) {
      // Not wanted (a screen frame that came just before the pause): keep nothing. The next stretchy filter
      // starts afresh.
      forgetPictures(mail, ring, shot, lastAt, rate);
      return;
    }
    if (!mail) {
      // Nothing new for a long while (the camera really stopped): show nothing, so the normal camera view shows
      // through. Until then the last good picture stays.
      if (ring.value.length > 0 && isStale(now, lastAt.value, STALE_MS)) {
        dropRing(ring.value);
        ring.value = [];
        shot.set(null);
        lastAt.value = 0;
        stats.gap.setDirty(stats.gap.getDirty() + 1);
        return;
      }
      // Testing readout only: is the picture on screen black? Only in a screen frame with no new picture (never
      // on top of making one) and only now and then (feedLogic.ts probeDue), because the drawing thread waits.
      if (box.probeDark.getDirty() && ring.value.length > 0 && probeDue(now, lastProbe.value, probeSoon.value)) {
        lastProbe.value = now;
        probeSoon.value = false;
        const shown = ring.value[0];
        if (looksDark(shown.image, shown.w, shown.h) === true) stats.dark.setDirty(stats.dark.getDirty() + 1);
      }
      return;
    }
    // How fast pictures come (the camera's own clock, in seconds on iPhone).
    rate.value = nextFrameRate(rate.value, mail.at * 1000);
    stats.fpsX10.setDirty(framesPerSecondX10(rate.value));
    stats.late.setDirty(rate.value.late);
    // The camera's label, voted on, so one odd picture never turns the picture.
    votes.value = voteTurn(votes.value, mail.label);
    const label = votes.value.latched;
    let image: SkImage | null = null;
    try {
      if (mail.ptr) {
        try {
          // A Skia image that uses the camera's buffer directly (no copy). It keeps the buffer alive itself.
          image = Skia.Image.MakeImageFromNativeBuffer(mail.ptr);
        } finally {
          Skia.NativeBuffer.Release(mail.ptr);
        }
      } else {
        image = mail.image;
      }
      if (!image) throw new Error('No camera picture');
      // Never show a picture whose size isn't what the camera said.
      if (!(mail.w > 0) || !(mail.h > 0) || image.width() !== mail.w || image.height() !== mail.h) {
        throw new Error('Camera picture has the wrong size');
      }
    } catch {
      // A failed picture is a skipped picture: the last good one stays on screen.
      if (image) {
        try {
          image.dispose();
        } catch {
          // Already gone.
        }
      }
      stats.uiErr.setDirty(stats.uiErr.getDirty() + 1);
      return;
    }
    const turn = IOS ? iosShotTurn(label, front, mail.w, mail.h) : label;
    // The first picture after the pictures (re)started (nothing was kept): a black check is due soon.
    if (ring.value.length === 0) probeSoon.value = true;
    const next = [...ring.value, { image, w: mail.w, h: mail.h, turn, mirror, label, front }];
    while (next.length > FRAME_DELAY + 1) {
      const gone = next.shift();
      if (gone) {
        try {
          gone.image.dispose();
        } catch {
          // Already gone.
        }
      }
    }
    ring.value = next;
    // The oldest kept picture is shown (FRAME_DELAY pictures back), so it matches the face points.
    shot.set(next[0]);
    lastAt.value = now;
    stats.w.setDirty(mail.w);
    stats.h.setDirty(mail.h);
    stats.label.setDirty(label);
    stats.turn.setDirty(turn);
    stats.mirror.setDirty(mirror ? 1 : 0);
  }, false);

  // Tells the camera thread whether the pictures are wanted, and runs the check above every screen frame only
  // while they are (otherwise it would wake the phone 60–120 times a second for nothing, for as long as the camera
  // is open). When they stop being wanted, everything kept or waiting is let go of at once.
  useEffect(() => {
    box.inUse.setDirty(inUse);
    frames.setActive(inUse);
    if (!inUse) {
      scheduleOnUI(() => {
        'worklet';
        forgetPictures(takeMail(box.mailbox), ring, shot, lastAt, rate);
      });
    }
  }, [box, frames, inUse, ring, shot, lastAt, rate]);

  // Main thread: switch the stretchy filters off if the shaders can't be made (for this download), or if most
  // camera pictures keep failing (only until the app is closed: a few failed pictures are just skipped).
  useEffect(() => {
    if (!warpEffects()) markFramesBroken('The stretchy filters’ shaders could not be made', 'remember');
    let seenAttempts = stats.attempts.getDirty();
    let seenErrors = stats.camErr.getDirty() + stats.uiErr.getDirty();
    const timer = setInterval(() => {
      const attempts = stats.attempts.getDirty();
      const errors = stats.camErr.getDirty() + stats.uiErr.getDirty();
      const failing = errorVerdict(attempts - seenAttempts, errors - seenErrors, FRAME_ERROR_MIN, FRAME_ERROR_RATE);
      seenAttempts = attempts;
      seenErrors = errors;
      if (failing) markFramesBroken('Camera pictures keep failing', 'thisRun');
    }, FRAME_ERROR_WINDOW_MS);
    return () => clearInterval(timer);
  }, [stats]);

  // Going away: stop taking pictures, let go of the one waiting and of the ones kept on the drawing thread.
  useEffect(
    () => () => {
      box.wanted.setDirty(false);
      try {
        // Straight away, here: the camera gets its buffer back sooner.
        dropMail(takeMail(box.mailbox));
      } catch {
        // Nothing more to do.
      }
      scheduleOnUI(() => {
        'worklet';
        forgetPictures(null, ring, shot, lastAt, rate);
      });
    },
    [box, ring, shot, lastAt, rate],
  );

  return null;
}
