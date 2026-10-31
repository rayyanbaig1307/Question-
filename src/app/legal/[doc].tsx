import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LegalText } from '@/components/LegalText';
import { ScreenHeader } from '@/components/ScreenHeader';
import { LEGAL_PAGES, type LegalPage } from '@/lib/legal';
import { LEGAL_DOCS } from '@/lib/legalDocs';
import { colors, space } from '@/theme';

// One legal document (Terms, Privacy, Community Guidelines or Dare Safety Rules), readable logged in or out.
export default function LegalScreen() {
  const { doc } = useLocalSearchParams<{ doc: string }>();
  const insets = useSafeAreaInsets();
  const page: LegalPage = doc in LEGAL_PAGES ? (doc as LegalPage) : 'terms';

  return (
    <View style={styles.fill}>
      <ScreenHeader title={LEGAL_PAGES[page]} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}>
        <LegalText markdown={LEGAL_DOCS[page]} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
  },
});
