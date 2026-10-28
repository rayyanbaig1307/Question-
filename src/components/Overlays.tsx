import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, font, radius, space } from '@/theme';

export type SheetOption = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

type SheetRequest = { title?: string; message?: string; options: SheetOption[]; onClose?: () => void };

type OverlayContextValue = {
  showToast: (message: string) => void;
  showOptions: (request: SheetRequest) => void;
};

const OverlayContext = createContext<OverlayContextValue | null>(null);

// Little pop-up messages ("toasts") and bottom menus, usable from any screen.
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showOptions = useCallback((request: SheetRequest) => setSheet(request), []);

  const closeSheet = () => {
    sheet?.onClose?.();
    setSheet(null);
  };

  const choose = (option: SheetOption) => {
    closeSheet();
    // Let the menu close before running the action (which may open another menu).
    setTimeout(option.onPress, 250);
  };

  return (
    <OverlayContext.Provider value={{ showToast, showOptions }}>
      {children}

      {toast && (
        <SafeAreaView edges={['top']} style={styles.toastWrap} pointerEvents="none">
          <Animated.View key={toast.id} entering={FadeInUp} exiting={FadeOutUp} style={styles.toast}>
            <Text style={styles.toastText}>{toast.message}</Text>
          </Animated.View>
        </SafeAreaView>
      )}

      <Modal visible={sheet !== null} transparent animationType="fade" onRequestClose={closeSheet}>
        <Pressable style={styles.backdrop} onPress={closeSheet}>
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            <Pressable>
              {sheet?.title ? <Text style={styles.sheetTitle}>{sheet.title}</Text> : null}
              {sheet?.message ? <Text style={styles.sheetMessage}>{sheet.message}</Text> : null}
              {sheet?.options.map((option) => (
                <Pressable
                  key={option.label}
                  onPress={() => choose(option)}
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}>
                  <Text style={[styles.optionText, option.destructive && styles.destructive]}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                onPress={closeSheet}
                style={({ pressed }) => [styles.option, styles.cancel, pressed && styles.optionPressed]}>
                <Text style={[styles.optionText, styles.cancelText]}>Cancel</Text>
              </Pressable>
            </Pressable>
          </SafeAreaView>
        </Pressable>
      </Modal>
    </OverlayContext.Provider>
  );
}

export function useOverlays(): OverlayContextValue {
  const value = useContext(OverlayContext);
  if (!value) throw new Error('useOverlays must be used inside <OverlayProvider>');
  return value;
}

const styles = StyleSheet.create({
  toastWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  toast: {
    marginTop: space.sm,
    backgroundColor: colors.yellow,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    maxWidth: '90%',
    boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
  },
  toastText: {
    color: colors.black,
    fontWeight: '800',
    fontSize: 15,
    textAlign: 'center',
  },
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlayStrong,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  sheetTitle: {
    ...font.heading,
    textAlign: 'center',
    marginBottom: space.xs,
  },
  sheetMessage: {
    ...font.small,
    textAlign: 'center',
    marginBottom: space.md,
  },
  option: {
    paddingVertical: space.lg,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  optionPressed: {
    backgroundColor: colors.cardPressed,
  },
  optionText: {
    ...font.body,
    fontWeight: '700',
  },
  destructive: {
    color: colors.red,
  },
  cancel: {
    marginTop: space.sm,
    backgroundColor: colors.card,
  },
  cancelText: {
    color: colors.textMuted,
  },
});
