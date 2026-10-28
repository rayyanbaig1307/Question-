import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { friendlyError } from '@/lib/errors';
import { removeFriendLink, respondToRequest, sendFriendRequest, type Relation } from '@/lib/friends';

// "Add friend" / "Requested" / "Accept" / "Friends ✓" – whatever fits, and what happens when you tap it.
export function FriendButton({ person, relation, onChanged, small }: {
  person: { id: string; username: string };
  relation: Relation;
  onChanged: () => void;
  small?: boolean;
}) {
  const { showOptions, showToast } = useOverlays();
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (error) {
      Alert.alert('Oops', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  if (relation.kind === 'none') {
    return (
      <Button
        title={small ? 'Add' : 'Add friend'}
        icon="person-add"
        small={small}
        loading={busy}
        onPress={() =>
          run(async () => {
            const result = await sendFriendRequest(person.id);
            showToast(result === 'accepted' ? `You and @${person.username} are friends! 🎉` : 'Friend request sent 💌');
          })
        }
      />
    );
  }

  if (relation.kind === 'sent') {
    return (
      <Button
        title="Requested"
        icon="time-outline"
        variant="secondary"
        small={small}
        loading={busy}
        onPress={() =>
          showOptions({
            title: `Cancel your request to @${person.username}?`,
            options: [
              {
                label: 'Cancel request',
                destructive: true,
                onPress: () =>
                  run(async () => {
                    await removeFriendLink(relation.linkId);
                    showToast('Request canceled');
                  }),
              },
            ],
          })
        }
      />
    );
  }

  if (relation.kind === 'received') {
    return (
      <View style={styles.row}>
        <Button
          title="Accept"
          icon="checkmark"
          small={small}
          loading={busy}
          style={small ? undefined : styles.grow}
          onPress={() =>
            run(async () => {
              await respondToRequest(relation.linkId, true);
              showToast(`You and @${person.username} are friends! 🎉`);
            })
          }
        />
        <Button
          title={small ? '✕' : 'Decline'}
          variant="secondary"
          small={small}
          disabled={busy}
          style={small ? undefined : styles.grow}
          onPress={() =>
            run(async () => {
              await respondToRequest(relation.linkId, false);
              showToast('Request declined');
            })
          }
        />
      </View>
    );
  }

  return (
    <Button
      title="Friends"
      icon="checkmark-circle"
      variant="secondary"
      small={small}
      loading={busy}
      onPress={() =>
        showOptions({
          title: `@${person.username}`,
          options: [
            {
              label: 'Unfriend',
              destructive: true,
              onPress: () =>
                run(async () => {
                  await removeFriendLink(relation.linkId);
                  showToast(`Unfriended @${person.username}`);
                }),
            },
          ],
        })
      }
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  grow: {
    flex: 1,
  },
});
