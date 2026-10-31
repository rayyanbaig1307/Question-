import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { colors, font, radius, space } from '@/theme';

// How a post will look once it's up: your name on top, the photo as a square grid tile, then the caption.
// `uri` is a local or signed URL; for a video pass its poster (or nothing for a dark tile).
export function PostPreview({ uri, isVideo, caption, name, avatarPath }: {
  uri: string | null;
  isVideo?: boolean;
  caption: string;
  name: string;
  avatarPath?: string | null;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.author}>
        <Avatar path={avatarPath} name={name} size={28} />
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
      </View>
      <View style={styles.tile}>
        {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        {isVideo ? <Text style={styles.videoTag}>▶︎</Text> : null}
      </View>
      {caption.trim() ? (
        <Text style={styles.caption}>{caption.trim()}</Text>
      ) : (
        <Text style={[styles.caption, styles.noCaption]}>No caption</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'center',
    width: 240,
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
  },
  author: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  name: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
    flexShrink: 1,
  },
  tile: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoTag: {
    color: colors.white,
    fontSize: 28,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  caption: {
    ...font.small,
    color: colors.text,
  },
  noCaption: {
    color: colors.textFaint,
    fontStyle: 'italic',
  },
});
