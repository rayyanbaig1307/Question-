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
// ---------------------------------------------------------------------------

// The same pink → purple as the app icon (the same in every theme).
const BRAND = ['#FE59A5', '#E469C7', '#8650DB'] as const;
const NAVY = '#2A1458';

const FEATURES: { emoji: string; title: string; soon?: boolean }[] = [
  { emoji: '👀', title: 'Who viewed your profile' },
  { emoji: '🔁', title: 'Who rewatched your story' },
  { emoji: '📸', title: 'Who screenshotted your story & posts' },
  { emoji: '🎨', title: 'App themes' },
  { emoji: '🌈', title: 'Moving chat backgrounds' },
  { emoji: '✨', title: '48 stickers' },
  { emoji: '📱', title: 'Custom app icons' },
  { emoji: '💾', title: 'Peek-a-Save (1 a month)' },
  { emoji: '⏪', title: 'Drop rewind' },
  { emoji: '🕵️', title: 'Guess Who hint' },
  { emoji: '📌', title: 'Pin your top 3 chats' },
  { emoji: '🎬', title: '60-second videos' },
  { emoji: '🌅', title: 'Soft Glow & Golden Hour filters' },
  { emoji: '⭐', title: 'Plus badge next to your name' },
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
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl }]}>
        {/* Top: the eyes, the name and a big "+". */}
        <View style={styles.hero}>
          <Animated.View style={eyesStyle}>
            <Image source={logoEyes} style={styles.eyes} contentFit="contain" accessibilityLabel="Peekaboo eyes" />
          </Animated.View>
          <View style={styles.logoLine}>
            <Wordmark height={40} onDark />
            <Text style={styles.plusSign}>+</Text>
          </View>
          <Text style={styles.title}>{plus ? 'You have Peekaboo+ ⭐' : 'Get Peekaboo+ ⭐'}</Text>
          <Text style={styles.tagline}>
            {plus ? 'Thank you for supporting Peekaboo! Here is everything you get.' : 'See more, peek more, glow more.'}
          </Text>
        </View>

        {/* What you get. */}
        <View style={styles.card}>
          {FEATURES.map((feature) => (
            <View key={feature.title} style={styles.feature}>
              <Text style={styles.featureEmoji}>{feature.emoji}</Text>
              <Text style={styles.featureText}>{feature.title}</Text>
              {feature.soon ? <Text style={styles.soon}>soon</Text> : null}
              {plus && !feature.soon ? <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" /> : null}
            </View>
          ))}
        </View>

        {/* The buttons. */}
        {plus ? (
          Platform.OS === 'ios' ? (
            <BigButton title="Manage subscription" onPress={() => Linking.openURL(MANAGE_SUBSCRIPTION_URL)} />
          ) : null
        ) : !CAN_BUY_PLUS ? (
          <View style={styles.soonBox}>
            <Text style={styles.soonTitle}>Peekaboo+ is coming soon ⭐</Text>
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
            title={price ? `Get Peekaboo+ · ${price}/month` : 'Get Peekaboo+'}
            loading={price === undefined || busy === 'buy'}
            onPress={buy}
          />
        )}

        {CAN_BUY_PLUS && !plus ? (
          <Pressable
            onPress={restore}
            disabled={!!busy}
            hitSlop={12}
            accessibilityRole="button"
            style={({ pressed }) => [styles.restore, pressed && styles.pressed]}>
            {busy === 'restore' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.restoreText}>Restore purchases</Text>
            )}
          </Pressable>
        ) : null}

        {/* The small print Apple asks for. */}
        {CAN_BUY_PLUS ? (
          <Text style={styles.smallPrint}>
            Peekaboo+ is {price ?? 'charged'} per month, and payment is charged to your Apple ID. It renews automatically every month
            until you cancel. Cancel anytime in Settings → Apple ID → Subscriptions, at least 24 hours before it renews.
          </Text>
        ) : null}
        <View style={styles.legalLinks}>
          <Text style={styles.legalLink} onPress={() => openLegal('terms')} accessibilityRole="link">
            Terms of Service
          </Text>
          <Text style={styles.legalDot}>·</Text>
          <Text style={styles.legalLink} onPress={() => openLegal('privacy')} accessibilityRole="link">
            Privacy Policy
          </Text>
        </View>
      </ScrollView>

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
  content: {
    paddingHorizontal: space.xl,
    gap: space.lg,
  },
  hero: {
    alignItems: 'center',
    gap: space.sm,
  },
  eyes: {
    width: 120,
    height: 96,
  },
  logoLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  plusSign: {
    color: '#FFE14D',
    fontSize: 44,
    fontWeight: '900',
    lineHeight: 48,
    textShadowColor: 'rgba(0,0,0,0.2)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 8,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
    marginTop: space.sm,
    textShadowColor: 'rgba(0,0,0,0.2)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 8,
  },
  tagline: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderColor: 'rgba(255,255,255,0.3)',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  featureEmoji: {
    fontSize: 22,
    width: 30,
    textAlign: 'center',
  },
  featureText: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  soon: {
    overflow: 'hidden',
    color: NAVY,
    backgroundColor: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    fontWeight: '900',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  bigButton: {
    minHeight: 60,
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
    padding: space.lg,
    alignItems: 'center',
    gap: space.xs,
  },
  soonTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  soonText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  restore: {
    alignSelf: 'center',
    minHeight: 24,
    justifyContent: 'center',
  },
  restoreText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.6,
  },
  smallPrint: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 17,
    textAlign: 'center',
  },
  legalLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.sm,
  },
  legalLink: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  legalDot: {
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
