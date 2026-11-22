import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { KeyboardSafeView } from '@/components/KeyboardSafeView';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { fetchMyBirthday } from '@/lib/birthday';
import { friendlyError } from '@/lib/errors';
import { inviteFriends, isAdultBirthday, normalizeInviteCode, resetInviteCode } from '@/lib/invite';
import { colors, font, radius, space } from '@/theme';

// "Invite friends": your username and a button that shares it with the App Store link (that's all an invite is
// now). Below: a box for a code from an invite link a friend sent before, and a way to turn off an invite link you
// sent before.
export default function InviteFriendsScreen() {
  const { userId, profile } = useMe();
  const { showToast } = useOverlays();
  const [resetting, setResetting] = useState(false);
  // Your birthday, once it's loaded ({ value: null } = you haven't added one).
  const [birthday, setBirthday] = useState<{ value: string | null } | null>(null);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    fetchMyBirthday(userId)
      .then((value) => active.current && setBirthday({ value }))
      .catch(() => {});
  }, [userId]);

  function confirmReset() {
    Alert.alert(
      'Turn off your old invite link?',
      'An invite link you sent before stops working straight away. Friends you already have stay your friends.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn it off', style: 'destructive', onPress: reset },
      ],
    );
  }

  async function reset() {
    if (!active.current || resetting) return;
    setResetting(true);
    try {
      await resetInviteCode(userId);
      if (active.current) showToast("Done ✨ Your old invite link doesn't work any more");
    } catch (error) {
      if (active.current) Alert.alert("Couldn't turn it off", friendlyError(error));
    } finally {
      if (active.current) setResetting(false);
    }
  }

  function openTypedCode() {
    const friendCode = normalizeInviteCode(typed);
    if (!friendCode) {
      setTypedError("That doesn't look like an invite code. Codes have 10 letters and numbers.");
      return;
    }
    setTypedError(null);
    router.push(`/invite/${friendCode}`);
  }

  // Who can add you once they search your username. Only you see this.
  const whoCanAdd =
    profile && birthday
      ? !profile.is_private && isAdultBirthday(birthday.value)
        ? 'Anyone who searches your username can add you as a friend – only share it with people you know.'
        : 'People who search your username send you a friend request.'
      : null;

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Invite friends" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <KeyboardSafeView style={styles.fill}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.label}>Your username</Text>
            {profile?.username ? (
              <Text style={styles.username} selectable>
                @{profile.username}
              </Text>
            ) : null}
            <Text style={styles.note}>
              Friends get the Peekaboo App Store link and your username. Once they have the app, they search your
              username and add you.
            </Text>
          </View>

          {whoCanAdd ? <Text style={styles.note}>{whoCanAdd}</Text> : null}

          <Button title="Invite friends" icon="share-outline" onPress={() => inviteFriends(profile?.username)} />

          <View style={styles.friendCode}>
            <TextField
              label="Got a code from a friend?"
              value={typed}
              onChangeText={(text) => {
                setTyped(text);
                if (typedError) setTypedError(null);
              }}
              placeholder="Type their code"
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={openTypedCode}
              error={typedError}
            />
            <Button title="Open invite" icon="person-add" variant="secondary" disabled={!typed.trim()} onPress={openTypedCode} />
          </View>

          <Button
            title="Turn off my old invite link"
            icon="close-circle-outline"
            variant="secondary"
            small
            loading={resetting}
            onPress={confirmReset}
          />
          <Text style={styles.small}>Sent an invite link to the wrong people before? This stops it working.</Text>
        </ScrollView>
      </KeyboardSafeView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    alignItems: 'center',
  },
  label: {
    ...font.label,
    textTransform: 'uppercase',
  },
  username: {
    ...font.title,
    textAlign: 'center',
  },
  note: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  small: {
    ...font.small,
    textAlign: 'center',
  },
  friendCode: {
    marginTop: space.lg,
    gap: space.sm,
  },
});
