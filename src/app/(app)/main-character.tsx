import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { SafeScreen } from '@/components/SafeEdge';
import { FACE_MESH_AVAILABLE } from '@/lib/faceMesh';
import { updateChannel } from '@/lib/lensDiagnostics';
import { MAIN_CHARACTER_PLUS, mainCharacterHere } from '@/lib/mainCharacter/config';
import { usePlusAnswer } from '@/lib/plus';
import { colors, font, space } from '@/theme';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: put your face in a comic poster (docs/MAIN_CHARACTER.md).
//
// This page only checks that this phone can do it, then shows the real screen (MainCharacterStudio). It loads on
// every download (Android, Expo Go and web too), so it imports nothing that needs the camera or Skia: the screen
// itself is only loaded on downloads that have face tracking, the same way the home camera loads its face filters.
// ---------------------------------------------------------------------------

const Studio: typeof import('@/components/mainCharacter/MainCharacterStudio').MainCharacterStudio | null = FACE_MESH_AVAILABLE
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/components/mainCharacter/MainCharacterStudio').MainCharacterStudio
  : null;

export default function MainCharacterScreen() {
  // Can this phone use it? (iPhone app with face tracking, and for now only on the owner's test channel.)
  // Worked out once when the page opens.
  const [here] = useState(() => mainCharacterHere(Platform.OS, FACE_MESH_AVAILABLE, updateChannel()));
  const plusAnswer = usePlusAnswer();
  // If it ever becomes a Peekaboo+ feature: people we're sure don't have Plus see the Peekaboo+ page instead.
  const needsPlus = here && Studio !== null && MAIN_CHARACTER_PLUS && plusAnswer === 'no';

  useEffect(() => {
    if (needsPlus) router.replace('/plus');
  }, [needsPlus]);

  if (!here || !Studio) return <NotHere />;
  if (needsPlus) return <View style={styles.black} />;
  return <Studio />;
}

// The page for phones that can't do it (Android, Expo Go, the website, or an older app).
function NotHere() {
  return (
    <SafeScreen style={styles.notHere}>
      <Text style={styles.emoji}>🌆</Text>
      <Text style={styles.title}>Main Character Mode</Text>
      <Text style={styles.text}>Main Character Mode needs the newest Peekaboo app on an iPhone.</Text>
      <Button title="Back" icon="arrow-back" onPress={() => router.back()} style={styles.back} />
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  black: {
    flex: 1,
    backgroundColor: colors.black,
  },
  notHere: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    backgroundColor: colors.bg,
  },
  emoji: {
    fontSize: 64,
  },
  title: {
    ...font.title,
    textAlign: 'center',
  },
  text: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  back: {
    alignSelf: 'stretch',
    marginTop: space.lg,
  },
});
