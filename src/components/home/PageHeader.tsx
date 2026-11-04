import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Wordmark } from '@/components/Wordmark';
import { useMe } from '@/lib/auth';
import { colors, font, space } from '@/theme';

// Top bar for the Chat and Home pages: a title (or the Peekaboo logo) in the middle, and your picture
// (→ profile) on the right – so your profile is always one tap away. (No camera button: the bottom bar has one.)
// `inbox`: a 🔔 bell next to your picture (Chat page) with a red number for new things in your Inbox.
export function PageHeader({ title, logo = false, inbox }: {
  title?: string;
  logo?: boolean;
  inbox?: { count: number; onPress: () => void };
}) {
  const { userId, profile } = useMe();
  const insets = useSafeAreaInsets();

  const me = (
    <Pressable onPress={() => router.push(`/profile/${userId}`)} accessibilityLabel="My profile">
      <Avatar path={profile?.avatar_path} name={profile?.display_name || profile?.username} size={40} />
    </Pressable>
  );

  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      {/* An empty space the same width as the right side, so the title stays in the middle. */}
      <View style={[styles.side, inbox && styles.sideWide]} />
      {logo ? (
        <View style={styles.logo}>
          <Wordmark height={30} />
        </View>
      ) : (
        <Text style={styles.title}>{title}</Text>
      )}
      <View style={[styles.side, styles.right, inbox && styles.sideWide]}>
        {inbox ? (
          <Pressable
            onPress={inbox.onPress}
            style={styles.bell}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={inbox.count > 0 ? `Inbox, ${inbox.count} new` : 'Inbox'}>
            <Ionicons name={inbox.count > 0 ? 'notifications' : 'notifications-outline'} size={22} color={colors.text} />
            {inbox.count > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{inbox.count > 99 ? '99+' : inbox.count}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
        {me}
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
  sideWide: {
    width: 96,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
  bell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
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
