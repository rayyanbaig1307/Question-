import { useEffect, useState } from 'react';
import { Alert, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { LegalText } from '@/components/LegalText';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { acceptLegal, hasAccepted, LEGAL_PAGES, TERMS_VERSION, type LegalPage } from '@/lib/legal';
import { LEGAL_DOCS } from '@/lib/legalDocs';
import { colors, font, radius, space } from '@/theme';

// Makes sure everyone has agreed to the current Terms of Service.
// - Just signed up (you ticked "I agree" on the sign-up screen): it's recorded quietly.
// - Signed up before the Terms existed, or the Terms changed: a full-screen "please agree" page, with
//   the documents one tap away. The only other choice is logging out.
export function TermsGate() {
  const { session, userId, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reading one of the documents (shown right here – this page sits on top of everything else).
  const [reading, setReading] = useState<LegalPage | null>(null);
  const agreedAtSignUp = session?.user.user_metadata?.terms_version === TERMS_VERSION;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    hasAccepted(userId, 'terms', TERMS_VERSION)
      .then(async (accepted) => {
        if (accepted || cancelled) return;
        if (agreedAtSignUp) {
          await acceptLegal('terms', TERMS_VERSION);
          return;
        }
        setNeeded(true);
      })
      .catch((error) => console.warn('Could not check the Terms', error));
    return () => {
      cancelled = true;
    };
  }, [userId, agreedAtSignUp]);

  async function agree() {
    setBusy(true);
    try {
      await acceptLegal('terms', TERMS_VERSION);
      setNeeded(false);
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  const open = (doc: LegalPage) => setReading(doc);

  return (
    <Modal visible={needed} animationType="slide" onRequestClose={() => {}}>
      <View style={[styles.fill, { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg }]}>
        {reading ? (
          <>
            <Text style={styles.readingTitle}>{LEGAL_PAGES[reading]}</Text>
            <ScrollView contentContainerStyle={styles.content}>
              <LegalText markdown={LEGAL_DOCS[reading]} />
            </ScrollView>
            <View style={styles.buttons}>
              <Button title="Back" icon="arrow-back" variant="secondary" onPress={() => setReading(null)} />
            </View>
          </>
        ) : (
          <>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.emoji}>📜</Text>
          <Text style={styles.title}>Our Terms</Text>
          <Text style={styles.text}>
            To keep using Peekaboo, please read and agree to our Terms of Service. They include the Dare Safety Rules
            and the Privacy Policy. In short:
          </Text>
          <View style={styles.card}>
            {[
              '🎯 Dares are optional – you decide what you do, and it’s your responsibility.',
              '🙅 Nobody gets hurt, nothing illegal, everyone in your photos agrees.',
              '📸 Others can screenshot "disappearing" photos – never send what you’d regret.',
              '🚩 We remove content and accounts that break the rules.',
              '🔒 We don’t sell your data or show ads.',
            ].map((line) => (
              <Text key={line} style={styles.point}>
                {line}
              </Text>
            ))}
          </View>
          <Text style={styles.links}>
            <Text style={styles.link} onPress={() => open('terms')}>
              Terms of Service
            </Text>
            {'  ·  '}
            <Text style={styles.link} onPress={() => open('dare-rules')}>
              Dare Safety Rules
            </Text>
            {'  ·  '}
            <Text style={styles.link} onPress={() => open('privacy')}>
              Privacy Policy
            </Text>
            {'  ·  '}
            <Text style={styles.link} onPress={() => open('guidelines')}>
              Community Guidelines
            </Text>
          </Text>
          <Text style={styles.small}>If you&apos;re under 18, show these to a parent or guardian – they need to agree too.</Text>
        </ScrollView>
        <View style={styles.buttons}>
          <Button title="I agree" icon="checkmark-circle" loading={busy} onPress={agree} />
          <Button title="Log out" variant="plain" onPress={() => signOut()} />
        </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: space.lg,
  },
  content: {
    gap: space.md,
    paddingBottom: space.lg,
  },
  emoji: {
    fontSize: 48,
    textAlign: 'center',
  },
  title: {
    ...font.title,
    textAlign: 'center',
  },
  readingTitle: {
    ...font.heading,
    textAlign: 'center',
    marginBottom: space.md,
  },
  text: {
    ...font.body,
    lineHeight: 22,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  point: {
    ...font.body,
    lineHeight: 22,
  },
  links: {
    ...font.small,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  link: {
    color: colors.accent,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  small: {
    ...font.small,
    textAlign: 'center',
  },
  buttons: {
    gap: space.sm,
  },
});
