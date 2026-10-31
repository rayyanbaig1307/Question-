import Ionicons from '@expo/vector-icons/Ionicons';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bouncy } from '@/components/Bouncy';
import { colors, isDark } from '@/theme';

// Height of the tab bar, not counting the phone's home-bar area below it.
export const TAB_BAR_HEIGHT = 58;

// How much room to leave at the bottom of a page so nothing hides behind the tab bar.
export function useTabBarSpace(): number {
  return useSafeAreaInsets().bottom + TAB_BAR_HEIGHT;
}

const TABS: { label: string; on: keyof typeof Ionicons.glyphMap; off: keyof typeof Ionicons.glyphMap }[] = [
  { label: 'Chat', on: 'chatbubble', off: 'chatbubble-outline' },
  { label: 'Camera', on: 'camera', off: 'camera-outline' },
  { label: 'Home', on: 'home', off: 'home-outline' },
];

// The bar at the bottom of the home screen: Chat · Camera · Home.
// Over the camera (and Home in dark mode) it's see-through; elsewhere it fades to solid.
export function HomeTabBar({ page, onSelect, unread, solid }: {
  page: number;
  onSelect: (index: number) => void;
  // Unread chats + unopened peeks + hit ups waiting.
  unread: number;
  // 0 = see-through, 1 = solid (follows your finger while swiping).
  solid: Animated.AnimatedInterpolation<number>;
}) {
  const insets = useSafeAreaInsets();
  // Over the camera the icons are white; elsewhere in light mode they use the dark text color.
  const overCamera = page === 1;
  const idleColor = overCamera || isDark ? colors.white : colors.text;

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
      <Animated.View style={[styles.background, { opacity: solid }]} pointerEvents="none" />
      {TABS.map((tab, index) => {
        const active = index === page;
        return (
          <Bouncy
            key={tab.label}
            style={styles.tab}
            pressScale={0.85}
            onPress={() => onSelect(index)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}>
            <View>
              <Ionicons name={active ? tab.on : tab.off} size={25} color={active ? colors.accent : idleColor} />
              {index === 0 && unread > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.label, !overCamera && styles.labelPlain, { color: active ? colors.accent : idleColor }, active && styles.labelActive]}>
              {tab.label}
            </Text>
          </Bouncy>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  background: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  tab: {
    flex: 1,
    height: TAB_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  label: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  labelPlain: {
    textShadowRadius: 0,
  },
  labelActive: {
    fontWeight: '900',
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -12,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
  },
});
