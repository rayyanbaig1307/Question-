import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { SafeEdge } from '@/components/SafeEdge';
import { LiveRulesCard } from '@/components/live/LiveRulesSheet';
import { holdCameraForLive, isLiveAvailable, LIVE_UNAVAILABLE_WORDS, setLiveNow } from '@/lib/liveAccess';
import { ensureLivePermissions, LIVE_PERMISSION_WORDS, openPhoneSettings, type LivePermission } from '@/lib/livePermissions';
import { fetchLiveState, type LiveState, type LiveWhyNot } from '@/lib/lives';
import { colors, font, radius, space } from '@/theme';

// Why you can't go live right now, in plain words (the server decides; this only explains).
export const GO_LIVE_WHY_NOT: Record<LiveWhyNot, string> = {
  off: "You can't go live right now.",
  testers: "You can't go live right now.",
  banned: "You can't go live right now.",
  restricted: "You can't go live right now.",
  birthday: 'Add your birthday to go live',
  rules: 'Read the Live rules to go live',
  no_friends: 'Add a friend to go live – only friends can watch.',
  new_account: 'Your account is a bit too new to go live – try again in a few days.',
  daily_limit: 'You’ve gone live 3 times today – try again tomorrow',
  month_limit: 'You’ve used your live time for this month – it resets on the 1st.',
  busy: 'Lives are busy right now – try again later',
};

// What going live means – shown right above the Go live button (this is what you agree to).
export function goLiveLines(maxMinutes: number): string[] {
  return [
    'Only your friends can watch.',
    'Friends with the newest Peekaboo get a notification (at most once every 2 hours).',
    `Up to ${maxMinutes} minutes. We don’t record or save your live – but friends watching could screen-record it, so only share what you’re OK with.`,
  ];
}

// The "Go live" sheet over the camera (the 🔴 bubble, then the shutter). The camera keeps running behind it.
// It asks the server whether you can go live; when you can, Go live checks the camera and microphone, checks
// this phone can do lives, then opens the live screen. Each time it opens it starts fresh (and asks again).
export function GoLiveSheet({ visible, facing, onClose }: {
  visible: boolean;
  facing: 'front' | 'back';
  onClose: () => void;
}) {
  return visible ? <OpenSheet facing={facing} onClose={onClose} /> : null;
}

function OpenSheet({ facing, onClose }: { facing: 'front' | 'back'; onClose: () => void }) {
  const [state, setState] = useState<LiveState | null>(null);
  const [failed, setFailed] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [permission, setPermission] = useState<LivePermission | null>(null);
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const asking = useRef(0);

  // Asks the server whether you can go live (the newest answer wins).
  const ask = useCallback(() => {
    const n = ++asking.current;
    fetchLiveState().then(
      (next) => {
        if (n !== asking.current) return;
        setState(next);
        // The rules are the next step: open them straight away.
        if (next.why_not === 'rules') setRulesOpen(true);
      },
      () => {
        if (n === asking.current) setFailed(true);
      },
    );
  }, []);

  useEffect(() => {
    ask();
  }, [ask]);

  // Try again (or after agreeing to the Live rules): ask once more.
  function load() {
    setFailed(false);
    setState(null);
    ask();
  }

  async function goLive() {
    if (busy) return;
    setBusy(true);
    try {
      const allowed = await ensureLivePermissions();
      if (allowed !== 'ok') {
        setPermission(allowed);
        return;
      }
      setPermission(null);
      // The real check (it wakes LiveKit's parts on the phone): only now, right before the live.
      if (!isLiveAvailable()) {
        setBroken(true);
        return;
      }
      // From here you're live: nothing restarts the app, and the camera is handed to the live.
      setLiveNow('host');
      holdCameraForLive();
      onClose();
      router.push({ pathname: '/go-live', params: { facing } });
    } finally {
      setBusy(false);
    }
  }

  function addBirthday() {
    onClose();
    router.push('/birthday');
  }

  const whyNot = state?.why_not ?? null;
  let body;
  if (failed) {
    body = (
      <>
        <Text style={styles.line}>Couldn’t check if you can go live – check your internet.</Text>
        <Button title="Try again" icon="refresh" onPress={load} />
      </>
    );
  } else if (!state) {
    body = <ActivityIndicator color={colors.live} style={styles.spinner} />;
  } else if (broken) {
    body = <Text style={styles.line}>{LIVE_UNAVAILABLE_WORDS.broken}</Text>;
  } else if (permission) {
    body = (
      <>
        <Text style={styles.line}>{LIVE_PERMISSION_WORDS}</Text>
        {permission === 'settings' ? (
          <Button title="Open Settings" icon="settings-outline" onPress={openPhoneSettings} />
        ) : (
          <Button title="Try again" icon="refresh" onPress={goLive} loading={busy} />
        )}
      </>
    );
  } else if (whyNot === 'birthday') {
    body = (
      <>
        <Text style={styles.line}>{GO_LIVE_WHY_NOT.birthday}</Text>
        <Button title="Add my birthday" icon="gift" onPress={addBirthday} />
      </>
    );
  } else if (whyNot === 'rules') {
    body = (
      <>
        <Text style={styles.line}>{GO_LIVE_WHY_NOT.rules}</Text>
        <Button title="Read the Live rules" icon="document-text" onPress={() => setRulesOpen(true)} />
      </>
    );
  } else if (whyNot) {
    body = <Text style={styles.line}>{GO_LIVE_WHY_NOT[whyNot]}</Text>;
  } else {
    body = (
      <>
        {goLiveLines(state.max_minutes).map((line) => (
          <View key={line} style={styles.row}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.text}>{line}</Text>
          </View>
        ))}
        <Button title="Go live 🔴" onPress={goLive} loading={busy} />
      </>
    );
  }

  // One pop-up sheet for everything (the Live rules show inside it): a phone can't open a second pop-up sheet
  // while one is open or closing.
  return (
    <Modal visible transparent animationType="slide" onRequestClose={rulesOpen ? () => setRulesOpen(false) : onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <SafeEdge edge="bottom" style={[styles.sheet, rulesOpen && styles.tall]}>
          {rulesOpen ? (
            <LiveRulesCard
              onAccepted={() => {
                setRulesOpen(false);
                load();
              }}
              onClose={() => setRulesOpen(false)}
              // A link opens a page: this whole sheet closes, or it would cover the page.
              onOpenPage={onClose}
            />
          ) : (
            <Pressable style={styles.inner}>
              <Text style={styles.title}>Go live 🔴</Text>
              {body}
              <Button title="Not now" variant="plain" onPress={onClose} />
            </Pressable>
          )}
        </SafeEdge>
      </Pressable>
    </Modal>
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
  },
  tall: {
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
  spinner: {
    marginVertical: space.lg,
  },
  line: {
    ...font.body,
    textAlign: 'center',
    lineHeight: 22,
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
});
