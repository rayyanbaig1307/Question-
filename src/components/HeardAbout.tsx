import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { FormScreen } from '@/components/FormScreen';
import { TextField } from '@/components/TextField';
import { HEARD_ABOUT_OPTIONS, saveHeardAbout, type HeardAboutSource } from '@/lib/heardAbout';
import { colors, font, radius, space } from '@/theme';

// "How did you hear about Peekaboo?" – shown once to new accounts, right after sign-up. Tap one and Continue,
// or Skip. Either way the app opens straight after.
export function HeardAbout({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [picked, setPicked] = useState<HeardAboutSource | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);

  async function finish(source: HeardAboutSource | 'skipped') {
    if (busy) return;
    setBusy(true);
    await saveHeardAbout(userId, source, other);
    onDone();
  }

  return (
    <FormScreen title="One quick question 👀" subtitle="How did you hear about Peekaboo?" showBack={false}>
      <View style={styles.grid}>
        {HEARD_ABOUT_OPTIONS.map((option) => {
          const on = picked === option.source;
          return (
            <Pressable
              key={option.source}
              onPress={() => {
                Haptics.selectionAsync();
                setPicked(option.source);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && styles.pressed]}>
              <Text style={styles.emoji}>{option.emoji}</Text>
              <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {picked === 'other' ? (
        <TextField label="Where?" value={other} onChangeText={setOther} placeholder="Tell us in a few words" maxLength={100} />
      ) : null}
      <Button title="Continue" icon="arrow-forward" onPress={() => picked && finish(picked)} disabled={!picked} loading={busy} />
      <Button title="Skip" variant="plain" onPress={() => finish('skipped')} disabled={busy} />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  option: {
    width: '48.5%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.card,
  },
  optionOn: {
    borderColor: colors.accent,
  },
  pressed: {
    transform: [{ scale: 0.97 }],
  },
  emoji: {
    fontSize: 22,
  },
  label: {
    ...font.body,
    fontWeight: '700',
    flexShrink: 1,
  },
  labelOn: {
    color: colors.accent,
  },
});
