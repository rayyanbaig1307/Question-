import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState, type ComponentRef } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';

import { DraggableItem, type TrashZone } from '@/components/editor/DraggableItem';
import { StickerPicker } from '@/components/editor/StickerPicker';
import { randomOffset, TEXT_COLORS, type OverlayItem } from '@/components/editor/stickers';
import { TextComposer, type TextDraft } from '@/components/editor/TextComposer';
import { IconButton } from '@/components/IconButton';
import { friendlyError } from '@/lib/errors';
import { colors, radius, space } from '@/theme';

const WORD_COLORS = [colors.pink, colors.purple, colors.blue, colors.yellow, colors.green, colors.orange];

// Decorate your photo: add text and stickers, move them around, then send it.
export default function Editor() {
  const { uri, fit, to } = useLocalSearchParams<{ uri: string; fit?: 'cover' | 'contain'; to?: string }>();
  const { width, height } = useWindowDimensions();
  const canvasRef = useRef<ComponentRef<typeof View>>(null);

  const [items, setItems] = useState<OverlayItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [composer, setComposer] = useState<{ editingId: string | null; draft: TextDraft } | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const trash: TrashZone = { top: height - 150, left: width / 2 - 70, right: width / 2 + 70 };

  function addItem(item: Omit<OverlayItem, 'id' | 'startX' | 'startY'>) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setItems((current) => [
      ...current,
      { ...item, id: randomUUID(), startX: randomOffset(width * 0.4), startY: randomOffset(height * 0.3) },
    ]);
  }

  function removeItem(id: string) {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setItems((current) => current.filter((item) => item.id !== id));
  }

  function editItem(id: string) {
    const item = items.find((entry) => entry.id === id);
    if (item?.kind === 'text') {
      setComposer({ editingId: id, draft: { content: item.content, color: item.color, look: item.look } });
    }
  }

  function finishText(draft: TextDraft) {
    const editingId = composer?.editingId;
    setComposer(null);
    if (editingId) {
      setItems((current) =>
        draft.content
          ? current.map((item) => (item.id === editingId ? { ...item, ...draft } : item))
          : current.filter((item) => item.id !== editingId),
      );
    } else if (draft.content) {
      addItem({ kind: 'text', ...draft });
    }
  }

  function close() {
    if (items.length === 0) {
      router.back();
      return;
    }
    Alert.alert('Throw this photo away?', undefined, [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Throw away', style: 'destructive', onPress: () => router.back() },
    ]);
  }

  async function next() {
    setBusy(true);
    try {
      // Take a "screenshot" of the photo with all the text and stickers on it.
      const finished = await captureRef(canvasRef, { format: 'jpg', quality: 0.9, result: 'tmpfile' });
      router.push({ pathname: '/share', params: to ? { uri: finished, to } : { uri: finished } });
    } catch (error) {
      Alert.alert('Could not save the photo', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.fill}>
      <View ref={canvasRef} collapsable={false} style={styles.canvas}>
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode={fit === 'contain' ? 'contain' : 'cover'} />
        {items.map((item) => (
          <DraggableItem
            key={item.id}
            item={item}
            trash={trash}
            onDragChange={setDragging}
            onDelete={removeItem}
            onTap={editItem}
          />
        ))}
      </View>

      {!dragging && !composer ? (
        <>
          <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
            <IconButton icon="close" label="Close" onPress={close} />
            <View style={styles.tools}>
              <IconButton
                icon="text"
                label="Add text"
                onPress={() =>
                  setComposer({ editingId: null, draft: { content: '', color: TEXT_COLORS[0], look: 'shadow' } })
                }
              />
              <IconButton icon="happy-outline" label="Add sticker" onPress={() => setStickersOpen(true)} />
              {items.length > 0 ? (
                <IconButton icon="arrow-undo" label="Undo" onPress={() => setItems((current) => current.slice(0, -1))} />
              ) : null}
            </View>
          </SafeAreaView>

          <SafeAreaView edges={['bottom']} style={styles.bottom} pointerEvents="box-none">
            {items.length === 0 ? (
              <Text style={styles.hint}>Add text or stickers, or just send it!</Text>
            ) : (
              <Text style={styles.hint}>Drag to move · pinch to resize · drop on 🗑️ to remove</Text>
            )}
            <Pressable
              onPress={next}
              disabled={busy}
              style={({ pressed }) => [styles.send, (pressed || busy) && styles.sendPressed]}
              accessibilityRole="button">
              <Text style={styles.sendText}>{busy ? 'Saving…' : 'Send to'}</Text>
              <Ionicons name="send" size={18} color={colors.black} />
            </Pressable>
          </SafeAreaView>
        </>
      ) : null}

      {dragging ? (
        <View style={[styles.trash, { top: trash.top + 20, left: width / 2 - 36 }]} pointerEvents="none">
          <Ionicons name="trash" size={30} color={colors.white} />
        </View>
      ) : null}

      {composer ? <TextComposer initial={composer.draft} onDone={finishText} /> : null}

      <StickerPicker
        visible={stickersOpen}
        onClose={() => setStickersOpen(false)}
        onPickEmoji={(emoji) => {
          setStickersOpen(false);
          addItem({ kind: 'sticker', content: emoji, color: colors.white, look: 'shadow' });
        }}
        onPickWord={(word) => {
          setStickersOpen(false);
          const color = WORD_COLORS[Math.floor(Math.random() * WORD_COLORS.length)];
          addItem({ kind: 'text', content: word, color, look: 'pill' });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  canvas: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.black,
    overflow: 'hidden',
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  tools: {
    gap: space.md,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'flex-end',
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.md,
  },
  hint: {
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '700',
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
  send: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.yellow,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill,
  },
  sendPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.97 }],
  },
  sendText: {
    color: colors.black,
    fontWeight: '900',
    fontSize: 17,
  },
  trash: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,77,94,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
