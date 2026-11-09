import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeInDown, useAnimatedStyle, useSharedValue, withDelay, withTiming, ZoomIn } from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { VideoClip } from '@/components/VideoClipSafe';
import type { GroupGuess } from '@/lib/groupGuess';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

const HOUR = 60 * 60 * 1000;
const nameOf = (person: Profile | undefined) => (person ? person.display_name || person.username : 'Someone');

// "5h left", or "20m left" in its last hour.
function timeLeft(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  const hours = Math.floor(ms / HOUR);
  return hours > 0 ? `${hours}h left` : `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

// 🕵️ A Guess Who in a group chat. It has NO name and NO picture of who sent it, and it sits in the middle of the
// chat (not on anyone's side), so nothing on it gives the sender away – not even on the sender's own phone, in
// case someone looks over their shoulder. Before you guess: the people to pick from. After: who it really was
// (only you see that) and how many people guessed. Nobody is ever told who guessed what.
export function GroupGuessCard({ post, people, now, mediaUrl, posterUrl, overlayUrl, busy, animate, onGuess, onOpen, onMenu }: {
  post: GroupGuess;
  // Profiles of the people to pick from (and, once you've guessed, of who sent it and who you picked).
  people: Map<string, Profile>;
  now: number;
  mediaUrl: string | undefined;
  posterUrl: string | undefined;
  overlayUrl: string | undefined;
  // Your guess is on its way.
  busy: boolean;
  // You just guessed: play the reveal once.
  animate: boolean;
  onGuess: (choice: string) => void;
  // Tap the photo: see it full screen.
  onOpen: () => void;
  // The ⋯ button (or hold the photo): delete yours, or report / block.
  onMenu: () => void;
}) {
  const revealed = !post.mine && post.poster !== null;
  const counts =
    post.guess_count !== null && (post.mine || revealed)
      ? `👀 ${post.guess_count} of ${post.others_count} guessed · ${post.right_count ?? 0} got it`
      : null;

  return (
    <View style={styles.row}>
      <View style={styles.card}>
        <View style={styles.top}>
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={1}>
              {post.mine ? '🕵️ Your Guess Who' : '🕵️ Who sent this?'}
            </Text>
            <Text style={styles.time}>{timeLeft(post.expires_at, now)}</Text>
          </View>
          <Pressable onPress={onMenu} hitSlop={10} accessibilityRole="button" accessibilityLabel="Guess Who options">
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        <Pressable
          onPress={onOpen}
          onLongPress={onMenu}
          style={styles.media}
          accessibilityRole="button"
          accessibilityLabel={post.media_type === 'video' ? 'Open video' : 'Open photo'}>
          {post.media_type === 'video' && mediaUrl ? (
            <VideoClip uri={mediaUrl} posterUri={posterUrl} overlayUri={overlayUrl} playing muted loop style={StyleSheet.absoluteFill} />
          ) : post.media_type === 'photo' && mediaUrl ? (
            <Image source={{ uri: mediaUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
          ) : null}
        </Pressable>

        {post.mine ? (
          <View style={styles.section}>
            <Text style={styles.note}>No name on it – only you know it&apos;s yours 🤫</Text>
            {counts ? <Text style={styles.counts}>{counts}</Text> : null}
          </View>
        ) : revealed ? (
          <View style={styles.section}>
            <Reveal
              person={post.poster ? people.get(post.poster) : undefined}
              correct={post.my_guess === post.poster}
              guessed={post.my_guess && post.my_guess !== post.poster ? nameOf(people.get(post.my_guess)) : null}
              animate={animate}
            />
            {counts ? <Text style={styles.counts}>{counts}</Text> : null}
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.note}>Who do you think sent it? You get one try!</Text>
            <View style={styles.choices}>
              {(post.options ?? []).map((option) => {
                const person = people.get(option);
                return (
                  <Bouncy
                    key={option}
                    style={styles.choice}
                    pressScale={0.92}
                    disabled={busy}
                    onPress={() => onGuess(option)}
                    accessibilityRole="button"
                    accessibilityLabel={`Guess ${nameOf(person)}`}>
                    <Avatar path={person?.avatar_path} name={nameOf(person)} size={26} />
                    <Text style={styles.choiceName} numberOfLines={1}>
                      {nameOf(person)}
                    </Text>
                  </Bouncy>
                );
              })}
            </View>
            {busy ? <ActivityIndicator color={colors.accent} /> : null}
            <Text style={styles.counts}>
              {post.others_count} {post.others_count === 1 ? 'person' : 'people'} can guess
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

// Who it really was: their picture pops in, with a burst of emojis. Only you see this.
function Reveal({ person, correct, guessed, animate }: {
  person: Profile | undefined;
  correct: boolean;
  guessed: string | null;
  animate: boolean;
}) {
  const emojis = correct ? ['🎉', '✨', '🥳', '🎯', '✨', '🎉'] : ['😜', '🙈', '👀', '😂', '🙈', '😜'];
  return (
    <View style={styles.reveal}>
      {animate ? (
        <View style={styles.burst} pointerEvents="none">
          {emojis.map((emoji, index) => (
            <FlyingEmoji key={index} emoji={emoji} index={index} />
          ))}
        </View>
      ) : null}
      <Animated.View
        entering={animate ? ZoomIn.springify().damping(7).stiffness(160) : undefined}
        style={[styles.revealRing, { borderColor: correct ? colors.green : colors.pink }]}>
        <Avatar path={person?.avatar_path} name={nameOf(person)} size={56} />
      </Animated.View>
      <Animated.Text entering={animate ? FadeInDown.delay(250) : undefined} style={styles.revealTitle}>
        {correct ? `You got it! It was ${nameOf(person)} 🎯` : `Nope! It was ${nameOf(person)} 🙈`}
      </Animated.Text>
      {guessed ? <Text style={styles.revealText}>You guessed {guessed}</Text> : null}
    </View>
  );
}

function FlyingEmoji({ emoji, index }: { emoji: string; index: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(withDelay(index * 60, withTiming(1, { duration: 1300, easing: Easing.out(Easing.quad) })));
  }, [index, progress]);
  const spread = (index - 2.5) * 30;
  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.get(),
    transform: [{ translateX: spread * progress.get() }, { translateY: -100 * progress.get() }, { scale: 0.6 + progress.get() * 0.9 }],
  }));
  return <Animated.Text style={[styles.flying, style]}>{emoji}</Animated.Text>;
}

const styles = StyleSheet.create({
  // In the middle of the chat: not on the sender's side, not on anyone else's.
  row: {
    alignItems: 'center',
  },
  card: {
    width: '82%',
    maxWidth: 340,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.yellow,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  titles: {
    flex: 1,
  },
  title: {
    ...font.body,
    fontWeight: '900',
  },
  time: {
    ...font.small,
    fontSize: 12,
  },
  media: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: colors.surface,
  },
  section: {
    gap: space.sm,
    padding: space.md,
  },
  note: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
    textAlign: 'center',
  },
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.sm,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    paddingVertical: 5,
    paddingLeft: 5,
    paddingRight: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.purple,
  },
  choiceName: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
    flexShrink: 1,
  },
  counts: {
    ...font.small,
    fontWeight: '800',
    textAlign: 'center',
  },
  reveal: {
    alignItems: 'center',
    gap: space.sm,
  },
  burst: {
    position: 'absolute',
    top: 28,
    alignSelf: 'center',
    width: 1,
    height: 1,
    alignItems: 'center',
  },
  flying: {
    position: 'absolute',
    fontSize: 24,
  },
  revealRing: {
    borderWidth: 4,
    borderRadius: 36,
    padding: 3,
  },
  revealTitle: {
    ...font.heading,
    textAlign: 'center',
  },
  revealText: {
    ...font.small,
  },
});
