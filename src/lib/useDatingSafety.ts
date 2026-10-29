import { Alert } from 'react-native';

import { useOverlays } from '@/components/Overlays';
import { blockDatingProfile, reportDatingProfile } from './dating';
import { friendlyError } from './errors';
import { REPORT_REASONS } from './safety';

type Person = { dating_id: string; name: string };

// Report and block for Peek Match – on every dating profile and in every match chat.
export function useDatingSafety() {
  const { showOptions, showToast } = useOverlays();

  function block(person: Person, onBlocked?: () => void) {
    Alert.alert(`Block ${person.name}?`, "You won't see each other in Peek Match again, and any match chat ends. We won't tell them.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block',
        style: 'destructive',
        onPress: async () => {
          try {
            await blockDatingProfile(person.dating_id);
            showToast(`Blocked ${person.name}`);
            onBlocked?.();
          } catch (error) {
            Alert.alert('Could not block', friendlyError(error));
          }
        },
      },
    ]);
  }

  function report(person: Person, what: 'profile' | 'message', onBlocked?: () => void) {
    showOptions({
      title: what === 'message' ? 'Why are you reporting this chat?' : 'Why are you reporting this profile?',
      message: "Your report is private. They won't know it was you.",
      options: REPORT_REASONS.map((reason) => ({
        label: reason.label,
        onPress: async () => {
          try {
            await reportDatingProfile(person.dating_id, reason.code, what);
            Alert.alert('Thanks for telling us 💛', 'We will take a look. Do you also want to block them?', [
              { text: 'Not now', style: 'cancel' },
              // Wait for this pop-up to close before opening the next one.
              { text: 'Block', style: 'destructive', onPress: () => setTimeout(() => block(person, onBlocked), 400) },
            ]);
          } catch (error) {
            Alert.alert('Could not send report', friendlyError(error));
          }
        },
      })),
    });
  }

  // The ••• menu: Report and Block (plus any extra options first).
  function openMenu(
    person: Person,
    what: 'profile' | 'message',
    onBlocked?: () => void,
    extra: { label: string; onPress: () => void; destructive?: boolean }[] = [],
  ) {
    showOptions({
      options: [
        ...extra,
        { label: `Report ${person.name}`, onPress: () => setTimeout(() => report(person, what, onBlocked), 400) },
        { label: `Block ${person.name}`, destructive: true, onPress: () => block(person, onBlocked) },
      ],
    });
  }

  return { openMenu, report, block };
}
