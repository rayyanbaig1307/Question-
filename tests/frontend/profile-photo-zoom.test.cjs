const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, unmount, host } = require('./harness.cjs');

// Tapping (or pressing and holding) a profile picture shows it big, like Instagram.
const bob = { id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: 'bob/avatar.jpg', is_private: false, bio: null };

function screen({ story = null } = {}) {
  return loadScreen('src/app/(app)/profile/[id].tsx', {
    'expo-router': { router: { push() {} }, useFocusEffect: callback => require('./harness.cjs').React.useEffect(callback, [callback]), useLocalSearchParams: () => ({ id: 'bob' }) },
    '@/components/FriendButton': { FriendButton: host('FriendButton') },
    '@/components/HitUpButton': { HitUpButton: host('HitUpButton') },
    '@/components/Overlays': { useOverlays: () => ({ showOptions() {}, showToast() {} }) },
    '@/components/PlusBadge': { PlusBadge: host('PlusBadge') },
    '@/components/PostGrid': { PostGrid: props => require('./harness.cjs').React.createElement('PostGrid', props, props.header) },
    '@/components/ScreenHeader': { ScreenHeader: host('ScreenHeader'), RoundIconButton: host('RoundIconButton'), BrandIconButton: host('BrandIconButton') },
    '@/components/SongCard': { SongCard: host('SongCard') },
    '@/components/StoryAvatar': { StoryAvatar: host('StoryAvatar') },
    '@/components/ProfilePhotoZoom': { ProfilePhotoZoom: host('ProfilePhotoZoom'), zoomBuzz() {} },
    '@/lib/friends': { fetchRelation: async () => ({ kind: 'friends' }) },
    '@/lib/insights': { recordProfileView() {} },
    '@/lib/posts': { fetchUserPosts: async () => [] },
    '@/lib/profiles': { fetchProfile: async () => bob, fetchProfileStats: async () => ({ posts: 0, friends: 1 }) },
    '@/lib/songs': { profileSong: () => null },
    '@/lib/stories': { fetchStoryRing: async () => story },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report() {}, confirmBlock() {} }) },
  });
}

for (const how of ['onPress', 'onLongPress']) {
  test(`${how === 'onPress' ? 'tapping' : 'pressing and holding'} the profile picture shows it big, and it closes again`, async () => {
    const tree = await renderScreen(screen());
    const zoom = () => tree.root.findByType('ProfilePhotoZoom');
    assert.equal(zoom().props.visible, false);
    await act(async () => tree.root.findByType('StoryAvatar').props[how]());
    assert.equal(zoom().props.visible, true);
    assert.equal(zoom().props.person.avatar_path, 'bob/avatar.jpg');
    await act(async () => zoom().props.onClose());
    assert.equal(zoom().props.visible, false);
    await unmount(tree);
  });
}
