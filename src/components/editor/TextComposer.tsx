import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SafeScreen } from '@/components/SafeEdge';
import { colors, keyboardAppearance, radius, space } from '@/theme';
import { TEXT_COLORS, textOn, type OverlayItem } from './stickers';

export type TextDraft = Pick<OverlayItem, 'content' | 'color' | 'look'>;

// Full-screen "type your text" mode, with color dots and a bubble on/off button.
export function TextComposer({ initial, onDone }: {
  initial: TextDraft;
  onDone: (draft: TextDraft) => void;
}) {
  const [content, setContent] = useState(initial.content);
  const [color, setColor] = useState(initial.color);
  const [look, setLook] = useState(initial.look);

  const finish = () => onDone({ content: content.trim(), color, look });

  return (
    <View style={styles.backdrop}>
      <SafeScreen style={styles.fill}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.topRow}>
            <Pressable
              onPress={() => setLook(look === 'pill' ? 'shadow' : 'pill')}
              style={[styles.lookButton, look === 'pill' && { backgroundColor: color }]}
              accessibilityLabel="Switch text bubble">
              <Text style={[styles.lookText, look === 'pill' && { color: textOn(color) }]}>Aa</Text>
            </Pressable>
            <Pressable onPress={finish} style={styles.done} accessibilityRole="button">
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>

          <View style={styles.center}>
            <TextInput
              value={content}
              onChangeText={setContent}
              autoFocus
              multiline
              maxLength={120}
              placeholder="Type something…"
              placeholderTextColor="rgba(255,255,255,0.5)"
              keyboardAppearance={keyboardAppearance}
              selectionColor={colors.accent}
              style={[
                styles.input,
                look === 'pill'
                  ? [styles.pill, { backgroundColor: color, color: textOn(color) }]
                  : { color },
              ]}
            />
          </View>

          <View style={styles.colors}>
            {TEXT_COLORS.map((option) => (
              <Pressable
                key={option}
                onPress={() => setColor(option)}
                accessibilityLabel={`Color ${option}`}
                style={[styles.dot, { backgroundColor: option }, option === color && styles.dotSelected]}
              />
            ))}
          </View>
        </KeyboardAvoidingView>
      </SafeScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  fill: {
    flex: 1,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  lookButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lookText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 16,
  },
  done: {
    backgroundColor: colors.accent,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  doneText: {
    color: colors.onAccent,
    fontWeight: '900',
    fontSize: 16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  input: {
    fontSize: 34,
    fontWeight: '900',
    textAlign: 'center',
    minWidth: 60,
    maxWidth: '90%',
  },
  pill: {
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  colors: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.md,
  },
  dot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  dotSelected: {
    borderColor: colors.white,
    borderWidth: 4,
    transform: [{ scale: 1.15 }],
  },
});
