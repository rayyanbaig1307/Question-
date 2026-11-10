import * as Haptics from 'expo-haptics';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { colors, font, space } from '@/theme';

// Like Instagram: tap (or press and hold) someone's profile picture and it pops up big in the middle of the
// screen, over a dark background. Tap anywhere to close it.
export function ProfilePhotoZoom({ person, visible, onClose }: {
  person: { avatar_path?: string | null; display_name?: string | null; username?: string | null } | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  // Big, but with some room around it on every phone.
  const size = Math.min(width - space.xl * 2, 340);
  const name = person?.display_name || person?.username;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the photo">
        {visible ? (
          <>
            <Animated.View entering={FadeIn.duration(150)} style={StyleSheet.absoluteFill}>
              <Pressable style={[StyleSheet.absoluteFill, styles.dim]} onPress={onClose} />
            </Animated.View>
            <Animated.View entering={ZoomIn.springify().damping(14).stiffness(180)} pointerEvents="none">
              <Avatar path={person?.avatar_path} name={name} size={size} />
            </Animated.View>
            {name ? (
              <Animated.View entering={FadeIn.delay(120)} pointerEvents="none">
                <Text style={styles.name}>{name}</Text>
              </Animated.View>
            ) : null}
          </>
        ) : null}
      </Pressable>
    </Modal>
  );
}

// A little buzz when the photo pops up.
export function zoomBuzz() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  dim: {
    backgroundColor: 'rgba(0,0,0,0.82)',
  },
  name: {
    ...font.heading,
    color: colors.white,
    textAlign: 'center',
  },
});
