import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { useMe } from '@/lib/auth';
import { colors, font, space } from '@/theme';

// Temporary home screen until the camera is built.
export default function Home() {
  const { userId, profile, signOut } = useMe();

  return (
    <SafeAreaView style={styles.wrap}>
      <View style={styles.center}>
        <Avatar path={profile?.avatar_path} name={profile?.display_name} size={96} ring />
        <Text style={styles.title}>You&apos;re in! 🎉</Text>
        <Text style={styles.subtitle}>
          {profile ? `Logged in as @${profile.username}` : 'Loading your profile…'}
        </Text>
      </View>
      <View style={styles.buttons}>
        <Button title="My profile" icon="person-circle-outline" onPress={() => router.push(`/profile/${userId}`)} />
        <Button title="Log out" variant="secondary" icon="log-out-outline" onPress={signOut} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    padding: space.xl,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
  title: {
    ...font.title,
  },
  subtitle: {
    ...font.body,
    color: colors.textMuted,
  },
  buttons: {
    gap: space.md,
  },
});
