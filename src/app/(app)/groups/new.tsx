import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { fetchFriends } from '@/lib/friends';
import { addToGroup, createGroup, fetchGroup, renameGroup } from '@/lib/groups';
import { inviteFriends } from '@/lib/invite';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

const MAX_PEOPLE = 12;

// Make a new group (name + pick friends) – or, with `group`, rename a group and add more friends to it.
export default function NewGroup() {
  const { group: groupId } = useLocalSearchParams<{ group?: string }>();
  const editing = !!groupId;
  const { userId, profile } = useMe();
  const { showToast } = useOverlays();
  const insets = useSafeAreaInsets();

  const [friends, setFriends] = useState<Profile[] | null>(null);
  const [inGroup, setInGroup] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [oldName, setOldName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([fetchFriends(userId), groupId ? fetchGroup(groupId) : Promise.resolve(null)])
      .then(([loaded, group]) => {
        if (group) {
          setName(group.name);
          setOldName(group.name);
          setInGroup(new Set(group.members.map((member) => member.userId)));
        }
        setFriends(loaded);
      })
      .catch(() => setFriends([]));
  }, [userId, groupId]);

  // Friends already in the group aren't shown again.
  const choices = (friends ?? []).filter((friend) => !inGroup.has(friend.id));
  const room = MAX_PEOPLE - Math.max(1, inGroup.size) - picked.size;

  function toggle(friend: Profile) {
    const next = new Set(picked);
    if (next.has(friend.id)) {
      next.delete(friend.id);
    } else {
      if (room <= 0) {
        Alert.alert('Group is full', `A group can have up to ${MAX_PEOPLE} people.`);
        return;
      }
      next.add(friend.id);
    }
    Haptics.selectionAsync();
    setPicked(next);
  }

  const nameOk = name.trim().length > 0;
  const canSave = nameOk && (editing ? picked.size > 0 || name.trim() !== oldName : picked.size > 0);

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      if (groupId) {
        if (name.trim() !== oldName) await renameGroup(groupId, name);
        await addToGroup(groupId, [...picked]);
        showToast(picked.size > 0 ? 'Added to the group 👯' : 'Group renamed ✏️');
        router.back();
      } else {
        const id = await createGroup(name, [...picked]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/groups/${id}`);
      }
    } catch (error) {
      Alert.alert(editing ? 'Could not save' : 'Could not make the group', friendlyError(error));
      setSaving(false);
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title={editing ? 'Edit group' : 'New group'} />
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        {friends === null ? (
          <ActivityIndicator style={styles.loading} color={colors.accent} />
        ) : (
          <FlatList
            data={choices}
            keyExtractor={(friend) => friend.id}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListHeaderComponent={
              <View style={styles.header}>
                <TextField
                  label="Group name"
                  value={name}
                  onChangeText={setName}
                  placeholder="Besties 💕"
                  maxLength={40}
                  returnKeyType="done"
                />
                <Text style={styles.sectionTitle}>
                  {editing ? 'Add friends' : 'Pick friends'}
                  {picked.size > 0 ? ` · ${picked.size} picked` : ''}
                </Text>
              </View>
            }
            ListEmptyComponent={
              friends.length === 0 ? (
                <EmptyState emoji="🫂" title="No friends yet" message="Add some friends first, then make a group together!">
                  <Button title="Invite friends" icon="paper-plane" onPress={() => inviteFriends(profile?.username)} />
                </EmptyState>
              ) : (
                <Text style={styles.allIn}>All your friends are already in this group 🎉</Text>
              )
            }
            renderItem={({ item }) => {
              const on = picked.has(item.id);
              return (
                <Pressable
                  style={[styles.row, on && styles.rowOn]}
                  onPress={() => toggle(item)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}>
                  <Avatar path={item.avatar_path} name={item.display_name || item.username} size={44} />
                  <View style={styles.names}>
                    <Text style={styles.name} numberOfLines={1}>
                      {item.display_name || item.username}
                    </Text>
                    <Text style={styles.username} numberOfLines={1}>
                      @{item.username}
                    </Text>
                  </View>
                  <View style={[styles.check, on && styles.checkOn]}>
                    {on ? <Ionicons name="checkmark" size={18} color={colors.white} /> : null}
                  </View>
                </Pressable>
              );
            }}
          />
        )}
        <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
          <Button
            title={
              editing
                ? picked.size > 0
                  ? `Add ${picked.size} to the group`
                  : 'Save'
                : picked.size > 0
                  ? `Make group with ${picked.size} ${picked.size === 1 ? 'friend' : 'friends'}`
                  : 'Pick some friends'
            }
            icon="people"
            loading={saving}
            disabled={!canSave}
            onPress={save}
          />
        </View>
      </KeyboardAvoidingView>
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
    gap: space.sm,
    flexGrow: 1,
  },
  header: {
    gap: space.lg,
    marginBottom: space.xs,
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
  },
  allIn: {
    ...font.small,
    textAlign: 'center',
    marginTop: space.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  rowOn: {
    borderColor: colors.pink,
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
  check: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: {
    backgroundColor: colors.pink,
    borderColor: colors.pink,
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.bg,
  },
});
