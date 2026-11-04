import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FriendButton } from '@/components/FriendButton';
import { useOverlays } from '@/components/Overlays';
import { PersonRow } from '@/components/PersonRow';
import { ScreenHeader } from '@/components/ScreenHeader';
import { describeActivity, useActivity, type ActivityItem } from '@/lib/activity';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { fetchIncomingRequests, relationFrom, type FriendLink } from '@/lib/friends';
import { respondToHitUp, useHitUps, type HitUp } from '@/lib/hitups';
import { clearDeliveredNotifications } from '@/lib/notifications';
import { timeAgo } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, radius, space } from '@/theme';

// Your Inbox 🔔 (the bell at the top of Chat), like Instagram's notifications page:
// hit ups and friend requests waiting for an answer, then your activity – who liked, commented, added you…
// Pull down to refresh. "Clear" empties the activity list. Leaving marks everything as seen.
export default function Inbox() {
  const { userId } = useMe();
  const [focused, setFocused] = useState(false);
  const { hitUps, reload: reloadHitUps } = useHitUps(userId, focused);
  const activity = useActivity(userId, focused);
  const { markSeen, reload: reloadActivity } = activity;
  const [requests, setRequests] = useState<FriendLink[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadRequests = useCallback(
    () =>
      fetchIncomingRequests(userId)
        .then(setRequests)
        .catch(() => setRequests((current) => current ?? [])),
    [userId],
  );

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      loadRequests();
      // Opening the Inbox clears Peekaboo's notifications off your lock screen and the number on the app icon.
      clearDeliveredNotifications();
      return () => {
        setFocused(false);
        markSeen();
      };
    }, [loadRequests, markSeen]),
  );

  async function refresh() {
    setRefreshing(true);
    reloadHitUps();
    reloadActivity();
    await loadRequests();
    setRefreshing(false);
  }

  const nothing = hitUps.length === 0 && (requests ?? []).length === 0 && activity.items.length === 0;

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Inbox 🔔" />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}>
        {nothing && requests !== null ? (
          <EmptyState emoji="📭" title="All caught up!" message="Likes, comments, friend requests and hit ups show up here." />
        ) : null}

        {hitUps.length > 0 ? (
          <Section title="Hit ups 👋">
            {hitUps.map((hitUp) => (
              <HitUpRow key={hitUp.id} hitUp={hitUp} onDone={reloadHitUps} />
            ))}
          </Section>
        ) : null}

        {(requests ?? []).length > 0 ? (
          <Section title="Friend requests 💌">
            {(requests ?? []).map((link) =>
              link.requester ? (
                <View key={link.id} style={styles.request}>
                  <PersonRow
                    person={link.requester}
                    right={<FriendButton person={link.requester} relation={relationFrom(link, userId)} onChanged={loadRequests} small />}
                  />
                </View>
              ) : null,
            )}
          </Section>
        ) : null}

        {activity.items.length > 0 ? (
          <Section
            title="Activity"
            action={
              <Pressable onPress={activity.clear} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear activity">
                <Text style={styles.clear}>Clear</Text>
              </Pressable>
            }>
            {activity.items.map((item) => (
              <ActivityRow key={`${item.kind}-${item.actor_id}-${item.at}`} item={item} isNew={activity.seenAt !== null && item.at > activity.seenAt} />
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

// One thing that happened: who, what, when. Likes and comments open the post; friend things open the profile.
function ActivityRow({ item, isNew }: { item: ActivityItem; isNew: boolean }) {
  const name = item.actor_name || `@${item.actor_username}`;
  return (
    <Pressable
      style={styles.activity}
      onPress={() => router.push(item.post_id ? `/post/${item.post_id}` : `/profile/${item.actor_id}`)}
      accessibilityRole="button">
      <Avatar path={item.actor_avatar} name={name} size={40} />
      <Text style={styles.activityText} numberOfLines={2}>
        <Text style={styles.name}>{name}</Text> {describeActivity(item)}
        <Text style={styles.statusText}> · {timeAgo(item.at)}</Text>
      </Text>
      {isNew ? <View style={styles.activityDot} /> : null}
      <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
    </Pressable>
  );
}

// Someone hit you up: Hit back (friends + the chat opens with their message) or Ignore (they're never told).
function HitUpRow({ hitUp, onDone }: { hitUp: HitUp; onDone: () => void }) {
  const { showOptions, showToast } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const [busy, setBusy] = useState<'back' | 'ignore' | null>(null);
  const sender = hitUp.sender;
  const name = sender.display_name || sender.username;

  async function respond(hitBack: boolean) {
    setBusy(hitBack ? 'back' : 'ignore');
    try {
      await respondToHitUp(hitUp.id, hitBack);
      onDone();
      if (hitBack) {
        showToast(`You and ${name} can chat now 🎉`);
        router.push(`/chat/${sender.id}`);
      } else {
        showToast("Ignored – they won't be told");
      }
    } catch (error) {
      Alert.alert('Oops', friendlyError(error));
      onDone();
    } finally {
      setBusy(null);
    }
  }

  function openMenu() {
    showOptions({
      title: `@${sender.username}`,
      options: [
        { label: 'See profile', onPress: () => router.push(`/profile/${sender.id}`) },
        { label: 'Report', onPress: () => report({ user: sender, contentType: 'user', contentId: sender.id, onBlocked: onDone }) },
        { label: 'Block', destructive: true, onPress: () => confirmBlock(sender, onDone) },
      ],
    });
  }

  return (
    <View style={styles.hitUp}>
      <View style={styles.hitUpTop}>
        <Pressable onPress={() => router.push(`/profile/${sender.id}`)} accessibilityLabel={`See ${name}'s profile`}>
          <Avatar path={sender.avatar_path} name={name} size={48} />
        </Pressable>
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.statusText}>
            @{sender.username} · {timeAgo(hitUp.created_at)}
          </Text>
        </View>
        <Pressable onPress={openMenu} hitSlop={10} accessibilityLabel="Report or block">
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
        </Pressable>
      </View>
      <Text style={styles.hitUpMessage}>{hitUp.message ? `“${hitUp.message}”` : '👋 Hit you up'}</Text>
      <View style={styles.hitUpButtons}>
        <Button
          title="Hit back"
          icon="hand-right"
          small
          style={styles.hitUpButton}
          loading={busy === 'back'}
          disabled={busy !== null}
          onPress={() => respond(true)}
        />
        <Button
          title="Ignore"
          variant="secondary"
          small
          style={styles.hitUpButton}
          loading={busy === 'ignore'}
          disabled={busy !== null}
          onPress={() => respond(false)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
    paddingBottom: space.xxl,
  },
  section: {
    gap: space.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    ...font.label,
  },
  clear: {
    ...font.small,
    color: colors.accent,
    fontWeight: '800',
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  name: {
    ...font.body,
    fontSize: 17,
    fontWeight: '800',
  },
  statusText: {
    ...font.small,
  },
  hitUp: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
  },
  hitUpTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  hitUpMessage: {
    ...font.body,
    fontWeight: '700',
  },
  hitUpButtons: {
    flexDirection: 'row',
    gap: space.sm,
  },
  hitUpButton: {
    flex: 1,
  },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.sm,
  },
  activityText: {
    ...font.body,
    flex: 1,
  },
  activityDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  request: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
  },
});
