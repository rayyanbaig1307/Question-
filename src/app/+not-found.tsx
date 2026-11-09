import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { colors, space } from '@/theme';

// Shown when a link points to a page the app doesn't have (an old link, or a typo), instead of a
// developer error screen. "Go home" works logged in or out (logged out, it goes to the welcome screen).
export default function NotFound() {
  return (
    <View style={styles.fill}>
      <EmptyState emoji="🙈" title="That page doesn't exist" message="The link might be old or broken.">
        <Button title="Go home" icon="home" onPress={() => router.replace('/')} />
      </EmptyState>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: 'center',
    padding: space.lg,
    backgroundColor: colors.bg,
  },
});
