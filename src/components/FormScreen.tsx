import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton } from '@/components/IconButton';
import { colors, font, space } from '@/theme';

// Layout for form screens: back button, big title, and fields that stay above the keyboard.
export function FormScreen({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          <IconButton
            icon="chevron-back"
            label="Go back"
            background={colors.card}
            onPress={() => router.back()}
          />
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.xl,
    gap: space.lg,
    flexGrow: 1,
  },
  header: {
    gap: space.xs,
    marginTop: space.sm,
    marginBottom: space.sm,
  },
  title: {
    ...font.title,
  },
  subtitle: {
    ...font.body,
    color: colors.textMuted,
  },
});
