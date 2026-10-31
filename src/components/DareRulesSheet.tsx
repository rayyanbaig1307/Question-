import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { SafeEdge } from '@/components/SafeEdge';
import { friendlyError } from '@/lib/errors';
import { colors, font, radius, space } from '@/theme';

const POINTS = [
  'Only do a dare if it’s **safe and legal** for you, right where you are.',
  '**No one gets hurt**: no fire, weapons, vehicles, alcohol, drugs, heights, open water, dangerous stunts or risky eating.',
  '**Everyone agrees**: only film and involve people who say yes – never someone asleep.',
  '**Under 18?** Physical dares only with an adult around.',
];

// The one-time "Before your first dare" sheet. Shown before your first dare, drop, forfeit or dare idea;
// agreeing is recorded (and asked again only if the rules change).
export function DareRulesSheet({ visible, onAccept, onClose }: {
  visible: boolean;
  onAccept: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    try {
      await onAccept();
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <SafeEdge edge="bottom" style={styles.sheet}>
          <Pressable>
            <ScrollView contentContainerStyle={styles.inner}>
              <Text style={styles.title}>Before your first dare 🎯</Text>
              <Text style={styles.text}>Dares are just ideas for fun. You never have to do one.</Text>
              {POINTS.map((point) => (
                <View key={point} style={styles.row}>
                  <Text style={styles.bullet}>•</Text>
                  <Text style={styles.text}>{bold(point)}</Text>
                </View>
              ))}
              <Text style={styles.small}>
                By continuing you confirm you&apos;ve read the{' '}
                <Text
                  style={styles.link}
                  onPress={() => {
                    onClose();
                    router.push({ pathname: '/legal/[doc]', params: { doc: 'dare-rules' } });
                  }}>
                  Dare Safety Rules
                </Text>
                , that <Text style={styles.strong}>you decide what you do and take responsibility for it</Text>, and that
                Peekaboo doesn&apos;t supervise dares and isn&apos;t liable for what you choose to do.
              </Text>
              <Button title="I understand – let's go" icon="flame" loading={busy} onPress={accept} />
              <Button title="Not now" variant="plain" onPress={onClose} />
            </ScrollView>
          </Pressable>
        </SafeEdge>
      </Pressable>
    </Modal>
  );
}

// "**bold** words" → bold text.
function bold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? (
      <Text key={i} style={styles.strong}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '90%',
  },
  inner: {
    padding: space.lg,
    gap: space.md,
  },
  title: {
    ...font.heading,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  bullet: {
    ...font.body,
    color: colors.accent,
    fontWeight: '900',
  },
  text: {
    ...font.body,
    flex: 1,
    lineHeight: 22,
  },
  strong: {
    fontWeight: '800',
  },
  small: {
    ...font.small,
    fontSize: 13,
    lineHeight: 19,
  },
  link: {
    color: colors.accent,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
});
