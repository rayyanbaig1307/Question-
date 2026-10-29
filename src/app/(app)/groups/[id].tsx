import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { postMedia, useDropStatus, useMyDropDays } from '@/lib/drop';
import { friendlyError } from '@/lib/errors';
import {
  counting,
  deleteGroup,
  fetchGroup,
  fetchGroupDrops,
  memberName,
  nudge,
  removeFromGroup,
  stillToPost,
  waitingText,
  type GroupMember,
  type PeekGroup,
} from '@/lib/groups';
import { useMediaUrls } from '@/lib/media';
import type { Post } from '@/lib/types';
import { colors, font, gradients, radius, space } from '@/theme';

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// One group: who has posted today's drop, a Nudge button for whoever hasn't, and everyone's drops –
// hidden until the whole group has posted, then revealed all at once.
export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { width } = useWindowDimensions();
  const drop = useDropStatus();

  const [group, setGroup] = useState<PeekGroup | null | undefined>(undefined);
  const [drops, setDrops] = useState<Post[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [nudged, setNudged] = useState<Set<string>>(new Set());
  const myDropDays = useMyDropDays(userId, group);

  const load = useCallback(async () => {
    const loaded = await fetchGroup(id);
    const posts = loaded
      ? await fetchGroupDrops(loaded.members.map((member) => member.postId).filter((postId): postId is string => !!postId))
      : [];
    return { loaded, posts };
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      load()
        .then(({ loaded, posts }) => {
          if (cancelled) return;
          setGroup(loaded);
          setDrops(posts);
        })
        .catch(() => !cancelled && setGroup((current) => current ?? null));
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    try {
      const { loaded, posts } = await load();
      setGroup(loaded);
      setDrops(posts);
    } catch {
      // keep what we have
    }
    setRefreshing(false);
  }

  const members = group ? counting(group) : [];
  const missing = group ? stillToPost(group) : [];
  const complete = !!group && missing.length === 0;
  const iPosted = members.some((member) => member.userId === userId && member.posted);
  const postsByUser = new Map(drops.map((post) => [post.user_id, post]));

  // Everyone's in: a happy buzz as the drops are revealed.
  useEffect(() => {
    if (complete) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [complete]);

  const files = (post: Post) => postMedia(post, userId, myDropDays);
  const urls = useMediaUrls(drops.map((post) => files(post).still).filter((path): path is string => !!path));

  async function sendNudge(member: GroupMember) {
    try {
      await nudge(id, member.userId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setNudged((current) => new Set(current).add(member.userId));
      showToast(`Nudged ${memberName(member, userId)} 👉`);
    } catch (error) {
      Alert.alert('Could not nudge', friendlyError(error));
    }
  }

  function confirm(title: string, message: string, action: string, run: () => Promise<void>) {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: action,
        style: 'destructive',
        onPress: async () => {
          try {
            await run();
          } catch (error) {
            Alert.alert('Something went wrong', friendlyError(error));
          }
        },
      },
    ]);
  }

  function openMenu() {
    if (!group) return;
    const options = [
      { label: 'Edit group (name, add friends)', onPress: () => router.push({ pathname: '/groups/new', params: { group: id } }) },
      {
        label: 'Leave group',
        destructive: true,
        onPress: () =>
          confirm(`Leave ${group.name}?`, "Your drops won't be held back for this group any more.", 'Leave', async () => {
            await removeFromGroup(id, userId);
            showToast(`You left ${group.name}`);
            router.back();
          }),
      },
    ];
    if (group.created_by === userId) {
      options.push({
        label: 'Delete group',
        destructive: true,
        onPress: () =>
          confirm(`Delete ${group.name}?`, 'The group is gone for everyone. Nobody’s posts are deleted.', 'Delete', async () => {
            await deleteGroup(id);
            showToast('Group deleted');
            router.back();
          }),
      });
    }
    showOptions({ options });
  }

  // The person who made the group can take people out of it (hold down on them).
  function memberMenu(member: GroupMember) {
    if (!group || group.created_by !== userId || member.userId === userId) return;
    const name = memberName(member, userId);
    showOptions({
      options: [
        {
          label: `Remove ${name} from the group`,
          destructive: true,
          onPress: () =>
            confirm(`Remove ${name}?`, `${name} won't be in ${group.name} any more.`, 'Remove', async () => {
              await removeFromGroup(id, member.userId);
              setGroup({ ...group, members: group.members.filter((m) => m.userId !== member.userId) });
            }),
        },
      ],
    });
  }

  if (group === undefined) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Group" />
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      </View>
    );
  }
  if (group === null) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Group" />
        <EmptyState emoji="💨" title="This group is gone" message="It was deleted, or you're not in it any more." />
      </View>
    );
  }

  const tileWidth = (width - space.lg * 2 - space.md) / 2;
  const posted = members.length - missing.length;
  const canNudge = drop.kind !== 'waiting';

  return (
    <View style={styles.fill}>
      <ScreenHeader
        title={group.name}
        right={<RoundIconButton icon="ellipsis-horizontal" label="Group options" onPress={openMenu} />}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}>
        {/* Today's status: who we're waiting on, and how far along the group is. */}
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.status}>
          <Text style={styles.statusTitle}>{waitingText(group, userId)}</Text>
          <View style={styles.progress}>
            <View style={[styles.progressFill, { width: `${(posted / Math.max(1, members.length)) * 100}%` }]} />
          </View>
          <Text style={styles.statusText}>
            {complete
              ? "Today's drops are out – have a look!"
              : `${posted} of ${members.length} posted today. Drops stay hidden until everyone has.`}
          </Text>
          {!iPosted ? (
            drop.kind === 'waiting' ? (
              <Text style={styles.statusHint}>⏰ Today&apos;s drop is at {clock(drop.at.toISOString())}</Text>
            ) : (
              <Button
                title="Post my drop"
                icon="camera"
                variant="secondary"
                onPress={() => router.push({ pathname: '/camera', params: { drop: '1' } })}
              />
            )
          ) : null}
        </LinearGradient>

        <Text style={styles.sectionTitle}>Today</Text>
        <View style={styles.members}>
          {group.members.map((member) => {
            const isMe = member.userId === userId;
            const name = isMe ? 'You' : memberName(member, userId);
            return (
              <Pressable
                key={member.userId}
                style={styles.member}
                onPress={() => router.push(`/profile/${member.userId}`)}
                onLongPress={() => memberMenu(member)}>
                <Avatar path={member.profile?.avatar_path} name={name} size={40} />
                <View style={styles.memberText}>
                  <Text style={styles.memberName} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={[styles.memberStatus, member.posted && styles.memberPosted]}>
                    {member.late
                      ? 'Joins in from tomorrow'
                      : member.posted && member.postedAt
                        ? `✅ Posted at ${clock(member.postedAt)}`
                        : '⏳ Not yet'}
                  </Text>
                </View>
                {!isMe && !member.posted && !member.late && canNudge ? (
                  nudged.has(member.userId) ? (
                    <Text style={styles.nudgedText}>Nudged 👋</Text>
                  ) : (
                    <Button title="Nudge" icon="hand-left" small onPress={() => sendNudge(member)} />
                  )
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionTitle}>Today&apos;s drops</Text>
        <View style={styles.grid}>
          {members.map((member, index) => {
            const post = postsByUser.get(member.userId);
            const name = member.userId === userId ? 'You' : memberName(member, userId);
            const size = { width: tileWidth, height: tileWidth * 1.33 };
            if (!member.posted) {
              return (
                <View key={member.userId} style={[styles.tile, styles.emptyTile, size]}>
                  <Text style={styles.tileEmoji}>⏳</Text>
                  <Text style={styles.tileName} numberOfLines={1}>
                    {name}
                  </Text>
                </View>
              );
            }
            if (!post) {
              // They posted, but their posts are private to their friends.
              return (
                <View key={member.userId} style={[styles.tile, styles.emptyTile, size]}>
                  <Text style={styles.tileEmoji}>🔒</Text>
                  <Text style={styles.tileName} numberOfLines={1}>
                    {name} posted
                  </Text>
                </View>
              );
            }
            const media = files(post);
            const uri = media.still ? urls[media.still] : undefined;
            return (
              <Animated.View
                key={member.userId}
                entering={complete ? ZoomIn.delay(index * 120).springify().damping(12) : undefined}>
                <Pressable
                  style={[styles.tile, size]}
                  disabled={media.locked}
                  onPress={() => router.push(`/post/${post.id}`)}
                  accessibilityLabel={media.locked ? `${name}'s drop (hidden)` : `Open ${name}'s drop`}>
                  {uri ? (
                    <Image
                      source={{ uri, cacheKey: media.still ?? undefined }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      blurRadius={media.locked ? 25 : 0}
                    />
                  ) : null}
                  {media.locked ? (
                    <View style={styles.hidden}>
                      <Text style={styles.tileEmoji}>🙈</Text>
                    </View>
                  ) : post.media_type === 'video' ? (
                    <Text style={styles.play}>▶</Text>
                  ) : null}
                  <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.tileShade} />
                  <Text style={[styles.tileName, styles.tileLabel]} numberOfLines={1}>
                    {name}
                  </Text>
                </Pressable>
              </Animated.View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xxl,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
    paddingBottom: space.xxl * 2,
  },
  status: {
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  statusTitle: {
    ...font.heading,
    color: colors.white,
  },
  progress: {
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 5,
    backgroundColor: colors.white,
  },
  statusText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '600',
  },
  statusHint: {
    color: colors.white,
    fontWeight: '800',
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
    marginBottom: -space.sm,
  },
  members: {
    gap: space.sm,
  },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
  },
  memberText: {
    flex: 1,
  },
  memberName: {
    ...font.body,
    fontWeight: '800',
  },
  memberStatus: {
    ...font.small,
  },
  memberPosted: {
    color: colors.green,
    fontWeight: '700',
  },
  nudgedText: {
    ...font.small,
    fontWeight: '800',
    color: colors.pink,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  tile: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTile: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.border,
    gap: space.sm,
  },
  hidden: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  tileEmoji: {
    fontSize: 36,
  },
  play: {
    color: colors.white,
    fontSize: 32,
  },
  tileShade: {
    ...StyleSheet.absoluteFill,
    top: '60%',
  },
  tileName: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
    paddingHorizontal: space.sm,
  },
  tileLabel: {
    position: 'absolute',
    left: space.sm,
    bottom: space.sm,
    color: colors.white,
  },
});
