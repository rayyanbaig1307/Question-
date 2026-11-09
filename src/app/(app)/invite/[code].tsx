import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import {
  acceptInvite,
  clearPendingInvite,
  INVITE_GONE,
  isInviteGone,
  normalizeInviteCode,
  previewInvite,
  type InvitePerson,
  type InviteResult,
} from '@/lib/invite';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';

type Shown =
  | { kind: 'loading' }
  // Couldn't ask the server (no internet?): offer "Try again".
  | { kind: 'failed' }
  // Wrong code, a new link was made, the account is gone, or a block – all look the same on purpose.
  | { kind: 'gone' }
  | { kind: 'own' }
  | { kind: 'ready'; person: InvitePerson };

// Someone's invite link opened in the app: who it's from, and "Add <name>". Nothing happens until you tap.
export default function OpenInvite() {
  const params = useLocalSearchParams<{ code?: string | string[] }>();
  const code = normalizeInviteCode(Array.isArray(params.code) ? params.code[0] : params.code);
  const { userId } = useMe();
  const { showToast, showOptions } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const [shown, setShown] = useState<Shown>(code ? { kind: 'loading' } : { kind: 'gone' });
  const [adding, setAdding] = useState(false);
  const active = useRef(true);
  // You saw who the invite is from: leaving the screen now counts as "dealt with".
  const seen = useRef(false);

  // The invite saved on this phone (if it's this one) is done: don't open it again later.
  const done = useCallback(() => {
    if (code) clearPendingInvite(code).catch(() => {});
  }, [code]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (seen.current) done();
    };
  }, [done]);

  const load = useCallback(() => {
    if (!code) return;
    previewInvite(code)
      .then((person) => {
        if (!active.current) return;
        if (!person) {
          setShown({ kind: 'gone' });
          done();
        } else if (person.id === userId) {
          setShown({ kind: 'own' });
          done();
        } else {
          seen.current = true;
          setShown({ kind: 'ready', person });
        }
      })
      .catch((error) => {
        if (!active.current) return;
        if (isInviteGone(error)) {
          setShown({ kind: 'gone' });
          done();
        } else {
          console.warn('Could not load the invite', error);
          setShown({ kind: 'failed' });
        }
      });
  }, [code, userId, done]);

  useEffect(() => {
    load();
  }, [load]);

  function retry() {
    setShown({ kind: 'loading' });
    load();
  }

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

  function notNow() {
    done();
    leave();
  }

  async function add(person: InvitePerson) {
    if (!code || adding) return;
    setAdding(true);
    try {
      const result = await acceptInvite(code, userId);
      done();
      if (!active.current) return;
      showToast(resultText(result, person));
      leave();
    } catch (error) {
      if (!active.current) return;
      if (isInviteGone(error)) {
        done();
        setShown({ kind: 'gone' });
      } else {
        Alert.alert('Oops', friendlyError(error));
      }
    } finally {
      if (active.current) setAdding(false);
    }
  }

  // After a block from here, this invite is finished too.
  function afterBlock() {
    done();
    leave();
  }

  function openMenu(person: InvitePerson) {
    showOptions({
      title: `@${person.username}`,
      options: [
        {
          label: 'Report profile',
          onPress: () => report({ user: person, contentType: 'user', contentId: person.id, onBlocked: afterBlock }),
        },
        { label: 'Block', destructive: true, onPress: () => confirmBlock(person, afterBlock) },
      ],
    });
  }

  const person = shown.kind === 'ready' ? shown.person : null;
  const name = person ? person.display_name || person.username : '';

  return (
    <View style={styles.fill}>
      <ScreenHeader
        title="Invite"
        onBack={leave}
        right={person ? <RoundIconButton icon="ellipsis-horizontal" label="More" onPress={() => openMenu(person)} /> : null}
      />
      {shown.kind === 'loading' ? (
        <ActivityIndicator color={colors.accent} size="large" style={styles.loading} />
      ) : shown.kind === 'failed' ? (
        <EmptyState emoji="📡" title="Couldn't load the invite – check your internet and try again">
          <Button title="Try again" icon="refresh" onPress={retry} />
        </EmptyState>
      ) : shown.kind === 'gone' ? (
        <EmptyState emoji="🔗" title={INVITE_GONE} message="Ask your friend to send you their link again.">
          <Button title="OK" variant="secondary" onPress={leave} />
        </EmptyState>
      ) : shown.kind === 'own' ? (
        <EmptyState emoji="😄" title="That's your own invite 😄" message="Send it to your friends so they can add you.">
          <Button title="OK" variant="secondary" onPress={leave} />
        </EmptyState>
      ) : person ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Avatar path={person.avatar_path} name={name} size={112} ring />
          <View style={styles.names}>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.username}>@{person.username}</Text>
          </View>
          <Text style={styles.invited}>{name} invited you to Peekaboo 👀</Text>
          <Text style={styles.careful}>Only add people you know in real life.</Text>
          <View style={styles.buttons}>
            <Button title={`Add ${name}`} icon="person-add" loading={adding} onPress={() => add(person)} />
            <Button title="Not now" variant="plain" disabled={adding} onPress={notNow} />
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

function resultText(result: InviteResult, person: InvitePerson): string {
  switch (result) {
    case 'friends':
      return `You and @${person.username} are friends! 🎉`;
    case 'already':
      return "You're already friends 🙌";
    case 'self':
      return "That's your own invite 😄";
    default:
      return 'Friend request sent 💌';
  }
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xxl,
  },
  content: {
    padding: space.xl,
    gap: space.lg,
    alignItems: 'center',
  },
  names: {
    alignItems: 'center',
    gap: space.xs,
  },
  name: {
    ...font.title,
    textAlign: 'center',
  },
  username: {
    ...font.body,
    color: colors.textMuted,
  },
  invited: {
    ...font.heading,
    textAlign: 'center',
  },
  careful: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  buttons: {
    alignSelf: 'stretch',
    gap: space.sm,
    marginTop: space.md,
  },
});
