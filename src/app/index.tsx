import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/lib/supabase';
import { colors, font, space } from '@/theme';

// Temporary screen: checks that the app can talk to Supabase.
export default function ConnectionCheck() {
  const [status, setStatus] = useState('Checking connection…');

  useEffect(() => {
    supabase
      .rpc('username_available', { name: 'peekaboo_check' })
      .then(({ error }) =>
        setStatus(error ? `Not connected yet: ${error.message}` : 'Connected to Supabase! 🎉'),
      );
  }, []);

  return (
    <View style={styles.wrap}>
      <Text style={styles.logo}>Peekaboo 👻</Text>
      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    backgroundColor: colors.bg,
  },
  logo: {
    ...font.hero,
  },
  status: {
    ...font.body,
    color: colors.textMuted,
  },
});
