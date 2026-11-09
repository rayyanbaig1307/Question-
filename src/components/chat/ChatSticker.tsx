import { StyleSheet, Text, View } from 'react-native';

import { SpecialSticker } from '@/components/editor/SpecialSticker';
import { isKnownSticker, stickerName, wordOfSticker } from '@/lib/chatStickers';
import { colors, radius, space } from '@/theme';

// A sticker sent in a chat 🏷️, drawn big with no bubble around it. Returns null for a sticker this version
// of the app doesn't know (the chat then shows its text version instead).
export function ChatSticker({ id }: { id: string }) {
  if (!isKnownSticker(id)) return null;
  const word = wordOfSticker(id);
  return (
    <View style={styles.wrap} accessible accessibilityLabel={`${stickerName(id)} sticker`}>
      {word ? (
        <View style={styles.word}>
          <Text style={styles.wordText}>{word}</Text>
        </View>
      ) : (
        <SpecialSticker id={id} small />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minWidth: 80,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xs,
  },
  word: {
    backgroundColor: colors.pink,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    transform: [{ rotate: '-4deg' }],
  },
  wordText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 22,
  },
});
