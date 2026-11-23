import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Job } from '@/lib/outbox';
import { colors, font, radius, space } from '@/theme';

// ---------------------------------------------------------------------------
// A message you sent that isn't in yet (lib/outbox.ts): it shows straight away, faded, with "Sending…". When it's
// in, the real message takes its place. If it couldn't be sent: "Couldn't send · tap to try again".
// Drawn under the newest message (the chats put these in their list's header, so nothing else in the list moves).
// ---------------------------------------------------------------------------

export const SENDING = 'Sending…';
export const COULD_NOT_SEND = "Couldn't send · tap to try again";

// "0:07"
function length(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// What the bubble says while it's on its way.
export function pendingWords(job: Pick<Job, 'what'>): string {
  const what = job.what;
  switch (what.kind) {
    case 'text':
    case 'groupText':
      return what.body;
    case 'dare':
    case 'groupDare':
      return `🎯 ${what.body}`;
    case 'sticker':
    case 'groupSticker':
      return what.body;
    case 'peek':
      return '👀 Sending peek…';
    case 'chatPhoto':
      return '📷 Sending photo…';
    case 'voice':
    case 'groupVoice':
      return `🎤 Sending voice note… ${length(what.durationMs)}`;
    case 'groupMedia':
      return what.snap ? '👀 Sending snap…' : what.dareId ? '🎯 Sending proof…' : '📸 Sending…';
    case 'groupGuess':
      return '🕵️ Sending Guess Who…';
    case 'comment':
      return what.body;
    default:
      return SENDING;
  }
}

// The small line under it.
export function pendingStatus(job: Pick<Job, 'state' | 'error' | 'final' | 'restored'>): string {
  if (job.state !== 'failed') return SENDING;
  if (job.restored && job.error) return job.error;
  return COULD_NOT_SEND;
}

// `sticker`: how a sticker on its way is drawn (the chats pass their own sticker drawing).
export function PendingBubble({ job, onPress, sticker }: { job: Job; onPress: () => void; sticker?: ReactNode }) {
  const failed = job.state === 'failed';
  const status = pendingStatus(job);
  // A photo or video on its way shows your own picture (a video: its first moment isn't ready, so just the words).
  const picture =
    job.capture?.kind === 'photo' && (job.what.kind === 'chatPhoto' || (job.what.kind === 'groupMedia' && !job.what.snap))
      ? job.capture.uri
      : null;
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={failed ? onPress : undefined}
        disabled={!failed}
        accessibilityRole="button"
        accessibilityLabel={failed ? status : `${pendingWords(job)} – ${SENDING}`}
        style={[styles.bubble, failed ? styles.failed : styles.sending]}>
        {picture ? <Image source={{ uri: picture }} style={styles.picture} resizeMode="cover" /> : null}
        {sticker ?? <Text style={styles.words}>{pendingWords(job)}</Text>}
        <View style={styles.statusRow}>
          {failed ? null : <ActivityIndicator size="small" color={colors.onAccent} />}
          <Text style={[styles.status, failed && styles.statusFailed]}>{status}</Text>
        </View>
        {failed && job.final && job.error && !job.restored ? <Text style={styles.reason}>{job.error}</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'flex-end',
    paddingHorizontal: space.md,
    marginTop: space.xs,
  },
  bubble: {
    maxWidth: '80%',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
  },
  sending: {
    opacity: 0.6,
  },
  failed: {
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.red,
  },
  picture: {
    width: 160,
    height: 200,
    borderRadius: radius.md,
  },
  words: {
    ...font.body,
    color: colors.onAccent,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  status: {
    ...font.small,
    color: colors.onAccent,
    fontWeight: '700',
  },
  statusFailed: {
    color: colors.red,
  },
  reason: {
    ...font.small,
  },
});
