import { StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { colors } from '@/theme';
import { PageHeader } from './PageHeader';

// Left page. Chats and snaps arrive in a later step.
export function ChatPage({ onCamera }: { onCamera: () => void }) {
  return (
    <View style={styles.fill}>
      <PageHeader title="Chat" cameraSide="right" onCamera={onCamera} />
      <EmptyState
        emoji="💬"
        title="Chats are coming soon!"
        message="Next up: add friends, then chat and send each other snaps right here."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
