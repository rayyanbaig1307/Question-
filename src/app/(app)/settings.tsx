import Ionicons from '@expo/vector-icons/Ionicons';
import { reloadAppAsync } from 'expo';
import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { formatBirthday } from '@/components/BirthdayForm';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { fetchMyBirthday } from '@/lib/birthday';
import { friendlyError } from '@/lib/errors';
import { fetchShowInProfileViews, setShowInProfileViews } from '@/lib/insights';
import { prefetchInviteCode } from '@/lib/invite';
import { contactEmail, type LegalPage } from '@/lib/legal';
import { LEGAL_DOCS } from '@/lib/legalDocs';
import { setLocationSharing } from '@/lib/location';
import { ALL_ON, fetchNotificationPrefs, saveNotificationPrefs, type NotificationPrefs } from '@/lib/notificationPrefs';
import { scheduleDropNotifications } from '@/lib/notifications';
import { openManageSubscription, usePlus, useStorePlus } from '@/lib/plus';
import { useScratchToReveal } from '@/lib/preferences';
import { deleteMyAccount, updateMyProfile } from '@/lib/profiles';
import type { HitUpsFrom, Profile } from '@/lib/types';
import { colors, font, radius, saveThemeChoice, space, themeChoice, type ThemeChoice } from '@/theme';

export default function Settings() {
  const { userId, profile, setProfile, signOut, currentUserId, refreshProfile } = useMe();
  const { showToast, showOptions } = useOverlays();
  const [scratchToReveal, setScratchToReveal] = useScratchToReveal();
  const plus = usePlus();
  // The App Store says you pay for Peekaboo+ (Delete account warns that deleting doesn't stop it).
  const storePlus = useStorePlus();
  const [notify, setNotify] = useState<NotificationPrefs | null>(null);
  // Your birthday: undefined while loading, null if you haven't added it yet.
  const [birthday, setBirthday] = useState<string | null | undefined>(undefined);
  // "Show me in Profile views" (null while loading, or if it can't be loaded yet).
  const [showInViews, setShowInViews] = useState<boolean | null>(null);
  const profileWrites = useRef(Promise.resolve());
  const latestProfile = useRef(profile);
  const locationRequest = useRef(0);
  const active = useRef(true);
  const deleting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    latestProfile.current = profile;
  }, [profile]);

  // Keep privacy saves in the order you chose them, even if the connection is slow.
  // A save waiting in line is still sent if you leave Settings (it's your choice, for your account),
  // but never if someone else has logged in on this phone in the meantime.
  function savePrivacyInOrder(save: () => Promise<Profile>, show: (updated: Profile) => void): Promise<void> {
    const saved = profileWrites.current.then(async () => {
      if (currentUserId() !== userId) return;
      const updated = await save();
      if (active.current) show(updated);
      // Settings is closed: just bring the app's copy of your profile up to date. This waits in the same
      // line as the saves, so an older refresh can never come back after a newer one and undo your choice.
      else await refreshProfile();
    });
    profileWrites.current = saved.catch(() => {});
    return saved;
  }

  function showProfileChange(updated: Profile, changes: Partial<Profile>) {
    if (!active.current) return;
    const next = { ...(latestProfile.current ?? updated), ...changes };
    latestProfile.current = next;
    setProfile(next);
  }

  useEffect(() => {
    fetchNotificationPrefs(userId)
      .then(setNotify)
      .catch(() => setNotify(ALL_ON));
  }, [userId]);

  useEffect(() => {
    fetchShowInProfileViews(userId).then((on) => active.current && setShowInViews(on));
  }, [userId]);

  // Get your invite link ready, so "Invite friends" opens with it straight away.
  useEffect(() => {
    prefetchInviteCode(userId);
  }, [userId]);

  async function changeShowInViews(on: boolean) {
    const before = showInViews;
    setShowInViews(on);
    try {
      await setShowInProfileViews(on);
      if (active.current) showToast(on ? '👀 You show up in Profile views' : "🙈 You're hidden from Profile views");
    } catch (error) {
      if (active.current) setShowInViews(before);
      Alert.alert('Could not save', friendlyError(error));
    }
  }

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
      if (!active.current) return;
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
      await savePrivacyInOrder(
        () => updateMyProfile(userId, { is_private: value }),
        (updated) => {
          showProfileChange(updated, { is_private: updated.is_private });
          showToast(value ? 'Your account is private 🔒' : 'Your account is public 🌍');
        },
      );
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    }
  }

  function chooseHitUps() {
    showOptions({
      title: 'Who can hit you up? 👋',
      message: 'Hit ups are only for people 18 and over.',
      options: HIT_UPS_FROM.map((option) => ({
        label: `${option.label}${profile?.hit_ups_from === option.key ? ' ✓' : ''}`,
        onPress: async () => {
          try {
            await savePrivacyInOrder(
              () => updateMyProfile(userId, { hit_ups_from: option.key }),
              (updated) => {
                showProfileChange(updated, { hit_ups_from: updated.hit_ups_from });
                showToast(`Hit ups: ${option.label.toLowerCase()}`);
              },
            );
          } catch (error) {
            Alert.alert('Could not save', friendlyError(error));
          }
        },
      })),
    });
  }

  async function setHidden(hidden: boolean) {
    const request = ++locationRequest.current;
    try {
      const updated = await setLocationSharing(userId, !hidden);
      if (request !== locationRequest.current) return;
      if (!updated) {
        Alert.alert('Location is turned off', 'Allow location for Peekaboo in your phone settings to share your spot.');
        return;
      }
      showProfileChange(updated, { location_sharing: updated.location_sharing });
      showToast(hidden ? "🙈 You're hidden on the map" : '👀 Your friends can see you now');
    } catch (error) {
      if (request !== locationRequest.current) return;
      Alert.alert('Could not save', friendlyError(error));
    }
  }

  // Two warnings before anything is deleted – there's no undo.
  // If you have Peekaboo+ (the App Store or the server says so), the first one also says Apple keeps billing until
  // you cancel (deleting your account can't stop an App Store subscription), with a button to Apple's
  // subscriptions sheet.
  function confirmDelete() {
    if (!active.current) return;
    const billing = plus || storePlus;
    Alert.alert(
      'Delete your account?',
      'Your profile, posts, stories, chats and friends will be gone forever. This cannot be undone.' +
        (billing ? '\n\nIf you pay for Peekaboo+, Apple keeps billing you until you cancel it. Please cancel it first.' : ''),
      [
        ...(billing ? [{ text: 'Manage subscription', onPress: () => { openManageSubscription(); } }] : []),
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (!active.current) return;
            Alert.alert('Are you really sure?', `@${profile?.username ?? 'you'} will be deleted right now.`, [
              { text: 'Keep my account', style: 'cancel' },
              {
                text: 'Delete forever',
                style: 'destructive',
                onPress: async () => {
                  if (!active.current || deleting.current) return;
                  deleting.current = true;
                  try {
                    await deleteMyAccount(userId);
                    if (active.current) showToast('Your account was deleted. Bye 👋');
                    // The login no longer exists, so this just clears it from the phone – even if you left
                    // Settings while it was deleting. signOut(userId) does nothing if someone else is logged in now.
                    await signOut(userId).catch(() => {});
                  } catch (error) {
                    if (active.current) Alert.alert('Could not delete your account', friendlyError(error));
                  } finally {
                    deleting.current = false;
                  }
                },
              },
            ]);
          },
        },
      ],
    );
  }

  function confirmSignOut() {
    if (!active.current) return;
    Alert.alert('Log out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: async () => {
        if (!active.current) return;
        try {
          await signOut(userId);
        } catch (error) {
          if (active.current) Alert.alert('Could not log out', friendlyError(error));
        }
      } },
    ]);
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Settings" />
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <Section title="Peekaboo+">
          <Row
            icon="star"
            color={colors.yellow}
            title="⭐ Peekaboo+"
            subtitle={plus ? 'You have Peekaboo+ – thank you!' : 'See who viewed your profile, themes, stickers and more'}
            onPress={() => router.push('/plus')}
          />
          <Row icon="apps" color={colors.purple} title="App icon" onPress={() => router.push('/app-icon')} />
        </Section>
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
          <Row
            icon="hand-right"
            color={colors.accent}
            title="Who can hit me up"
            subtitle={HIT_UPS_FROM.find((option) => option.key === (profile?.hit_ups_from ?? 'everyone'))?.label}
            onPress={chooseHitUps}
          />
          {showInViews !== null ? (
            <Row
              icon="eye"
              color={colors.blue}
              title="Show me in Profile views"
              subtitle="When off, people don't see you visited – and you can't see your own visitors"
              right={
                <Switch
                  value={showInViews}
                  onValueChange={changeShowInViews}
                  trackColor={{ true: colors.blue, false: colors.border }}
                  thumbColor={colors.white}
                />
              }
            />
          ) : null}
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
            subtitle="Your invite link, or add a friend with their code"
            onPress={() => router.push('/invite')}
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
            {THEMES.map((option) => {
              const on = themeChoice === option.key;
              // Plus themes are locked for people without Peekaboo+.
              const locked = !!option.plus && !plus;
              return (
                <Pressable
                  key={option.key}
                  onPress={() => (locked ? router.push('/plus') : chooseTheme(option.key))}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: locked }}
                  accessibilityLabel={locked ? `${option.label}, Peekaboo+ only` : option.label}
                  style={[styles.theme, on && styles.themeOn, locked && styles.themeLocked]}>
                  {option.swatch ? (
                    <View style={[styles.swatch, { backgroundColor: option.swatch[0], borderColor: option.swatch[1] }]}>
                      <View style={[styles.swatchDot, { backgroundColor: option.swatch[1] }]} />
                    </View>
                  ) : (
                    <Text style={styles.themeEmoji}>{option.emoji}</Text>
                  )}
                  <Text style={[styles.themeLabel, on && styles.themeLabelOn]} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {option.plus ? (
                    <Text style={styles.plusTag}>{locked ? '🔒 ' : ''}⭐ Peekaboo+</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </Section>

        <Section title="Legal & safety">
          <Row icon="document-text" color={colors.blue} title="Terms of Service" onPress={() => openLegal('terms')} />
          <Row icon="shield-checkmark" color={colors.green} title="Privacy Policy" onPress={() => openLegal('privacy')} />
          <Row icon="people-circle" color={colors.purple} title="Community Guidelines" onPress={() => openLegal('guidelines')} />
          <Row icon="flame" color={colors.pink} title="Dare Safety Rules" onPress={() => openLegal('dare-rules')} />
          {CONTACT ? (
            // Opens your mail app with our address already filled in (the address itself isn't shown here).
            <Row
              icon="mail"
              color={colors.orange}
              title="Contact us"
              subtitle="Send us an email"
              onPress={() =>
                Linking.openURL(`mailto:${CONTACT}?subject=${encodeURIComponent('Peekaboo')}`).catch(() =>
                  Alert.alert('No mail app found', 'Set up the Mail app on your phone to send us an email.'),
                )
              }
            />
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

const HIT_UPS_FROM: { key: HitUpsFrom; label: string }[] = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'friends_of_friends', label: 'Friends of friends' },
  { key: 'nobody', label: 'Nobody' },
];

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
  const inside = (
    <>
      <View style={[styles.icon, { backgroundColor: color }]}>
        <Ionicons name={icon} size={18} color={colors.white} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={20} color={colors.textFaint} /> : null)}
    </>
  );
  // A row you can't tap (for example one with a switch) is a plain row that looks the same. It is not a
  // "disabled" button: screen readers would then call the switch inside it disabled.
  if (!onPress) return <View style={styles.row}>{inside}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      {inside}
    </Pressable>
  );
}

const openLegal = (doc: LegalPage) => router.push({ pathname: '/legal/[doc]', params: { doc } });
// The contact email from the Terms (shown once it's been filled in).
const CONTACT = contactEmail(LEGAL_DOCS.terms);

// The theme buttons. Plus themes show a little colour sample (background + button colour) instead of an emoji.
const THEMES: { key: ThemeChoice; label: string; emoji?: string; swatch?: [string, string]; plus?: boolean }[] = [
  { key: 'dark', label: 'Dark', emoji: '🌙' },
  { key: 'light', label: 'Light', emoji: '☀️' },
  { key: 'system', label: 'Match phone', emoji: '📱' },
  { key: 'gold', label: 'Black & Gold', swatch: ['#050403', '#E9B44C'], plus: true },
  { key: 'midnight', label: 'Midnight', swatch: ['#0A0820', '#9BE7FF'], plus: true },
  { key: 'sunset', label: 'Sunset', swatch: ['#2B1A55', '#FF7A45'], plus: true },
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
    flexWrap: 'wrap',
    gap: space.sm,
    padding: space.sm,
  },
  theme: {
    // Three to a row.
    flexGrow: 1,
    flexBasis: '30%',
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
  themeLocked: {
    opacity: 0.55,
  },
  themeEmoji: {
    fontSize: 24,
    lineHeight: 30,
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  plusTag: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
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
