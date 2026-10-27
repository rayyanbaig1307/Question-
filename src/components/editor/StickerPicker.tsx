import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, font, radius, space } from '@/theme';
import { EMOJI_STICKERS, WORD_STICKERS } from './stickers';

// Bottom sheet full of stickers. Tap one to drop it on your photo.
export function StickerPicker({ visible, onClose, onPickEmoji, onPickWord }: {
  visible: boolean;
  onClose: () => void;
  onPickEmoji: (emoji: string) => void;
  onPickWord: (word: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <Pressable>
            <View style={styles.handle} />
            <Text style={styles.title}>Stickers</Text>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
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
        </SafeAreaView>
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
