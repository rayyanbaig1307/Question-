import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FriendButton } from '@/components/FriendButton';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { PostGrid } from '@/components/PostGrid';
import { useMe } from '@/lib/auth';
import { fetchRelation, type Relation } from '@/lib/friends';
import { fetchUserPosts } from '@/lib/posts';
import { fetchProfile, fetchProfileStats, type ProfileStats } from '@/lib/profiles';
import type { Post, Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, radius, space } from '@/theme';

type Loaded = {
  profile: Profile | null;
  stats: ProfileStats;
  posts: Post[];
  relation: Relation;
};

export default function ProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const isMe = id === userId;
  const { showOptions } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();

  const [data, setData] = useState<Loaded | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [profile, stats, posts, relation] = await Promise.all([
        fetchProfile(id),
        fetchProfileStats(id),
        fetchUserPosts(id),
        isMe ? Promise.resolve<Relation>({ kind: 'none' }) : fetchRelation(userId, id),
      ]);
      setData({ profile, stats, posts, relation });
    } catch (error) {
      console.warn('Could not load profile', error);
      setData(
        (previous) => previous ?? { profile: null, stats: { posts: 0, friends: 0 }, posts: [], relation: { kind: 'none' } },
      );
    }
  }, [id, isMe, userId]);

  // Reload every time this screen comes into view (e.g. after posting or editing).
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const profile = data?.profile ?? null;

  function openMenu() {
    if (!profile) return;
    showOptions({
      title: `@${profile.username}`,
      options: [
        {
          label: 'Report',
          onPress: () => report({ user: profile, contentType: 'user', contentId: profile.id }),
        },
        { label: 'Block', destructive: true, onPress: () => confirmBlock(profile) },
      ],
    });
  }

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: profile ? `@${profile.username}` : '',
        headerRight: () =>
          isMe ? (
            <IconButton
              icon="settings-outline"
              label="Settings"
              size={38}
              background={colors.card}
              onPress={() => router.push('/settings')}
            />
          ) : profile ? (
            <IconButton icon="ellipsis-horizontal" label="More" size={38} background={colors.card} onPress={openMenu} />
          ) : null,
      }}
    />
  );

  if (!data) {
    return (
      <View style={styles.center}>
        {header}
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.center}>
        {header}
        <EmptyState emoji="🤷" title="This account isn't available" message="It may have been deleted." />
      </View>
    );
  }

  const isFriend = data.relation.kind === 'friends';
  const locked = !isMe && profile.is_private && !isFriend;

  const profileHeader = (
    <View style={styles.header}>
      <View style={styles.topRow}>
        <Avatar path={profile.avatar_path} name={profile.display_name || profile.username} size={92} ring />
        <View style={styles.stats}>
          <Stat number={data.stats.posts} label={data.stats.posts === 1 ? 'Post' : 'Posts'} />
          <Pressable disabled={!isMe} onPress={() => router.push('/friends')} accessibilityLabel="My friends">
            <Stat number={data.stats.friends} label={data.stats.friends === 1 ? 'Friend' : 'Friends'} />
          </Pressable>
        </View>
      </View>

      <View style={styles.names}>
        <Text style={styles.displayName}>{profile.display_name || profile.username}</Text>
        <View style={styles.badges}>
          <Text style={styles.username}>@{profile.username}</Text>
          {profile.is_private ? <Text style={styles.badge}>🔒 Private</Text> : null}
          {isFriend ? <Text style={[styles.badge, styles.friendBadge]}>👯 Friends</Text> : null}
        </View>
        {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}
      </View>

      {isMe ? (
        <View style={styles.actions}>
          <Button
            title="Edit profile"
            icon="create-outline"
            variant="secondary"
            small
            style={styles.action}
            onPress={() => router.push('/edit-profile')}
          />
          <Button
            title="Friends"
            icon="people"
            variant="secondary"
            small
            style={styles.action}
            onPress={() => router.push('/friends')}
          />
        </View>
      ) : (
        <FriendButton person={profile} relation={data.relation} onChanged={load} />
      )}
    </View>
  );

  const empty = locked ? (
    <EmptyState
      emoji="🔒"
      title="This account is private"
      message={`Become friends with @${profile.username} to see their photos.`}
    />
  ) : isMe ? (
    <EmptyState
      emoji="📸"
      title="No posts yet"
      message={'Take a photo, then pick "Post to my profile" to add it here.'}
    />
  ) : (
    <EmptyState emoji="🌵" title="No posts yet" />
  );

  return (
    <View style={styles.fill}>
      {header}
      <PostGrid
        posts={locked ? [] : data.posts}
        header={profileHeader}
        empty={empty}
        refreshing={refreshing}
        onRefresh={refresh}
      />
    </View>
  );
}

function Stat({ number, label }: { number: number; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statNumber}>{number}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  header: {
    padding: space.lg,
    gap: space.lg,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
  },
  stats: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  stat: {
    alignItems: 'center',
  },
  statNumber: {
    ...font.heading,
    fontSize: 22,
  },
  statLabel: {
    ...font.small,
  },
  names: {
    gap: space.xs,
  },
  displayName: {
    ...font.heading,
  },
  badges: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  username: {
    ...font.body,
    color: colors.textMuted,
    fontWeight: '700',
  },
  badge: {
    overflow: 'hidden',
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  friendBadge: {
    backgroundColor: colors.purple,
  },
  bio: {
    ...font.body,
    lineHeight: 22,
    marginTop: space.xs,
  },
  actions: {
    flexDirection: 'row',
    gap: space.sm,
  },
  action: {
    flex: 1,
  },
});
