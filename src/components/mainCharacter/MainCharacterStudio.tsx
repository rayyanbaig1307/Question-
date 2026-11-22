import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { updateChannel } from '@/lib/lensDiagnostics';
import { markCameraReleased, useCameraHeldByLive } from '@/lib/liveAccess';
import { LIVE_WORDMARK, MISSION_INTRO_MS, NO_FACE, POSTER_H, POSTER_W } from '@/lib/mainCharacter/config';
import { useMainCharacterLibrary } from '@/lib/mainCharacter/library';
import type { CharacterArt, SceneArt } from '@/lib/mainCharacter/types';
import { CAN_SHARE_FILES, saveOut, shareOut } from '@/lib/shareOut';
import { colors, radius, space } from '@/theme';

import { analyseCharacter, normaliseArt } from './analyseArt';
import { MainCharacterCamera, type MainCharacterCameraHandle } from './MainCharacterCamera';
import { MissionPassed } from './MissionPassed';
import { ScreenWordmark, type ShownArea } from './ScreenWordmark';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the screen (docs/MAIN_CHARACTER.md). Only loaded on downloads with face tracking
// (app/(app)/main-character.tsx checks first).
//
// What you see:
//   * live: the poster fills the screen – a scene behind, a character in front, your face in the character's face.
//     Swipe left/right for the next character (its name pops up), 🌴 for the next scene, flip for the back camera;
//   * the shutter: a white flash, the banner (MissionPassed) over the still-moving poster, then the finished poster;
//   * the finished poster: Share, Save, My story, Send, Take another.
//
// Rules that keep it safe:
//   * the camera keeps running while the poster is made (the photo way needs it, and the live poster stays behind
//     the banner); it only stops on the finished poster or when another screen is on top;
//   * while the poster is made (and on the finished poster) swipes, 🌴 and flip do nothing, and the poster is the
//     one from the moment of the press (MainCharacterCamera copies it then);
//   * when a live 🔴 needs the camera, this screen shows no camera at all and says so (lib/liveAccess.ts).
// ---------------------------------------------------------------------------

type Phase = 'live' | 'making' | 'done';
type Pop = { id: number; text: string; kind: 'character' | 'scene' };
type Last = { character: string | null; scene: string | null; picked: boolean };
// One remembered value. `known` is false when the phone's storage failed or was too slow: then we don't know what
// is saved, so this visit must not write over it.
type Stored = { text: string | null; known: boolean };

// The picture steps for online art (made once; they need Skia, which this screen may use).
const LIBRARY_STEPS = { normalise: normaliseArt, analyse: analyseCharacter };

// Remembered on this phone: the character and scene you used last, and how often the swipe hint was shown.
const LAST_KEY = 'mc:last';
const HINTS_KEY = 'mc:hints';
const HINT_VISITS = 3;
const HINT_MS = 5000;
// The phone's storage gets this long to answer before we start without it (milliseconds).
const STORAGE_WAIT_MS = 600;
// A swipe this far (points) or this fast (points a second) picks the next character.
const SWIPE_DISTANCE = 60;
const SWIPE_SPEED = 600;
// How long a name stays up, and how long without a face before "Point the camera at a face".
const POP_MS = 1200;
const NO_FACE_MS = 1500;
// The shutter ring: sunset orange, the same as the 🌆 bubble's ring on the home camera.
const RING = '#FF6B3D';

const NO_FACE_WORDS = "We can't see a face – look at the camera 👀";
const COULD_NOT_MAKE = "Couldn't make your poster. Try again.";

// Reads one remembered value. `text` is null when nothing is saved; `known` is false when the phone's storage
// fails or is too slow (then `text` is null too).
async function readStored(key: string): Promise<Stored> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const slow = new Promise<Stored>((resolve) => {
      timer = setTimeout(() => resolve({ text: null, known: false }), STORAGE_WAIT_MS);
    });
    const read = AsyncStorage.getItem(key).then((value): Stored => ({ text: typeof value === 'string' ? value : null, known: true }));
    return await Promise.race([read, slow]);
  } catch {
    return { text: null, known: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeStored(key: string, value: string) {
  try {
    AsyncStorage.setItem(key, value).catch(() => {});
  } catch {
    // Not remembered this time: nothing else depends on it.
  }
}

// The character and scene you used last (anything odd in it is ignored).
function readLast(text: string | null): Last | null {
  if (!text) return null;
  try {
    const saved: unknown = JSON.parse(text);
    if (!saved || typeof saved !== 'object') return null;
    const { character, scene, picked } = saved as Record<string, unknown>;
    return {
      character: typeof character === 'string' ? character : null,
      scene: typeof scene === 'string' ? scene : null,
      picked: picked === true,
    };
  } catch {
    return null;
  }
}

function bySlug<T extends { slug: string }>(list: T[], slug: string | null): T | null {
  if (!slug) return null;
  return list.find((item) => item.slug === slug) ?? null;
}

// VoiceOver: the screen is one "adjustable" element; swiping up or down on it picks the next or previous character.
const ADJUST_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }];

// The characters either side of the one at `at` (read early, so a swipe is quick).
function neighbours(list: CharacterArt[], at: number): CharacterArt[] {
  if (at < 0 || list.length < 2) return [];
  const next = list[(at + 1) % list.length];
  const previous = list[(at - 1 + list.length) % list.length];
  return previous === next ? [next] : [next, previous];
}

// Where a 1080 × 1920 poster shows inside a box when the whole poster is shown ("contain").
function containArea(width: number, height: number): ShownArea {
  const scale = Math.min(width / POSTER_W, height / POSTER_H);
  const shownW = POSTER_W * scale;
  const shownH = POSTER_H * scale;
  return { x: (width - shownW) / 2, y: (height - shownH) / 2, width: shownW, height: shownH };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function MainCharacterStudio() {
  const focused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const { showToast } = useOverlays();
  const [permission, requestPermission] = useCameraPermissions();
  // A live 🔴 is using the camera: no camera here until it is done.
  const cameraHeld = useCameraHeldByLive();
  const { characters, scenes } = useMainCharacterLibrary(LIBRARY_STEPS);

  const [phase, setPhase] = useState<Phase>('live');
  const [result, setResult] = useState<string | null>(null);
  const [banner, setBanner] = useState(false);
  // The character and scene picked (by their file names, so the list can grow without the pick moving).
  const [characterSlug, setCharacterSlug] = useState<string | null>(null);
  const [sceneSlug, setSceneSlug] = useState<string | null>(null);
  // You picked a scene with 🌴: it stays when you swipe (this visit). Otherwise each character brings its own.
  // A pick from last time (remembered) only holds until the first swipe.
  const [scenePicked, setScenePicked] = useState(false);
  const [restored, setRestored] = useState(false);
  // false when the phone's storage didn't answer in time: then this visit doesn't write over what is saved.
  const [canRemember, setCanRemember] = useState(false);
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [faceSeen, setFaceSeen] = useState(false);
  const [faceMissing, setFaceMissing] = useState(false);
  const [artLoading, setArtLoading] = useState(false);
  const [hint, setHint] = useState(false);
  const [pop, setPop] = useState<Pop | null>(null);
  // Testing channel only: show the simpler "lite" look that older downloads get (the FULL/LITE pill).
  const [testing] = useState(() => updateChannel() === 'testing');
  const [forceLite, setForceLite] = useState(false);

  const camera = useRef<MainCharacterCameraHandle | null>(null);
  // True from the shutter press until "Take another": swipes, 🌴 and flip do nothing then.
  const locked = useRef(false);
  // The screen was closed: a poster still being made is thrown away.
  const gone = useRef(false);
  const pops = useRef(0);
  // 🌴 was tapped on this visit (not just remembered from last time).
  const pickedThisVisit = useRef(false);
  // The character list as it is now, for the moment last time's pick has been read.
  const listNow = useRef(characters);

  const flash = useSharedValue(0);
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.get() }));

  // What shows now. Each character brings its own scene unless you picked one with 🌴.
  const character = bySlug(characters, characterSlug) ?? characters[0] ?? null;
  const ownScene = !scenePicked && character?.scene ? bySlug(scenes, character.scene) : null;
  const scene: SceneArt | null = ownScene ?? bySlug(scenes, sceneSlug) ?? scenes[0] ?? null;
  const at = character ? characters.indexOf(character) : -1;
  const cameraAllowed = permission?.granted === true;
  const cameraShown = cameraAllowed && !cameraHeld;
  const cameraLive = cameraShown && focused && phase === 'live';

  useEffect(() => {
    listNow.current = characters;
  });

  // Start on the character and scene you used last time. With none saved (the first visit, or the phone's storage
  // didn't answer), start on the first character and stay on it: online art that is made ready a moment later goes
  // in front of it in the list, and must not swap the poster by itself.
  useEffect(() => {
    let stopped = false;
    void readStored(LAST_KEY).then(({ text, known }) => {
      if (stopped) return;
      const last = readLast(text);
      if (last?.character) {
        setCharacterSlug(last.character);
        setSceneSlug(last.scene);
        setScenePicked(last.picked);
      } else {
        setCharacterSlug(listNow.current[0]?.slug ?? null);
      }
      setCanRemember(known);
      setRestored(true);
    });
    return () => {
      stopped = true;
    };
  }, []);

  // Remember them for next time (only once last time's have been read, so they aren't overwritten first, and not
  // at all when the phone's storage didn't answer in time).
  const lastCharacter = character?.slug ?? null;
  const lastScene = scene?.slug ?? null;
  useEffect(() => {
    if (!restored || !canRemember || !lastCharacter) return;
    writeStored(LAST_KEY, JSON.stringify({ character: lastCharacter, scene: lastScene, picked: scenePicked }));
  }, [restored, canRemember, lastCharacter, lastScene, scenePicked]);

  // The first 3 visits: a hint about swiping and 🌴. Not when the phone's storage didn't answer in time (the
  // count would start again from 0).
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void readStored(HINTS_KEY).then(({ text, known }) => {
      const shown = Number(text ?? '0');
      if (stopped || !known || (Number.isFinite(shown) && shown >= HINT_VISITS)) return;
      writeStored(HINTS_KEY, String((Number.isFinite(shown) ? shown : 0) + 1));
      setHint(true);
      timer = setTimeout(() => setHint(false), HINT_MS);
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // A live took the camera: once this screen's camera has gone (this runs after it is removed), say so.
  useEffect(() => {
    if (cameraHeld) markCameraReleased();
  }, [cameraHeld]);

  // When the camera goes away (a live takes it), forget the face it saw: the camera that comes back starts from
  // "no face" and only says so once it really sees one.
  useEffect(() => {
    if (!cameraShown) return;
    return () => {
      setFaceSeen(false);
      setFaceMissing(false);
    };
  }, [cameraShown]);

  // No face for a moment: "Point the camera at a face".
  useEffect(() => {
    if (faceSeen || !cameraLive) return;
    const timer = setTimeout(() => setFaceMissing(true), NO_FACE_MS);
    return () => clearTimeout(timer);
  }, [faceSeen, cameraLive]);

  // A name that popped up goes away again.
  useEffect(() => {
    if (!pop) return;
    const timer = setTimeout(() => setPop(null), POP_MS);
    return () => clearTimeout(timer);
  }, [pop]);

  // Closed: anything still being made is thrown away. (Set back on opening, for React's double start while developing.)
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  function showPop(text: string, kind: Pop['kind']) {
    pops.current += 1;
    setPop({ id: pops.current, text, kind });
  }

  function faceSeenChanged(seen: boolean) {
    setFaceSeen(seen);
    if (seen) setFaceMissing(false);
  }

  // Swipe: the next (1) or previous (-1) character, round and round.
  function step(direction: number) {
    if (phase !== 'live' || locked.current || characters.length === 0) return;
    const next = characters[(Math.max(0, at) + direction + characters.length) % characters.length];
    if (!next) return;
    Haptics.selectionAsync().catch(() => {});
    // A character without a scene of its own keeps the scene that shows now.
    if (scene) setSceneSlug(scene.slug);
    // A scene picked last time (not on this visit) lets go now: each character brings its own scene again.
    if (!pickedThisVisit.current) setScenePicked(false);
    setCharacterSlug(next.slug);
    setHint(false);
    showPop(next.name.toUpperCase(), 'character');
  }

  // 🌴: the next scene. It stays when you swipe to another character (this visit).
  function nextScene() {
    if (phase !== 'live' || locked.current || scenes.length === 0) return;
    const from = scene ? scenes.indexOf(scene) : -1;
    const next = scenes[(from + 1) % scenes.length];
    if (!next) return;
    Haptics.selectionAsync().catch(() => {});
    setSceneSlug(next.slug);
    setScenePicked(true);
    pickedThisVisit.current = true;
    setHint(false);
    showPop(next.name, 'scene');
  }

  function flip() {
    if (phase !== 'live' || locked.current) return;
    setFacing((now) => (now === 'front' ? 'back' : 'front'));
  }

  const swipe = usePanGesture({
    enabled: phase === 'live',
    minDistance: 12,
    onDeactivate: (event) => {
      'worklet';
      if (Math.abs(event.translationY) > Math.abs(event.translationX)) return;
      if (event.translationX < -SWIPE_DISTANCE || event.velocityX < -SWIPE_SPEED) scheduleOnRN(step, 1);
      else if (event.translationX > SWIPE_DISTANCE || event.velocityX > SWIPE_SPEED) scheduleOnRN(step, -1);
    },
  });

  // The shutter: flash, banner, then the finished poster (shown once the banner had its moment).
  async function shoot() {
    if (phase !== 'live' || locked.current) return;
    const maker = camera.current;
    if (!maker || !character) return;
    if (!faceSeen) {
      showToast(NO_FACE_WORDS);
      return;
    }
    locked.current = true;
    const pressedAt = Date.now();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    flash.set(withSequence(withTiming(1, { duration: 60 }), withTiming(0, { duration: 300 })));
    setHint(false);
    setPop(null);
    setPhase('making');
    setBanner(true);
    try {
      const made = await maker.capture();
      const left = MISSION_INTRO_MS - (Date.now() - pressedAt);
      if (left > 0) await wait(left);
      if (gone.current) return;
      setResult(made.uri);
      setPhase('done');
    } catch (error) {
      if (gone.current) return;
      // NO_FACE: the camera hasn't seen a face in the last second, or the face was gone by the time of the photo.
      const noFace = (error as { message?: unknown } | null)?.message === NO_FACE;
      if (!noFace) console.warn('Main Character: could not make the poster', error);
      setBanner(false);
      setPhase('live');
      locked.current = false;
      showToast(noFace ? NO_FACE_WORDS : COULD_NOT_MAKE);
    }
  }

  function holdShutter() {
    if (phase !== 'live' || locked.current) return;
    showToast('Main Character videos are coming soon 🎬');
  }

  function takeAnother() {
    setResult(null);
    setBanner(false);
    setPhase('live');
    locked.current = false;
  }

  function close() {
    gone.current = true;
    router.back();
  }

  const live = phase !== 'done';
  const shutterReady = phase === 'live' && cameraLive && character !== null && restored && !artLoading;

  return (
    <View style={styles.screen}>
      {/* The live poster. Not drawn at all while a live uses the camera. */}
      {cameraShown ? (
        <MainCharacterCamera
          ref={camera}
          active={focused && phase !== 'done'}
          facing={facing}
          // Nothing is read until last time's character is known, so the wrong one isn't read first.
          character={restored ? character : null}
          scene={restored ? scene : null}
          nearby={restored ? neighbours(characters, at) : []}
          forceLite={forceLite}
          onFaceSeen={faceSeenChanged}
          onLoading={setArtLoading}
        />
      ) : null}

      {/* Swipe anywhere for the next character. With VoiceOver: swipe up or down (VoiceOver reads the new name). */}
      <GestureDetector gesture={swipe}>
        <View
          style={StyleSheet.absoluteFill}
          accessible={phase === 'live' && character !== null}
          accessibilityRole="adjustable"
          accessibilityLabel="Character"
          accessibilityValue={character ? { text: character.name } : undefined}
          accessibilityHint="Swipe up or down for another character"
          accessibilityActions={ADJUST_ACTIONS}
          onAccessibilityAction={(event) => {
            const action = event.nativeEvent.actionName;
            if (action === 'increment') step(1);
            else if (action === 'decrement') step(-1);
          }}
        />
      </GestureDetector>

      {LIVE_WORDMARK && live && cameraShown ? <ScreenWordmark area={{ x: 0, y: 0, width, height }} /> : null}

      {/* Little messages over the live poster. */}
      {phase === 'live' ? (
        <View style={styles.middle} pointerEvents="box-none">
          {!cameraAllowed && permission ? (
            <View style={styles.panel}>
              <Text style={styles.panelEmoji}>🌆</Text>
              <Text style={styles.panelText}>Peekaboo needs your camera to put your face in the poster.</Text>
              {permission.canAskAgain === false ? (
                <Button title="Open Settings" icon="settings-outline" onPress={() => Linking.openSettings().catch(() => {})} />
              ) : (
                <Button title="Allow camera" icon="camera" onPress={() => void requestPermission()} />
              )}
            </View>
          ) : cameraHeld ? (
            <Pill text="Your camera is busy with a live 🔴" />
          ) : !cameraAllowed ? null : characters.length === 0 ? (
            <Pill text="No characters yet – try again soon 🌆" />
          ) : !restored || artLoading ? (
            <ActivityIndicator color={colors.white} accessibilityLabel="Loading the poster" />
          ) : faceMissing ? (
            <Pill text="Point the camera at a face 👀" />
          ) : null}
        </View>
      ) : null}

      {pop?.kind === 'character' && phase === 'live' ? (
        <View style={styles.bigPopSpot} pointerEvents="none">
          <NamePop key={pop.id} text={pop.text} big />
        </View>
      ) : null}

      {phase === 'done' && result ? (
        <Finished uri={result} onTakeAnother={takeAnother} showToast={showToast} />
      ) : null}

      <Animated.View style={[styles.flash, flashStyle]} pointerEvents="none" />

      {/* Top: close on the left; flip, 🌴 and (testing channel) FULL/LITE on the right. */}
      <SafeEdge edge="top" style={styles.top} pointerEvents="box-none">
        <IconButton icon="close" label="Close Main Character Mode" size={38} onPress={close} />
        {live ? (
          <View style={styles.tools} pointerEvents="box-none">
            <IconButton
              icon="camera-reverse"
              label="Flip camera"
              size={40}
              onPress={flip}
              disabled={phase !== 'live'}
              style={phase !== 'live' && styles.dimmed}
            />
            <View>
              <Bouncy
                accessibilityRole="button"
                accessibilityLabel="Next scene"
                accessibilityState={{ disabled: phase !== 'live' }}
                disabled={phase !== 'live'}
                pressScale={0.85}
                hitSlop={8}
                onPress={nextScene}
                style={[styles.sceneButton, phase !== 'live' && styles.dimmed]}>
                <Text style={styles.sceneEmoji}>🌴</Text>
              </Bouncy>
              {pop?.kind === 'scene' && phase === 'live' ? (
                <View style={styles.scenePopSpot} pointerEvents="none">
                  <NamePop key={pop.id} text={pop.text} big={false} />
                </View>
              ) : null}
            </View>
            {testing ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={forceLite ? 'Lite look. Tap for the full look' : 'Full look. Tap for the lite look'}
                disabled={phase !== 'live'}
                onPress={() => setForceLite((now) => !now)}
                style={[styles.lookPill, forceLite && styles.lookPillLite]}>
                <Text style={styles.lookPillText}>{forceLite ? 'LITE' : 'FULL'}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </SafeEdge>

      {/* Bottom: the hint and the shutter (tap for a poster; holding it says videos are coming). */}
      {live ? (
        <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
          {hint && phase === 'live' ? <Pill text="Swipe ← → for a new character · 🌴 for a new scene" /> : null}
          <Bouncy
            onPress={shoot}
            onLongPress={holdShutter}
            delayLongPress={300}
            disabled={!shutterReady}
            accessibilityRole="button"
            accessibilityLabel="Make my poster"
            accessibilityState={{ disabled: !shutterReady }}
            pressScale={0.82}
            style={[styles.shutter, !shutterReady && styles.dimmed]}>
            <View style={styles.shutterInner} />
          </Bouncy>
        </SafeEdge>
      ) : null}

      <MissionPassed playing={banner} />
    </View>
  );
}

// A dark rounded label over the camera.
function Pill({ text }: { text: string }) {
  return (
    <View style={styles.pill} pointerEvents="none">
      <Text style={styles.pillText}>{text}</Text>
    </View>
  );
}

// A name that pops up for a moment: big in the middle (a character), small under 🌴 (a scene).
function NamePop({ text, big }: { text: string; big: boolean }) {
  const grow = useSharedValue(0.6);
  const seen = useSharedValue(0);
  useEffect(() => {
    grow.set(withSpring(1, { damping: 12, stiffness: 260 }));
    seen.set(withSequence(withTiming(1, { duration: 120 }), withDelay(POP_MS - 320, withTiming(0, { duration: 200 }))));
  }, [grow, seen]);
  const style = useAnimatedStyle(() => ({ opacity: seen.get(), transform: [{ scale: grow.get() }] }));
  return (
    <Animated.View style={[big ? styles.bigPop : styles.smallPop, style]} pointerEvents="none">
      <Text style={big ? styles.bigPopText : styles.smallPopText} numberOfLines={1} adjustsFontSizeToFit>
        {text}
      </Text>
    </Animated.View>
  );
}

// The finished poster (on a blurred copy of itself) and what you can do with it.
function Finished({ uri, onTakeAnother, showToast }: {
  uri: string;
  onTakeAnother: () => void;
  showToast: (message: string) => void;
}) {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [saving, setSaving] = useState(false);

  // The share sheet, with a copy that has the small Peekaboo logo on it (lib/shareOut.ts adds it).
  async function share() {
    if (sharing) return;
    setSharing(true);
    try {
      const outcome = await shareOut(uri, 'photo');
      if (outcome === 'not-possible') showToast("Couldn't open sharing on this phone. Try Save instead.");
    } catch (error) {
      console.warn('Main Character: could not share the poster', error);
      showToast("Couldn't open sharing. Try again.");
    } finally {
      setSharing(false);
    }
  }

  // Into Photos, also with the logo on it.
  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const outcome = await saveOut(uri, 'photo');
      showToast(
        outcome === 'saved'
          ? 'Saved to Photos ✅'
          : outcome === 'no-permission'
            ? 'Peekaboo needs permission to save to Photos'
            : "Couldn't save to Photos on this phone.",
      );
    } catch (error) {
      console.warn('Main Character: could not save the poster', error);
      showToast("Couldn't save to Photos. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[StyleSheet.absoluteFill, styles.finished]}>
      <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} accessible={false} />
      <View style={[StyleSheet.absoluteFill, styles.dim]} />
      {/* Room for the close button: the phone's top edge (SafeEdge adds it) plus 52 points. */}
      <SafeEdge edge="top" style={styles.finishedTop} />
      <View style={styles.posterBox} onLayout={(event) => setBox(event.nativeEvent.layout)}>
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          accessibilityLabel="Your Main Character poster"
        />
        {LIVE_WORDMARK && box ? <ScreenWordmark area={containArea(box.width, box.height)} /> : null}
      </View>
      <SafeEdge edge="bottom" style={styles.actions}>
        {CAN_SHARE_FILES ? (
          <Bouncy
            accessibilityRole="button"
            accessibilityLabel="Share your poster"
            accessibilityState={{ disabled: sharing }}
            disabled={sharing}
            pressScale={0.95}
            onPress={() => void share()}
            style={[styles.shareButton, sharing && styles.dimmed]}>
            <Ionicons name="share-outline" size={22} color={colors.white} />
            <Text style={styles.shareText}>Share</Text>
          </Bouncy>
        ) : null}
        <View style={styles.row}>
          <Action icon="download-outline" title="Save" label="Save to Photos" busy={saving} onPress={() => void save()} />
          <Action
            icon="add-circle-outline"
            title="My story"
            label="Post to my story"
            onPress={() => router.push({ pathname: '/share', params: { uri } })}
          />
          <Action
            icon="paper-plane-outline"
            title="Send"
            label="Send to a friend"
            onPress={() => router.push({ pathname: '/share', params: { uri, pick: 'friends' } })}
          />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Take another poster" onPress={onTakeAnother} style={styles.again} hitSlop={8}>
          <Text style={styles.againText}>Take another</Text>
        </Pressable>
      </SafeEdge>
    </View>
  );
}

// One of the smaller buttons under Share.
function Action({ icon, title, label, busy = false, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  label: string;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <Bouncy
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      pressScale={0.92}
      onPress={onPress}
      style={[styles.action, busy && styles.dimmed]}>
      <Ionicons name={icon} size={22} color={colors.white} />
      <Text style={styles.actionText}>{title}</Text>
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.black,
  },
  middle: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  panel: {
    alignItems: 'center',
    gap: space.md,
    padding: space.xl,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  panelEmoji: {
    fontSize: 48,
  },
  panelText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  pill: {
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  pillText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  bigPopSpot: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    top: '56%',
    alignItems: 'center',
  },
  bigPop: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  bigPopText: {
    color: colors.white,
    fontSize: 40,
    fontWeight: '900',
    letterSpacing: 1,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 8,
  },
  scenePopSpot: {
    position: 'absolute',
    top: 48,
    right: 0,
    alignItems: 'flex-end',
  },
  smallPop: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  smallPopText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
  },
  flash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.white,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: space.lg,
  },
  tools: {
    alignItems: 'flex-end',
    gap: space.sm,
  },
  sceneButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  sceneEmoji: {
    fontSize: 20,
  },
  lookPill: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: colors.white,
  },
  lookPillLite: {
    backgroundColor: RING,
  },
  lookPillText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
  },
  dimmed: {
    opacity: 0.4,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
  },
  shutter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 6,
    borderColor: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  finished: {
    backgroundColor: colors.black,
  },
  dim: {
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  finishedTop: {
    paddingTop: 52,
  },
  posterBox: {
    flex: 1,
    marginHorizontal: space.lg,
  },
  actions: {
    gap: space.md,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.pink,
  },
  shareText: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '900',
  },
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  action: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  actionText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
  },
  again: {
    alignSelf: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  againText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '800',
  },
});
