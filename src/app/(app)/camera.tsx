import { useIsFocused, useLocalSearchParams } from 'expo-router';

import { CameraPage } from '@/components/home/CameraPage';

// Camera opened from inside a chat: whatever you snap goes to that friend.
export default function SnapCamera() {
  const { to } = useLocalSearchParams<{ to: string }>();
  const focused = useIsFocused();
  return <CameraPage active={focused} sendTo={to} />;
}
