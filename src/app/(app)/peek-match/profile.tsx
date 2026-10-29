import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useMe } from '@/lib/auth';
import {
  addDatingPhoto,
  ageFrom,
  DATING_PROMPTS,
  DISTANCES_KM,
  fetchMyDating,
  GENDERS,
  makeMainPhoto,
  MAX_PHOTOS,
  MIN_PHOTOS,
  removeDatingPhoto,
  roughLocation,
  saveDatingProfile,
  type DatingPhoto,
  type DatingPrompt,
  type Gender,
} from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import { useMediaUrls } from '@/lib/media';
import { fetchPeekMatchStatus } from '@/lib/peekMatch';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

type Spot = { lat: number; lng: number };

// Your Peek Match profile: photos, the basics, 3 prompts, and who you'd like to see.
export default function DatingProfileEditor() {
  const { userId, profile: myProfile } = useMe();
  const { showOptions, showToast } = useOverlays();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const [loaded, setLoaded] = useState(false);
  const [datingId, setDatingId] = useState<string | null>(null);
  const [age, setAge] = useState<number | null>(null);
  const [photos, setPhotos] = useState<DatingPhoto[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [area, setArea] = useState('');
  const [spot, setSpot] = useState<Spot | null>(null);
  const [locating, setLocating] = useState(false);
  const [prompts, setPrompts] = useState<DatingPrompt[]>(
    [0, 1, 2].map((position) => ({ position, prompt: DATING_PROMPTS[position], answer: '' })),
  );
  const [showGenders, setShowGenders] = useState<Gender[]>(['woman', 'man', 'nonbinary']);
  const [ageMin, setAgeMin] = useState(18);
  const [ageMax, setAgeMax] = useState(40);
  const [maxKm, setMaxKm] = useState(25);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([fetchPeekMatchStatus(userId), fetchMyDating(userId)])
      .then(([status, mine]) => {
        setDatingId(status.member?.dating_id ?? null);
        setAge(ageFrom(status.ageCheck?.verified_birthday));
        setPhotos(mine.photos);
        if (mine.profile) {
          setName(mine.profile.name);
          setGender(mine.profile.gender);
          setArea(mine.profile.area);
          setSpot({ lat: mine.profile.lat, lng: mine.profile.lng });
          setShowGenders(mine.profile.show_genders);
          setAgeMin(mine.profile.age_min);
          setAgeMax(mine.profile.age_max);
          setMaxKm(mine.profile.max_km);
        } else {
          setName((myProfile?.display_name || '').split(' ')[0] ?? '');
        }
        if (mine.prompts.length > 0) {
          setPrompts((current) => current.map((slot) => mine.prompts.find((p) => p.position === slot.position) ?? slot));
        }
        setLoaded(true);
      })
      .catch((error) => {
        Alert.alert('Could not load your dating profile', friendlyError(error));
        setLoaded(true);
      });
  }, [userId, myProfile?.display_name]);

  const urls = useMediaUrls(photos.map((photo) => photo.path));

  async function addPhoto() {
    if (!datingId || adding || photos.length >= MAX_PHOTOS) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [4, 5],
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return;
    setAdding(true);
    try {
      const position = photos.length === 0 ? 0 : Math.max(...photos.map((photo) => photo.position)) + 1;
      const added = await addDatingPhoto(userId, datingId, result.assets[0].uri, position);
      setPhotos((current) => [...current, added]);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (error) {
      Alert.alert('Could not add the photo', friendlyError(error));
    } finally {
      setAdding(false);
    }
  }

  function photoMenu(photo: DatingPhoto, index: number) {
    const options = [];
    if (index > 0) {
      options.push({
        label: 'Make this my main photo',
        onPress: async () => {
          try {
            await makeMainPhoto(photos, photo);
            setPhotos((current) => [photo, ...current.filter((p) => p.id !== photo.id)]);
          } catch (error) {
            Alert.alert('Something went wrong', friendlyError(error));
          }
        },
      });
    }
    options.push({
      label: 'Remove photo',
      destructive: true,
      onPress: async () => {
        try {
          await removeDatingPhoto(photo);
          setPhotos((current) => current.filter((p) => p.id !== photo.id));
        } catch (error) {
          Alert.alert('Could not remove it', friendlyError(error));
        }
      },
    });
    showOptions({ options });
  }

  async function findMyLocation() {
    setLocating(true);
    try {
      const found = await roughLocation();
      if (!found) {
        Alert.alert(
          'Location needed 📍',
          'Peek Match uses your rough location to find people near you. Nobody ever sees it – only a rough distance like "5 km away".',
        );
        return;
      }
      setSpot({ lat: found.lat, lng: found.lng });
      if (found.area && !area.trim()) setArea(found.area);
      showToast('Got your rough area 📍');
    } catch (error) {
      Alert.alert('Could not find your location', friendlyError(error));
    } finally {
      setLocating(false);
    }
  }

  function choosePrompt(position: number) {
    const taken = prompts.filter((p) => p.position !== position).map((p) => p.prompt);
    showOptions({
      title: 'Pick a prompt',
      options: DATING_PROMPTS.filter((prompt) => !taken.includes(prompt)).map((prompt) => ({
        label: prompt,
        onPress: () => setPrompts((current) => current.map((p) => (p.position === position ? { ...p, prompt } : p))),
      })),
    });
  }

  function toggleShow(key: Gender) {
    setShowGenders((current) =>
      current.includes(key) ? (current.length > 1 ? current.filter((g) => g !== key) : current) : [...current, key],
    );
  }

  const missing = [
    !name.trim() && 'your name',
    !gender && 'your gender',
    (!area.trim() || !spot) && 'your rough area (tap "Use my location")',
    prompts.some((p) => !p.answer.trim()) && 'answers to all 3 prompts',
  ].filter((item): item is string => !!item);

  async function save() {
    if (missing.length > 0 || !gender || !spot) {
      Alert.alert('Almost there!', `Please add ${missing.join(', ')}.`);
      return;
    }
    setSaving(true);
    try {
      await saveDatingProfile(
        userId,
        { name, gender, area, lat: spot.lat, lng: spot.lng, show_genders: showGenders, age_min: ageMin, age_max: ageMax, max_km: maxKm },
        prompts,
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(photos.length >= MIN_PHOTOS ? 'Dating profile saved 💘' : `Saved! Add ${MIN_PHOTOS - photos.length} more photo(s) to show it`);
      router.back();
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="My dating profile" />
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      </View>
    );
  }

  const tile = (width - space.lg * 2 - space.sm * 2) / 3;

  return (
    <View style={styles.fill}>
      <ScreenHeader title="My dating profile" />
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 100 }]} keyboardShouldPersistTaps="handled">
          <Text style={styles.note}>🙈 Only people in Peek Match see this – never your friends, posts or stories.</Text>

          <Section title={`Photos (${photos.length}/${MAX_PHOTOS})`} hint={`Add ${MIN_PHOTOS} to ${MAX_PHOTOS}. The first one is your main photo.`}>
            <View style={styles.photos}>
              {Array.from({ length: MAX_PHOTOS }, (_, index) => {
                const photo = photos[index];
                const size = { width: tile, height: tile * 1.25 };
                if (photo) {
                  const uri = urls[photo.path];
                  return (
                    <Pressable key={photo.id} style={[styles.photo, size]} onPress={() => photoMenu(photo, index)}>
                      {uri ? <Image source={{ uri, cacheKey: photo.path }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
                      {index === 0 ? <Text style={styles.mainTag}>Main</Text> : null}
                    </Pressable>
                  );
                }
                return (
                  <Pressable
                    key={`empty-${index}`}
                    style={[styles.photo, styles.emptyPhoto, size]}
                    onPress={addPhoto}
                    disabled={adding}
                    accessibilityLabel="Add a photo">
                    {adding && index === photos.length ? (
                      <ActivityIndicator color={colors.pink} />
                    ) : (
                      <Ionicons name="add" size={28} color={index < MIN_PHOTOS ? colors.pink : colors.textFaint} />
                    )}
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section title="The basics">
            <TextField label="First name" value={name} onChangeText={setName} maxLength={30} placeholder="Your first name" />
            <Text style={styles.label}>Age</Text>
            <Text style={styles.value}>{age ?? '–'} (from your ID check – can&apos;t be changed)</Text>
            <Text style={styles.label}>I am a…</Text>
            <View style={styles.chips}>
              {GENDERS.map((option) => (
                <Chip key={option.key} label={option.label} on={gender === option.key} onPress={() => setGender(option.key)} />
              ))}
            </View>
            <TextField
              label="Rough area"
              value={area}
              onChangeText={setArea}
              maxLength={40}
              placeholder="e.g. East London"
              hint="Shown on your profile. Your exact spot is never shown – only a rough distance."
            />
            <Button
              title={spot ? 'Update my location 📍' : 'Use my location 📍'}
              variant="secondary"
              small
              loading={locating}
              onPress={findMyLocation}
            />
          </Section>

          <Section title="Prompts" hint="Answer 3 – people can like and comment on your answers.">
            {prompts.map((slot) => (
              <View key={slot.position} style={styles.prompt}>
                <Pressable style={styles.promptHead} onPress={() => choosePrompt(slot.position)}>
                  <Text style={styles.promptText}>{slot.prompt}</Text>
                  <Ionicons name="swap-horizontal" size={18} color={colors.pink} />
                </Pressable>
                <TextInput
                  value={slot.answer}
                  onChangeText={(answer) =>
                    setPrompts((current) => current.map((p) => (p.position === slot.position ? { ...p, answer } : p)))
                  }
                  placeholder="Your answer…"
                  placeholderTextColor={colors.textFaint}
                  keyboardAppearance={keyboardAppearance}
                  selectionColor={colors.accent}
                  multiline
                  maxLength={200}
                  style={styles.answer}
                />
              </View>
            ))}
          </Section>

          <Section title="Who I'd like to see">
            <Text style={styles.label}>Show me</Text>
            <View style={styles.chips}>
              {GENDERS.map((option) => (
                <Chip key={option.key} label={option.plural} on={showGenders.includes(option.key)} onPress={() => toggleShow(option.key)} />
              ))}
            </View>
            <Text style={styles.label}>Ages</Text>
            <View style={styles.ages}>
              <Stepper value={ageMin} onChange={(v) => setAgeMin(Math.min(Math.max(18, v), ageMax))} />
              <Text style={styles.value}>to</Text>
              <Stepper value={ageMax} onChange={(v) => setAgeMax(Math.max(Math.min(99, v), ageMin))} />
            </View>
            <Text style={styles.label}>Up to</Text>
            <View style={styles.chips}>
              {DISTANCES_KM.map((km) => (
                <Chip key={km} label={`${km} km`} on={maxKm === km} onPress={() => setMaxKm(km)} />
              ))}
            </View>
          </Section>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
          <Button title="Save my dating profile" icon="heart" loading={saving} onPress={save} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Bouncy
      style={[styles.chip, on && styles.chipOn]}
      pressScale={0.92}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Bouncy>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <View style={styles.stepper}>
      <Pressable onPress={() => onChange(value - 1)} hitSlop={8} accessibilityLabel="Less">
        <Ionicons name="remove-circle" size={30} color={colors.pink} />
      </Pressable>
      <Text style={styles.stepperValue}>{value}</Text>
      <Pressable onPress={() => onChange(value + 1)} hitSlop={8} accessibilityLabel="More">
        <Ionicons name="add-circle" size={30} color={colors.pink} />
      </Pressable>
    </View>
  );
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
    gap: space.xl,
  },
  note: {
    ...font.small,
    textAlign: 'center',
  },
  section: {
    gap: space.md,
  },
  sectionTitle: {
    ...font.heading,
  },
  hint: {
    ...font.small,
    marginTop: -space.sm,
  },
  label: {
    ...font.label,
  },
  value: {
    ...font.body,
    marginTop: -space.sm,
  },
  photos: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  photo: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPhoto: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  mainTag: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.pink,
    color: colors.white,
    fontWeight: '900',
    fontSize: 11,
    overflow: 'hidden',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chip: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: {
    backgroundColor: colors.pink,
    borderColor: colors.pink,
  },
  chipText: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
  },
  chipTextOn: {
    color: colors.white,
  },
  prompt: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  promptHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  promptText: {
    ...font.body,
    fontWeight: '800',
    color: colors.pink,
    flexShrink: 1,
  },
  answer: {
    ...font.body,
    minHeight: 44,
    color: colors.text,
  },
  ages: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  stepperValue: {
    ...font.heading,
    minWidth: 32,
    textAlign: 'center',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.bg,
  },
});
