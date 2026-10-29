import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { friendlyError } from '@/lib/errors';
import { setBirthday } from '@/lib/peekMatch';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatBirthday(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Day / Month / Year boxes. Your birthday is saved once and can't be changed later.
export function BirthdayForm({ onSaved }: { onSaved: () => void }) {
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [saving, setSaving] = useState(false);

  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  const date = new Date(y, m - 1, d);
  const valid =
    year.length === 4 && d >= 1 && m >= 1 && m <= 12 && date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;

  function confirm() {
    if (!valid) return;
    Alert.alert(`Is ${d} ${MONTHS[m - 1]} ${y} right?`, "You can't change your birthday later.", [
      { text: 'Fix it', style: 'cancel' },
      { text: "Yes, that's right", onPress: save },
    ]);
  }

  async function save() {
    setSaving(true);
    try {
      const pad = (n: number) => String(n).padStart(2, '0');
      await setBirthday(`${y}-${pad(m)}-${pad(d)}`);
      onSaved();
    } catch (error) {
      Alert.alert('Could not save your birthday', friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.form}>
      <View style={styles.dateRow}>
        <DateBox label="Day" value={day} onChange={setDay} max={2} placeholder="DD" />
        <DateBox label="Month" value={month} onChange={setMonth} max={2} placeholder="MM" />
        <DateBox label="Year" value={year} onChange={setYear} max={4} placeholder="YYYY" wide />
      </View>
      <Button title="Save my birthday" icon="gift" disabled={!valid} loading={saving} onPress={confirm} />
    </View>
  );
}

function DateBox({ label, value, onChange, max, placeholder, wide = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  placeholder: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.dateBox, wide && styles.dateBoxWide]}>
      <Text style={styles.dateLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(text) => onChange(text.replace(/[^0-9]/g, '').slice(0, max))}
        keyboardType="number-pad"
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        keyboardAppearance={keyboardAppearance}
        selectionColor={colors.accent}
        maxLength={max}
        style={styles.dateInput}
        accessibilityLabel={`Birthday ${label.toLowerCase()}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: space.lg,
  },
  dateRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  dateBox: {
    flex: 1,
    gap: space.xs,
  },
  dateBoxWide: {
    flex: 1.5,
  },
  dateLabel: {
    ...font.label,
  },
  dateInput: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
  },
});
