import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { friendlyError } from '@/lib/errors';
import { fetchReports, reviewReport, type Report, type ReviewAction } from '@/lib/moderation';
import { timeAgo } from '@/lib/time';
import { colors, font, radius, space } from '@/theme';

const TYPE_LABEL: Record<Report['content_type'], string> = {
  user: 'Account',
  post: 'Post',
  story: 'Story',
  message: 'Message',
  comment: 'Comment',
  dare_idea: 'Dare idea',
};

// Admins only: every report, and what to do about it. The app promises to act within 24 hours.
export default function Reports() {
  const { showToast } = useOverlays();
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [reports, setReports] = useState<Report[] | null>(null);

  const load = useCallback(() => {
    fetchReports(onlyOpen)
      .then(setReports)
      .catch((error) => {
        Alert.alert('Could not load reports', friendlyError(error));
        setReports((current) => current ?? []);
      });
  }, [onlyOpen]);

  useEffect(load, [load]);

  async function act(report: Report, action: ReviewAction, done: string) {
    try {
      await reviewReport(report.id, action);
      showToast(done);
      load();
    } catch (error) {
      Alert.alert('Could not do that', friendlyError(error));
    }
  }

  function confirm(report: Report, action: ReviewAction, title: string, message: string, done: string) {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: title, style: 'destructive', onPress: () => act(report, action, done) },
    ]);
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Reports" />
      <View style={styles.filter}>
        {[
          { key: true, label: 'Open' },
          { key: false, label: 'All' },
        ].map((option) => (
          <Pressable
            key={option.label}
            onPress={() => setOnlyOpen(option.key)}
            accessibilityRole="radio"
            accessibilityState={{ selected: onlyOpen === option.key }}
            style={[styles.chip, onlyOpen === option.key && styles.chipOn]}>
            <Text style={[styles.chipText, onlyOpen === option.key && styles.chipTextOn]}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
      {reports === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(report) => report.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <EmptyState emoji="🧹" title={onlyOpen ? 'No open reports' : 'No reports yet'} message="Nothing to look at right now." />
          }
          renderItem={({ item }) => {
            const who = item.reported_name || item.reported_username || 'Unknown account';
            return (
              <View style={styles.card}>
                <View style={styles.top}>
                  <Pressable
                    onPress={() => item.reported_id && router.push(`/profile/${item.reported_id}`)}
                    style={styles.person}
                    accessibilityLabel={`Open ${who}'s profile`}>
                    <Avatar path={item.reported_avatar} name={who} size={40} />
                    <View style={styles.personText}>
                      <Text style={styles.name} numberOfLines={1}>
                        {who}
                        {item.reported_banned ? '  🚫 banned' : ''}
                      </Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {TYPE_LABEL[item.content_type]} · reported by @{item.reporter_username ?? '?'} · {timeAgo(item.created_at)}
                      </Text>
                    </View>
                  </Pressable>
                  <Text style={[styles.status, item.status === 'open' && styles.statusOpen]}>{item.status}</Text>
                </View>
                <Text style={styles.reason}>
                  <Text style={styles.reasonLabel}>Reason: </Text>
                  {item.reason}
                  {item.details ? ` – ${item.details}` : ''}
                </Text>
                {item.content_type !== 'user' ? (
                  <Text style={[styles.preview, !item.content_exists && styles.gone]} numberOfLines={4}>
                    {item.content_exists ? (item.preview ?? '(photo or video – open their profile to see it)') : '(already removed)'}
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  {item.content_type !== 'user' && item.content_exists ? (
                    <Button
                      title="Remove"
                      icon="trash"
                      variant="danger"
                      small
                      onPress={() =>
                        confirm(item, 'remove_content', 'Remove', 'Delete this content for everyone?', 'Content removed 🗑️')
                      }
                    />
                  ) : null}
                  {item.reported_id ? (
                    item.reported_banned ? (
                      <Button title="Unban" icon="lock-open" variant="secondary" small onPress={() => act(item, 'unban', 'Account unbanned')} />
                    ) : (
                      <Button
                        title="Ban"
                        icon="ban"
                        variant="danger"
                        small
                        onPress={() =>
                          confirm(item, 'ban', 'Ban', `@${item.reported_username ?? '?'} won't be able to log in any more. Their content stays unless you remove it.`, 'Account banned 🚫')
                        }
                      />
                    )
                  ) : null}
                  {item.status === 'open' ? (
                    <>
                      <Button title="Reviewed" icon="checkmark" variant="secondary" small onPress={() => act(item, 'reviewed', 'Marked as reviewed ✅')} />
                      <Button title="Dismiss" variant="plain" small onPress={() => act(item, 'dismiss', 'Report dismissed')} />
                    </>
                  ) : null}
                </View>
              </View>
            );
          }}
        />
      )}
      <View style={styles.footer}>
        <Ionicons name="time-outline" size={14} color={colors.textMuted} />
        <Text style={styles.footerText}>The Terms promise a look at every report within 24 hours.</Text>
      </View>
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
  filter: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  chip: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipOn: {
    borderColor: colors.accent,
  },
  chipText: {
    ...font.body,
    fontWeight: '800',
    color: colors.textMuted,
  },
  chipTextOn: {
    color: colors.text,
  },
  list: {
    padding: space.lg,
    gap: space.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  person: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  personText: {
    flex: 1,
  },
  name: {
    ...font.body,
    fontWeight: '800',
  },
  meta: {
    ...font.small,
    fontSize: 12,
  },
  status: {
    ...font.small,
    fontWeight: '800',
  },
  statusOpen: {
    color: colors.accent,
  },
  reason: {
    ...font.body,
    fontSize: 15,
  },
  reasonLabel: {
    fontWeight: '800',
  },
  preview: {
    ...font.body,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: space.sm,
  },
  gone: {
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: space.md,
  },
  footerText: {
    ...font.small,
    fontSize: 12,
  },
});
