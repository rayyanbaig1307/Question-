import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { IconButton } from '@/components/IconButton';
import { useMe } from '@/lib/auth';
import { colors, font, space } from '@/theme';

// Top bar for the Chat and Stories pages: your picture (→ profile), a title, and a camera button.
export function PageHeader({ title, cameraSide, onCamera }: {
  title: string;
  cameraSide: 'left' | 'right';
  onCamera: () => void;
}) {
  const { userId, profile } = useMe();
  const insets = useSafeAreaInsets();

  const camera = (
    <IconButton icon="camera" label="Back to camera" background={colors.card} size={40} onPress={onCamera} />
  );
  const me = (
    <Pressable onPress={() => router.push(`/profile/${userId}`)} accessibilityLabel="My profile">
      <Avatar path={profile?.avatar_path} name={profile?.display_name || profile?.username} size={40} />
    </Pressable>
  );

  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      <View style={styles.side}>{cameraSide === 'left' ? camera : me}</View>
      <Text style={styles.title}>{title}</Text>
      <View style={[styles.side, styles.right]}>{cameraSide === 'right' ? camera : me}</View>
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
  title: {
    ...font.title,
    flex: 1,
    textAlign: 'center',
    paddingTop: space.sm,
  },
});
