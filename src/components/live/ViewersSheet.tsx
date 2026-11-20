import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { IconButton } from '@/components/IconButton';
import { SafeEdge } from '@/components/SafeEdge';
import { fetchLiveViewers, type LiveViewer } from '@/lib/lives';
import { colors, font, radius, space } from '@/theme';

export function viewerName(viewer: { display_name?: string | null; username?: string | null }): string {
  return viewer.display_name || viewer.username || 'Your friend';
}

// The host only: who's watching right now (fresh every 10 seconds while open). Each friend can be brought on
// (grey when they can't come on right now – the app never says why), removed, or removed and blocked.
export function ViewersSheet({ visible, liveId, cohostId, inviteOpen, onClose, onBringOn, onCantBringOn, onRemove, onBackToWatching }: {
  visible: boolean;
  liveId: string;
  cohostId: string | null;
  // An ask is waiting for an answer: nobody else can be asked yet.
  inviteOpen: boolean;
  onClose: () => void;
  onBringOn: (viewer: LiveViewer) => void;
  onCantBringOn: (viewer: LiveViewer) => void;
  // The ⋯ next to a friend: Remove, or Remove and block.
  onRemove: (viewer: LiveViewer) => void;
  // Take the co-host off the stage.
  onBackToWatching: (viewer: LiveViewer) => void;
}) {
  const [viewers, setViewers] = useState<LiveViewer[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await fetchLiveViewers(liveId);
      setViewers(list);
      setFailed(false);
    } catch {
      setFailed(true);
      setViewers((now) => now ?? []);
    }
  }, [liveId]);

  useEffect(() => {
    if (!visible) return;
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [visible, load]);

  // The co-host first, then the newest to join.
  const sorted = [...(viewers ?? [])].sort((a, b) => Number(b.is_cohost) - Number(a.is_cohost) || b.joined_at.localeCompare(a.joined_at));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <SafeEdge edge="bottom" style={styles.sheet}>
          <Pressable style={styles.inner}>
            <Text style={styles.title}>👀 Watching now</Text>
            {viewers === null ? (
              <ActivityIndicator color={colors.live} style={styles.spinner} />
            ) : sorted.length === 0 ? (
              <Text style={styles.empty}>{failed ? 'Couldn’t load who’s watching – check your internet.' : 'No friends watching yet'}</Text>
            ) : (
              <FlatList
                data={sorted}
                keyExtractor={(viewer) => viewer.user_id}
                style={styles.list}
                renderItem={({ item }) => {
                  const name = viewerName(item);
                  const canAsk = item.can_cohost && !cohostId && !inviteOpen;
                  return (
                    <View style={styles.row}>
                      <Avatar path={item.avatar_path} name={name} size={40} />
                      <View style={styles.names}>
                        <Text style={styles.name} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.username} numberOfLines={1}>
                          {item.is_cohost ? 'On with you' : `@${item.username}`}
                        </Text>
                      </View>
                      {item.is_cohost ? (
                        <Button title="Back to watching" variant="secondary" small onPress={() => onBackToWatching(item)} />
                      ) : (
                        <Pressable
                          onPress={() => (canAsk ? onBringOn(item) : onCantBringOn(item))}
                          style={[styles.bring, !canAsk && styles.bringGrey]}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: !canAsk }}
                          accessibilityLabel={`Bring ${name} on`}>
                          <Text style={[styles.bringText, !canAsk && styles.bringTextGrey]}>Bring on</Text>
                        </Pressable>
                      )}
                      <IconButton icon="ellipsis-horizontal" label={`More for ${name}`} size={34} background={colors.card} onPress={() => onRemove(item)} />
                    </View>
                  );
                }}
              />
            )}
            <Button title="Done" variant="plain" onPress={onClose} />
          </Pressable>
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
    maxHeight: '75%',
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
  empty: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginVertical: space.lg,
  },
  list: {
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  names: {
    flex: 1,
  },
  name: {
    ...font.body,
    fontWeight: '800',
  },
  username: {
    ...font.small,
  },
  bring: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.live,
  },
  bringGrey: {
    backgroundColor: colors.card,
  },
  bringText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
  },
  bringTextGrey: {
    color: colors.textFaint,
  },
});
