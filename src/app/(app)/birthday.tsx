import { router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { FormScreen } from '@/components/FormScreen';
import { BirthdayForm } from '@/components/BirthdayForm';
import { useOverlays } from '@/components/Overlays';
import { font } from '@/theme';

// Add your birthday (asked once when you open Peekaboo, or from Settings). Only you ever see it.
export default function Birthday() {
  const { showToast } = useOverlays();

  return (
    <FormScreen title="When's your birthday? 🎂" subtitle="Only you see it. It helps keep Peekaboo safe and right for your age.">
      <BirthdayForm
        onSaved={() => {
          showToast('Birthday saved 🎂');
          router.back();
        }}
      />
      <Button title="Not now" variant="plain" onPress={() => router.back()} />
      <Text style={styles.note}>You can add it later in Settings → Birthday.</Text>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  note: {
    ...font.small,
    textAlign: 'center',
  },
});
