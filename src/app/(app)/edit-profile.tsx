import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { FormScreen } from '@/components/FormScreen';
import { useOverlays } from '@/components/Overlays';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { deleteAvatar, resizePhoto, uploadAvatar } from '@/lib/media';
import {
  checkUsernameFormat,
  cleanUsername,
  isUsernameAvailable,
  updateMyProfile,
  USERNAME_RULES,
} from '@/lib/profiles';
import { colors, font, radius, space } from '@/theme';

const BIO_LIMIT = 160;

export default function EditProfile() {
  const { userId, profile, setProfile } = useMe();
  const { showToast, showOptions } = useOverlays();

  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [isPrivate, setIsPrivate] = useState(profile?.is_private ?? false);
  // 'keep' = leave the picture as it is; otherwise a new photo from the phone, or no photo at all.
  const [photo, setPhoto] = useState<{ kind: 'keep' } | { kind: 'new'; uri: string } | { kind: 'remove' }>({ kind: 'keep' });
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasPhoto = photo.kind === 'new' || (photo.kind === 'keep' && !!profile?.avatar_path);

  function changePhoto() {
    showOptions({
      title: 'Profile picture',
      options: [
        { label: '📸 Take a photo', onPress: takePhoto },
        { label: '🖼️ Choose from camera roll', onPress: choosePhoto },
        ...(hasPhoto ? [{ label: 'Remove photo', destructive: true, onPress: () => setPhoto({ kind: 'remove' }) }] : []),
      ],
    });
  }

  // Both open a square crop box, so the picture fits the circle nicely.
  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera is off', 'Allow camera access for Peekaboo in your phone settings to take a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
      cameraType: ImagePicker.CameraType.front,
    });
    if (!result.canceled && result.assets[0]) setPhoto({ kind: 'new', uri: result.assets[0].uri });
  }

  async function choosePhoto() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]) setPhoto({ kind: 'new', uri: result.assets[0].uri });
  }

  async function save() {
    if (!profile) return;
    const formatError = checkUsernameFormat(username);
    if (formatError) {
      setUsernameError(formatError);
      return;
    }
    setBusy(true);
    setUsernameError(null);
    try {
      if (username !== profile.username && !(await isUsernameAvailable(username))) {
        setUsernameError('Taken! Try another one.');
        return;
      }
      let avatarPath = profile.avatar_path;
      if (photo.kind === 'new') avatarPath = await uploadAvatar(userId, await resizePhoto(photo.uri, 512));
      if (photo.kind === 'remove') avatarPath = null;
      const updated = await updateMyProfile(userId, {
        display_name: displayName.trim(),
        username,
        bio: bio.trim(),
        is_private: isPrivate,
        avatar_path: avatarPath,
      });
      // Clean up the old picture once the new one is saved.
      if (photo.kind !== 'keep' && profile.avatar_path) deleteAvatar(profile.avatar_path).catch(() => {});
      // Updating the saved profile makes the new picture show up everywhere in the app right away.
      setProfile(updated);
      showToast('Profile saved ✨');
      router.back();
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormScreen title="Edit profile">
      <Pressable style={styles.photo} onPress={changePhoto} accessibilityLabel="Change profile picture">
        <Avatar
          path={photo.kind === 'keep' ? profile?.avatar_path : null}
          localUri={photo.kind === 'new' ? photo.uri : null}
          name={displayName || username}
          size={112}
          ring
        />
        <Text style={styles.photoText}>Change photo</Text>
      </Pressable>

      <TextField label="Name" value={displayName} onChangeText={setDisplayName} maxLength={40} placeholder="Your name" />
      <TextField
        label="Username"
        prefix="@"
        value={username}
        onChangeText={(text) => {
          setUsername(cleanUsername(text));
          setUsernameError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        error={usernameError}
        hint={USERNAME_RULES}
      />
      <TextField
        label="Bio"
        value={bio}
        onChangeText={setBio}
        maxLength={BIO_LIMIT}
        multiline
        placeholder="Say something fun about yourself ✌️"
        hint={`${bio.length}/${BIO_LIMIT}`}
      />

      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchTitle}>🔒 Private account</Text>
          <Text style={styles.switchHint}>Only your friends can see your posts.</Text>
        </View>
        <Switch
          value={isPrivate}
          onValueChange={setIsPrivate}
          trackColor={{ true: colors.pink, false: colors.border }}
          thumbColor={colors.white}
        />
      </View>

      <Button title="Save" icon="checkmark" onPress={save} loading={busy} style={styles.save} />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  photo: {
    alignItems: 'center',
    gap: space.sm,
  },
  photoText: {
    color: colors.accent,
    fontWeight: '800',
    fontSize: 15,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.lg,
    borderRadius: radius.md,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  switchTitle: {
    ...font.body,
    fontWeight: '800',
  },
  switchHint: {
    ...font.small,
  },
  save: {
    marginTop: space.sm,
  },
});
