import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { IconButton } from '@/components/IconButton';
import { MatchFeed } from '@/components/match/MatchFeed';
import { AgeCheckCard, MatchWelcome, setupStyles, TurnOnCard } from '@/components/match/MatchSetup';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { fetchMyDating, isComplete, MIN_PHOTOS, type MyDating } from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import { setDatingHidden, type PeekMatchStatus } from '@/lib/peekMatch';
import { colors, font, space } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';

// The Match tab (to the right of Home): Peek Match, right in the app (only for people whose birthday says 18+).
// Not verified yet → the age check. Verified → turn it on. Then: finish your dating profile → the feed.
export function MatchPage({ visible, status, news, onChanged }: {
  visible: boolean;
  status: PeekMatchStatus | null;
  // Likes waiting + chats with unread messages.
  news: number;
  onChanged: () => void;
}) {
  const tabSpace = useTabBarSpace();
  const ageCheck = status?.ageCheck ?? null;
  const member = status?.member ?? null;

  let body;
  if (!status || !ageCheck || ageCheck.blocked) {
    body = <ActivityIndicator color={colors.accent} style={styles.loading} />;
  } else if (ageCheck.check_state !== 'verified' || !member) {
    body = (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabSpace + space.lg }]}>
        <MatchWelcome />
        {ageCheck.check_state !== 'verified' ? (
          <AgeCheckCard ageCheck={ageCheck} onChanged={onChanged} />
        ) : (
          <TurnOnCard onChanged={onChanged} />
        )}
      </ScrollView>
    );
  } else {
    body = <MemberArea visible={visible} hidden={member.hidden} bottomSpace={tabSpace} onChanged={onChanged} />;
  }

  return (
    <View style={styles.fill}>
      <MatchHeader member={!!member} news={news} />
      {body}
    </View>
  );
}

// Top bar: ⚙ Peek Match settings · title · 💬 matches (with a dot when something's new).
function MatchHeader({ member, news }: { member: boolean; news: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      <View style={styles.side}>
        {member ? (
          <IconButton icon="settings-sharp" label="Peek Match settings" background={colors.card} size={40} onPress={() => router.push('/peek-match')} />
        ) : null}
      </View>
      <Text style={styles.title}>Peek Match 💘</Text>
      <View style={[styles.side, styles.right]}>
        {member ? (
          <View>
            <IconButton icon="chatbubbles" label="Matches and likes" background={colors.card} size={40} onPress={() => router.push('/peek-match/matches')} />
            {news > 0 ? (
              <View style={styles.badge} pointerEvents="none">
                <Text style={styles.badgeText}>{news > 9 ? '9+' : news}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

// You're in: make sure your dating profile is finished and showing, then show people.
function MemberArea({ visible, hidden, bottomSpace, onChanged }: {
  visible: boolean;
  hidden: boolean;
  bottomSpace: number;
  onChanged: () => void;
}) {
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const [mine, setMine] = useState<MyDating | null>(null);

  // Check your profile each time you come to the tab (e.g. after editing it).
  useEffect(() => {
    if (!visible) return;
    fetchMyDating(userId)
      .then(setMine)
      .catch(() => setMine((current) => current ?? { profile: null, photos: [], prompts: [] }));
  }, [visible, userId]);

  async function showMeAgain() {
    try {
      await setDatingHidden(false);
      showToast('Your dating profile is showing again 👀');
      onChanged();
    } catch (error) {
      Alert.alert('Something went wrong', friendlyError(error));
    }
  }

  if (mine === null) return <ActivityIndicator color={colors.accent} style={styles.loading} />;

  if (!isComplete(mine)) {
    const photosLeft = MIN_PHOTOS - mine.photos.length;
    const missing = [
      !mine.profile && 'the basics (name, area, who you want to see)',
      photosLeft > 0 && `${photosLeft} more photo${photosLeft === 1 ? '' : 's'}`,
      mine.prompts.length < 3 && 'your 3 prompts',
    ].filter((item): item is string => !!item);
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomSpace + space.lg }]}>
        <View style={setupStyles.card}>
          <Text style={styles.bigEmoji}>📸</Text>
          <Text style={setupStyles.cardTitle}>{mine.profile ? 'Finish your dating profile' : 'Make your dating profile'}</Text>
          <Text style={setupStyles.cardText}>
            People see you once it has 3–6 photos, your name, age, rough area and 3 prompts.
            {missing.length > 0 ? ` Still to add: ${missing.join(', ')}.` : ''}
          </Text>
          <Button title={mine.profile ? 'Finish my profile' : 'Make my profile'} icon="create" onPress={() => router.push('/peek-match/profile')} />
        </View>
      </ScrollView>
    );
  }

  if (hidden) {
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomSpace + space.lg }]}>
        <View style={setupStyles.card}>
          <Text style={styles.bigEmoji}>🙈</Text>
          <Text style={setupStyles.cardTitle}>Your dating profile is hidden</Text>
          <Text style={setupStyles.cardText}>
            Nobody new sees you, and you don&apos;t see new people. Your matches and chats are still here (💬 at the top).
          </Text>
          <Button title="Show me again" icon="eye" onPress={showMeAgain} />
        </View>
      </ScrollView>
    );
  }

  return <MatchFeed visible={visible} bottomSpace={bottomSpace} />;
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xxl,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: colors.bg,
  },
  side: {
    width: 48,
    paddingTop: space.sm,
  },
  right: {
    alignItems: 'flex-end',
  },
  title: {
    ...font.title,
    flex: 1,
    textAlign: 'center',
    paddingTop: space.sm,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
  },
  bigEmoji: {
    fontSize: 40,
    textAlign: 'center',
  },
});
