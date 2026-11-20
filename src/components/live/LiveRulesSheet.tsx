import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { SafeEdge } from '@/components/SafeEdge';
import { friendlyError } from '@/lib/errors';
import { acceptLegal, LIVE_RULES_VERSION } from '@/lib/legal';
import { colors, font, radius, space } from '@/theme';

// The Live rules card 🔴. Everyone agrees once, before their first live or their first time on someone's live
// (the server checks it: saved as 'live_rules', with the version in LIVE_RULES_VERSION). The server only checks
// that you agreed once: asking everyone again after a change to the rules would need a server change too.
export const LIVE_RULES = [
  '**Friends only.** Only your friends can watch. While a friend is on with you, only people who are friends with you both can watch.',
  '**Bringing someone on needs their yes**, and anyone on the stage can leave it any time.',
  "**We don't record or save lives** – but friends watching could screen-record them, so only share what you're OK with.",
  '**Keep it safe:** never show your school, your address or anything that says where you are. Nothing sexual.',
  '**You can end your live any time.** Report anyone who pressures you – in the live or after.',
  'We can end a live or stop you going live if the rules are broken.',
];

export const TAKE_IT_DOWN_URL = 'https://takeitdown.ncmec.org';
export const CYBERTIP_URL = 'https://www.cybertip.ca';

// The Live rules sheet on its own (a pop-up sheet). Where another sheet is already open (the Go live sheet,
// the "come on my live?" sheet), show LiveRulesCard inside that sheet instead: a phone can't open a second
// pop-up sheet while one is open or closing.
export function LiveRulesSheet({ visible, onAccepted, onClose, onOpenPage = onClose }: {
  visible: boolean;
  // Called once agreeing was saved.
  onAccepted: () => void;
  onClose: () => void;
  // A link opens the Privacy Policy or the Guidelines: close whatever would cover that page (a pop-up sheet
  // stays on top of every screen). Closes just this card unless told otherwise.
  onOpenPage?: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close the Live rules">
        <SafeEdge edge="bottom" style={styles.sheet}>
          <LiveRulesCard onAccepted={onAccepted} onClose={onClose} onOpenPage={onOpenPage} />
        </SafeEdge>
      </Pressable>
    </Modal>
  );
}

// The card itself: the rules, the links, "I agree" (saved on the server) and "Not now".
export function LiveRulesCard({ onAccepted, onClose, onOpenPage = onClose }: {
  onAccepted: () => void;
  onClose: () => void;
  onOpenPage?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function accept() {
    if (busy) return;
    setBusy(true);
    try {
      await acceptLegal('live_rules', LIVE_RULES_VERSION);
      onAccepted();
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  function openPage(doc: 'privacy' | 'guidelines') {
    onOpenPage();
    router.push({ pathname: '/legal/[doc]', params: { doc } });
  }

  return (
    <Pressable style={styles.card}>
      <ScrollView contentContainerStyle={styles.inner}>
        <Text style={styles.title}>Live rules 🔴</Text>
        {LIVE_RULES.map((rule) => (
          <View key={rule} style={styles.row}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.text}>{bold(rule)}</Text>
          </View>
        ))}
        <Text style={styles.small}>
          Lives use a company called LiveKit to carry your video and sound – see the{' '}
          <Text style={styles.link} onPress={() => openPage('privacy')} accessibilityRole="link">
            Privacy Policy
          </Text>
          .
        </Text>
        <Text style={styles.small}>
          Under 18 and someone shared a photo or video of you that they shouldn&apos;t have? Get help taking it
          down:{' '}
          <Text style={styles.link} onPress={() => Linking.openURL(TAKE_IT_DOWN_URL).catch(() => {})} accessibilityRole="link">
            Take It Down
          </Text>{' '}
          (NCMEC) or{' '}
          <Text style={styles.link} onPress={() => Linking.openURL(CYBERTIP_URL).catch(() => {})} accessibilityRole="link">
            Cybertip.ca
          </Text>
          .
        </Text>
        <Text style={styles.small}>
          By going live you agree to these rules and the{' '}
          <Text style={styles.link} onPress={() => openPage('guidelines')} accessibilityRole="link">
            Community Guidelines
          </Text>
          .
        </Text>
        <Button title="I agree" icon="checkmark-circle" loading={busy} onPress={accept} />
        <Button title="Not now" variant="plain" onPress={onClose} />
      </ScrollView>
    </Pressable>
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
  card: {
    flexShrink: 1,
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
    color: colors.live,
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
