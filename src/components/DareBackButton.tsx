import { useState } from 'react';
import { Alert, StyleSheet, Text } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Bouncy } from '@/components/Bouncy';
import { DareComposer } from '@/components/DareComposer';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { sendDare } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { colors, radius, space } from '@/theme';

// "🎯 Dare them back" under a friend's public dare post: write a dare and it lands in your chat with them,
// where they can do it, send proof, and you confirm it – building your dare streak 🔥 (see chat/[id].tsx).
// Only shown for friends (you can only message friends).
export function DareBackButton({ person }: { person: { id: string; name: string } }) {
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const [open, setOpen] = useState(false);

  async function send(dare: string): Promise<boolean> {
    try {
      await sendDare(userId, person.id, dare);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(`Dare sent to ${person.name} 🎯 It's in your chat`);
      return true;
    } catch (error) {
      Alert.alert('Dare not sent', friendlyError(error));
      return false;
    }
  }

  return (
    <>
      <Bouncy style={styles.button} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`Dare ${person.name} back`}>
        <Text style={styles.text} numberOfLines={1}>
          🎯 Dare {person.name} back
        </Text>
      </Bouncy>
      <DareComposer visible={open} friendName={person.name} onClose={() => setOpen(false)} onSend={send} />
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.pink,
  },
  text: {
    color: colors.onAccent,
    fontWeight: '900',
    fontSize: 14,
  },
});
