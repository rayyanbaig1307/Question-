import { router } from 'expo-router';
import { Alert } from 'react-native';

import type { SheetOption } from '@/components/Overlays';
import { friendlyError } from '@/lib/errors';
import { aloneInGroup, canDeleteGroup, deleteGroup, groupMaker, leaveGroup, type PeekGroup } from '@/lib/groups';

// 🚪 Leave / 🗑️ Delete for a group's ⋯ menus (the group chat and the Group Peek screen), with the same plain words
// in both places:
// - the person who made the group can delete it any time, for everyone (if they left, whoever has been in it
//   longest counts as the maker);
// - anyone who is the only person left can delete it;
// - everyone else can leave (when the last person leaves, the group is deleted; when the maker leaves, whoever has
//   been in it longest takes over – the server does both).
// After either one you land on the Chat list (the group isn't there any more for you).
export function leaveOrDeleteOptions(
  group: PeekGroup,
  me: string,
  showToast: (message: string) => void,
): SheetOption[] {
  const alone = aloneInGroup(group, me);
  const options: SheetOption[] = [];
  if (!alone && group.members.some((member) => member.userId === me)) {
    options.push({ label: '🚪 Leave group', destructive: true, onPress: () => confirmLeave(group, me, showToast) });
  }
  if (canDeleteGroup(group, me)) {
    options.push({ label: '🗑️ Delete group', destructive: true, onPress: () => confirmDelete(group, alone, showToast) });
  }
  return options;
}

// Back to the Chat list (the group is gone for you, so its screens would only say "This group is gone").
function backToChats() {
  router.dismissTo({ pathname: '/', params: { page: 'chat' } });
}

export const DELETE_GROUP_WORDS = {
  everyone:
    "This deletes the group and its chat for everyone in it – all the messages, photos, videos, voice notes, dares and Guess Whos. Nobody's own posts or drops are deleted. You can't undo this.",
  alone:
    "You're the only one left in this group. Deleting it removes the group and its whole chat – messages, photos, videos and voice notes. You can't undo this.",
};

export function leaveGroupWords(group: PeekGroup, me: string): string {
  const base = "You won't see this group or its chat any more, and your drops won't wait for this group. Your messages stay in the chat.";
  return groupMaker(group) === me ? `${base} You're in charge of this group, so whoever has been in it the longest takes over.` : base;
}

function confirmDelete(group: PeekGroup, alone: boolean, showToast: (message: string) => void) {
  Alert.alert(`Delete "${group.name}"?`, alone ? DELETE_GROUP_WORDS.alone : DELETE_GROUP_WORDS.everyone, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete group',
      style: 'destructive',
      onPress: async () => {
        try {
          await deleteGroup(group.id);
          showToast('Group deleted 🗑️');
          backToChats();
        } catch (error) {
          Alert.alert('Could not delete the group', friendlyError(error));
        }
      },
    },
  ]);
}

function confirmLeave(group: PeekGroup, me: string, showToast: (message: string) => void) {
  Alert.alert(`Leave "${group.name}"?`, leaveGroupWords(group, me), [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Leave',
      style: 'destructive',
      onPress: async () => {
        try {
          const result = await leaveGroup(group.id, me);
          // You were the last one in it, so the server deleted the group too.
          showToast(result === 'deleted' ? `You left ${group.name} – nobody was left, so it's deleted 🗑️` : `You left ${group.name}`);
          backToChats();
        } catch (error) {
          Alert.alert('Could not leave the group', friendlyError(error));
        }
      },
    },
  ]);
}
