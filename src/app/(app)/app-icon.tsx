import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { APP_ICONS, CAN_CHANGE_APP_ICON, currentAppIcon, setAppIcon, type AppIcon, type AppIconKey } from '@/lib/appIcons';
import { friendlyError } from '@/lib/errors';
import { usePlus } from '@/lib/plus';
import { colors, font, space } from '@/theme';

// ---------------------------------------------------------------------------
// The "App icon" screen (from Settings): pick the picture Peekaboo has on your home screen.
// Classic is free; the others are Peekaboo+ ⭐ – tapping one without Plus opens the Peekaboo+ screen.
// ---------------------------------------------------------------------------

export default function AppIconScreen() {
  const plus = usePlus();
  const insets = useSafeAreaInsets();
  const { showToast } = useOverlays();
  const [current, setCurrent] = useState<AppIconKey>(() => currentAppIcon());
  const [busy, setBusy] = useState(false);

  async function choose(icon: AppIcon) {
    if (icon.plus && !plus) {
      router.push('/plus');
      return;
    }
    if (busy || icon.key === current || !CAN_CHANGE_APP_ICON) return;
    setBusy(true);
    try {
      await setAppIcon(icon.key);
      setCurrent(icon.key);
      Haptics.selectionAsync();
      showToast(`App icon: ${icon.label}`);
    } catch (error) {
      Alert.alert('Could not change the icon', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="App icon" />
      <ScrollView style={styles.fill} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}>
        {CAN_CHANGE_APP_ICON ? (
          <Text style={styles.lede}>Pick the picture Peekaboo has on your home screen.</Text>
        ) : (
          <Text style={styles.lede}>
            Changing the app icon works on iPhone, in the newest Peekaboo download. You can still look at them here.
          </Text>
        )}
        <View style={styles.grid}>
          {APP_ICONS.map((icon) => {
            const on = icon.key === current;
            const locked = icon.plus && !plus;
            return (
              <Pressable
                key={icon.key}
                onPress={() => choose(icon)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={locked ? `${icon.label}, Peekaboo+ only` : icon.label}
                style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
                <View style={[styles.tile, on && styles.tileOn]}>
                  <Image source={icon.preview} style={styles.picture} />
                  {on ? (
                    <View style={styles.tick}>
                      <Ionicons name="checkmark" size={14} color={colors.white} />
                    </View>
                  ) : null}
                  {icon.plus ? <Text style={styles.star}>⭐</Text> : null}
                </View>
                <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1}>
                  {icon.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {!plus ? (
          <Text style={styles.note}>⭐ icons come with Peekaboo+. Classic is free for everyone.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const TILE = 76;

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  lede: { ...font.body, color: colors.textMuted, marginBottom: space.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.lg },
  item: { width: '25%', alignItems: 'center' },
  pressed: { opacity: 0.7 },
  tile: { width: TILE, height: TILE, borderRadius: TILE * 0.225, borderWidth: 3, borderColor: 'transparent', padding: 2 },
  tileOn: { borderColor: colors.accent },
  picture: { width: '100%', height: '100%', borderRadius: (TILE - 10) * 0.225 },
  tick: {
    position: 'absolute',
    right: -6,
    bottom: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  star: { position: 'absolute', top: -6, right: -6, fontSize: 14 },
  label: { ...font.small, marginTop: space.xs, textAlign: 'center' },
  labelOn: { color: colors.text, fontWeight: '700' },
  note: { ...font.small, color: colors.textFaint, marginTop: space.xl, textAlign: 'center' },
});
