import type { SkImage } from '@shopify/react-native-skia';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { useSharedValue } from 'react-native-reanimated';

import { FRAME_WAIT_MS, LIVE_FACE_FROM_CAMERA, NO_FACE, POSTER_H, POSTER_W, SNAP_FROM_SCREEN, SNAP_TIMEOUT_MS } from '@/lib/mainCharacter/config';
import type { CharacterArt, SceneArt } from '@/lib/mainCharacter/types';

import type { LensFace } from '../lens/lensPaint';
import { SoftGlowCamera, type CustomLook, type SoftGlowHandle } from '../lens/SoftGlowCamera';
import { holdScene, noteShown, useArtImages, useDrawingClock } from './artCache';
import { bakeMainCharacter, encodePoster } from './bakeMainCharacter';
import { CameraFollow } from './CameraFollow';
import { comicEffect } from './comicEffect';
import { biggestFace, coverCrop, placeArt } from './fit';
import { MainCharacterOverlay, type McExtra } from './MainCharacterOverlay';
import type { LiveScene } from './paintScene';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the live camera with the poster on it, and the saved poster (docs/MAIN_CHARACTER.md).
// MainCharacterStudio.tsx shows this; only load it where FACE_MESH_AVAILABLE is true (it uses SoftGlowCamera).
//
// It is SoftGlowCamera with a look of its own (`custom`): MainCharacterOverlay draws the poster, CameraFollow moves
// the camera view for the lite way, and bakeMainCharacter makes the poster from the photo. The pictures are read
// ahead by the art cache (the character, its neighbours for a quick swipe, and the scene).
//
// capture() makes the clean poster (no watermark):
// 1. no face seen in the last second → it throws NO_FACE ('no-face', config.ts; the screen says "look at the
//    camera"). The photo bake throws the same when the face is gone by the time of the photo;
// 2. the character and scene are copied at the press and held until the poster is made, so swiping meanwhile
//    can't change it;
// 3. the full way (camera pictures on): the poster is drawn once more from exactly what the screen shows;
// 4. otherwise (or when that gives nothing within SNAP_TIMEOUT_MS): the photo way, through SoftGlowCamera.
// ---------------------------------------------------------------------------

export type MainCharacterCameraHandle = { capture(): Promise<{ uri: string }> };

// What capture() hands the photo bake: the poster as it was at the press.
type Press = { scene: LiveScene };

// A face counts as "seen" for this long after the face finder last saw one (milliseconds).
const FACE_MEMORY_MS = 1000;
const NO_CROP = { x: 0, y: 0, w: 0, h: 0 };

// The character and scene ready to draw, or null while the character's picture isn't read yet.
function makeLiveScene(character: CharacterArt | null, characterImage: SkImage | null, scene: SceneArt | null,
  sceneImage: SkImage | null): LiveScene | null {
  if (!character || !characterImage) return null;
  try {
    return {
      key: `${character.key}|${scene && sceneImage ? scene.key : 'no-scene'}`,
      character: characterImage,
      characterCrop: coverCrop(characterImage.width(), characterImage.height(), POSTER_W / POSTER_H),
      background: sceneImage,
      backgroundCrop: sceneImage ? coverCrop(sceneImage.width(), sceneImage.height(), POSTER_W / POSTER_H) : NO_CROP,
      art: placeArt(character.anchors),
    };
  } catch (error) {
    console.warn('Main Character: this character could not be set up', error);
    return null;
  }
}

// Lets go of one Skia object (it may already be gone).
function letGo(thing: { dispose: () => void } | null) {
  if (!thing) return;
  try {
    thing.dispose();
  } catch {
    // Already gone: nothing more to do.
  }
}

export function MainCharacterCamera({ ref, active, facing, character, scene, nearby, forceLite, onFaceSeen, onLoading }: {
  ref: Ref<MainCharacterCameraHandle>;
  active: boolean;
  facing: 'front' | 'back';
  character: CharacterArt | null;
  scene: SceneArt | null;
  nearby: CharacterArt[];               // previous and next, read early
  forceLite: boolean;                   // testing-channel FULL/LITE pill
  onFaceSeen?: (seen: boolean) => void; // changes only
  onLoading?: (loading: boolean) => void;
}) {
  const glow = useRef<SoftGlowHandle | null>(null);

  // The pictures: the character and its scene first (read first), then the neighbours.
  const want: (CharacterArt | SceneArt)[] = [];
  for (const art of [character, scene, ...nearby]) {
    if (art && !want.some((other) => other.key === art.key)) want.push(art);
  }
  const { images, failed } = useArtImages(want);
  const characterImage = character ? images.get(character.key) ?? null : null;
  const sceneImage = scene ? images.get(scene.key) ?? null : null;
  // Wait for the scene too (no flash of an empty sky), unless it can't be read.
  const sceneSettled = !scene || sceneImage !== null || failed.has(scene.key);
  const next = useMemo(
    () => (sceneSettled ? makeLiveScene(character, characterImage, scene, sceneImage) : null),
    [character, characterImage, scene, sceneImage, sceneSettled],
  );
  const busy = character !== null && next === null && !failed.has(character.key);

  // The values the live drawing reads (made once and handed over through SoftGlowCamera's `custom.extra`).
  const liveScene = useSharedValue<LiveScene | null>(null);
  const cameraPictures = useSharedValue(!forceLite);
  const drawn = useSharedValue(0);
  const snapAsk = useSharedValue(0);
  const [fx] = useState(comicEffect);
  // The shown poster, for capture() (the JS thread's copy of `liveScene`).
  const shown = useRef<LiveScene | null>(null);
  // Snapshots asked for and not answered yet (by ask number).
  const waiters = useRef(new Map<number, (image: SkImage | null) => void>());
  const asks = useRef(0);
  // Faces: when one was last seen, what the screen was last told, and the timer that says "gone".
  const lastFaceAt = useRef(0);
  const toldSeen = useRef<boolean | null>(null);
  const lostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const faceSeenListener = useRef(onFaceSeen);
  const loadingListener = useRef(onLoading);

  useDrawingClock(drawn);

  // A new poster is ready: show it (the old one stays until then, so a swipe never flashes).
  useEffect(() => {
    if (!next) return;
    shown.current = next;
    liveScene.set(next);
    noteShown(next, drawn.get());
  }, [next, liveScene, drawn]);

  useEffect(() => {
    cameraPictures.set(!forceLite);
  }, [cameraPictures, forceLite]);

  useEffect(() => {
    faceSeenListener.current = onFaceSeen;
    loadingListener.current = onLoading;
  }, [onFaceSeen, onLoading]);

  // The screen's spinner: only when it changes.
  useEffect(() => {
    try {
      loadingListener.current?.(busy);
    } catch (error) {
      console.warn('Main Character: loading listener', error);
    }
  }, [busy]);

  // Closing: stop the face timer, and any snapshot still waited for gets nothing (the photo way).
  useEffect(() => {
    const pending = waiters.current;
    return () => {
      if (lostTimer.current) clearTimeout(lostTimer.current);
      for (const answer of [...pending.values()]) answer(null);
      pending.clear();
    };
  }, []);

  // The drawing thread's answer to a snapshot ask. Nobody waits any more (timed out): let it go at once.
  const onSnap = useCallback((ask: number, image: SkImage | null) => {
    const answer = waiters.current.get(ask);
    if (answer) {
      waiters.current.delete(ask);
      answer(image);
    } else {
      letGo(image);
    }
  }, []);

  const tellSeen = useCallback((seen: boolean) => {
    if (toldSeen.current === seen) return;
    toldSeen.current = seen;
    try {
      faceSeenListener.current?.(seen);
    } catch (error) {
      console.warn('Main Character: face seen listener', error);
    }
  }, []);

  // JS thread, every time the face finder answers.
  const handleFaces = useCallback((found: LensFace[]) => {
    if (!biggestFace(found)) return;
    lastFaceAt.current = Date.now();
    tellSeen(true);
    if (lostTimer.current) clearTimeout(lostTimer.current);
    lostTimer.current = setTimeout(() => {
      lostTimer.current = null;
      tellSeen(false);
    }, FACE_MEMORY_MS);
  }, [tellSeen]);

  const extra = useMemo<McExtra>(
    () => ({ scene: liveScene, fx, cameraPictures, drawn, snapAsk, onSnap }),
    [liveScene, fx, cameraPictures, drawn, snapAsk, onSnap],
  );
  const look = useMemo<CustomLook<McExtra>>(
    () => ({
      wantsFrames: LIVE_FACE_FROM_CAMERA,
      Overlay: MainCharacterOverlay,
      CameraWrap: CameraFollow,
      extra,
      frameWaitMs: FRAME_WAIT_MS,
      bake: (photoUri, faces, view, press) => {
        const at = (press as Press | null | undefined)?.scene;
        if (!at) return Promise.reject(new Error('No character to put the face in'));
        return bakeMainCharacter(photoUri, faces, view, at, fx);
      },
      onFaces: handleFaces,
    }),
    [extra, fx, handleFaces],
  );

  // Asks the drawing thread for the poster as shown now; null after SNAP_TIMEOUT_MS or when it can't.
  const askSnapshot = useCallback(
    () =>
      new Promise<SkImage | null>((resolve) => {
        asks.current += 1;
        const ask = asks.current;
        const timer = setTimeout(() => {
          waiters.current.delete(ask);
          resolve(null);
        }, SNAP_TIMEOUT_MS);
        waiters.current.set(ask, (image) => {
          clearTimeout(timer);
          resolve(image);
        });
        snapAsk.set(ask);
      }),
    [snapAsk],
  );

  useImperativeHandle(
    ref,
    () => ({
      async capture() {
        if (Date.now() - lastFaceAt.current > FACE_MEMORY_MS) throw new Error(NO_FACE);
        // The poster as it is now: swiping while it is made can't change it, and its pictures are held.
        const at = shown.current;
        if (!at) throw new Error('No character to put the face in');
        const press: Press = { scene: at };
        const release = holdScene(at);
        try {
          if (SNAP_FROM_SCREEN && !forceLite) {
            const image = await askSnapshot();
            if (image) {
              try {
                return { uri: await encodePoster(image) };
              } catch (error) {
                console.warn('Main Character: could not save the poster from the screen, using the photo', error);
              } finally {
                letGo(image);
              }
            }
          }
          const camera = glow.current;
          if (!camera) throw new Error('The camera is not ready');
          return await camera.capture(press);
        } finally {
          release();
        }
      },
    }),
    [askSnapshot, forceLite],
  );

  return <SoftGlowCamera ref={glow} custom={look} active={active} facing={facing} flash="off" zoom={0} />;
}
