import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { avatarUrl } from '@/lib/media';
import { colors, gradients } from '@/theme';

type Props = {
  path?: string | null;
  // A photo picked on the phone that isn't uploaded yet.
  localUri?: string | null;
  name?: string | null;
  size?: number;
  ring?: boolean;
};

// Round profile picture. Shows a colorful first letter when there's no photo.
export function Avatar({ path, localUri, name, size = 40, ring = false }: Props) {
  const uri = localUri ?? avatarUrl(path);
  const letter = (name?.trim()[0] ?? '?').toUpperCase();
  const inner = ring ? size - 8 : size;

  const picture = uri ? (
    <Image
      source={{ uri }}
      style={{ width: inner, height: inner, borderRadius: inner / 2 }}
      contentFit="cover"
      transition={150}
    />
  ) : (
    <LinearGradient
      colors={gradients.ocean}
      style={[styles.placeholder, { width: inner, height: inner, borderRadius: inner / 2 }]}>
      <Text style={[styles.letter, { fontSize: inner * 0.42 }]}>{letter}</Text>
    </LinearGradient>
  );

  if (!ring) return picture;

  return (
    <LinearGradient
      colors={gradients.brand}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.ring, { width: size, height: size, borderRadius: size / 2 }]}>
      <View style={[styles.gap, { borderRadius: size / 2 }]}>{picture}</View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  letter: {
    color: colors.white,
    fontWeight: '900',
  },
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  gap: {
    padding: 2,
    backgroundColor: colors.bg,
  },
});
