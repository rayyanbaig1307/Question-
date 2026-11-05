import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Wordmark } from '@/components/Wordmark';
import { colors, font, space } from '@/theme';

// Top bar for the Chat and Home pages: a title (or the Peekaboo logo) in the middle, and the 🔔 Inbox bell on
// the right, with a red number (and a pink ring) when something new is waiting. Your profile is on the Camera
// screen's top bar. (No camera button here: the bottom bar has one.)
export function PageHeader({ title, logo = false, inbox }: {
  title?: string;
  logo?: boolean;
  inbox?: { count: number; onPress: () => void };
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      {/* An empty space the same width as the right side, so the title stays in the middle. */}
      <View style={styles.side} />
      {logo ? (
        <View style={styles.logo}>
          <Wordmark height={30} />
        </View>
      ) : (
        <Text style={styles.title}>{title}</Text>
      )}
      <View style={[styles.side, styles.right]}>
        {inbox ? (
          <Pressable
            onPress={inbox.onPress}
            style={[styles.bell, inbox.count > 0 && styles.bellNew]}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={inbox.count > 0 ? `Inbox, ${inbox.count} new` : 'Inbox'}>
            <Ionicons name={inbox.count > 0 ? 'notifications' : 'notifications-outline'} size={22} color={inbox.count > 0 ? colors.accent : colors.text} />
            {inbox.count > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{inbox.count > 99 ? '99+' : inbox.count}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: colors.bg,
  },
  side: {
    width: 48,
    paddingTop: space.sm,
  },
  right: {
    alignItems: 'flex-end',
  },
  bell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  // Something new: a pink ring around the bell, so it's easy to spot.
  bellNew: {
    borderWidth: 2,
    borderColor: colors.accent,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.red,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  badgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
  },
  title: {
    ...font.title,
    flex: 1,
    textAlign: 'center',
    paddingTop: space.sm,
  },
  logo: {
    flex: 1,
    alignItems: 'center',
    paddingTop: space.sm,
  },
});
