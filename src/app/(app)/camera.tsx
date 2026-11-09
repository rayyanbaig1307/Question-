import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { CameraPage } from '@/components/home/CameraPage';

// The camera on its own screen:
// - opened from a chat (?to=friend): whatever you take goes to that friend as a peek;
//   (&chatDare=<message id>: it's the proof for their dare, so the dare is marked as done for you);
// - opened from a group chat (?group=<id>): the photo/video goes to that group chat
//   (&groupDare=<message id>: it's your proof for that group dare;
//   &groupGuess=1: it starts in Guess Who mode – the photo goes to the group with no name on it);
// - opened from the Daily Dare (?dare=1): your photo becomes your answer to today's dare;
// - opened for the Peekaboo drop (?drop=1): your photo becomes today's drop;
// - opened from Guess Who (?guess=1): your photo is posted anonymously for friends to guess;
// - opened to pay a forfeit (?forfeit=<id>&ftext=…): your photo pays that forfeit.
export default function SoloCamera() {
  const { to, chatDare, group, groupDare, groupGuess, dare, drop, guess, forfeit, ftext } = useLocalSearchParams<{
    to?: string;
    group?: string;
    groupDare?: string;
    groupGuess?: string;
    chatDare?: string;
    dare?: string;
    drop?: string;
    guess?: string;
    forfeit?: string;
    ftext?: string;
  }>();
  const focused = useIsFocused();
  return (
    <>
      <StatusBar style="light" />
      <CameraPage
        active={focused}
        sendTo={to}
        chatDare={chatDare}
        sendToGroup={group}
        groupDare={groupDare}
        groupGuess={groupGuess === '1'}
        dare={dare === '1'}
        drop={drop === '1'}
        guess={guess === '1'}
        forfeit={forfeit}
        forfeitText={ftext}
      />
    </>
  );
}
