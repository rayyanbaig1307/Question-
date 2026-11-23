import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOverlays } from '@/components/Overlays';
import { lateLabel } from '@/lib/drop';
import {
  discard,
  getVisibleScope,
  groupSize,
  inScope,
  onOutboxDone,
  retry,
  useOutbox,
  type Job,
} from '@/lib/outbox';
import { colors, radius, space } from '@/theme';

// ---------------------------------------------------------------------------
// How your sends are doing, wherever you are in the app (lib/outbox.ts sends them in the background):
// - SendingPill: a small pill just under the top bar, "Sending… (2)" while things go out (taps go straight through
//   it to whatever is underneath), or a short red "Not sent · tap" that offers Try again / Delete (the reason is in
//   that sheet). Sends in the chat that's on screen show there as bubbles instead.
// - OutboxToasts: the same happy toasts as before ("Drop posted · On time! 👀🔥", "Peek sent to Ray! 💌", …),
//   now when it's really in. If something couldn't be sent, a toast says so.
// ---------------------------------------------------------------------------

// A few words about what a send is ("your drop", "your peek to Ray"…).
export function sendName(job: Pick<Job, 'what'>): string {
  const what = job.what;
  switch (what.kind) {
    case 'post':
      return what.drop ? 'your drop' : what.forfeit ? 'your forfeit' : what.dare ? 'your dare' : 'your post';
    case 'peek': {
      const names = what.friendIds.map((id) => what.names?.[id]).filter((name): name is string => !!name);
      return names.length === 1 ? `your peek to ${names[0]}` : what.friendIds.length > 1 ? 'your peek' : 'your peek';
    }
    case 'chatPhoto':
      return 'your photo';
    case 'story':
      return 'your story';
    case 'guess':
    case 'groupGuess':
      return 'your Guess Who';
    case 'publicPhoto':
      return 'your photo to the public chat';
    case 'groupMedia':
      return what.snap ? 'your snap' : what.dareId ? 'your proof' : 'your photo';
    case 'voice':
    case 'groupVoice':
      return 'your voice note';
    case 'comment':
      return 'your comment';
    default:
      return 'your message';
  }
}

// What a toast says when a send failed.
export function failureWords(job: Pick<Job, 'what' | 'final' | 'error'>): string {
  const drop = job.what.kind === 'post' && job.what.drop;
  if (job.final && job.error) return drop ? `Your drop didn't post: ${job.error}` : `Couldn't send ${sendName(job)}: ${job.error}`;
  return drop ? "Your drop didn't post – tap the banner to try again" : `Couldn't send ${sendName(job)} – tap the banner to try again`;
}

// The drop, dare or forfeit post is in.
export function postWords(job: Job): string | null {
  const what = job.what;
  if (what.kind !== 'post') return null;
  if (what.forfeit) return 'Forfeit paid 💀✅ Respect.';
  if (what.drop) {
    const late = job.result?.dropLate ?? null;
    if (job.result?.dropRewound) return "Drop posted ⏰ No 'late' label this time 👀🔥";
    if (late === null) return 'Drop posted 👀';
    const label = lateLabel(late);
    if (what.rewind && !label.onTime) return `Drop posted · ${label.text} (the rewind wasn't available)`;
    return label.onTime ? 'Drop posted · On time! 👀🔥' : `Drop posted · ${label.text}`;
  }
  if (what.dare) return 'Dare done! 🎯🔥';
  return null;
}

// One send on its own (from the editor or a chat), when it's in. null = no toast (texts just show in the chat).
export function sentWords(job: Job): string | null {
  const what = job.what;
  switch (what.kind) {
    case 'peek':
      if (what.chatDare) {
        const problem = job.result?.dareProblem;
        if (problem === 'gone') return "Peek sent – that dare isn't there any more";
        if (problem) return `Peek sent – the dare wasn't updated: ${problem}`;
        return 'Proof sent 🎯 Now they confirm it';
      }
      return 'Peek sent 👀';
    case 'chatPhoto':
      return job.capture?.kind === 'video' ? 'Video sent 🎬' : 'Photo sent 📷';
    case 'groupMedia':
      return what.snap ? 'Snap sent 👀' : what.dareId ? 'Proof posted in the group 🎯' : 'Sent to the group 📸';
    case 'groupGuess':
      return 'Guess Who sent 🕵️ No name on it – let the group guess!';
    case 'guess':
      return "Guess Who posted 🕵️ Let's see who figures it out!";
    case 'publicPhoto':
      return 'Posted in the public chat 📸';
    default:
      return null;
  }
}

// Everything a "Send to…" sent, once it's all in (as before: "Peek sent to Ray! 💌", "Shared to your story and 2
// friends! 🎉").
export function shareWords(jobs: Job[]): string | null {
  const guess = jobs.find((job) => job.what.kind === 'guess');
  if (guess) return "Guess Who posted 🕵️ Let's see who figures it out!";
  const peek = jobs.find((job) => job.what.kind === 'peek');
  const friendIds = peek && peek.what.kind === 'peek' ? peek.what.friendIds.filter((id) => !peek.result?.refused?.includes(id)) : [];
  const names = peek && peek.what.kind === 'peek' ? peek.what.names ?? {} : {};
  const story = jobs.some((job) => job.what.kind === 'story');
  const profile = jobs.some((job) => job.what.kind === 'post' && !job.what.drop && !job.what.dare && !job.what.forfeit);
  const friends =
    friendIds.length === 1 ? (names[friendIds[0]] ?? '1 friend') : friendIds.length > 1 ? `${friendIds.length} friends` : null;
  const places = [friends, story ? 'your story' : null, profile ? 'your profile' : null].filter((place): place is string => !!place);
  if (places.length === 0) return null;
  const refused = peek?.result?.refused ?? [];
  const extra = refused.length > 0 ? ` (not to ${refused.map((id) => names[id] ?? 'someone').join(', ')}: ${peek?.result?.refusedWhy ?? 'not allowed'})` : '';
  if (places.length === 1 && friends) return `Peek sent to ${friends}! 💌${extra}`;
  const list = places.length > 1 ? `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}` : places[0];
  return `Shared to ${list}! 🎉${extra}`;
}

export function OutboxToasts({ userId }: { userId: string }) {
  const { showToast } = useOverlays();
  // "Send to…" groups: the sends that finished so far, and whether the post's toast already showed. A group that
  // already had its toast: a send of it that's tried again later gets a toast of its own.
  const groups = useRef(new Map<string, { done: Job[]; posted: boolean }>());
  const closed = useRef(new Set<string>());
  useEffect(
    () =>
      onOutboxDone((job) => {
        if (job.owner !== userId) return;
        const visible = getVisibleScope();
        const onScreen = !!visible && inScope(job, visible);
        const failed = job.state === 'failed';
        // In the chat on screen the bubble says it already.
        if (failed && !onScreen) showToast(failureWords(job));
        if (!job.group) {
          const words = failed ? null : sentWords(job);
          if (words) showToast(words);
          return;
        }
        if (closed.current.has(job.group)) {
          const words = failed ? null : (postWords(job) ?? shareWords([job]));
          if (words) showToast(words);
          return;
        }
        // A "Send to…" group: a failure counts as finished too, so the toast for the ones that did go still shows
        // (a story that went while a peek was refused).
        const group = groups.current.get(job.group) ?? { done: [], posted: false };
        group.done = [...group.done.filter((done) => done.key !== job.key), job];
        groups.current.set(job.group, group);
        // The drop, dare or forfeit: said as soon as it's saved (it's what counts most).
        const posted = failed ? null : postWords(job);
        if (posted) {
          group.posted = true;
          showToast(posted);
        }
        if (group.done.length >= groupSize(job.group)) {
          groups.current.delete(job.group);
          closed.current.add(job.group);
          // Everything else that went (a failure already had its own toast).
          const sent = group.done.filter((done) => done.state === 'sent');
          if (!group.posted && sent.length > 0) {
            const words = shareWords(sent);
            if (words) showToast(words);
          }
        }
      }),
    [userId, showToast],
  );
  return null;
}

export function SendingPill({ userId }: { userId: string }) {
  const insets = useSafeAreaInsets();
  const { showOptions } = useOverlays();
  const all = useOutbox(userId);
  const visible = getVisibleScope();
  // Sends in the chat on screen show there as bubbles instead.
  const jobs = all.filter((job) => job.state !== 'sent' && !(visible && inScope(job, visible)));
  if (jobs.length === 0) return null;
  const failed = jobs.filter((job) => job.state === 'failed');
  const going = jobs.filter((job) => job.state !== 'failed');
  const drop = going.find((job) => job.what.kind === 'post' && job.what.drop);
  // Short, so it never reaches the buttons at the sides of the top bar (the reason is in the sheet a tap opens).
  const label =
    failed.length > 0
      ? failed.some((job) => job.what.kind === 'post' && job.what.drop)
        ? 'Drop not posted · tap'
        : failed.length > 1
          ? `${failed.length} not sent · tap`
          : 'Not sent · tap'
      : drop
        ? 'Posting your drop…'
        : going.length === 1 && going[0].what.kind === 'peek' && going[0].what.friendIds.length === 1 && going[0].what.names?.[going[0].what.friendIds[0]]
          ? `Sending to ${going[0].what.names[going[0].what.friendIds[0]]}…`
          : going.length > 1
            ? `Sending… (${going.length})`
            : 'Sending…';
  function open() {
    if (failed.length === 0) return;
    // "Try again" is there as long as ANY of them can still go (one that can't – its picture is gone, or its day is
    // over – can only be deleted). The sheet talks about your drop first – a drop that can still go before an old
    // one whose day is over – then about one that can still go.
    const canTry = failed.filter((job) => !(job.restored && job.final));
    const isDrop = (job: Job) => job.what.kind === 'post' && !!job.what.drop;
    const first = canTry.find(isDrop) ?? failed.find(isDrop) ?? canTry[0] ?? failed[0];
    showOptions({
      title: failureWords(first),
      options: [
        ...(canTry.length > 0 ? [{ label: 'Try again', onPress: () => canTry.forEach((job) => retry(job.key)) }] : []),
        { label: failed.length > 1 ? `Delete (${failed.length})` : 'Delete', destructive: true, onPress: () => failed.forEach((job) => void discard(job.key)) },
      ],
    });
  }
  return (
    // Just under the top bars (they end about 56 points below the top), so it never sits on the camera's flip and
    // flash buttons, your picture, or a screen's back button. While things are only sending there's nothing to tap,
    // so taps go straight through it.
    <View pointerEvents={failed.length > 0 ? 'box-none' : 'none'} style={[styles.wrap, { top: insets.top + PILL_TOP }]}>
      <Pressable
        onPress={open}
        disabled={failed.length === 0}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.pill, failed.length > 0 && styles.pillFailed]}>
        <Text style={styles.text} numberOfLines={1}>
          {failed.length > 0 ? '⚠️ ' : '📤 '}
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

// How far below the top of the safe area the pill sits: below the top bars (a screen's header and the camera's
// top buttons both end about 52–56 points down).
export const PILL_TOP = 60;

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pill: {
    maxWidth: '70%',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    opacity: 0.95,
  },
  pillFailed: {
    backgroundColor: colors.red,
  },
  text: {
    color: colors.onAccent,
    fontWeight: '800',
    fontSize: 13,
  },
});
