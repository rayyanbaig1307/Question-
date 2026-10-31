import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { useMe } from '@/lib/auth';
import { inviteFriends } from '@/lib/invite';
import type { StoryRing } from '@/lib/stories';
import { colors, font, gradients, space } from '@/theme';

export type Rings = { mine: StoryRing | null; friends: StoryRing[] };

// The row of story circles at the top of Home, like Instagram: My Story first (tap ＋ to add one),
// then Guess Who (anonymous posts from friends – a number when there are some to guess), then friends'
// stories (colorful ring = new, grey = seen, green = close friends), then an Invite circle.
export function StoryRow({ rings, toGuess, onCamera }: { rings: Rings; toGuess: number; onCamera: () => void }) {
  const { userId, profile } = useMe();
  const { mine, friends } = rings;
  const myName = profile?.display_name || profile?.username;

  // Watch one friend's stories, then carry on with the next friends who have new ones.
  function openFriend(index: number) {
    const queue = friends
      .slice(index + 1)
      .filter((ring) => !ring.allSeen)
      .map((ring) => ring.author.id);
    router.push({
      pathname: '/stories/[user]',
      params: queue.length ? { user: friends[index].author.id, queue: queue.join(',') } : { user: friends[index].author.id },
    });
  }

  const openMine = () => (mine ? router.push({ pathname: '/stories/[user]', params: { user: userId } }) : onCamera());

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.row}>
      <Pressable style={styles.circle} onPress={openMine} accessibilityLabel={mine ? 'Watch my story' : 'Add to my story'}>
        <Ring active={!!mine} close={!!mine?.closeFriends}>
          <Avatar path={profile?.avatar_path} name={myName} size={64} />
        </Ring>
        <Bouncy style={styles.plus} pressScale={0.8} onPress={onCamera} accessibilityLabel="Add to my story">
          <Text style={styles.plusText}>＋</Text>
        </Bouncy>
        <Text style={styles.name} numberOfLines={1}>
          My Story
        </Text>
      </Pressable>

      <Pressable style={styles.circle} onPress={() => router.push('/guess')} accessibilityLabel="Guess Who">
        <Ring active={toGuess > 0}>
          <View style={styles.guess}>
            <Text style={styles.guessEmoji}>🕵️</Text>
          </View>
        </Ring>
        {toGuess > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{toGuess > 9 ? '9+' : toGuess}</Text>
          </View>
        ) : null}
        <Text style={[styles.name, toGuess === 0 && styles.seen]} numberOfLines={1}>
          Guess Who
        </Text>
      </Pressable>

      {friends.map((ring, index) => (
        <Pressable key={ring.author.id} style={styles.circle} onPress={() => openFriend(index)}>
          <Ring active={!ring.allSeen} close={ring.closeFriends}>
            <Avatar path={ring.author.avatar_path} name={ring.author.display_name || ring.author.username} size={64} />
          </Ring>
          <Text style={[styles.name, ring.allSeen && styles.seen]} numberOfLines={1}>
            {ring.author.display_name || ring.author.username}
          </Text>
        </Pressable>
      ))}

      <Pressable
        style={styles.circle}
        onPress={() => inviteFriends(profile?.username)}
        accessibilityRole="button"
        accessibilityLabel="Invite friends">
        <View style={[styles.ring, styles.inviteRing]}>
          <Text style={styles.inviteText}>＋</Text>
        </View>
        <Text style={styles.name}>Invite</Text>
      </Pressable>
    </ScrollView>
  );
}

// The colorful ring around a story circle (green for close-friends stories, grey once you've seen everything).
function Ring({ active, close = false, children }: { active: boolean; close?: boolean; children: ReactNode }) {
  const ringColors = !active ? ([colors.border, colors.border] as const) : close ? ([colors.green, colors.green] as const) : gradients.brand;
  return (
    <LinearGradient colors={ringColors} style={styles.ring}>
      <View style={styles.ringGap}>{children}</View>
    </LinearGradient>
  );
}

const RING = 76;

const styles = StyleSheet.create({
  strip: {
    // The page has side padding; the row runs edge to edge so it can scroll under it.
    marginHorizontal: -space.lg,
  },
  row: {
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
  circle: {
    width: RING,
    alignItems: 'center',
    gap: 6,
  },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringGap: {
    padding: 3,
    borderRadius: RING / 2,
    backgroundColor: colors.bg,
  },
  plus: {
    position: 'absolute',
    top: RING - 26,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '900',
  },
  name: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
  },
  seen: {
    color: colors.textMuted,
  },
  guess: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guessEmoji: {
    fontSize: 30,
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 5,
    backgroundColor: colors.red,
    borderWidth: 2,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
  },
  inviteRing: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accent,
  },
  inviteText: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: '900',
  },
});
