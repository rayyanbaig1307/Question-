import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import logoEyes from '../../../assets/images/logo-eyes.png';
import { Bouncy } from '@/components/Bouncy';
import { useOverlays } from '@/components/Overlays';
import { Wordmark } from '@/components/Wordmark';
import { friendlyError } from '@/lib/errors';
import type { LegalPage } from '@/lib/legal';
import { buyPlus, CAN_BUY_PLUS, getPlusPrice, MANAGE_SUBSCRIPTION_URL, restorePurchases, usePlus } from '@/lib/plus';
import { radius, space } from '@/theme';

// ---------------------------------------------------------------------------
// The Peekaboo+ ⭐ screen: what you get, the price, and the button to subscribe (iPhone only for now).
// Opened from Settings and from anything locked (themes, chat backgrounds, stickers).
// Everything fits on one screen: what you get is a grid of small tiles, and the Subscribe button, the price
// and the small print stay pinned to the bottom (on a small phone only the tiles scroll).
// ---------------------------------------------------------------------------

// The same pink → purple as the app icon (the same in every theme).
const BRAND = ['#FE59A5', '#E469C7', '#8650DB'] as const;
const NAVY = '#2A1458';

// Short names, so they fit in the small tiles.
const FEATURES: { emoji: string; title: string; soon?: boolean }[] = [
  { emoji: '👀', title: 'Who viewed your profile' },
  { emoji: '🔁', title: 'Who rewatched your story' },
  { emoji: '📸', title: 'Who screenshotted you' },
  { emoji: '🌅', title: 'Glow face filters' },
  { emoji: '🎨', title: 'App themes' },
  { emoji: '🌈', title: 'Moving chat backgrounds' },
  { emoji: '✨', title: '48 stickers' },
  { emoji: '📱', title: 'Custom app icons' },
  { emoji: '💾', title: 'Peek-a-Save (1 a month)' },
  { emoji: '⏪', title: 'Drop rewind' },
  { emoji: '🕵️', title: 'Guess Who hint' },
  { emoji: '📌', title: 'Pin top 3 chats' },
  { emoji: '🎬', title: '60-second videos' },
  { emoji: '⭐', title: 'Plus badge' },
  { emoji: '💖', title: 'Support Peekaboo' },
];

export default function PlusScreen() {
  const plus = usePlus();
  const insets = useSafeAreaInsets();
  const { showToast } = useOverlays();
  // undefined = still loading; null = couldn't get it.
  const [price, setPrice] = useState<string | null | undefined>(CAN_BUY_PLUS ? undefined : null);
  const [busy, setBusy] = useState<'buy' | 'restore' | null>(null);

  // Ask the App Store for the price (in the person's own money) when the screen opens.
  useEffect(() => {
    if (CAN_BUY_PLUS) getPlusPrice().then(setPrice);
  }, []);
  const retryPrice = () => {
    setPrice(undefined);
    getPlusPrice().then(setPrice);
  };

  // The eyes bob up and down, like on the welcome screen.
  const bob = useSharedValue(0);
  useEffect(() => {
    bob.set(withRepeat(withSequence(withTiming(-10, { duration: 900 }), withTiming(0, { duration: 900 })), -1));
  }, [bob]);
  const eyesStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bob.get() }, { rotate: `${bob.get() / 2}deg` }],
  }));

  const buy = async () => {
    if (busy) return;
    setBusy('buy');
    try {
      const result = await buyPlus();
      if (result === 'bought') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast('Welcome to Peekaboo+ ⭐');
      }
    } catch (error) {
      showToast(friendlyError(error));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (busy) return;
    setBusy('restore');
    try {
      const found = await restorePurchases();
      showToast(found ? 'Peekaboo+ is back ⭐' : "We didn't find a Peekaboo+ subscription on this Apple ID.");
    } catch (error) {
      showToast(friendlyError(error));
    } finally {
      setBusy(null);
    }
  };

  const openLegal = (doc: LegalPage) => router.push({ pathname: '/legal/[doc]', params: { doc } });

  return (
    <LinearGradient colors={BRAND} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill}>
      {/* Top: the eyes, the name and a big "+". */}
      <View style={[styles.hero, { paddingTop: insets.top + space.sm }]}>
        <Animated.View style={eyesStyle}>
          <Image source={logoEyes} style={styles.eyes} contentFit="contain" accessibilityLabel="Peekaboo eyes" />
        </Animated.View>
        <View style={styles.logoLine}>
          <Wordmark height={28} onDark />
          <Text style={styles.plusSign}>+</Text>
        </View>
        <Text style={styles.title}>{plus ? "You're a member ⭐" : 'Unlock it all ⭐'}</Text>
        <Text style={styles.tagline}>
          {plus ? 'Thank you for supporting Peekaboo!' : 'See more, peek more, glow more.'}
        </Text>
      </View>

      {/* What you get: small tiles, three in a row. Only this part scrolls, and only on small phones. */}
      <ScrollView style={styles.fill} contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
        {FEATURES.map((feature) => (
          <View key={feature.title} style={styles.tile}>
            <Text style={styles.tileEmoji}>{feature.emoji}</Text>
            <Text style={styles.tileText} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>
              {feature.title}
            </Text>
            {feature.soon ? <Text style={styles.soon}>soon</Text> : null}
            {plus && !feature.soon ? (
              <Ionicons name="checkmark-circle" size={16} color="#FFFFFF" style={styles.tileCheck} />
            ) : null}
          </View>
        ))}
      </ScrollView>

      {/* Pinned to the bottom: the button, the price and the small print – always in view. */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + space.sm }]}>
        {plus ? (
          Platform.OS === 'ios' ? (
            <BigButton title="Manage subscription" onPress={() => Linking.openURL(MANAGE_SUBSCRIPTION_URL)} />
          ) : null
        ) : !CAN_BUY_PLUS ? (
          <View style={styles.soonBox}>
            <Text style={styles.soonTitle}>Coming soon ⭐</Text>
            <Text style={styles.soonText}>
              {Platform.OS === 'ios'
                ? "You'll be able to get it right here. Keep Peekaboo up to date!"
                : "It's coming to Android a bit later. Hang tight!"}
            </Text>
          </View>
        ) : price === null ? (
          <BigButton title="Couldn't load the price · Try again" onPress={retryPrice} />
        ) : (
          <BigButton
            title={price ? `Subscribe · ${price}/month` : 'Subscribe'}
            loading={price === undefined || busy === 'buy'}
            onPress={buy}
          />
        )}

        {/* The small print Apple asks for. */}
        {CAN_BUY_PLUS && !plus ? (
          <Text style={styles.smallPrint}>
            Peekaboo+ is {price ?? 'charged'} per month, and payment is charged to your Apple ID. It renews automatically every month
            until you cancel. Cancel anytime in Settings → Apple ID → Subscriptions, at least 24 hours before it renews.
          </Text>
        ) : null}

        {/* Restore, Terms of Use and Privacy Policy (on one line when they fit). */}
        <View style={styles.links}>
          {CAN_BUY_PLUS && !plus ? (
            <>
              <Pressable
                onPress={restore}
                disabled={!!busy}
                hitSlop={10}
                accessibilityRole="button"
                style={({ pressed }) => pressed && styles.pressed}>
                {busy === 'restore' ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.link}>Restore purchases</Text>
                )}
              </Pressable>
              <Text style={styles.linkDot}>·</Text>
            </>
          ) : null}
          <Text style={styles.link} onPress={() => openLegal('terms')} accessibilityRole="link">
            Terms of Use
          </Text>
          <Text style={styles.linkDot}>·</Text>
          <Text style={styles.link} onPress={() => openLegal('privacy')} accessibilityRole="link">
            Privacy Policy
          </Text>
        </View>
      </View>

      {/* Close, floating at the top. */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={({ pressed }) => [styles.close, { top: insets.top + space.sm }, pressed && styles.pressed]}>
        <Ionicons name="close" size={24} color="#FFFFFF" />
      </Pressable>
    </LinearGradient>
  );
}

// The big white button with navy letters (stands out on the pink → purple background).
function BigButton({ title, onPress, loading = false }: { title: string; onPress: () => void; loading?: boolean }) {
  return (
    <Bouncy
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={loading}
      pressScale={0.95}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onPress();
      }}
      style={styles.bigButton}>
      {loading ? <ActivityIndicator color={NAVY} /> : <Text style={styles.bigButtonText}>{title}</Text>}
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  hero: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: space.xl,
    paddingBottom: space.md,
  },
  eyes: {
    width: 70,
    height: 56,
  },
  logoLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  plusSign: {
    color: '#FFE14D',
    fontSize: 32,
    fontWeight: '900',
    lineHeight: 36,
    textShadowColor: 'rgba(0,0,0,0.2)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 8,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
    marginTop: space.xs,
    textShadowColor: 'rgba(0,0,0,0.2)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 8,
  },
  tagline: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  tile: {
    width: '31%',
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: space.sm,
    paddingHorizontal: 6,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderColor: 'rgba(255,255,255,0.3)',
    borderWidth: 1,
  },
  tileEmoji: {
    fontSize: 22,
  },
  tileText: {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  tileCheck: {
    position: 'absolute',
    top: 4,
    right: 4,
  },
  soon: {
    overflow: 'hidden',
    color: NAVY,
    backgroundColor: 'rgba(255,255,255,0.85)',
    fontSize: 10,
    fontWeight: '900',
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
  },
  footer: {
    gap: space.sm,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    backgroundColor: 'rgba(42,20,88,0.25)',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  bigButton: {
    minHeight: 56,
    borderRadius: radius.pill,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  bigButtonText: {
    color: NAVY,
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
  },
  soonBox: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: radius.lg,
    padding: space.md,
    alignItems: 'center',
    gap: space.xs,
  },
  soonTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
  },
  soonText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  smallPrint: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 15,
    textAlign: 'center',
  },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.sm,
  },
  link: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  linkDot: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },
  close: {
    position: 'absolute',
    right: space.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
