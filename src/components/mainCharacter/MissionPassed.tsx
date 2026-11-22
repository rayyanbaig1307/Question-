import { Bungee_400Regular } from '@expo-google-fonts/bungee/400Regular';
import * as Haptics from 'expo-haptics';
import { useFonts } from 'expo-font';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { MISSION_REWARD, MISSION_SHOW_MS, MISSION_TITLE } from '@/lib/mainCharacter/config';
import { colors, space } from '@/theme';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the banner that pops up when you take your poster (docs/MAIN_CHARACTER.md).
//
// Our own look: a pink → purple band, tilted a little, across the middle of the screen, with the words from
// config.ts (MISSION_TITLE, MISSION_REWARD) in big blocky letters with a dark outline. The words only ever come
// from config.ts. Nothing here can be tapped: it lies over the poster and goes away by itself.
//
// The letters are Bungee, by David Jonathan Ross / The Bungee Project Authors, under the SIL Open Font License 1.1
// (the licence is in assets/fonts/Bungee-OFL.txt). The app already has it for the editor's RETRO text. Until it
// has loaded (the very first time only), the banner uses the phone's own heavy letters, so it never waits.
// ---------------------------------------------------------------------------

// Our own band colours (the same pink and purple in every app theme).
const BAND: readonly [string, string] = [colors.pink, colors.purple];
// The dark outline round the letters.
const NAVY = '#1E1437';
const TILT = '-4deg';
const TITLE_SIZE = 40;
const REWARD_SIZE = 26;

// The timeline (milliseconds after the press).
const BAND_MS = 180;          // the band grows sideways
const TITLE_AT = 120;         // the title springs in
const REWARD_AT = 420;        // the reward slides up and pops (with a happy buzz)
const FADE_MS = 250;          // everything fades out at MISSION_SHOW_MS

// `playing`: true from the shutter press. The banner plays once each time it turns true, then fades out by itself
// (it stays faded until `playing` goes back to false).
export function MissionPassed({ playing }: { playing: boolean }) {
  // Loaded here (not only while playing), so the letters are ready by the first press.
  const [fontLoaded] = useFonts({ Bungee_400Regular });
  if (!playing) return null;
  return <Banner fontLoaded={fontLoaded} />;
}

// One showing of the banner: it starts when it appears.
function Banner({ fontLoaded }: { fontLoaded: boolean }) {
  const { width } = useWindowDimensions();
  const band = useSharedValue(0);
  const title = useSharedValue(0);
  const titleScale = useSharedValue(1.6);
  const reward = useSharedValue(0);
  const rewardLift = useSharedValue(24);
  const rewardScale = useSharedValue(0.6);
  const shown = useSharedValue(1);

  useEffect(() => {
    band.set(withTiming(1, { duration: BAND_MS, easing: Easing.out(Easing.cubic) }));
    title.set(withDelay(TITLE_AT, withTiming(1, { duration: 140 })));
    titleScale.set(withDelay(TITLE_AT, withSpring(1, { damping: 11, stiffness: 220 })));
    reward.set(withDelay(REWARD_AT, withTiming(1, { duration: 100 })));
    rewardLift.set(withDelay(REWARD_AT, withSpring(0, { damping: 12, stiffness: 240 })));
    rewardScale.set(withDelay(REWARD_AT, withSequence(withTiming(1.15, { duration: 120 }), withSpring(1, { damping: 10, stiffness: 260 }))));
    shown.set(withDelay(MISSION_SHOW_MS, withTiming(0, { duration: FADE_MS })));
    const buzz = setTimeout(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }, REWARD_AT);
    return () => clearTimeout(buzz);
  }, [band, title, titleScale, reward, rewardLift, rewardScale, shown]);

  const wholeStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const bandStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: band.get() }] }));
  const titleStyle = useAnimatedStyle(() => ({ opacity: title.get(), transform: [{ scale: titleScale.get() }] }));
  const rewardStyle = useAnimatedStyle(() => ({
    opacity: reward.get(),
    transform: [{ translateY: rewardLift.get() }, { scale: rewardScale.get() }],
  }));

  // The band is wider than the screen (so its tilted ends never show); the words stay inside the screen.
  const extra = Math.round(width * 0.1);
  const letters: TextStyle = fontLoaded ? { fontFamily: 'Bungee_400Regular' } : { fontWeight: '900' };

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, styles.middle, wholeStyle]}>
      <View style={[styles.tilt, { width: width + extra * 2, paddingHorizontal: extra + space.lg }]}>
        <Animated.View style={[StyleSheet.absoluteFill, bandStyle]}>
          <LinearGradient colors={BAND} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={[styles.line, titleStyle]}>
          <Outlined text={MISSION_TITLE} size={TITLE_SIZE} color={colors.white} letters={letters} />
        </Animated.View>
        <Animated.View style={[styles.line, rewardStyle]}>
          <Outlined text={MISSION_REWARD} size={REWARD_SIZE} color={colors.yellow} letters={letters} />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

// One line of words with a dark outline: 4 dark copies just off each corner behind the coloured words (the same
// way the editor outlines text), and a soft shadow under it all.
function Outlined({ text, size, color, letters }: { text: string; size: number; color: string; letters: TextStyle }) {
  const edge = Math.max(2, Math.round(size * 0.06));
  const base: TextStyle = { ...letters, fontSize: size, textAlign: 'center' };
  const corners = [
    [edge, edge],
    [-edge, edge],
    [edge, -edge],
    [-edge, -edge],
  ];
  return (
    <View>
      {corners.map(([dx, dy], index) => (
        <Text
          key={index}
          numberOfLines={1}
          adjustsFontSizeToFit
          style={[base, StyleSheet.absoluteFill, { color: NAVY, transform: [{ translateX: dx }, { translateY: dy }] }]}>
          {text}
        </Text>
      ))}
      <Text numberOfLines={1} adjustsFontSizeToFit style={[base, styles.shadow, { color }]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  middle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tilt: {
    paddingVertical: space.lg,
    gap: space.xs,
    transform: [{ rotate: TILT }],
  },
  line: {
    alignSelf: 'stretch',
  },
  shadow: {
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 8,
  },
});
