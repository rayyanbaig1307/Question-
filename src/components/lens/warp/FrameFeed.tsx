import { Skia, type SkImage } from '@shopify/react-native-skia';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { CommonResolutions, useFrameOutput, type CameraFrameOutput, type CameraOutput, type Frame } from 'react-native-vision-camera';
import { createSynchronizable, scheduleOnUI } from 'react-native-worklets';

import { FRAME_DELAY, FRAME_PATH, markFramesBroken, STALE_MS } from '@/lib/frameAccess';

import { MIRROR_FRONT, screenTurn, type FrameShot } from './frameMatrix';
import { warpEffects } from './warpEffects';

// ---------------------------------------------------------------------------
// Hands the camera's own pictures to the screen, for the 4 stretchy filters (🫥 🗿 😃 👾). The overlay
// (LensOverlay.tsx) then draws the whole camera picture itself, stretched, over the normal camera view.
//
// ONLY load this file when FRAME_ACCESS_AVAILABLE is true (lib/frameAccess.ts): it uses the camera's
// useFrameOutput, which needs react-native-vision-camera-worklets, and only the newest downloads have that.
// SoftGlowCamera.tsx loads it like this and shows it only while a stretchy filter is on, so the other filters
// pay nothing:
//
//   const FrameFeed = FRAME_ACCESS_AVAILABLE ? require('./warp/FrameFeed').FrameFeed : null;
//
// How a picture travels (no copy on iPhone):
// - camera thread (onFrame): takes the picture's GPU buffer, puts it in the "mailbox" (one picture at a time,
//   the newest wins) and lets go of the one that was waiting, if the screen never took it;
// - drawing thread (every screen frame): takes the picture out of the mailbox, turns it into a Skia image and
//   keeps the last FRAME_DELAY + 1 of them; the oldest is shown, so the picture matches the face points
//   (they come a moment later than the picture);
// - no picture for STALE_MS: nothing is shown, so the normal camera view shows through.
// If the pictures keep failing, the stretchy filters switch themselves off (markFramesBroken).
//
// One FrameFeed is for one camera (selfie or back): SoftGlowCamera gives it `key={facing}`, so flipping the
// camera throws this one away (with every picture it kept) and starts a new one for the other camera. Each
// picture says itself whether it is drawn mirrored, so an old picture is never drawn the wrong way round.
// ---------------------------------------------------------------------------

// A picture waiting in the mailbox: the camera's buffer (`ptr`, iPhone) or a copy (`image`, Android), its
// size and which way it is turned.
type Mail = {
  ptr: bigint | null;
  image: SkImage | null;
  w: number;
  h: number;
  orientation: string;
  outputOrientation: string;
};

// How many failed pictures switch the stretchy filters off.
const MAX_ERRORS = 3;
// How often the main thread checks for failed pictures (milliseconds).
const CHECK_EVERY = 500;

const SHARE = FRAME_PATH === 'share';

// The camera drops a picture now and then when the phone is busy. That's fine (the next one comes at once);
// without this the camera would write a warning for every one.
function ignoreDroppedFrame() {}

// Lets go of a picture nobody will show (either kind). Runs on any thread.
function dropMail(mail: Mail | null) {
  'worklet';
  if (!mail) return;
  if (mail.ptr) Skia.NativeBuffer.Release(mail.ptr);
  else if (mail.image) mail.image.dispose();
}

export function FrameFeed({ shot, onOutput, facing }: {
  // Where the picture to show goes (read by LensOverlay.tsx). null = nothing to show.
  shot: SharedValue<FrameShot | null>;
  // Hands the camera output up to the camera (null when this goes away).
  onOutput: (output: CameraOutput | null) => void;
  // Which camera the pictures come from (never changes for one FrameFeed: see the top of this file).
  facing: 'front' | 'back';
}) {
  // The selfie camera's pictures are drawn mirrored, like the normal camera view.
  const mirror = MIRROR_FRONT && facing === 'front';
  // Shared between the camera thread, the drawing thread and the main thread.
  const box = useMemo(
    () => ({
      mailbox: createSynchronizable<Mail | null>(null),
      // False once this is going away: the camera thread stops taking pictures.
      wanted: createSynchronizable(true, { fixedType: true }),
      // Failed pictures on the camera thread and on the drawing thread.
      errors: createSynchronizable(0, { fixedType: true }),
      drawErrors: createSynchronizable(0, { fixedType: true }),
    }),
    [],
  );
  // The pictures kept on the drawing thread (newest last), and when the last one came.
  const ring = useSharedValue<FrameShot[]>([]);
  const lastAt = useSharedValue(0);
  // The camera output, once it exists: the camera thread reads which way the phone is held from it.
  const [output, setOutput] = useState<CameraFrameOutput | null>(null);

  // Camera thread: one call for every camera picture. Must be quick and must always let go of the frame.
  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      // What we hold right now and must let go of if anything goes wrong: the camera's buffer (until it is in
      // a picture), then the picture (until it is in the mailbox).
      let buffer: { release: () => void } | null = null;
      let pending: Mail | null = null;
      try {
        if (!box.wanted.getDirty()) return;
        const native = frame.getNativeBuffer();
        buffer = native;
        const turned = output ? output.outputOrientation : 'up';
        if (SHARE) {
          // The buffer is ours now (+1); whoever takes it out of the mailbox lets go of it.
          pending = { ptr: native.pointer, image: null, w: frame.width, h: frame.height, orientation: frame.orientation, outputOrientation: turned };
          buffer = null;
        } else {
          // Android: the camera wants its buffer back soon, so make a copy and let go of the buffer at once.
          const texture = Skia.Image.MakeImageFromNativeBuffer(native.pointer);
          const copy = texture.makeNonTextureImage();
          texture.dispose();
          native.release();
          buffer = null;
          if (!copy) throw new Error('Could not copy the camera picture');
          pending = { ptr: null, image: copy, w: frame.width, h: frame.height, orientation: frame.orientation, outputOrientation: turned };
        }
        let old: Mail | null = null;
        box.mailbox.lock();
        try {
          if (box.wanted.getDirty()) {
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
        box.errors.setDirty(box.errors.getDirty() + 1);
      } finally {
        try {
          if (buffer) buffer.release();
          // Not in the mailbox (this is going away, or something failed): let go of it.
          dropMail(pending);
        } catch {
          box.errors.setDirty(box.errors.getDirty() + 1);
        }
        frame.dispose();
      }
    },
    [box, output],
  );

  const frameOutput = useFrameOutput({
    // iPhone: the camera's own YUV pictures (Skia reads them directly). Android: whatever the camera uses.
    pixelFormat: Platform.OS === 'ios' ? 'yuv' : 'native',
    // iOS 17+: pictures about the size of the screen (smaller and quicker). This is why iOS 17 is needed.
    enablePreviewSizedOutputBuffers: true,
    // Android only. Without a "resolution bias" this doesn't change the camera's format (the photo stays).
    targetResolution: CommonResolutions.HD_4_3,
    dropFramesWhileBusy: true,
    allowDeferredStart: true,
    enablePhysicalBufferRotation: false,
    onFrameDropped: ignoreDroppedFrame,
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

  // Drawing thread, every screen frame: take the newest picture out of the mailbox.
  useFrameCallback((info) => {
    'worklet';
    let mail: Mail | null = null;
    box.mailbox.lock();
    try {
      mail = box.mailbox.getBlocking();
      if (mail) box.mailbox.setBlocking(null);
    } finally {
      box.mailbox.unlock();
    }
    const now = info.timestamp;
    if (!mail) {
      // Nothing new for a while: show nothing, so the normal camera view shows through.
      if (ring.value.length > 0 && now - lastAt.value > STALE_MS) {
        for (const old of ring.value) old.image.dispose();
        ring.value = [];
        shot.set(null);
      }
      return;
    }
    try {
      let image: SkImage | null = mail.image;
      if (mail.ptr) {
        try {
          // A Skia image that uses the camera's buffer directly (no copy). It keeps the buffer alive itself.
          image = Skia.Image.MakeImageFromNativeBuffer(mail.ptr);
        } finally {
          Skia.NativeBuffer.Release(mail.ptr);
        }
      }
      if (!image) throw new Error('No camera picture');
      const next = [...ring.value, { image, w: mail.w, h: mail.h, turn: screenTurn(mail.orientation, mail.outputOrientation), mirror }];
      while (next.length > FRAME_DELAY + 1) {
        const gone = next.shift();
        if (gone) gone.image.dispose();
      }
      ring.value = next;
      // The oldest kept picture is shown (FRAME_DELAY pictures back), so it matches the face points.
      shot.set(next[0]);
      lastAt.value = now;
    } catch {
      box.drawErrors.setDirty(box.drawErrors.getDirty() + 1);
    }
  });

  // Main thread: switch the stretchy filters off if pictures keep failing, or the shaders can't be made.
  useEffect(() => {
    if (!warpEffects()) markFramesBroken('The stretchy filters’ shaders could not be made');
    const timer = setInterval(() => {
      if (box.errors.getDirty() >= MAX_ERRORS || box.drawErrors.getDirty() >= MAX_ERRORS) {
        markFramesBroken('Camera pictures keep failing');
      }
    }, CHECK_EVERY);
    return () => clearInterval(timer);
  }, [box]);

  // Going away: stop taking pictures, let go of the one waiting and of the ones kept on the drawing thread.
  useEffect(
    () => () => {
      box.wanted.setDirty(false);
      let waiting: Mail | null = null;
      box.mailbox.lock();
      try {
        waiting = box.mailbox.getBlocking();
        box.mailbox.setBlocking(null);
      } finally {
        box.mailbox.unlock();
      }
      try {
        dropMail(waiting);
      } catch {
        // Nothing more to do.
      }
      scheduleOnUI(() => {
        'worklet';
        for (const old of ring.value) old.image.dispose();
        ring.value = [];
        shot.set(null);
      });
    },
    [box, ring, shot],
  );

  return null;
}
