import { useIsFocused, useLocalSearchParams } from 'expo-router';

import { CameraPage } from '@/components/home/CameraPage';

// The camera on its own screen:
// - opened from a chat (?to=friend): whatever you take goes to that friend as a peek;
// - opened from the Daily Dare (?dare=1): your photo becomes your answer to today's dare.
export default function SoloCamera() {
  const { to, dare } = useLocalSearchParams<{ to?: string; dare?: string }>();
  const focused = useIsFocused();
  return <CameraPage active={focused} sendTo={to} dare={dare === '1'} />;
}
