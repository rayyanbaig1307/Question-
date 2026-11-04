import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { friendlyError } from '@/lib/errors';
import { setBirthday } from '@/lib/birthday';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatBirthday(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Nobody on Peekaboo is under 13 or over 100.
export const MIN_AGE = 13;
export const MAX_AGE = 100;

// Why these Day / Month / Year boxes aren't a real birthday yet, or null when they are.
// A birthday can't be in the future, can't be more than 100 years ago, and you must be 13 or older.
export function checkBirthday(day: string, month: string, year: string, today: Date = new Date()): string | null {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!day || !month || year.length !== 4) return 'Type the day, month and a 4-digit year.';
  if (m < 1 || m > 12) return 'The month must be 1 to 12.';
  const date = new Date(y, m - 1, d);
  if (d < 1 || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return `${MONTHS[m - 1]} ${y} doesn't have a day ${d}.`;
  }
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (date > now) return "That's in the future – check the year.";
  const oldest = new Date(now.getFullYear() - MAX_AGE, now.getMonth(), now.getDate());
  if (date < oldest) return `That's more than ${MAX_AGE} years ago – check the year.`;
  const youngest = new Date(now.getFullYear() - MIN_AGE, now.getMonth(), now.getDate());
  if (date > youngest) return `You need to be ${MIN_AGE} or older to use Peekaboo.`;
  return null;
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
  const problem = checkBirthday(day, month, year);
  const valid = problem === null;

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
      {problem && day && month && year.length === 4 ? <Text style={styles.problem}>{problem}</Text> : null}
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
  problem: {
    ...font.small,
    color: colors.red,
    textAlign: 'center',
    marginTop: -space.sm,
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
