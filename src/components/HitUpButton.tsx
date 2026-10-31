import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput } from 'react-native';

import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { friendlyError } from '@/lib/errors';
import { fetchHitUpStatus, HIT_UP_MAX_LENGTH, sendHitUp, type HitUpStatus } from '@/lib/hitups';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

// The 👋 button on someone's profile (people you're not friends with yet):
// "Hit up" (with a short message if you want) · "Hit up sent" · "Hit back" when they hit you up first.
// Nothing shows when hit ups aren't possible (they turned them off, a different age group, or blocked).
export function HitUpButton({ person, onConnected }: {
  person: { id: string; username: string; display_name: string };
  // You're friends now (they had hit you up too).
  onConnected: () => void;
}) {
  const { showToast } = useOverlays();
  const [status, setStatus] = useState<HitUpStatus | null>(null);
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const name = person.display_name || `@${person.username}`;

  const load = useCallback(() => {
    fetchHitUpStatus(person.id)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [person.id]);

  useEffect(load, [load]);

  async function send(message: string) {
    setSending(true);
    try {
      const result = await sendHitUp(person.id, message);
      setWriting(false);
      setNote('');
      if (result === 'connected') {
        showToast(`You and ${name} can chat now 🎉`);
        onConnected();
        router.push(`/chat/${person.id}`);
      } else {
        showToast(`Hit up sent to ${name} 👋`);
        setStatus('sent');
      }
    } catch (error) {
      Alert.alert('Could not hit them up', friendlyError(error));
      load();
    } finally {
      setSending(false);
    }
  }

  if (status === 'no_birthday') {
    return (
      <Button
        title="👋 Hit up"
        variant="secondary"
        onPress={() =>
          Alert.alert('Add your birthday first 🎂', 'Hit ups are only between people your age. Only you see your birthday.', [
            { text: 'Not now', style: 'cancel' },
            { text: 'Add birthday', onPress: () => router.push('/birthday') },
          ])
        }
      />
    );
  }

  if (status === 'sent') {
    return (
      <Button
        title="Hit up sent ✓"
        variant="secondary"
        onPress={() => showToast(`It's up to ${name} now – you can chat once they hit back`)}
      />
    );
  }

  if (status === 'theirs') {
    return <Button title={`👋 Hit back – ${name} hit you up`} loading={sending} onPress={() => send('')} />;
  }

  if (status !== 'can') return null;

  return (
    <>
      <Button title="👋 Hit up" variant="pink" onPress={() => setWriting(true)} />
      <Modal visible={writing} transparent animationType="slide" onRequestClose={() => setWriting(false)}>
        <KeyboardAvoidingView style={styles.fill} behavior="padding">
          <Pressable style={styles.backdrop} onPress={() => setWriting(false)}>
            <SafeEdge edge="bottom" style={styles.sheet}>
              <Pressable style={styles.inner}>
                <Text style={styles.title}>Hit up {name} 👋</Text>
                <Text style={styles.text}>
                  They&apos;ll see it at the top of their Chat. If they hit back, you&apos;re friends and can chat.
                </Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Add a message (optional)"
                  placeholderTextColor={colors.textFaint}
                  keyboardAppearance={keyboardAppearance}
                  selectionColor={colors.accent}
                  maxLength={HIT_UP_MAX_LENGTH}
                  multiline
                  autoFocus
                  style={styles.input}
                />
                <Text style={styles.count}>
                  {note.length}/{HIT_UP_MAX_LENGTH}
                </Text>
                <Button title="Send hit up" icon="hand-right" loading={sending} onPress={() => send(note)} />
                <Button title="Cancel" variant="plain" onPress={() => setWriting(false)} />
              </Pressable>
            </SafeEdge>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  inner: {
    padding: space.lg,
    gap: space.md,
  },
  title: {
    ...font.heading,
    textAlign: 'center',
  },
  text: {
    ...font.small,
    textAlign: 'center',
    lineHeight: 19,
  },
  input: {
    ...font.body,
    minHeight: 70,
    maxHeight: 130,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.md,
    color: colors.text,
  },
  count: {
    ...font.small,
    textAlign: 'right',
    marginTop: -space.sm,
  },
});
