import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SongCard } from '@/components/SongCard';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { updateMyProfile } from '@/lib/profiles';
import { profileSong, searchSongs, songFields, type Song } from '@/lib/songs';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

// Pick a song for your profile: search Apple Music, play the 30-second preview, tap Pick.
export default function SongPicker() {
  const { userId, profile, setProfile } = useMe();
  const { showToast } = useOverlays();
  const current = profileSong(profile);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Song[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  // Search a moment after you stop typing.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      searchSongs(term)
        .then((songs) => !cancelled && setResults(songs))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setSearching(false));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  async function save(song: Song | null) {
    setSaving(true);
    try {
      const updated = await updateMyProfile(userId, songFields(song));
      setProfile(updated);
      showToast(song ? `🎵 ${song.title} is on your profile` : 'Song removed');
      router.back();
    } catch (error) {
      Alert.alert('Could not save the song', friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Profile song 🎵" />
      <FlatList
        data={query.trim().length >= 2 ? (results ?? []) : []}
        keyExtractor={(song) => String(song.id)}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <View style={styles.header}>
            {current ? (
              <>
                <Text style={styles.label}>On your profile now</Text>
                <SongCard song={current} />
                <Button title="Remove song" variant="secondary" small loading={saving} onPress={() => save(null)} />
              </>
            ) : null}
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search for a song or artist"
              placeholderTextColor={colors.textFaint}
              keyboardAppearance={keyboardAppearance}
              selectionColor={colors.accent}
              returnKeyType="search"
              autoCorrect={false}
              style={styles.search}
            />
            {searching ? <ActivityIndicator color={colors.accent} /> : null}
          </View>
        }
        ListEmptyComponent={
          query.trim().length < 2 ? (
            <EmptyState emoji="🎧" title="Pick your song" message="Search for a song – tap ▶ to hear a 30-second preview." />
          ) : results && !searching ? (
            <Text style={styles.none}>No songs found – try another search.</Text>
          ) : undefined
        }
        renderItem={({ item }) => (
          <SongCard song={item} right={<Button title="Pick" small disabled={saving} onPress={() => save(item)} />} />
        )}
        ListFooterComponent={
          <Text style={styles.note}>
            Songs and previews come from Apple Music. Peekaboo only saves the song&apos;s name and links – never the music.
          </Text>
        }
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
    flexGrow: 1,
  },
  header: {
    gap: space.md,
    marginBottom: space.sm,
  },
  label: {
    ...font.label,
    textTransform: 'uppercase',
  },
  search: {
    ...font.body,
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    color: colors.text,
  },
  none: {
    ...font.small,
    textAlign: 'center',
    marginTop: space.lg,
  },
  note: {
    ...font.small,
    fontSize: 12,
    textAlign: 'center',
    marginTop: space.lg,
  },
});
