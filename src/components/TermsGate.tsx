import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { LegalText } from '@/components/LegalText';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { acceptLegal, hasAccepted, LEGAL_PAGES, TERMS_VERSION, type LegalPage } from '@/lib/legal';
import { LEGAL_DOCS } from '@/lib/legalDocs';
import { forgetAgreed, knownAgreed, rememberAgreed } from '@/lib/termsCache';
import { colors, font, radius, space } from '@/theme';

// Makes sure everyone has agreed to the current Terms of Service.
// - While we check (a moment at start-up): a plain cover, so the app can't be used before we know.
// - Already agreed: the cover goes away.
// - Just signed up (you ticked "I agree" on the sign-up screen): it's recorded quietly.
// - Signed up before the Terms existed, or the Terms changed: a full-screen "please agree" page, with
//   the documents one tap away. The only other choice is logging out.
// - The check didn't work (no internet?) or took too long: "Couldn't check – Try again" (and "Log out"). It
//   also tries again by itself when you come back to the app. It never lets you in without a confirmed "yes, agreed".
type TermsStatus = 'checking' | 'needed' | 'agreed' | 'failed';

// How long a check may take before we stop waiting and offer "Try again" / "Log out". (On Android a request
// can hang forever, for example right after switching from wifi to mobile data.)
export const CHECK_TIME_LIMIT_MS = 15_000;

export function TermsGate() {
  const { session, userId, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  // The answer, and whose account it's about (a different login is always checked again first).
  // `tapped` is true when the person agreed on the Terms page just now (so the page may slide away).
  const [answer, setAnswer] = useState<{ user: string; status: TermsStatus; tapped?: boolean } | null>(null);
  // Known on this phone to have agreed already: straight in, no cover (the check still runs below).
  const cached = !!userId && knownAgreed(userId, TERMS_VERSION);
  const status: TermsStatus = userId && answer?.user === userId ? answer.status : cached ? 'agreed' : 'checking';
  // Goes up by one for every new try of the check.
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  // Reading one of the documents (shown right here – this page sits on top of everything else).
  const [reading, setReading] = useState<LegalPage | null>(null);
  const agreedAtSignUp = session?.user.user_metadata?.terms_version === TERMS_VERSION;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let answered = false;
    // Taking too long counts as "couldn't check". If the real answer still comes later, it wins.
    const timer = setTimeout(() => {
      if (!cancelled && !answered && !cached) setAnswer({ user: userId, status: 'failed' });
    }, CHECK_TIME_LIMIT_MS);
    hasAccepted(userId, 'terms', TERMS_VERSION)
      .then(async (accepted): Promise<TermsStatus> => {
        if (accepted) return 'agreed';
        if (agreedAtSignUp) {
          await acceptLegal('terms', TERMS_VERSION);
          return 'agreed';
        }
        return 'needed';
      })
      .catch((error): TermsStatus => {
        console.warn('Could not check the Terms', error);
        return 'failed';
      })
      .then((result) => {
        answered = true;
        clearTimeout(timer);
        if (result === 'agreed') rememberAgreed(userId, TERMS_VERSION);
        if (result === 'needed') forgetAgreed(userId);
        // Couldn't check, but this phone knows they agreed: let them carry on.
        if (result === 'failed' && cached) return;
        if (!cancelled) setAnswer({ user: userId, status: result });
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, agreedAtSignUp, attempt, cached]);

  function tryAgain() {
    if (!active.current) return;
    setAnswer(null);
    setAttempt((count) => count + 1);
  }

  // The check failed: try again by itself as soon as you come back to the app.
  const failed = status === 'failed';
  useEffect(() => {
    if (!failed) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && active.current) {
        setAnswer(null);
        setAttempt((count) => count + 1);
      }
    });
    return () => subscription.remove();
  }, [failed]);

  async function agree() {
    if (!active.current) return;
    setBusy(true);
    try {
      await acceptLegal('terms', TERMS_VERSION);
      if (userId) rememberAgreed(userId, TERMS_VERSION);
      if (!active.current || !userId) return;
      setAnswer({ user: userId, status: 'agreed', tapped: true });
    } catch (error) {
      if (active.current) Alert.alert('Could not save', friendlyError(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function logOut() {
    if (!active.current) return;
    try {
      await signOut(userId ?? undefined);
    } catch (error) {
      if (active.current) Alert.alert('Could not log out', friendlyError(error));
    }
  }

  const open = (doc: LegalPage) => setReading(doc);

  // One pop-up page covers the app for the whole check. It is never closed and opened again in one go:
  // on an iPhone, opening a new pop-up while another one is closing can fail, and then the Terms page
  // would not show at all.
  // - Checking: a plain cover (no Terms text). It appears and goes away without any animation, so people
  //   who already agreed see nothing slide on every launch.
  // - The check failed: "Couldn't check" on the same page.
  // - Agreeing is needed: the Terms page on the same page. After "I agree" it slides away.
  const slide = status === 'needed' || (status === 'agreed' && answer?.tapped === true);
  return (
    <Modal visible={status !== 'agreed'} animationType={slide ? 'slide' : 'none'} onRequestClose={() => {}}>
      {status === 'checking' ? (
        <View style={[styles.fill, styles.center]}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : status === 'failed' ? (
        <CouldNotCheck onRetry={tryAgain} />
      ) : (
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
          <Button title="Log out" variant="plain" onPress={logOut} />
        </View>
          </>
        )}
      </View>
      )}
    </Modal>
  );
}

// Shown instead of the app when we couldn't check something we must know first (no internet?).
// "Try again" checks again; you can also log out.
export function CouldNotCheck({ onRetry, checking = false }: { onRetry: () => void; checking?: boolean }) {
  const { userId, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function logOut() {
    if (!mounted.current) return;
    try {
      await signOut(userId ?? undefined);
    } catch (error) {
      if (mounted.current) Alert.alert('Could not log out', friendlyError(error));
    }
  }

  return (
    <View style={[styles.fill, styles.center, { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg }]}>
      <Text style={styles.emoji}>📶</Text>
      <Text style={styles.title}>Couldn&apos;t check</Text>
      <Text style={[styles.text, styles.centerText]}>
        We couldn&apos;t reach Peekaboo just now. Check your internet connection and try again.
      </Text>
      <View style={styles.buttons}>
        <Button title="Try again" icon="refresh" loading={checking} onPress={onRetry} />
        <Button title="Log out" variant="plain" onPress={logOut} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: space.lg,
  },
  center: {
    justifyContent: 'center',
    gap: space.md,
  },
  centerText: {
    textAlign: 'center',
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
