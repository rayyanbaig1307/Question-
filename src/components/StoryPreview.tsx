import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { SafeEdge } from '@/components/SafeEdge';
import { VideoClip } from '@/components/VideoClipSafe';
import type { Audience } from '@/lib/types';
import { colors, radius, space } from '@/theme';

// Before something goes on your story: full screen, just like your friends will see it.
// "Edit" goes back to the editor (your text and stickers are still there); "Share to story" posts it.
export function StoryPreview({ visible, uri, isVideo, overlayUri, audience, avatarPath, name, busy, onEdit, onShare, onClose }: {
  visible: boolean;
  uri: string;
  isVideo: boolean;
  overlayUri?: string | null;
  audience: Audience;
  avatarPath?: string | null;
  name: string;
  busy: boolean;
  onEdit: () => void;
  onShare: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.fill}>
        {isVideo ? (
          <VideoClip uri={uri} overlayUri={overlayUri} playing={visible} muted={false} loop style={StyleSheet.absoluteFill} />
        ) : (
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        )}

        <SafeEdge edge="top" style={styles.top} pointerEvents="box-none">
          <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent']} style={StyleSheet.absoluteFill} pointerEvents="none" />
          <View style={styles.bar} />
          <View style={styles.header}>
            <Avatar path={avatarPath} name={name} size={36} />
            <Text style={styles.title}>My Story</Text>
            <Text style={styles.now}>now</Text>
            {audience === 'close_friends' ? <Text style={styles.closeTag}>⭐ Close friends</Text> : null}
            <View style={styles.spacer} />
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close preview">
              <Ionicons name="close" size={28} color={colors.white} />
            </Pressable>
          </View>
        </SafeEdge>

        <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.6)']} style={StyleSheet.absoluteFill} pointerEvents="none" />
          <Text style={styles.hint}>This is how your story will look</Text>
          <View style={styles.buttons}>
            <Bouncy style={[styles.button, styles.edit]} pressScale={0.92} onPress={onEdit} accessibilityRole="button" accessibilityLabel="Edit">
              <Ionicons name="pencil" size={18} color={colors.white} />
              <Text style={styles.buttonText}>Edit</Text>
            </Bouncy>
            <Bouncy
              style={[styles.button, styles.share, busy && styles.busy]}
              pressScale={0.92}
              onPress={busy ? undefined : onShare}
              accessibilityRole="button"
              accessibilityLabel="Share to story">
              <Text style={[styles.buttonText, styles.shareText]}>{busy ? 'Sharing…' : 'Share to story'}</Text>
              <Ionicons name="send" size={16} color={colors.onAccent} />
            </Bouncy>
          </View>
        </SafeEdge>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    paddingBottom: space.lg,
    gap: space.sm,
  },
  bar: {
    height: 3,
    borderRadius: 2,
    marginTop: space.sm,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 15,
  },
  now: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    fontWeight: '600',
  },
  closeTag: {
    overflow: 'hidden',
    color: colors.white,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.green,
  },
  spacer: {
    flex: 1,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.lg,
    gap: space.md,
  },
  hint: {
    color: colors.white,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  buttons: {
    flexDirection: 'row',
    gap: space.sm,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 52,
    borderRadius: radius.pill,
  },
  edit: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  share: {
    flex: 1.6,
    backgroundColor: colors.accent,
  },
  busy: {
    opacity: 0.7,
  },
  buttonText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 16,
  },
  shareText: {
    color: colors.onAccent,
  },
});
