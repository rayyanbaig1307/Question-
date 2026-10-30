import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { fetchForfeitOptions, giveForfeit, type ForfeitOption } from '@/lib/dareChain';
import { friendlyError } from '@/lib/errors';
import { colors, font, radius, space } from '@/theme';

// A friend you dared ran out of time: pick their forfeit from the list (nobody can type their own).
export default function PickForfeit() {
  const { nomination, name } = useLocalSearchParams<{ nomination: string; name?: string }>();
  const { showToast } = useOverlays();
  const [options, setOptions] = useState<ForfeitOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const who = name || 'your friend';

  useEffect(() => {
    fetchForfeitOptions()
      .then(setOptions)
      .catch(() => setOptions([]));
  }, []);

  function confirm(option: ForfeitOption) {
    Haptics.selectionAsync();
    Alert.alert(`${who}'s forfeit 💀`, option.text, [
      { text: 'Pick another', style: 'cancel' },
      {
        text: 'Give this one',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await giveForfeit(nomination, option.key);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            showToast(`💀 ${who} owes you a forfeit`);
            router.back();
          } catch (error) {
            Alert.alert('Could not give the forfeit', friendlyError(error));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Pick a forfeit 💀" />
      {options === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : (
        <FlatList
          data={options}
          keyExtractor={(option) => option.key}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <Text style={styles.explain}>
              {who} didn&apos;t do the dare in time. Pick what they owe you – they get a notification and pay it by
              posting a photo or video of it.
            </Text>
          }
          renderItem={({ item, index }) => (
            <Pressable
              disabled={busy}
              onPress={() => confirm(item)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={`Forfeit: ${item.text}`}>
              <Text style={styles.number}>{index + 1}</Text>
              <Text style={styles.text}>{item.text}</Text>
            </Pressable>
          )}
        />
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
    marginTop: space.xxl,
  },
  content: {
    padding: space.lg,
    gap: space.sm,
    paddingBottom: space.xxl * 2,
  },
  explain: {
    ...font.small,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
  },
  rowPressed: {
    backgroundColor: colors.cardPressed,
  },
  number: {
    ...font.label,
    color: colors.purple,
    width: 24,
    textAlign: 'center',
  },
  text: {
    ...font.body,
    flex: 1,
    fontWeight: '700',
  },
});
