import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, space } from '@/theme';

// A person in a list with their face and name hidden (Peekaboo+ shows who it is).
export function HiddenPersonRow() {
  return (
    <View style={styles.row} accessibilityLabel="Hidden person">
      <View style={styles.face}>
        <Text style={styles.emoji}>🙈</Text>
      </View>
      <View style={styles.names}>
        <View style={[styles.bar, styles.barLong]} />
        <View style={styles.bar} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
  },
  face: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 22,
  },
  names: {
    flex: 1,
    gap: space.xs,
  },
  bar: {
    height: 10,
    width: '40%',
    borderRadius: radius.pill,
    backgroundColor: colors.border,
  },
  barLong: {
    width: '65%',
  },
});
