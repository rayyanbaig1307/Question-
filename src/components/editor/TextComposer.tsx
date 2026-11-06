import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextInputInstance,
  type TextStyle,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useOverlays } from '@/components/Overlays';
import { SafeScreen } from '@/components/SafeEdge';
import { usePlus } from '@/lib/plus';
import { colors, keyboardAppearance } from '@/theme';
import { BRAND_TEXT_COLORS, TEXT_COLORS, textOn, type OverlayItem, type TextAlign } from './stickers';
import {
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  resolveText,
  TEXT_ANIMATIONS,
  TEXT_BACKGROUNDS,
  TEXT_EFFECTS,
  TEXT_FONTS,
  TextLook,
  useTextFonts,
  type TextSpec,
} from './TextLook';

export type TextDraft = Pick<
  OverlayItem,
  'content' | 'color' | 'look' | 'font' | 'effect' | 'animation' | 'align' | 'background' | 'size' | 'googly'
>;

type Tool = 'style' | 'color' | 'effect' | 'animate';

const ALL_COLORS = [...TEXT_COLORS, ...BRAND_TEXT_COLORS];
const ALIGN_ICONS: Record<TextAlign, 'format-align-left' | 'format-align-center' | 'format-align-right'> = {
  left: 'format-align-left',
  center: 'format-align-center',
  right: 'format-align-right',
};
const NEXT_ALIGN: Record<TextAlign, TextAlign> = { center: 'left', left: 'right', right: 'center' };

// The full-screen text tool: type in the middle, size slider on the left, tools down the right,
// style bubbles above the keyboard. Everything here is free for everyone.
export function TextComposer({ initial, onDone, onCancel }: {
  initial: TextDraft;
  onDone: (draft: TextDraft) => void;
  onCancel: () => void;
}) {
  const { width } = useWindowDimensions();
  const plus = usePlus();
  const { showToast } = useOverlays();
  const insets = useSafeAreaInsets();
  const fontsLoaded = useTextFonts();
  const input = useRef<TextInputInstance>(null);
  const [spec, setSpec] = useState<TextSpec>(() => {
    const start = resolveText(initial);
    // New text (and older text being edited) starts in the Bubbly style.
    return { ...start, font: start.font ?? 'bubbly' };
  });
  const [tool, setTool] = useState<Tool>('style');

  const change = (patch: Partial<TextSpec>) => setSpec((current) => ({ ...current, ...patch }));

  // Plus-only choices show a ⭐ and say so when tapped without Peekaboo+.
  function choose(plusOnly: boolean, apply: () => void) {
    if (plusOnly && !plus) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      showToast('That one comes with Peekaboo+ ⭐');
      return;
    }
    Haptics.selectionAsync();
    apply();
  }

  function finish() {
    const content = spec.content.trim();
    onDone({
      content,
      color: spec.color,
      // Kept for older copies of the app.
      look: spec.background === 'pill' ? 'pill' : 'shadow',
      font: spec.font,
      effect: spec.effect,
      animation: spec.animation,
      align: spec.align,
      background: spec.background,
      size: spec.size,
      googly: spec.googly,
    });
  }

  function insert(text: string) {
    Haptics.selectionAsync();
    change({ content: (spec.content + text).slice(0, 120) });
    input.current?.focus();
  }

  const lock = (plusOnly: boolean) => plusOnly && !plus;
  const alignItems = spec.align === 'left' ? 'flex-start' : spec.align === 'right' ? 'flex-end' : 'center';

  return (
    <View style={styles.backdrop}>
      <SafeScreen style={styles.fill}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.topRow}>
            <Pressable onPress={onCancel} style={styles.cancel} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={styles.cancelText}>✕</Text>
            </Pressable>
            <Pressable onPress={finish} accessibilityRole="button" accessibilityLabel="Done">
              <LinearGradient colors={[colors.pink, colors.purple]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.done}>
                <Text style={styles.doneText}>Done ✓</Text>
              </LinearGradient>
            </Pressable>
          </View>

          {/* The words, drawn exactly as they'll look on the photo. Tap to bring the keyboard back. */}
          <Pressable style={[styles.center, { alignItems }]} onPress={() => input.current?.focus()} accessibilityLabel="Your text">
            <TextLook spec={spec} maxWidth={width - 130} caret placeholder="Type something…" />
          </Pressable>

          {/* The real typing box is hidden: what you type shows up in the picture above. */}
          <TextInput
            ref={input}
            value={spec.content}
            onChangeText={(content) => change({ content })}
            autoFocus
            multiline
            maxLength={120}
            keyboardAppearance={keyboardAppearance}
            style={styles.hiddenInput}
            caretHidden
          />

          <View style={styles.bottom}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="always">
              {tool === 'style'
                ? TEXT_FONTS.map((font) => (
                    <Bubble
                      key={font.id}
                      label={font.label}
                      on={spec.font === font.id}
                      locked={lock(font.plus)}
                      textStyle={fontsLoaded ? { fontFamily: font.family, fontWeight: 'normal', fontSize: 15 * font.scale } : undefined}
                      onPress={() => choose(font.plus, () => change({ font: font.id }))}
                    />
                  ))
                : tool === 'color'
                  ? ALL_COLORS.map((option) => (
                      <Pressable
                        key={option}
                        onPress={() => choose(false, () => change({ color: option }))}
                        accessibilityLabel={`Colour ${option}`}
                        style={[styles.dot, { backgroundColor: option }, option === spec.color && styles.dotOn]}
                      />
                    ))
                  : tool === 'effect'
                    ? TEXT_EFFECTS.map((effect) => (
                        <Bubble
                          key={effect.id}
                          label={effect.label}
                          on={spec.effect === effect.id}
                          locked={lock(effect.plus)}
                          onPress={() => choose(effect.plus, () => change({ effect: effect.id }))}
                        />
                      ))
                    : TEXT_ANIMATIONS.map((animation) => (
                        <Bubble
                          key={animation.id}
                          label={animation.label}
                          on={spec.animation === animation.id}
                          locked={lock(animation.plus)}
                          onPress={() => choose(animation.plus, () => change({ animation: animation.id }))}
                        />
                      ))}
            </ScrollView>
            {tool === 'animate' ? <Text style={styles.note}>It moves on the screen. The photo you send shows it standing still.</Text> : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="always">
              <Pressable onPress={() => insert('@')} style={styles.quick} accessibilityRole="button">
                <Text style={styles.quickText}>@ Tag a friend</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>

        <SizeSlider top={insets.top + 96} size={spec.size} onChange={(size) => change({ size })} />

        {/* The tool dock down the right side. */}
        <View style={[styles.dock, { top: insets.top + 70 }]}>
          <DockButton label="Text style" on={tool === 'style'} onPress={() => setTool('style')}>
            <Text style={[styles.dockText, tool === 'style' && styles.dockTextOn]}>Aa</Text>
          </DockButton>
          <DockButton label="Colour" on={tool === 'color'} onPress={() => setTool('color')}>
            <LinearGradient
              colors={[colors.pink, colors.yellow, colors.green, colors.blue, colors.purple]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.wheel}>
              <View style={[styles.wheelMiddle, { backgroundColor: spec.color }]} />
            </LinearGradient>
          </DockButton>
          <DockButton label="Effect" on={tool === 'effect'} onPress={() => setTool('effect')}>
            <Text style={styles.dockEmoji}>✨</Text>
          </DockButton>
          <DockButton label="Animate" on={tool === 'animate'} onPress={() => setTool('animate')}>
            <Text style={styles.dockEmoji}>🎬</Text>
          </DockButton>
          <DockButton label={`Align ${spec.align}`} onPress={() => choose(false, () => change({ align: NEXT_ALIGN[spec.align] }))}>
            <MaterialCommunityIcons name={ALIGN_ICONS[spec.align]} size={20} color={colors.white} />
          </DockButton>
          <DockButton
            label={`Background ${spec.background}`}
            onPress={() =>
              choose(false, () =>
                change({ background: TEXT_BACKGROUNDS[(TEXT_BACKGROUNDS.indexOf(spec.background) + 1) % TEXT_BACKGROUNDS.length] }),
              )
            }>
            <BackgroundIcon background={spec.background} color={spec.color} />
          </DockButton>
          <DockButton label="Googly o's" on={spec.googly} onPress={() => choose(false, () => change({ googly: !spec.googly }))}>
            <Text style={styles.dockEmoji}>👀</Text>
          </DockButton>
        </View>
      </SafeScreen>
    </View>
  );
}

function DockButton({ label, on = false, onPress, children }: { label: string; on?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.dockButton, on && styles.dockButtonOn]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}>
      {children}
    </Pressable>
  );
}

function Bubble({ label, on, locked, textStyle, onPress }: {
  label: string;
  on: boolean;
  locked: boolean;
  textStyle?: StyleProp<TextStyle>;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.bubble, on && styles.bubbleOn, locked && styles.locked]}
      accessibilityRole="button"
      accessibilityLabel={locked ? `${label}, Peekaboo+ only` : label}
      accessibilityState={{ selected: on }}>
      <Text style={[styles.bubbleText, textStyle, on && styles.bubbleTextOn]}>{label}</Text>
      {locked ? <Text style={styles.star}>⭐</Text> : null}
    </Pressable>
  );
}

// A little "A" that shows which background is on.
function BackgroundIcon({ background, color }: { background: TextSpec['background']; color: string }) {
  const box =
    background === 'pill'
      ? { backgroundColor: color, borderRadius: 10 }
      : background === 'block'
        ? { backgroundColor: color, borderRadius: 3 }
        : background === 'clear'
          ? { backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 6 }
          : { borderWidth: 1.5, borderColor: colors.white, borderRadius: 6 };
  const ink = background === 'pill' || background === 'block' ? textOn(color) : colors.white;
  return (
    <View style={[styles.bgIcon, box]}>
      <Text style={[styles.bgIconText, { color: ink }]}>A</Text>
    </View>
  );
}

// The size slider down the left edge: a thin track that's wide at the top. Drag up for bigger letters.
const TRACK = 190;
const KNOB = 22;

function SizeSlider({ top, size, onChange }: { top: number; size: number; onChange: (size: number) => void }) {
  const level = useSharedValue((size - MIN_TEXT_SIZE) / (MAX_TEXT_SIZE - MIN_TEXT_SIZE));

  const update = (y: number) => {
    'worklet';
    const next = Math.min(1, Math.max(0, 1 - (y - KNOB / 2) / TRACK));
    level.set(next);
    scheduleOnRN(onChange, Math.round(MIN_TEXT_SIZE + next * (MAX_TEXT_SIZE - MIN_TEXT_SIZE)));
  };
  const pan = usePanGesture({
    minDistance: 0,
    onBegin: (event) => {
      'worklet';
      update(event.y);
    },
    onUpdate: (event) => {
      'worklet';
      update(event.y);
    },
  });
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - level.get()) * TRACK }] }));

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.slider, { top }]} accessibilityLabel="Text size" accessibilityRole="adjustable">
        <View style={styles.track} />
        <Animated.View style={[styles.knob, knobStyle]} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  fill: {
    flex: 1,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  cancel: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '800',
  },
  done: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
  },
  doneText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    paddingLeft: 52,
    paddingRight: 72,
  },
  hiddenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  bottom: {
    gap: 8,
    paddingBottom: 10,
  },
  row: {
    gap: 8,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  bubbleOn: {
    backgroundColor: colors.white,
    borderColor: colors.white,
  },
  locked: {
    opacity: 0.6,
  },
  bubbleText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  bubbleTextOn: {
    color: '#1B1428',
  },
  star: {
    fontSize: 10,
  },
  dot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  dotOn: {
    borderColor: colors.white,
    borderWidth: 4,
    transform: [{ scale: 1.12 }],
  },
  note: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 16,
  },
  quick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  quickText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
  },
  dock: {
    position: 'absolute',
    right: 10,
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 5,
    borderRadius: 26,
    backgroundColor: 'rgba(20,14,30,0.72)',
  },
  dockButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockButtonOn: {
    backgroundColor: colors.white,
  },
  dockText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '900',
  },
  dockTextOn: {
    color: '#1B1428',
  },
  dockEmoji: {
    fontSize: 18,
  },
  wheel: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelMiddle: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.white,
  },
  bgIcon: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bgIconText: {
    fontSize: 13,
    fontWeight: '900',
  },
  slider: {
    position: 'absolute',
    left: 0,
    width: 44,
    height: TRACK + KNOB,
    alignItems: 'center',
  },
  // A thin track, wide at the top and narrow at the bottom.
  track: {
    position: 'absolute',
    top: KNOB / 2,
    width: 3,
    height: 0,
    borderTopWidth: TRACK,
    borderLeftWidth: 3,
    borderRightWidth: 3,
    borderTopColor: 'rgba(255,255,255,0.55)',
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  knob: {
    position: 'absolute',
    top: 0,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    backgroundColor: colors.white,
    shadowColor: colors.black,
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});
