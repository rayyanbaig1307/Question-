import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FriendButton } from '@/components/FriendButton';
import { PersonRow } from '@/components/PersonRow';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { fetchMyFriendLinks, otherPerson, relationFrom, searchUsers, type FriendLink } from '@/lib/friends';
import { inviteFriends } from '@/lib/invite';
import { supabase } from '@/lib/supabase';
import type { Profile } from '@/lib/types';
import { colors, font, space } from '@/theme';

// Find people by username, answer friend requests, and see your friends.
export default function Friends() {
  const { userId, profile } = useMe();
  const [links, setLinks] = useState<FriendLink[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; people: Profile[] } | null>(null);

  const loadLinks = useCallback(() => {
    fetchMyFriendLinks(userId)
      .then(setLinks)
      .catch((error) => {
        console.warn('Could not load friends', error);
        setLinks((current) => current ?? []);
      });
  }, [userId]);

  // Load when the screen opens, and again whenever a request arrives or changes.
  useFocusEffect(
    useCallback(() => {
      loadLinks();
      const channel = supabase
        .channel(`friends-screen-${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, loadLinks)
        .subscribe();
      return () => {
        supabase.removeChannel(channel);
      };
    }, [loadLinks, userId]),
  );

  // Search a moment after you stop typing.
  const trimmed = query.trim().replace(/^@/, '');
  useEffect(() => {
    if (!trimmed) return;
    const timer = setTimeout(() => {
      searchUsers(trimmed, userId)
        .then((people) => setResults({ query: trimmed, people }))
        .catch((error) => console.warn('Search failed', error));
    }, 300);
    return () => clearTimeout(timer);
  }, [trimmed, userId]);

  const all = links ?? [];
  const received = all.filter((link) => link.status === 'pending' && link.addressee_id === userId);
  const sent = all.filter((link) => link.status === 'pending' && link.requester_id === userId);
  const friends = all.filter((link) => link.status === 'accepted');

  const relationWith = (personId: string) =>
    relationFrom(
      all.find((link) => link.requester_id === personId || link.addressee_id === personId) ?? null,
      userId,
    );

  const renderLink = (link: FriendLink) => {
    const person = otherPerson(link, userId);
    if (!person) return null;
    return (
      <PersonRow
        key={link.id}
        person={person}
        right={<FriendButton person={person} relation={relationFrom(link, userId)} onChanged={loadLinks} small />}
      />
    );
  };

  const searchResults = results && results.query === trimmed ? results.people : null;
  const invite = () => inviteFriends(profile?.username);

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Friends" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TextField
          label="Find friends"
          prefix="@"
          value={query}
          onChangeText={setQuery}
          placeholder="Search by username"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />

        {trimmed ? (
          searchResults === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : searchResults.length === 0 ? (
            <EmptyState
              emoji="🕵️"
              title={`Nobody called @${trimmed}…`}
              message="Check the spelling – or maybe they're not on Peekaboo yet. Send them an invite!">
              <Button title="Invite friends" icon="paper-plane" onPress={invite} />
            </EmptyState>
          ) : (
            <Section title="Results">
              {searchResults.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  right={
                    <FriendButton person={person} relation={relationWith(person.id)} onChanged={loadLinks} small />
                  }
                />
              ))}
            </Section>
          )
        ) : links === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : all.length === 0 ? (
          <EmptyState
            emoji="🫥"
            title="No friends yet?! Let's fix that."
            message="Search for a username above, or invite your friends to join you.">
            <Button title="Invite friends" icon="paper-plane" onPress={invite} />
          </EmptyState>
        ) : (
          <>
            <Button title="Invite friends" icon="paper-plane" onPress={invite} />
            {received.length > 0 ? (
              <Section title={`Friend requests (${received.length})`}>{received.map(renderLink)}</Section>
            ) : null}
            {friends.length > 0 ? (
              <Section title={`My friends (${friends.length})`}>{friends.map(renderLink)}</Section>
            ) : null}
            {sent.length > 0 ? <Section title="Waiting for them">{sent.map(renderLink)}</Section> : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
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
    gap: space.xl,
  },
  loading: {
    marginTop: space.xl,
  },
  section: {
    gap: space.sm,
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
    marginLeft: space.xs,
  },
});
