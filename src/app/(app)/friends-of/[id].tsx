import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { FriendButton } from '@/components/FriendButton';
import { PersonRow } from '@/components/PersonRow';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { fetchFriendsOf, fetchMyFriendLinks, relationFrom, type FriendLink } from '@/lib/friends';
import { fetchProfile } from '@/lib/profiles';
import type { Profile } from '@/lib/types';
import { colors, space } from '@/theme';

// A friend's friends list (from the Friends number on their profile). Each row has an Add button, so you can
// add their friends too. Only friends can see it – add someone first to see who they know.
export default function FriendsOf() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const [person, setPerson] = useState<Profile | null>(null);
  const [friends, setFriends] = useState<Profile[] | null>(null);
  const [links, setLinks] = useState<FriendLink[]>([]);

  const load = useCallback(() => {
    if (!id) return;
    fetchProfile(id)
      .then(setPerson)
      .catch(() => {});
    Promise.all([fetchFriendsOf(id), fetchMyFriendLinks(userId)])
      .then(([people, myLinks]) => {
        setFriends(people);
        setLinks(myLinks);
      })
      .catch((error) => {
        console.warn('Could not load their friends', error);
        setFriends((current) => current ?? []);
      });
  }, [id, userId]);

  useFocusEffect(load);

  const relationWith = (personId: string) =>
    relationFrom(links.find((link) => link.requester_id === personId || link.addressee_id === personId) ?? null, userId);
  const name = person ? person.display_name || `@${person.username}` : '';

  return (
    <View style={styles.fill}>
      <ScreenHeader title={person ? `${name}'s friends` : 'Friends'} />
      {friends === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : friends.length === 0 ? (
        <EmptyState emoji="🫥" title="No friends to show" message={`${name || 'They'} hasn't added anyone yet – or you need to be friends first.`} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {friends.map((friend) => (
            <PersonRow
              key={friend.id}
              person={friend}
              right={friend.id === userId ? undefined : <FriendButton person={friend} relation={relationWith(friend.id)} onChanged={load} small />}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xl,
  },
  content: {
    padding: space.lg,
    gap: space.sm,
  },
});
