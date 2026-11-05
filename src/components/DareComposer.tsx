import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { KeyboardSafeView } from '@/components/KeyboardSafeView';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

const MAX_LENGTH = 200;

// A few ideas to tap if you can't think of one (they fill the box, you can still change them).
const IDEAS = [
  'Sing the chorus of your favourite song in public',
  'Call your mum and tell her a joke',
  'Do 20 push-ups right now',
  'Wear your clothes inside out for an hour',
  'Order your next drink in your best accent',
];

// The pop-up for writing your own dare in a chat: a box for the dare, a few ideas, and Send.
export function DareComposer({ visible, friendName, onClose, onSend }: {
  visible: boolean;
  friendName: string;
  onClose: () => void;
  onSend: (dare: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const dare = text.trim();

  async function send() {
    if (!dare || busy) return;
    setBusy(true);
    const ok = await onSend(dare);
    setBusy(false);
    if (ok) {
      setText('');
      onClose();
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSafeView style={styles.fill}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <Text style={styles.title}>🎯 Dare {friendName || 'them'}</Text>
          <Text style={styles.hint}>Keep it fun and safe – nothing dangerous, illegal or mean.</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="I dare you to…"
            placeholderTextColor={colors.textFaint}
            keyboardAppearance={keyboardAppearance}
            selectionColor={colors.accent}
            multiline
            maxLength={MAX_LENGTH}
            autoFocus
            style={styles.input}
          />
          <Text style={styles.count}>
            {dare.length}/{MAX_LENGTH}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.ideas} keyboardShouldPersistTaps="handled">
            {IDEAS.map((idea) => (
              <Pressable key={idea} onPress={() => setText(idea)} style={styles.idea} accessibilityLabel={`Use idea: ${idea}`}>
                <Text style={styles.ideaText} numberOfLines={1}>
                  💡 {idea}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <Button title="Send dare" icon="paper-plane" onPress={send} loading={busy} disabled={!dare} />
        </View>
      </KeyboardSafeView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  title: {
    ...font.heading,
  },
  hint: {
    ...font.small,
  },
  input: {
    minHeight: 90,
    maxHeight: 160,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
    padding: space.md,
    textAlignVertical: 'top',
  },
  count: {
    ...font.small,
    alignSelf: 'flex-end',
  },
  ideas: {
    gap: space.sm,
    paddingBottom: space.sm,
  },
  idea: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    maxWidth: 260,
  },
  ideaText: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
  },
});
