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
  const { showToast } = useOverlays();

  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [isPrivate, setIsPrivate] = useState(profile?.is_private ?? false);
  const [newPhoto, setNewPhoto] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickPhoto() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]) setNewPhoto(result.assets[0].uri);
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
      if (newPhoto) {
        avatarPath = await uploadAvatar(userId, await resizePhoto(newPhoto, 512));
      }
      const updated = await updateMyProfile(userId, {
        display_name: displayName.trim(),
        username,
        bio: bio.trim(),
        is_private: isPrivate,
        avatar_path: avatarPath,
      });
      // Clean up the old picture once the new one is saved.
      if (newPhoto && profile.avatar_path) deleteAvatar(profile.avatar_path).catch(() => {});
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
      <Pressable style={styles.photo} onPress={pickPhoto} accessibilityLabel="Change profile picture">
        <Avatar
          path={profile?.avatar_path}
          localUri={newPhoto}
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
