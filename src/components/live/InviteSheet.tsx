import { useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { SafeEdge } from '@/components/SafeEdge';
import { colors, font, radius, space } from '@/theme';

export function inviteWords(hostName: string): string {
  return `🎥 ${hostName} wants you on their live. Everyone watching will see and hear you. While you're on, only people who are friends with you too can watch.`;
}

// The guest's "come on my live?" sheet. It runs out after 60 seconds (the bar shrinks as time goes).
export function InviteSheet({ visible, hostName, expiresAt, busy, onJoin, onNotNow, onExpired }: {
  visible: boolean;
  hostName: string;
  expiresAt: string | null;
  busy: boolean;
  onJoin: () => void;
  onNotNow: () => void;
  // The 60 seconds ran out.
  onExpired: () => void;
}) {
  const end = expiresAt ? Date.parse(expiresAt) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible || !Number.isFinite(end)) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [visible, end]);
  const left = Number.isFinite(end) ? Math.max(0, end - now) : 60_000;
  useEffect(() => {
    if (visible && Number.isFinite(end) && left <= 0) onExpired();
  }, [visible, end, left, onExpired]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onNotNow}>
      <View style={styles.backdrop}>
        <SafeEdge edge="bottom" style={styles.sheet}>
          <View style={styles.inner}>
            <View style={styles.track} accessibilityLabel={`${Math.ceil(left / 1000)} seconds to answer`}>
              <View style={[styles.fill, { width: `${Math.min(100, (left / 60_000) * 100)}%` }]} />
            </View>
            <Text style={styles.text}>{inviteWords(hostName)}</Text>
            <Button title="Join live" icon="videocam" loading={busy} onPress={onJoin} />
            <Button title="Not now" variant="plain" disabled={busy} onPress={onNotNow} />
          </View>
        </SafeEdge>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
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
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.live,
  },
  text: {
    ...font.body,
    textAlign: 'center',
    lineHeight: 22,
  },
});
