import Ionicons from '@expo/vector-icons/Ionicons';
import { reloadAppAsync } from 'expo';
import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { formatBirthday } from '@/components/match/BirthdayForm';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { inviteFriends } from '@/lib/invite';
import { contactEmail, type LegalPage } from '@/lib/legal';
import { LEGAL_DOCS } from '@/lib/legalDocs';
import { setLocationSharing } from '@/lib/location';
import { ALL_ON, fetchNotificationPrefs, saveNotificationPrefs, type NotificationPrefs } from '@/lib/notificationPrefs';
import { scheduleDropNotifications } from '@/lib/notifications';
import { fetchMyBirthday } from '@/lib/peekMatch';
import { useScratchToReveal } from '@/lib/preferences';
import { deleteMyAccount, updateMyProfile } from '@/lib/profiles';
import { colors, font, radius, saveThemeChoice, space, themeChoice, type ThemeChoice } from '@/theme';

export default function Settings() {
  const { userId, profile, setProfile, signOut } = useMe();
  const { showToast } = useOverlays();
  const [scratchToReveal, setScratchToReveal] = useScratchToReveal();
  const [notify, setNotify] = useState<NotificationPrefs | null>(null);
  // Your birthday: undefined while loading, null if you haven't added it yet.
  const [birthday, setBirthday] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    fetchNotificationPrefs(userId)
      .then(setNotify)
      .catch(() => setNotify(ALL_ON));
  }, [userId]);

  // Fresh each time you come back here (e.g. right after adding your birthday).
  useFocusEffect(
    useCallback(() => {
      fetchMyBirthday(userId)
        .then(setBirthday)
        .catch(() => {});
    }, [userId]),
  );

  // Turn one type of notification on or off (saved straight away).
  async function setNotifyType(key: keyof NotificationPrefs, on: boolean) {
    if (!notify) return;
    const before = notify;
    const next = { ...notify, [key]: on };
    setNotify(next);
    try {
      await saveNotificationPrefs(userId, next);
      if (key === 'drops') await scheduleDropNotifications(on);
    } catch (error) {
      setNotify(before);
      Alert.alert('Could not save', friendlyError(error));
    }
  }

  const notifySwitch = (key: keyof NotificationPrefs) => (
    <Switch
      value={notify?.[key] ?? true}
      disabled={!notify}
      onValueChange={(on) => setNotifyType(key, on)}
      trackColor={{ true: colors.pink, false: colors.border }}
      thumbColor={colors.white}
    />
  );

  async function setPrivate(value: boolean) {
    try {
      setProfile(await updateMyProfile(userId, { is_private: value }));
      showToast(value ? 'Your account is private 🔒' : 'Your account is public 🌍');
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    }
  }

  async function setHidden(hidden: boolean) {
    try {
      const updated = await setLocationSharing(userId, !hidden);
      if (!updated) {
        Alert.alert('Location is turned off', 'Allow location for Expo Go in your phone settings to share your spot.');
        return;
      }
      setProfile(updated);
      showToast(hidden ? "🙈 You're hidden on the map" : '👀 Your friends can see you now');
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    }
  }

  // Two warnings before anything is deleted – there's no undo.
  function confirmDelete() {
    Alert.alert(
      'Delete your account?',
      'Your profile, posts, stories, chats and friends will be gone forever. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Are you really sure?', `@${profile?.username ?? 'you'} will be deleted right now.`, [
              { text: 'Keep my account', style: 'cancel' },
              {
                text: 'Delete forever',
                style: 'destructive',
                onPress: async () => {
                  try {
                    await deleteMyAccount();
                    showToast('Your account was deleted. Bye 👋');
                    // The login no longer exists, so this just clears it from the phone.
                    await signOut().catch(() => {});
                  } catch (error) {
                    Alert.alert('Could not delete your account', friendlyError(error));
                  }
                },
              },
            ]),
        },
      ],
    );
  }

  function confirmSignOut() {
    Alert.alert('Log out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: signOut },
    ]);
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Settings" />
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <Section title="Privacy & safety">
          <Row
            icon="lock-closed"
            color={colors.pink}
            title="Private account"
            subtitle="Only friends see your posts (strangers don't see them on Home)"
            right={
              <Switch
                value={profile?.is_private ?? false}
                onValueChange={setPrivate}
                trackColor={{ true: colors.pink, false: colors.border }}
                thumbColor={colors.white}
              />
            }
          />
          <Row
            icon="eye-off"
            color={colors.purple}
            title="Hide me on the map"
            subtitle="When on, nobody sees where you are"
            right={
              <Switch
                value={!(profile?.location_sharing ?? false)}
                onValueChange={setHidden}
                trackColor={{ true: colors.purple, false: colors.border }}
                thumbColor={colors.white}
              />
            }
          />
          <Row icon="map" color={colors.green} title="Friend map" onPress={() => router.push('/map')} />
          <Row
            icon="hand-left"
            color={colors.orange}
            title="Blocked accounts"
            onPress={() => router.push('/blocked')}
          />
        </Section>

        <Section title="Notifications">
          <Row icon="chatbubble" color={colors.blue} title="Messages & peeks" right={notifySwitch('messages')} />
          <Row icon="person-add" color={colors.green} title="Friend requests" right={notifySwitch('friend_requests')} />
          <Row icon="heart" color={colors.pink} title="Likes" right={notifySwitch('likes')} />
          <Row icon="chatbubble-ellipses" color={colors.purple} title="Comments" right={notifySwitch('comments')} />
          <Row
            icon="eye"
            color={colors.accent}
            title="Peekaboo drops & nudges"
            subtitle="The 'you have 2 minutes' alert, and group nudges"
            right={notifySwitch('drops')}
          />
        </Section>

        <Section title="Peekaboo drops">
          <Row
            icon="people-circle"
            color={colors.purple}
            title="Group Peek"
            subtitle="Drops stay hidden until the whole group posts"
            onPress={() => router.push('/groups')}
          />
          <Row
            icon="finger-print"
            color={colors.accent}
            title="Scratch to reveal drops"
            subtitle="Drop photos start blurred – hold and scratch them clear"
            right={
              <Switch
                value={scratchToReveal}
                onValueChange={setScratchToReveal}
                trackColor={{ true: colors.pink, false: colors.border }}
                thumbColor={colors.white}
              />
            }
          />
        </Section>

        <Section title="Friends">
          <Row
            icon="paper-plane"
            color={colors.accent}
            title="Invite friends"
            subtitle="Tell your friends about Peekaboo"
            onPress={() => inviteFriends(profile?.username)}
          />
          <Row icon="people" color={colors.blue} title="My friends" onPress={() => router.push('/friends')} />
          <Row
            icon="star"
            color={colors.green}
            title="Close friends"
            subtitle="Share stories and posts with just them"
            onPress={() => router.push('/close-friends')}
          />
        </Section>

        <Section title="Appearance">
          <View style={styles.themes}>
            {THEMES.map((option) => (
              <Pressable
                key={option.key}
                onPress={() => chooseTheme(option.key)}
                accessibilityRole="radio"
                accessibilityState={{ selected: themeChoice === option.key }}
                style={[styles.theme, themeChoice === option.key && styles.themeOn]}>
                <Text style={styles.themeEmoji}>{option.emoji}</Text>
                <Text style={[styles.themeLabel, themeChoice === option.key && styles.themeLabelOn]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section title="Legal & safety">
          <Row icon="document-text" color={colors.blue} title="Terms of Service" onPress={() => openLegal('terms')} />
          <Row icon="shield-checkmark" color={colors.green} title="Privacy Policy" onPress={() => openLegal('privacy')} />
          <Row icon="people-circle" color={colors.purple} title="Community Guidelines" onPress={() => openLegal('guidelines')} />
          <Row icon="flame" color={colors.pink} title="Dare Safety Rules" onPress={() => openLegal('dare-rules')} />
          {CONTACT ? (
            <Row icon="mail" color={colors.orange} title="Contact us" subtitle={CONTACT} onPress={() => Linking.openURL(`mailto:${CONTACT}`)} />
          ) : null}
        </Section>

        <Section title="Account">
          <Row icon="person" color={colors.blue} title="Edit profile" onPress={() => router.push('/edit-profile')} />
          <Row
            icon="gift"
            color={colors.pink}
            title="Birthday"
            subtitle={
              birthday === undefined
                ? undefined
                : birthday
                  ? `🎂 ${formatBirthday(birthday)} · only you see this`
                  : 'Add your birthday – only you see it'
            }
            onPress={birthday === null ? () => router.push('/birthday') : undefined}
          />
          <Row icon="log-out" color={colors.orange} title="Log out" onPress={confirmSignOut} />
          <Row icon="trash" color={colors.red} title="Delete account" subtitle="Gone forever – no undo" onPress={confirmDelete} />
        </Section>

        <Text style={styles.footer}>
          Peekaboo {Constants.expoConfig?.version ?? ''} · made with 💛
        </Text>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({ icon, color, title, subtitle, right, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={[styles.icon, { backgroundColor: color }]}>
        <Ionicons name={icon} size={18} color={colors.white} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={20} color={colors.textFaint} /> : null)}
    </Pressable>
  );
}

const openLegal = (doc: LegalPage) => router.push({ pathname: '/legal/[doc]', params: { doc } });
// The contact email from the Terms (shown once it's been filled in).
const CONTACT = contactEmail(LEGAL_DOCS.terms);

const THEMES: { key: ThemeChoice; label: string; emoji: string }[] = [
  { key: 'dark', label: 'Dark', emoji: '🌙' },
  { key: 'light', label: 'Light', emoji: '☀️' },
  { key: 'system', label: 'Match phone', emoji: '📱' },
];

// Switching colors restarts the app for a second, so every screen is redrawn in the new colors.
async function chooseTheme(choice: ThemeChoice) {
  if (choice === themeChoice) return;
  try {
    await saveThemeChoice(choice);
    await reloadAppAsync();
  } catch (error) {
    Alert.alert('Saved!', 'Close Peekaboo and open it again to see the new colors.');
    console.warn('Could not restart for the new theme', error);
  }
}

const styles = StyleSheet.create({
  themes: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.sm,
  },
  theme: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  themeOn: {
    borderColor: colors.accent,
  },
  themeEmoji: {
    fontSize: 24,
  },
  themeLabel: {
    ...font.small,
    fontWeight: '800',
  },
  themeLabelOn: {
    color: colors.text,
  },
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.xl,
  },
  section: {
    gap: space.sm,
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
    marginLeft: space.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  rowPressed: {
    backgroundColor: colors.cardPressed,
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...font.body,
    fontWeight: '700',
  },
  rowSubtitle: {
    ...font.small,
  },
  footer: {
    ...font.small,
    textAlign: 'center',
    color: colors.textFaint,
  },
});
