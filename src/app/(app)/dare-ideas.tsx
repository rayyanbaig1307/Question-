import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import {
  deleteIdea,
  fetchIdeas,
  IDEA_MAX,
  IDEA_MIN,
  MIN_VOTES,
  reportIdea,
  submitIdea,
  voteIdea,
  type DareIdea,
} from '@/lib/communityDares';
import { friendlyError } from '@/lib/errors';
import { REPORT_REASONS } from '@/lib/safety';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

// Community dares: suggest one, vote 🔥 on everyone's, and the top one becomes tomorrow's dare with your name on it.
export default function DareIdeas() {
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const [sort, setSort] = useState<'top' | 'new'>('top');
  const [ideas, setIdeas] = useState<DareIdea[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(
    () =>
      fetchIdeas(userId, sort)
        .then(setIdeas)
        .catch((error) => {
          console.warn('Could not load ideas', error);
          setIdeas((current) => current ?? []);
        }),
    [userId, sort],
  );

  useEffect(() => {
    load();
  }, [load]);

  const clean = text.trim();
  const canSend = clean.length >= IDEA_MIN && clean.length <= IDEA_MAX;

  async function suggest() {
    if (!canSend) return;
    setSending(true);
    try {
      await submitIdea(clean);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast('💡 Idea in! Get your friends to 🔥 it');
      setText('');
      setSort('new');
      await load();
    } catch (error) {
      const message = friendlyError(error);
      Alert.alert(
        'Could not add your idea',
        /row-level security|policy/i.test(message)
          ? "Keep it silly, not dangerous – and it's one idea a day. (House rules: nobody gets hurt, no fire, clothes stay on.)"
          : message,
      );
    } finally {
      setSending(false);
    }
  }

  async function vote(idea: DareIdea) {
    const on = !idea.mine;
    Haptics.selectionAsync();
    setIdeas((current) =>
      current?.map((i) => (i.id === idea.id ? { ...i, mine: on, votes: Math.max(0, i.votes + (on ? 1 : -1)) } : i)) ?? null,
    );
    try {
      await voteIdea(idea.id, on);
    } catch (error) {
      await load();
      Alert.alert('Could not vote', friendlyError(error));
    }
  }

  function menu(idea: DareIdea) {
    if (idea.user_id === userId) {
      showOptions({
        options: [
          {
            label: 'Delete my idea',
            destructive: true,
            onPress: async () => {
              try {
                await deleteIdea(idea.id);
                setIdeas((current) => current?.filter((i) => i.id !== idea.id) ?? null);
                showToast('Idea deleted');
              } catch (error) {
                Alert.alert('Could not delete', friendlyError(error));
              }
            },
          },
        ],
      });
      return;
    }
    showOptions({
      title: 'Report this idea?',
      message: 'Three reports from different people hide it for good. Reports are private.',
      options: REPORT_REASONS.map((reason) => ({
        label: reason.label,
        onPress: async () => {
          try {
            await reportIdea(idea.id, reason.code);
            showToast('Thanks – we will take a look 💛');
          } catch (error) {
            Alert.alert('Could not report', friendlyError(error));
          }
        },
      })),
    });
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Dare ideas 💡" />
      <FlatList
        data={ideas ?? []}
        keyExtractor={(idea) => idea.id}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Your dare could be everyone&apos;s dare</Text>
              <Text style={styles.cardText}>
                Suggest one. The idea with the most 🔥 (at least {MIN_VOTES}) becomes the next day&apos;s dare for everyone –
                with your name on it. One idea a day · silly, not dangerous.
              </Text>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="I dare everyone to…"
                placeholderTextColor={colors.textFaint}
                keyboardAppearance={keyboardAppearance}
                selectionColor={colors.accent}
                maxLength={IDEA_MAX}
                multiline
                style={styles.input}
              />
              <View style={styles.sendRow}>
                <Text style={styles.count}>
                  {clean.length}/{IDEA_MAX}
                </Text>
                <Button title="Suggest 💡" small disabled={!canSend} loading={sending} onPress={suggest} />
              </View>
            </View>
            <View style={styles.tabs}>
              {(['top', 'new'] as const).map((key) => (
                <Pressable
                  key={key}
                  onPress={() => setSort(key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: sort === key }}
                  style={[styles.tab, sort === key && styles.tabOn]}>
                  <Text style={[styles.tabText, sort === key && styles.tabTextOn]}>{key === 'top' ? '🔥 Top' : '🆕 New'}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
        ListEmptyComponent={
          ideas === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : (
            <EmptyState emoji="💡" title="No ideas yet" message="Be the first – suggest a dare above." />
          )
        }
        renderItem={({ item }) => {
          const name = item.author.display_name || item.author.username;
          return (
            <View style={styles.idea}>
              <Pressable style={styles.ideaMain} onLongPress={() => menu(item)} onPress={() => router.push(`/profile/${item.author.id}`)}>
                <Text style={styles.ideaText}>{item.text}</Text>
                <View style={styles.ideaBy}>
                  <Avatar path={item.author.avatar_path} name={name} size={20} />
                  <Text style={styles.ideaByText} numberOfLines={1}>
                    @{item.author.username}
                    {item.votes >= MIN_VOTES ? ' · 🔥 ready to run' : ''}
                  </Text>
                </View>
              </Pressable>
              <Bouncy
                style={[styles.vote, item.mine && styles.voteOn]}
                pressScale={0.85}
                onPress={() => vote(item)}
                accessibilityRole="button"
                accessibilityState={{ selected: item.mine }}
                accessibilityLabel={`${item.votes} votes${item.mine ? ', you voted' : ''}`}>
                <Text style={styles.voteEmoji}>🔥</Text>
                <Text style={[styles.voteCount, item.mine && styles.voteCountOn]}>{item.votes}</Text>
              </Bouncy>
              <Pressable onPress={() => menu(item)} hitSlop={8} accessibilityLabel="More">
                <Ionicons name="ellipsis-horizontal" size={20} color={colors.textFaint} />
              </Pressable>
            </View>
          );
        }}
      />
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
    gap: space.sm,
    paddingBottom: space.xxl * 2,
  },
  loading: {
    marginTop: space.xl,
  },
  header: {
    gap: space.md,
    marginBottom: space.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  cardTitle: {
    ...font.heading,
  },
  cardText: {
    ...font.small,
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    ...font.body,
    minHeight: 60,
    maxHeight: 120,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    color: colors.text,
  },
  sendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  count: {
    ...font.small,
    fontSize: 12,
  },
  tabs: {
    flexDirection: 'row',
    gap: space.sm,
  },
  tab: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  tabOn: {
    backgroundColor: colors.pink,
  },
  tabText: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
  },
  tabTextOn: {
    color: colors.white,
  },
  idea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
  },
  ideaMain: {
    flex: 1,
    gap: 6,
  },
  ideaText: {
    ...font.body,
    fontWeight: '700',
  },
  ideaBy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ideaByText: {
    ...font.small,
    fontSize: 12,
  },
  vote: {
    alignItems: 'center',
    minWidth: 48,
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  voteOn: {
    backgroundColor: colors.pink,
  },
  voteEmoji: {
    fontSize: 16,
  },
  voteCount: {
    ...font.small,
    fontWeight: '900',
    color: colors.text,
  },
  voteCountOn: {
    color: colors.white,
  },
});
