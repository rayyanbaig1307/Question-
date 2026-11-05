import { Anton_400Regular } from '@expo-google-fonts/anton/400Regular';
import { Bungee_400Regular } from '@expo-google-fonts/bungee/400Regular';
import { Caveat_700Bold } from '@expo-google-fonts/caveat/700Bold';
import { Fredoka_700Bold } from '@expo-google-fonts/fredoka/700Bold';
import { PermanentMarker_400Regular } from '@expo-google-fonts/permanent-marker/400Regular';
import { SpecialElite_400Regular } from '@expo-google-fonts/special-elite/400Regular';
import { useFonts } from 'expo-font';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '@/theme';
import { GooglyEye } from './SpecialSticker';
import {
  textOn,
  type OverlayItem,
  type TextAlign,
  type TextAnimation,
  type TextBackground,
  type TextEffect,
  type TextFont,
} from './stickers';

// ---------------------------------------------------------------------------
// How a piece of text looks: its style (font), colour, effect, background, size and googly o's.
// Used by the text tool while you type and by the text placed on the photo, so both look the same.
// ---------------------------------------------------------------------------

export const DEFAULT_TEXT_SIZE = 34;
export const MIN_TEXT_SIZE = 16;
export const MAX_TEXT_SIZE = 80;

// The 6 text styles. `plus` ones are for Peekaboo+ ⭐ only. `scale` evens out fonts that look small or big.
export const TEXT_FONTS: { id: TextFont; label: string; family: string; scale: number; plus: boolean }[] = [
  { id: 'bubbly', label: 'Bubbly', family: 'Fredoka_700Bold', scale: 1, plus: false },
  { id: 'marker', label: 'Marker', family: 'PermanentMarker_400Regular', scale: 0.95, plus: false },
  { id: 'retro', label: 'RETRO', family: 'Bungee_400Regular', scale: 0.85, plus: true },
  { id: 'diary', label: 'Diary', family: 'Caveat_700Bold', scale: 1.25, plus: true },
  { id: 'typed', label: 'Typed', family: 'SpecialElite_400Regular', scale: 0.9, plus: true },
  { id: 'loud', label: 'LOUD', family: 'Anton_400Regular', scale: 1.05, plus: true },
];

export const TEXT_EFFECTS: { id: TextEffect; label: string; plus: boolean }[] = [
  { id: 'none', label: 'None', plus: false },
  { id: 'glow', label: 'Glow', plus: false },
  { id: 'neon', label: 'Neon', plus: true },
  { id: 'outline', label: 'Outline', plus: false },
  { id: 'shadow', label: 'Shadow', plus: false },
  { id: 'pop3d', label: '3D Pop', plus: true },
];

export const TEXT_ANIMATIONS: { id: TextAnimation; label: string; plus: boolean }[] = [
  { id: 'none', label: 'None', plus: false },
  { id: 'pop', label: 'Pop', plus: true },
  { id: 'bounce', label: 'Bounce', plus: true },
  { id: 'wiggle', label: 'Wiggle', plus: true },
  { id: 'typewriter', label: 'Typewriter', plus: true },
  { id: 'peek', label: 'Peek', plus: true },
];

// The background button goes round these, one per tap.
export const TEXT_BACKGROUNDS: TextBackground[] = ['none', 'pill', 'block', 'clear'];

// Everything about a piece of text, with nothing missing.
export type TextSpec = {
  content: string;
  color: string;
  // No font = the app's normal bold letters (text made before the new text tool, and word stickers).
  font?: TextFont;
  effect: TextEffect;
  animation: TextAnimation;
  align: TextAlign;
  background: TextBackground;
  size: number;
  googly: boolean;
};

// Fills in what's missing. Older text only had `look`: 'shadow' (coloured text with a shadow) or 'pill' (a bubble).
export function resolveText(item: Pick<OverlayItem, 'content' | 'color' | 'look'> & Partial<OverlayItem>): TextSpec {
  return {
    content: item.content,
    color: item.color,
    font: item.font,
    effect: item.effect ?? (item.look === 'pill' ? 'none' : 'shadow'),
    animation: item.animation ?? 'none',
    align: item.align ?? 'center',
    background: item.background ?? (item.look === 'pill' ? 'pill' : 'none'),
    size: item.size ?? DEFAULT_TEXT_SIZE,
    googly: item.googly ?? false,
  };
}

// Loads the text styles' fonts (once – it's quick after the first time).
export function useTextFonts(): boolean {
  const [loaded] = useFonts({
    Fredoka_700Bold,
    PermanentMarker_400Regular,
    Bungee_400Regular,
    Caveat_700Bold,
    SpecialElite_400Regular,
    Anton_400Regular,
  });
  return loaded;
}

type Layer = { dx: number; dy: number; color: string; shadow?: TextStyle };

// The text itself. `caret` adds a blinking line at the end (while typing); `placeholder` shows when it's empty;
// `visibleChars` shows only the first few letters (for the typewriter animation).
export function TextLook({
  spec,
  maxWidth,
  caret = false,
  placeholder,
  visibleChars,
}: {
  spec: TextSpec;
  maxWidth: number;
  caret?: boolean;
  placeholder?: string;
  visibleChars?: number;
}) {
  const fontsLoaded = useTextFonts();
  const font = spec.font ? TEXT_FONTS.find((entry) => entry.id === spec.font) : undefined;
  const fontSize = spec.size * (font?.scale ?? 1);
  const filled = spec.background === 'pill' || spec.background === 'block';
  // On a coloured bubble the letters are black or white; otherwise they're the chosen colour.
  const ink = filled ? textOn(spec.color) : spec.color;

  let shown = spec.font === 'loud' ? spec.content.toUpperCase() : spec.content;
  if (visibleChars !== undefined) shown = Array.from(shown).slice(0, visibleChars).join('');
  const showPlaceholder = !shown && !!placeholder;

  const base: TextStyle = {
    fontSize,
    textAlign: spec.align,
    // Until the fonts are in, the normal bold letters stand in.
    ...(font && fontsLoaded ? { fontFamily: font.family } : { fontWeight: '900' }),
  };

  // Copies of the text drawn behind it (for the outline, 3D and neon effects).
  const layers: Layer[] = [];
  let mainInk = ink;
  let mainShadow: TextStyle | undefined;
  switch (spec.effect) {
    case 'glow':
      mainShadow = { textShadowColor: spec.color, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: fontSize * 0.45 };
      break;
    case 'neon':
      // A bright, almost-white middle with a strong coloured glow, like a neon tube.
      mainInk = mix(ink, colors.white, 0.55);
      mainShadow = { textShadowColor: spec.color, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: fontSize * 0.22 };
      layers.push({
        dx: 0,
        dy: 0,
        color: ink,
        shadow: { textShadowColor: spec.color, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: fontSize * 0.8 },
      });
      break;
    case 'outline': {
      const edge = ink === colors.black ? colors.white : colors.black;
      const width = Math.max(1.5, fontSize * 0.06);
      for (let step = 0; step < 8; step++) {
        const angle = (step / 8) * Math.PI * 2;
        layers.push({ dx: Math.cos(angle) * width, dy: Math.sin(angle) * width, color: edge });
      }
      break;
    }
    case 'shadow':
      mainShadow = {
        textShadowColor: 'rgba(0,0,0,0.6)',
        textShadowOffset: { width: 0, height: fontSize * 0.06 },
        textShadowRadius: fontSize * 0.24,
      };
      break;
    case 'pop3d': {
      const shade = ink === colors.black ? colors.pink : mix(ink, colors.black, 0.55);
      const depth = Math.max(3, Math.round(fontSize * 0.12));
      for (let step = depth; step >= 1; step--) layers.push({ dx: step * 0.6, dy: step, color: shade });
      break;
    }
    default:
      break;
  }

  const eyeSize = fontSize * 0.7;
  const background = backgroundStyle(spec.background, spec.color, fontSize);

  return (
    <View style={[background, { maxWidth }]}>
      <View>
        {showPlaceholder
          ? null
          : layers.map((layer, index) => (
              <Text
                key={index}
                style={[
                  base,
                  StyleSheet.absoluteFill,
                  { color: layer.color, transform: [{ translateX: layer.dx }, { translateY: layer.dy }] },
                  layer.shadow,
                ]}>
                {pieces(shown, spec.googly, eyeSize, false)}
                {caret ? <Caret height={fontSize} color="transparent" /> : null}
              </Text>
            ))}
        {showPlaceholder ? (
          <Text style={[base, { color: ink, opacity: 0.5 }]}>
            {caret ? <Caret height={fontSize} color={ink} /> : null}
            {placeholder}
          </Text>
        ) : (
          <Text style={[base, mainShadow, { color: mainInk }]}>
            {pieces(shown, spec.googly, eyeSize, true)}
            {caret ? <Caret height={fontSize} color={ink} /> : null}
          </Text>
        )}
      </View>
    </View>
  );
}

// Splits the words so every "o" can be drawn as a googly eye. Copies behind the text get an empty space the
// same size instead, so everything lines up.
function pieces(text: string, googly: boolean, eyeSize: number, eyes: boolean): ReactNode[] {
  if (!googly) return [text];
  const out: ReactNode[] = [];
  let run = '';
  Array.from(text).forEach((letter, index) => {
    if (letter === 'o' || letter === 'O' || letter === 'ο') {
      if (run) out.push(run);
      run = '';
      out.push(
        <View key={index} style={{ width: eyeSize, height: eyeSize, marginHorizontal: eyeSize * 0.05 }}>
          {eyes ? <GooglyEye size={eyeSize} /> : null}
        </View>,
      );
    } else {
      run += letter;
    }
  });
  if (run) out.push(run);
  return out;
}

// The blinking line that shows where your typing goes.
function Caret({ height, color }: { height: number; color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(withRepeat(withTiming(0, { duration: 500 }), -1, true));
    return () => cancelAnimation(opacity);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={[{ width: 3, height: height * 0.9, marginLeft: 2, borderRadius: 2, backgroundColor: color }, style]} />;
}

function backgroundStyle(background: TextBackground, color: string, fontSize: number): ViewStyle {
  switch (background) {
    case 'pill':
      return {
        backgroundColor: color,
        borderRadius: fontSize * 0.55,
        paddingHorizontal: fontSize * 0.45,
        paddingVertical: fontSize * 0.15,
      };
    case 'block':
      return {
        backgroundColor: color,
        borderRadius: 4,
        paddingHorizontal: fontSize * 0.4,
        paddingVertical: fontSize * 0.2,
      };
    case 'clear':
      return {
        backgroundColor: 'rgba(0,0,0,0.45)',
        borderRadius: fontSize * 0.35,
        paddingHorizontal: fontSize * 0.4,
        paddingVertical: fontSize * 0.15,
      };
    default:
      // A little room so glows and outlines aren't cut off.
      return { padding: fontSize * 0.12 };
  }
}

// Blends two "#RRGGBB" colours (amount 0 = all `from`, 1 = all `to`).
function mix(from: string, to: string, amount: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  if (!a || !b) return from;
  const part = (index: number) => Math.round(a[index] + (b[index] - a[index]) * amount);
  return `rgb(${part(0)},${part(1)},${part(2)})`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// ---------------------------------------------------------------------------
// Text placed on the photo, with its animation (Pop, Bounce, Wiggle, Typewriter, Peek). The animation plays,
// rests for a moment and plays again, so you can see it. `still` stops it at its resting look – the editor
// sets it while it takes the final picture.
// ---------------------------------------------------------------------------

const ANIMATION_MS: Record<TextAnimation, number> = {
  none: 0,
  pop: 450,
  bounce: 900,
  wiggle: 800,
  typewriter: 0,
  peek: 550,
};

export function PlacedText({ spec, maxWidth, still = false }: { spec: TextSpec; maxWidth: number; still?: boolean }) {
  const animation: TextAnimation = still ? 'none' : spec.animation;
  // How far along the animation is: 0 = start, 1 = resting.
  const progress = useSharedValue(1);

  useEffect(() => {
    cancelAnimation(progress);
    progress.set(1);
    if (animation === 'none' || animation === 'typewriter') return;
    const easing = animation === 'bounce' || animation === 'wiggle' ? Easing.linear : Easing.out(Easing.cubic);
    progress.set(0);
    progress.set(
      withRepeat(
        withSequence(
          withTiming(1, { duration: ANIMATION_MS[animation], easing }),
          withDelay(1600, withTiming(1, { duration: 0 })),
          withTiming(0, { duration: 0 }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(progress);
  }, [animation, spec.content, progress]);

  // Typewriter: the letters appear one by one, stay for a bit, then start again.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (animation !== 'typewriter') return;
    const timer = setInterval(() => setTick((count) => count + 1), 70);
    return () => clearInterval(timer);
  }, [animation]);
  const letters = Array.from(spec.content).length;
  const visibleChars = animation === 'typewriter' ? Math.min(tick % (letters + 25), letters) : undefined;

  const style = useAnimatedStyle(() => {
    const p = progress.get();
    let opacity = 1;
    let translateY = 0;
    let scale = 1;
    let rotate = 0;
    if (animation === 'pop') {
      scale = interpolate(p, [0, 0.6, 1], [0.2, 1.15, 1]);
      opacity = Math.min(1, p * 4);
    } else if (animation === 'bounce') {
      translateY = -Math.abs(Math.sin(p * Math.PI * 3)) * 24 * (1 - p);
    } else if (animation === 'wiggle') {
      rotate = Math.sin(p * Math.PI * 6) * 10 * (1 - p);
    } else if (animation === 'peek') {
      translateY = (1 - p) * 50;
      opacity = Math.min(1, p * 1.5);
    }
    return { opacity, transform: [{ translateY }, { scale }, { rotateZ: `${rotate}deg` }] };
  });

  return (
    <Animated.View style={style}>
      <TextLook spec={spec} maxWidth={maxWidth} visibleChars={visibleChars} />
    </Animated.View>
  );
}
