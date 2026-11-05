import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { SafeEdge } from '@/components/SafeEdge';
import { CHAT_BACKGROUNDS, ChatBackground } from '@/components/chat/ChatBackground';
import { colors, font, radius, space } from '@/theme';

const COLUMNS = 3;
const GAP = space.md;

// The "Chat background" sheet: little moving previews of every background, plus "None".
// Without Peekaboo+ the backgrounds show, but locked.
export function ChatBackgroundPicker({ visible, current, plus, onPick, onClose }: {
  visible: boolean;
  current: string | null;
  plus: boolean;
  onPick: (backgroundId: string | null) => void;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const tileWidth = Math.floor((Math.min(width, 520) - space.lg * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

  const close = () => onClose();

  const pick = (backgroundId: string | null) => {
    if (backgroundId && !plus) {
      // Locked: close this sheet and show the Peekaboo+ screen.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      close();
      router.push('/plus');
      return;
    }
    Haptics.selectionAsync();
    onPick(backgroundId);
    close();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <SafeEdge edge="bottom" style={styles.sheet}>
          <Pressable>
            <Text style={styles.title}>Chat background</Text>
            <Text style={styles.message}>
              {plus
                ? 'Only you see it. It holds still if your phone has Reduce Motion on.'
                : '⭐ Moving backgrounds come with Peekaboo+. Only you would see yours.'}
            </Text>
            <ScrollView contentContainerStyle={styles.grid} style={styles.scroll}>
              <Tile label="None" width={tileWidth} selected={!current} onPress={() => pick(null)}>
                <View style={styles.none}>
                  <Ionicons name="close-circle-outline" size={28} color={colors.textFaint} />
                </View>
              </Tile>
              {CHAT_BACKGROUNDS.map((bg) => (
                <Tile
                  key={bg.id}
                  label={bg.name}
                  width={tileWidth}
                  selected={current === bg.id}
                  locked={!plus}
                  onPress={() => pick(bg.id)}>
                  {visible ? <ChatBackground id={bg.id} small /> : null}
                  <View style={[styles.bubble, styles.bubbleThem]} />
                  <View style={[styles.bubble, styles.bubbleMe]} />
                </Tile>
              ))}
            </ScrollView>
            <Pressable onPress={close} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </SafeEdge>
      </Pressable>
    </Modal>
  );
}

function Tile({ label, width, selected, locked = false, onPress, children }: {
  label: string;
  width: number;
  selected: boolean;
  locked?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { width }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={locked ? `${label}, needs Peekaboo+` : label}>
      <View style={[styles.preview, { height: Math.round(width * 1.33) }, selected && styles.previewSelected]}>
        {children}
        {locked ? (
          <View style={styles.lock}>
            <Text style={styles.lockText}>⭐ Peekaboo+</Text>
          </View>
        ) : null}
        {selected ? (
          <View style={styles.check}>
            <Ionicons name="checkmark" size={14} color={colors.onAccent} />
          </View>
        ) : null}
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.overlay,
  },
  sheet: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 520,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
  },
  title: {
    ...font.heading,
    fontSize: 18,
    textAlign: 'center',
  },
  message: {
    ...font.small,
    textAlign: 'center',
    marginTop: space.xs,
    marginBottom: space.md,
  },
  scroll: {
    maxHeight: 460,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
    paddingBottom: space.sm,
  },
  tile: {
    gap: space.xs,
  },
  preview: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.bg,
    borderWidth: 2,
    borderColor: colors.border,
    justifyContent: 'flex-end',
    padding: 8,
    gap: 4,
  },
  previewSelected: {
    borderColor: colors.accent,
    borderWidth: 3,
  },
  none: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Two tiny pretend messages, so you can see how bubbles look on it.
  bubble: {
    height: 10,
    borderRadius: 5,
  },
  bubbleThem: {
    width: '60%',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  bubbleMe: {
    width: '45%',
    alignSelf: 'flex-end',
    backgroundColor: colors.purple,
  },
  lock: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    alignItems: 'center',
  },
  lockText: {
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: colors.white,
    fontSize: 10,
    fontWeight: '800',
  },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  label: {
    ...font.small,
    fontWeight: '700',
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.75,
  },
  cancel: {
    alignItems: 'center',
    paddingVertical: space.md,
    marginTop: space.xs,
  },
  cancelText: {
    ...font.body,
    fontWeight: '800',
    color: colors.textMuted,
  },
});
