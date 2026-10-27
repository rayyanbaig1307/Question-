import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, font, radius, space } from '@/theme';

type Props = TextInputProps & {
  label: string;
  error?: string | null;
  hint?: string | null;
  prefix?: string;
};

// A labelled text box with room for a hint or an error underneath.
export function TextField({ label, error, hint, prefix, style, multiline, ...inputProps }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.box, multiline && styles.multilineBox, error ? styles.boxError : null]}>
        {prefix ? <Text style={styles.prefix}>{prefix}</Text> : null}
        <TextInput
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.yellow}
          keyboardAppearance="dark"
          multiline={multiline}
          style={[styles.input, multiline && styles.multilineInput, style]}
          {...inputProps}
        />
      </View>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.xs,
  },
  label: {
    ...font.label,
    marginLeft: space.xs,
  },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
    paddingHorizontal: space.lg,
  },
  multilineBox: {
    alignItems: 'flex-start',
    paddingVertical: space.sm,
  },
  boxError: {
    borderColor: colors.red,
  },
  prefix: {
    color: colors.textMuted,
    fontSize: 17,
    fontWeight: '700',
    marginRight: 2,
  },
  input: {
    flex: 1,
    minHeight: 52,
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
  },
  multilineInput: {
    minHeight: 90,
    textAlignVertical: 'top',
  },
  error: {
    color: colors.red,
    fontSize: 13,
    fontWeight: '700',
    marginLeft: space.xs,
  },
  hint: {
    ...font.small,
    marginLeft: space.xs,
  },
});
