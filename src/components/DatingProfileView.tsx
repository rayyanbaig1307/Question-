import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { roughDistance, type DatingCard } from '@/lib/dating';
import { colors, font, radius, space } from '@/theme';

export type LikeTarget = { photoId: string; path: string } | { prompt: number; text: string; answer: string };

// A Peek Match profile, Hinge-style: photos and prompts one after another, each with a ♥ to like that one
// thing. Shows only dating info – never anything from the person's normal Peekaboo account.
export function DatingProfileView({ card, urls, onLike, footer, blurred = false }: {
  card: DatingCard;
  urls: Record<string, string>;
  onLike?: (target: LikeTarget) => void;
  footer?: ReactNode;
  // In a match chat, photos stay blurred until you've both sent 5 messages.
  blurred?: boolean;
}) {
  const [first, ...morePhotos] = card.photos;
  // Photo, prompt, photo, prompt, photo, prompt, then any extra photos.
  const rest: ReactNode[] = [];
  for (let i = 0; i < Math.max(morePhotos.length, card.prompts.length); i++) {
    const prompt = card.prompts[i];
    if (prompt) {
      rest.push(
        <View key={`prompt-${prompt.position}`} style={styles.prompt}>
          <Text style={styles.promptQuestion}>{prompt.prompt}</Text>
          <Text style={styles.promptAnswer}>{prompt.answer}</Text>
          {onLike ? (
            <LikeButton onPress={() => onLike({ prompt: prompt.position, text: prompt.prompt, answer: prompt.answer })} />
          ) : null}
        </View>,
      );
    }
    const photo = morePhotos[i];
    if (photo) {
      rest.push(
        <Photo
          key={photo.id}
          uri={urls[photo.path]}
          cacheKey={photo.path}
          blurred={blurred}
          onLike={onLike && (() => onLike({ photoId: photo.id, path: photo.path }))}
        />,
      );
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.name}>
          {card.name}, {card.age}
        </Text>
        <Text style={styles.where}>
          📍 {card.area} · {roughDistance(card.km)}
        </Text>
      </View>
      {first ? (
        <Photo
          uri={urls[first.path]}
          cacheKey={first.path}
          blurred={blurred}
          onLike={onLike && (() => onLike({ photoId: first.id, path: first.path }))}
        />
      ) : null}
      {rest}
      {footer}
    </View>
  );
}

function Photo({ uri, cacheKey, onLike, blurred }: {
  uri: string | undefined;
  cacheKey: string;
  onLike?: () => void;
  blurred: boolean;
}) {
  return (
    <View style={styles.photo}>
      {uri ? (
        <Image
          source={{ uri, cacheKey }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          blurRadius={blurred ? 40 : 0}
        />
      ) : null}
      {blurred ? <Text style={styles.blurredHint}>🙈</Text> : null}
      {onLike ? <LikeButton onPress={onLike} /> : null}
    </View>
  );
}

function LikeButton({ onPress }: { onPress: () => void }) {
  return (
    <Bouncy style={styles.like} pressScale={0.8} onPress={onPress} accessibilityLabel="Like this">
      <Ionicons name="heart" size={26} color={colors.pink} />
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.lg,
  },
  header: {
    gap: 2,
  },
  name: {
    ...font.title,
  },
  where: {
    ...font.small,
    fontSize: 14,
  },
  photo: {
    width: '100%',
    aspectRatio: 4 / 5,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  prompt: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.xl,
    paddingBottom: space.xxl + space.lg,
    gap: space.md,
  },
  promptQuestion: {
    ...font.label,
    color: colors.pink,
  },
  promptAnswer: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.text,
    lineHeight: 32,
  },
  blurredHint: {
    position: 'absolute',
    alignSelf: 'center',
    top: '42%',
    fontSize: 48,
  },
  like: {
    position: 'absolute',
    right: space.md,
    bottom: space.md,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.black,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
});
