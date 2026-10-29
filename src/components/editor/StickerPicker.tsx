import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SafeEdge } from '@/components/SafeEdge';
import { colors, font, radius, space } from '@/theme';
import { SPECIAL_STICKERS, SpecialSticker } from './SpecialSticker';
import { EMOJI_STICKERS, WORD_STICKERS } from './stickers';

// Bottom sheet full of stickers. Tap one to drop it on your photo.
export function StickerPicker({ visible, onClose, onPickEmoji, onPickWord, onPickSpecial }: {
  visible: boolean;
  onClose: () => void;
  onPickEmoji: (emoji: string) => void;
  onPickWord: (word: string) => void;
  onPickSpecial: (id: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <SafeEdge edge="bottom" style={styles.sheet}>
          <Pressable>
            <View style={styles.handle} />
            <Text style={styles.title}>Stickers</Text>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
              <Text style={styles.section}>Peekaboo originals 👀</Text>
              <View style={styles.specials}>
                {SPECIAL_STICKERS.map((id) => (
                  <Pressable
                    key={id}
                    onPress={() => onPickSpecial(id)}
                    accessibilityLabel={`${id.replace(/-/g, ' ')} sticker`}
                    style={({ pressed }) => [styles.special, pressed && styles.pressed]}>
                    <SpecialSticker id={id} small />
                  </Pressable>
                ))}
              </View>
              <View style={styles.words}>
                {WORD_STICKERS.map((word) => (
                  <Pressable
                    key={word}
                    onPress={() => onPickWord(word)}
                    style={({ pressed }) => [styles.word, pressed && styles.pressed]}>
                    <Text style={styles.wordText}>{word}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.grid}>
                {EMOJI_STICKERS.map((emoji) => (
                  <Pressable
                    key={emoji}
                    onPress={() => onPickEmoji(emoji)}
                    style={({ pressed }) => [styles.cell, pressed && styles.pressed]}>
                    <Text style={styles.emoji}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        </SafeEdge>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '60%',
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginTop: space.sm,
  },
  title: {
    ...font.heading,
    textAlign: 'center',
    marginVertical: space.md,
  },
  scroll: {
    flexGrow: 0,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.lg,
  },
  section: {
    ...font.label,
    textAlign: 'center',
  },
  specials: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.sm,
  },
  special: {
    width: 104,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  words: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    justifyContent: 'center',
  },
  word: {
    backgroundColor: colors.pink,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  wordText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  cell: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  emoji: {
    fontSize: 40,
  },
  pressed: {
    backgroundColor: colors.cardPressed,
    transform: [{ scale: 0.92 }],
  },
});
