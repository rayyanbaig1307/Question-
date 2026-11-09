import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { KeyboardSafeView } from '@/components/KeyboardSafeView';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import { fetchMyBirthday } from '@/lib/birthday';
import { friendlyError } from '@/lib/errors';
import {
  fetchMyInviteCode,
  formatInviteCode,
  inviteLink,
  isAdultBirthday,
  normalizeInviteCode,
  resetInviteCode,
  shareInviteLink,
} from '@/lib/invite';
import { colors, font, radius, space } from '@/theme';

// "Your invite link": your personal link to share, a way to swap it for a new one, and a box for a code a
// friend gave you.
export default function YourInviteLink() {
  const { userId, profile } = useMe();
  const { showToast } = useOverlays();
  // Your code: null while loading.
  const [code, setCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Your birthday, once it's loaded ({ value: null } = you haven't added one).
  const [birthday, setBirthday] = useState<{ value: string | null } | null>(null);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const active = useRef(true);
  const sharing = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const loadCode = useCallback(() => {
    fetchMyInviteCode(userId)
      .then((loaded) => {
        if (!active.current) return;
        setCode(loaded);
        setFailed(false);
      })
      .catch((error) => {
        console.warn('Could not load your invite link', error);
        if (active.current) setFailed(true);
      });
  }, [userId]);

  useEffect(() => {
    loadCode();
  }, [loadCode]);

  useEffect(() => {
    fetchMyBirthday(userId)
      .then((value) => active.current && setBirthday({ value }))
      .catch(() => {});
  }, [userId]);

  function retry() {
    setFailed(false);
    loadCode();
  }

  async function share() {
    if (!code || sharing.current) return;
    sharing.current = true;
    try {
      await shareInviteLink(code);
    } finally {
      sharing.current = false;
    }
  }

  function confirmReset() {
    Alert.alert(
      'Get a new link?',
      'Your old link and code stop working straight away. Friends you already have stay your friends.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Get a new link', style: 'destructive', onPress: reset },
      ],
    );
  }

  async function reset() {
    if (!active.current || resetting) return;
    setResetting(true);
    try {
      const fresh = await resetInviteCode(userId);
      if (!active.current) return;
      setCode(fresh);
      setFailed(false);
      showToast("New link ready ✨ The old one doesn't work any more");
    } catch (error) {
      if (active.current) Alert.alert('Could not get a new link', friendlyError(error));
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

  // Who can use your link to add you – the same rule as adding you by username. Only you see this.
  const whoCanAdd =
    profile && birthday
      ? !profile.is_private && isAdultBirthday(birthday.value)
        ? 'Anyone with this link can add you as a friend – only share it with people you know.'
        : 'People who use your link send you a friend request.'
      : null;

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Invite friends" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <KeyboardSafeView style={styles.fill}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.label}>Your invite link</Text>
            {code ? (
              <>
                <Text style={styles.link} selectable>
                  {inviteLink(code)}
                </Text>
                <Text style={styles.code} selectable accessibilityLabel={`Your code: ${code.split('').join(' ')}`}>
                  {formatInviteCode(code)}
                </Text>
              </>
            ) : failed ? (
              <>
                <Text style={styles.note}>Couldn&apos;t load your link – check your internet and try again.</Text>
                <Button title="Try again" icon="refresh" variant="secondary" small onPress={retry} />
              </>
            ) : (
              <ActivityIndicator color={colors.accent} style={styles.loading} />
            )}
          </View>

          {whoCanAdd ? <Text style={styles.note}>{whoCanAdd}</Text> : null}

          <Button title="Share my link" icon="share-outline" disabled={!code} onPress={share} />
          <Button
            title="Get a new link"
            icon="refresh"
            variant="secondary"
            disabled={!code}
            loading={resetting}
            onPress={confirmReset}
          />
          <Text style={styles.small}>Shared it with the wrong people? Get a new link – the old one stops working.</Text>

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
  link: {
    ...font.body,
    color: colors.accent,
    textAlign: 'center',
  },
  code: {
    ...font.title,
    letterSpacing: 3,
    textAlign: 'center',
  },
  loading: {
    marginVertical: space.lg,
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
