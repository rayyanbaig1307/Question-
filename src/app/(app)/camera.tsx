import { useIsFocused, useLocalSearchParams } from 'expo-router';

import { CameraPage } from '@/components/home/CameraPage';

// The camera on its own screen:
// - opened from a chat (?to=friend): whatever you take goes to that friend as a peek;
// - opened from the Daily Dare (?dare=1): your photo becomes your answer to today's dare;
// - opened for the Peekaboo drop (?drop=1): your photo becomes today's drop;
// - opened from Guess Who (?guess=1): your photo is posted anonymously for friends to guess.
export default function SoloCamera() {
  const { to, dare, drop, guess } = useLocalSearchParams<{ to?: string; dare?: string; drop?: string; guess?: string }>();
  const focused = useIsFocused();
  return <CameraPage active={focused} sendTo={to} dare={dare === '1'} drop={drop === '1'} guess={guess === '1'} />;
}
