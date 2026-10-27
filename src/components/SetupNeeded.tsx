import { LinearGradient } from 'expo-linear-gradient';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, font, gradients, radius, space } from '@/theme';

// Shown instead of the app when the .env file with the Supabase details is missing.
export function SetupNeeded() {
  return (
    <LinearGradient colors={gradients.night} style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.emoji}>🔌</Text>
          <Text style={styles.title}>Almost ready!</Text>
          <Text style={styles.body}>
            The app doesn&apos;t know which Supabase project to talk to yet.
          </Text>
          <View style={styles.card}>
            <Text style={styles.step}>1. In the project folder, copy .env.example to a new file named .env</Text>
            <Text style={styles.step}>2. Paste your Supabase URL and publishable key into it</Text>
            <Text style={styles.step}>3. Stop the app (Ctrl + C) and run: npx expo start --clear</Text>
          </View>
          <Text style={styles.small}>Full steps are in README.md.</Text>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  content: {
    padding: space.xl,
    gap: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
  },
  emoji: {
    fontSize: 64,
  },
  title: {
    ...font.title,
  },
  body: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    alignSelf: 'stretch',
  },
  step: {
    ...font.body,
    lineHeight: 22,
  },
  small: {
    ...font.small,
  },
});
