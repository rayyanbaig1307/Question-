import { useIsFocused } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

// ---------------------------------------------------------------------------
// Moving chat backgrounds (Peekaboo+ ⭐). Each one is a soft gradient with a few little things moving on it
// (hearts, stars, clovers, coins…). Everything moves on the phone's drawing thread, so the chat stays smooth,
// and nothing moves if the phone has "Reduce Motion" switched on.
//
// The background sits behind the messages and never takes taps.
// ---------------------------------------------------------------------------

export type ChatBackgroundId = 'candy' | 'night' | 'golden' | 'mint' | 'pot' | 'dust';

export type ChatBackgroundInfo = {
  id: ChatBackgroundId;
  name: string;
  note: string;
  // Is the picture mostly light or mostly dark? Loose text (times, "Seen") is coloured to match.
  tone: 'light' | 'dark';
};

// The list for the picker, in order.
export const CHAT_BACKGROUNDS: ChatBackgroundInfo[] = [
  { id: 'candy', name: 'Cotton Candy', note: 'Little hearts float up', tone: 'light' },
  { id: 'night', name: 'Night Peek', note: 'Shooting stars and a drifting moon', tone: 'dark' },
  { id: 'golden', name: 'Golden Hour', note: 'Sunset with twinkling stars and glitter', tone: 'dark' },
  { id: 'mint', name: 'Lucky Mint', note: 'Lucky clovers floating by', tone: 'dark' },
  { id: 'pot', name: 'Pot of Gold', note: 'A rainbow with coins popping out', tone: 'light' },
  { id: 'dust', name: 'Gold Dust', note: 'Gold dust sparkling in the dark', tone: 'dark' },
];

export function chatBackgroundInfo(id: string | null | undefined): ChatBackgroundInfo | null {
  return CHAT_BACKGROUNDS.find((b) => b.id === id) ?? null;
}

// ---- Text that sits right on the background (times, "Delivered", names) ----

export type ChatInk = { color: string; textShadowColor?: string; textShadowRadius?: number };

const DARK_INK: ChatInk = { color: 'rgba(27,20,40,0.7)' };
const LIGHT_INK: ChatInk = { color: 'rgba(255,255,255,0.85)', textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 3 };

// The colour for loose text on this background, or null with no background.
export function chatInk(id: string | null | undefined): ChatInk | null {
  const info = chatBackgroundInfo(id);
  if (!info) return null;
  return info.tone === 'light' ? DARK_INK : LIGHT_INK;
}

const ChatInkContext = createContext<ChatInk | null>(null);

export function ChatInkProvider({ ink, children }: { ink: ChatInk | null; children: ReactNode }) {
  return <ChatInkContext.Provider value={ink}>{children}</ChatInkContext.Provider>;
}

// Inside a chat: the loose-text colour for the chat's background (null = use the normal colours).
export function useChatInk(): ChatInk | null {
  return useContext(ChatInkContext);
}

// ---- The background itself ----

type Size = { w: number; h: number };

type SceneProps = {
  time: SharedValue<number>;
  size: Size;
  // How much bigger than the 220-wide design the space is (positions), and how much to grow the little things.
  k: number;
  s: number;
  // A small preview (the picker) – fewer things moving.
  small: boolean;
};

// `small`: a little preview tile with fewer things moving.
export const ChatBackground = memo(function ChatBackground({ id, small = false, style }: {
  id: string | null | undefined;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [size, setSize] = useState<Size | null>(null);
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();
  const info = chatBackgroundInfo(id);

  // One clock (in milliseconds) that every moving thing reads. It only ticks while the chat is on screen.
  const time = useSharedValue(0);
  const clock = useFrameCallback((frame) => {
    'worklet';
    time.set(time.get() + Math.min(frame.timeSincePreviousFrame ?? 16, 100));
  }, false);
  const running = !!info && !!size && focused && !reduceMotion;
  useEffect(() => {
    clock.setActive(running);
  }, [clock, running]);

  if (!info) return null;

  const k = size ? size.w / 220 : 1;
  const props: SceneProps | null = size
    ? { time, size, k, s: Math.min(Math.max(k, 0.55), 1.4), small }
    : null;

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.clip, style]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0 && (width !== size?.w || height !== size?.h)) setSize({ w: width, h: height });
      }}>
      <Gradient id={info.id} />
      {props ? <Scene id={info.id} {...props} /> : null}
    </View>
  );
});

function Gradient({ id }: { id: ChatBackgroundId }) {
  switch (id) {
    case 'candy':
      return (
        <LinearGradient
          colors={['#FFD6EA', '#FFF3FA', '#FFF3FA', '#E2D2FF']}
          locations={[0, 0.4, 0.6, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      );
    case 'night':
      return (
        <LinearGradient colors={['#0A0820', '#1B1440', '#2A1F55']} locations={[0, 0.6, 1]} style={StyleSheet.absoluteFill} />
      );
    case 'golden':
      return (
        <LinearGradient
          colors={['#2B1A55', '#8A4DFF', '#FF6F91', '#FFB86B']}
          locations={[0, 0.28, 0.6, 1]}
          start={{ x: 0.4, y: 0 }}
          end={{ x: 0.6, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      );
    case 'mint':
      return (
        <LinearGradient
          colors={['#0E3B33', '#0E3B33', '#1C7A5E', '#3DDC97']}
          locations={[0, 0.35, 0.8, 1]}
          style={StyleSheet.absoluteFill}
        />
      );
    case 'pot':
      return (
        <LinearGradient colors={['#BDE9FF', '#E9F8FF', '#C9F2D7']} locations={[0, 0.7, 1]} style={StyleSheet.absoluteFill} />
      );
    case 'dust':
      return (
        <LinearGradient colors={['#0B0805', '#2A1F10', '#0B0805']} locations={[0, 0.4, 1]} style={StyleSheet.absoluteFill} />
      );
  }
}

function Scene({ id, ...props }: SceneProps & { id: ChatBackgroundId }) {
  switch (id) {
    case 'candy':
      return <CottonCandy {...props} />;
    case 'night':
      return <NightPeek {...props} />;
    case 'golden':
      return <GoldenHour {...props} />;
    case 'mint':
      return <LuckyMint {...props} />;
    case 'pot':
      return <PotOfGold {...props} />;
    case 'dust':
      return <GoldDust {...props} />;
  }
}

// ---- Helpers ----

// The same "random" numbers every time, so things don't jump around when the screen redraws.
function seeded(seed: number) {
  let value = seed;
  return (min: number, max: number) => {
    value = (value * 16807) % 2147483647;
    return min + ((value - 1) / 2147483646) * (max - min);
  };
}

// How far (0 → 1) a thing is through its loop right now.
function loop(time: number, durationMs: number, offset: number): number {
  'worklet';
  const p = (time / durationMs + offset) % 1;
  return p < 0 ? p + 1 : p;
}

// 0 → 1 → 0 smoothly over one loop (for twinkles and gentle bobbing).
function wave(p: number): number {
  'worklet';
  return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
}

// ---- 1. Cotton Candy: hearts float up ----

const HEARTS = ['💗', '🩷', '💜', '☁️'];

function CottonCandy({ time, size, s, small }: SceneProps) {
  const hearts = useMemo(() => {
    const rnd = seeded(11);
    return Array.from({ length: small ? 6 : 12 }, (_, i) => ({
      left: rnd(0.05, 0.9),
      dur: rnd(6000, 11000) * (small ? 1 : 1.3),
      offset: rnd(0, 1),
      emoji: HEARTS[i % HEARTS.length],
    }));
  }, [small]);
  return (
    <>
      {hearts.map((h, i) => (
        <Rise key={i} time={time} size={size} left={h.left * size.w} dur={h.dur} offset={h.offset} fontSize={14 * s} emoji={h.emoji} />
      ))}
    </>
  );
}

function Rise({ time, size, left, dur, offset, fontSize, emoji }: {
  time: SharedValue<number>;
  size: Size;
  left: number;
  dur: number;
  offset: number;
  fontSize: number;
  emoji: string;
}) {
  const style = useAnimatedStyle(() => {
    const p = loop(time.get(), dur, offset);
    return {
      opacity: 0.8 * (1 - p),
      transform: [{ translateY: -p * (size.h + fontSize * 2) }, { rotate: `${p * 20}deg` }],
    };
  });
  return (
    <Animated.Text allowFontScaling={false} style={[styles.thing, { left, top: size.h, fontSize }, style]}>
      {emoji}
    </Animated.Text>
  );
}

// ---- Stars and sparkles (used by Night Peek, Golden Hour and Gold Dust) ----

type Twinkler = { x: number; y: number; dur: number; offset: number };

function makeTwinklers(seed: number, count: number, maxY: number): Twinkler[] {
  const rnd = seeded(seed);
  return Array.from({ length: count }, () => ({
    x: rnd(0, 1),
    y: rnd(0, maxY),
    dur: rnd(1500, 4000),
    offset: rnd(0, 1),
  }));
}

function Twinkle({ time, x, y, dur, offset, dot, color, glow, gold }: Twinkler & {
  time: SharedValue<number>;
  dot: number;
  color: string;
  glow?: string;
  // Gold dust fades right out; stars always keep a faint glow.
  gold?: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const w = wave(loop(time.get(), dur, offset));
    return gold
      ? { opacity: w, transform: [{ scale: 0.4 + 0.9 * w }] }
      : { opacity: 0.2 + 0.8 * w, transform: [{ scale: 0.8 + 0.6 * w }] };
  });
  return (
    <Animated.View
      style={[
        styles.thing,
        {
          left: x,
          top: y,
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: color,
          shadowColor: glow,
          shadowOpacity: glow ? 1 : 0,
          shadowRadius: glow ? dot * 2 : 0,
          shadowOffset: { width: 0, height: 0 },
        },
        style,
      ]}
    />
  );
}

// ---- 2. Night Peek: stars, shooting stars and a drifting moon ----

function NightPeek({ time, size, k, s, small }: SceneProps) {
  const stars = useMemo(() => makeTwinklers(21, small ? 20 : 40, 0.75), [small]);
  const shooters = useMemo(() => {
    const rnd = seeded(23);
    return Array.from({ length: small ? 2 : 3 }, (_, i) => ({ x: rnd(0.6, 1.1), y: rnd(0, 0.35), offset: (i * 1.7) / 5 }));
  }, [small]);
  return (
    <>
      {stars.map((star, i) => (
        <Twinkle key={i} time={time} {...star} x={star.x * size.w} y={star.y * size.h} dot={2 * s} color="#FFFFFF" />
      ))}
      {shooters.map((shot, i) => (
        <ShootingStar key={i} time={time} left={shot.x * size.w} top={shot.y * size.h} offset={shot.offset} k={k} s={s} />
      ))}
      <Moon time={time} size={size} k={k} s={s} />
    </>
  );
}

function ShootingStar({ time, left, top, offset, k, s }: {
  time: SharedValue<number>;
  left: number;
  top: number;
  offset: number;
  k: number;
  s: number;
}) {
  const style = useAnimatedStyle(() => {
    const p = loop(time.get(), 5000, -offset);
    // It streaks across in the first 18% of each 5 seconds, then waits.
    if (p > 0.18) return { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '-30deg' }] };
    const q = p / 0.18;
    const eased = q * q;
    return {
      opacity: p < 0.04 ? p / 0.04 : 1 - (p - 0.04) / 0.14,
      transform: [{ translateX: -170 * k * eased }, { translateY: 100 * k * eased }, { rotate: '-30deg' }],
    };
  });
  return (
    <Animated.View style={[styles.thing, { left, top, width: 80 * s, height: 2 }, style]}>
      {/* Bright at the front (left), fading out behind. */}
      <LinearGradient
        colors={['#FFFFFF', 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.streak}
      />
    </Animated.View>
  );
}

function Moon({ time, size, k, s }: { time: SharedValue<number>; size: Size; k: number; s: number }) {
  const moon = 34 * s;
  const style = useAnimatedStyle(() => {
    // Starts part of the way across, so it's on screen straight away (and when nothing moves).
    const p = loop(time.get(), 26000 * Math.max(1, k * 0.8), 0.4);
    return {
      transform: [{ translateX: p * (size.w + moon * 2.4) }, { translateY: 30 * k - 36 * k * Math.sin(p * Math.PI) }],
    };
  });
  return (
    <Animated.View style={[styles.thing, { left: -moon * 1.2, top: 22 * k }, style]}>
      <View style={[styles.moon, { width: moon, height: moon, borderRadius: moon / 2 }]}>
        {/* A dark circle over the top-left turns the full moon into a crescent. */}
        <View
          style={[
            styles.moonShade,
            { width: moon, height: moon, borderRadius: moon / 2, left: -moon * 0.27, top: -moon * 0.09 },
          ]}
        />
      </View>
    </Animated.View>
  );
}

// ---- 3. Golden Hour: sunset, stars at the top, gold glitter falling ----

function GoldenHour({ time, size, k, s, small }: SceneProps) {
  const stars = useMemo(() => makeTwinklers(31, small ? 12 : 22, 0.45), [small]);
  const glitter = useMemo(() => {
    const rnd = seeded(37);
    return Array.from({ length: small ? 10 : 18 }, () => ({ x: rnd(0, 1), dur: rnd(4000, 8000), offset: rnd(0, 1) }));
  }, [small]);
  return (
    <>
      {stars.map((star, i) => (
        <Twinkle key={i} time={time} {...star} x={star.x * size.w} y={star.y * size.h} dot={2 * s} color="#FFFFFF" />
      ))}
      {glitter.map((g, i) => (
        <Fall key={i} time={time} size={size} left={g.x * size.w} dur={g.dur * Math.max(1, k * 0.7)} offset={g.offset} k={k} s={s} />
      ))}
    </>
  );
}

function Fall({ time, size, left, dur, offset, k, s }: {
  time: SharedValue<number>;
  size: Size;
  left: number;
  dur: number;
  offset: number;
  k: number;
  s: number;
}) {
  const dot = 3 * s;
  const style = useAnimatedStyle(() => {
    const p = loop(time.get(), dur, offset);
    return {
      opacity: 1 - 0.8 * p,
      transform: [{ translateY: p * (size.h + dot * 4) }, { translateX: 20 * k * p }],
    };
  });
  return (
    <Animated.View
      style={[styles.thing, styles.glitter, { left, top: -dot * 2, width: dot, height: dot, borderRadius: dot / 2, shadowRadius: dot * 2 }, style]}
    />
  );
}

// ---- 4. Lucky Mint: clovers gently floating ----

function LuckyMint({ time, size, k, s, small }: SceneProps) {
  const clovers = useMemo(() => {
    const rnd = seeded(41);
    return Array.from({ length: small ? 5 : 9 }, (_, i) => ({
      x: rnd(0.02, 0.88),
      y: rnd(0.02, 0.7),
      dur: rnd(3000, 6000),
      offset: rnd(0, 1),
      fontSize: rnd(14, 26),
      emoji: i % 3 ? '☘️' : '🍀',
    }));
  }, [small]);
  return (
    <>
      {clovers.map((c, i) => (
        <Drift key={i} time={time} left={c.x * size.w} top={c.y * size.h} dur={c.dur} offset={c.offset} rise={14 * k} fontSize={c.fontSize * s} emoji={c.emoji} />
      ))}
    </>
  );
}

function Drift({ time, left, top, dur, offset, rise, fontSize, emoji }: {
  time: SharedValue<number>;
  left: number;
  top: number;
  dur: number;
  offset: number;
  rise: number;
  fontSize: number;
  emoji: string;
}) {
  const style = useAnimatedStyle(() => {
    const w = wave(loop(time.get(), dur, offset));
    return { transform: [{ translateY: -rise * w }, { rotate: `${-10 + 25 * w}deg` }] };
  });
  return (
    <Animated.Text allowFontScaling={false} style={[styles.thing, styles.clover, { left, top, fontSize }, style]}>
      {emoji}
    </Animated.Text>
  );
}

// ---- 5. Pot of Gold: a rainbow, a little pot and coins popping out ----

const RAINBOW = ['#FF4F9A', '#FF8A3D', '#FFE14D', '#3DDC97', '#38B6FF', '#9B5CFF'];

function PotOfGold({ time, size, k, s, small }: SceneProps) {
  const coins = useMemo(() => {
    const rnd = seeded(51);
    return Array.from({ length: small ? 4 : 6 }, (_, i) => ({ dx: rnd(-70, 70), offset: (i * 400) / 2400 }));
  }, [small]);

  const arcWidth = 170 * k;
  const radius = arcWidth / 2;
  const band = radius * 0.09;
  const potWidth = 40 * s;
  const potHeight = 30 * s;
  const potTop = 104 * k + (30 * k - potHeight);
  const centre = size.w / 2;

  return (
    <>
      <Shimmer time={time} style={[styles.thing, { left: centre - radius, top: 40 * k, width: arcWidth, height: radius, overflow: 'hidden' }]}>
        {RAINBOW.map((color, i) => {
          const d = arcWidth - i * band * 2;
          return (
            <View
              key={color}
              style={[styles.thing, { left: i * band, top: i * band, width: d, height: d, borderRadius: d / 2, borderWidth: band, borderColor: color }]}
            />
          );
        })}
      </Shimmer>
      {coins.map((coin, i) => (
        <Coin key={i} time={time} left={centre - 7 * s} top={potTop} dx={coin.dx * k} rise={70 * k} offset={coin.offset} fontSize={13 * s} />
      ))}
      <View
        style={[
          styles.thing,
          styles.pot,
          { left: centre - potWidth / 2, top: potTop, width: potWidth, height: potHeight, borderBottomLeftRadius: potHeight * 0.6, borderBottomRightRadius: potHeight * 0.6 },
        ]}>
        {/* The pile of gold on top. */}
        <View style={[styles.gold, { left: -3 * s, right: -3 * s, top: -7 * s, height: 12 * s, borderRadius: 6 * s }]}>
          <View style={[styles.goldShine, { width: potWidth * 0.35, height: 4 * s, borderRadius: 2 * s, left: potWidth * 0.2, top: 2 * s }]} />
        </View>
      </View>
    </>
  );
}

function Shimmer({ time, style, children }: { time: SharedValue<number>; style: StyleProp<ViewStyle>; children: ReactNode }) {
  const shimmer = useAnimatedStyle(() => ({ opacity: 0.75 + 0.25 * wave(loop(time.get(), 4000, 0)) }));
  return <Animated.View style={[style, shimmer]}>{children}</Animated.View>;
}

function Coin({ time, left, top, dx, rise, offset, fontSize }: {
  time: SharedValue<number>;
  left: number;
  top: number;
  dx: number;
  rise: number;
  offset: number;
  fontSize: number;
}) {
  const style = useAnimatedStyle(() => {
    const p = loop(time.get(), 2400, -offset);
    // Fast at first, then slowing down (like being thrown up).
    const out = 1 - (1 - p) * (1 - p);
    return {
      opacity: p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85,
      transform: [{ translateX: dx * out }, { translateY: -rise * out }],
    };
  });
  return (
    <Animated.Text allowFontScaling={false} style={[styles.thing, { left, top, fontSize }, style]}>
      🪙
    </Animated.Text>
  );
}

// ---- 6. Gold Dust: gold sparkles in the dark ----

function GoldDust({ time, size, s, small }: SceneProps) {
  const dust = useMemo(() => makeTwinklers(61, small ? 22 : 45, 1), [small]);
  return (
    <>
      {dust.map((d, i) => (
        <Twinkle key={i} time={time} {...d} x={d.x * size.w} y={d.y * size.h} dot={3 * s} color="#F2C14E" glow="#E8A93A" gold />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  thing: {
    position: 'absolute',
  },
  streak: {
    flex: 1,
    borderRadius: 1,
  },
  moon: {
    overflow: 'hidden',
    backgroundColor: '#FFF1C2',
  },
  moonShade: {
    position: 'absolute',
    backgroundColor: '#0C0923',
  },
  glitter: {
    backgroundColor: '#FFE9A8',
    shadowColor: '#FFD36E',
    shadowOpacity: 1,
    shadowOffset: { width: 0, height: 0 },
  },
  clover: {
    opacity: 0.85,
  },
  pot: {
    backgroundColor: '#1B1428',
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    borderBottomWidth: 4,
    borderBottomColor: '#2E2440',
  },
  gold: {
    position: 'absolute',
    backgroundColor: '#F5C400',
    borderBottomWidth: 2,
    borderBottomColor: '#C98A0B',
  },
  goldShine: {
    position: 'absolute',
    backgroundColor: '#FFF3B0',
  },
});
