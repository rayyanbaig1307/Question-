const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, textOf } = require('./harness.cjs');

// The public chat screen (18+, photos only): who gets in, and the menus on a photo.
const photo = (changes = {}) => ({ id: 'p1', sender_id: 'bob', media_path: 'bob/public/a.jpg', created_at: '2026-11-18T12:00:00Z', hidden: false, author: { id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: null }, ...changes });

function fixture({ status = 'ok', photos = [photo()] } = {}) {
  const calls = { routes: [], options: [], reports: [], deleted: [] };
  const screen = loadScreen('src/app/(app)/public-chat.tsx', {
    'expo-router': { router: { push: to => calls.routes.push(to) }, useFocusEffect: callback => React.useEffect(callback, [callback]) },
    'expo-image': { Image: host('ExpoImage') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/ZoomableImage': { ZoomableImage: host('ZoomableImage') },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions: value => calls.options.push(value) }) },
    '@/lib/media': { useMediaUrls: paths => Object.fromEntries(paths.map(p => [p, `https://files/${p}`])) },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: value => calls.reports.push(value) }) },
    '@/lib/publicChat': {
      PUBLIC_CHAT: 'public', usePublicChatStatus: () => status, fetchPublicPhotos: async () => photos,
      deletePublicPhoto: async value => calls.deleted.push(value.id), subscribeToPublicChat: () => () => {},
    },
  });
  return { screen, calls };
}
const allText = tree => tree.root.findAll(node => typeof node.type === 'string').map(textOf).join(' ');

test('under 18: no photos, just "not available"', async () => {
  const { screen } = fixture({ status: 'under_18' });
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findAllByType('ExpoImage').length, 0);
  assert.equal(tree.root.findByType('EmptyState').props.title, 'Not available');
  await unmount(tree);
});

test('no birthday yet: asks for it instead of showing the room', async () => {
  const { screen, calls } = fixture({ status: 'no_birthday' });
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findAllByType('ExpoImage').length, 0);
  await act(async () => tree.root.findByType('Button').props.onPress());
  assert.deepEqual(calls.routes, ['/birthday']);
  await unmount(tree);
});

test('an adult sees the photos; the camera button opens the public chat camera', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findAllByType('ExpoImage').length, 1);
  await act(async () => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Post a photo').props.onPress());
  assert.equal(JSON.stringify(calls.routes), JSON.stringify([{ pathname: '/camera', params: { group: 'public' } }]));
  await unmount(tree);
});

test("someone else's photo can be reported (with its id); your own can be deleted", async () => {
  const { screen, calls } = fixture({ photos: [photo(), photo({ id: 'p2', sender_id: 'alice', media_path: 'alice/public/b.jpg', author: { id: 'alice', username: 'alice', display_name: 'Alice', avatar_path: null } })] });
  const tree = await renderScreen(screen);
  const menus = tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === 'More');
  await act(async () => menus[0].props.onPress());
  await act(async () => calls.options[0].options.find(o => o.label === 'Report photo').onPress());
  assert.equal(calls.reports[0].contentType, 'public_photo');
  assert.equal(calls.reports[0].contentId, 'p1');
  assert.equal(calls.reports[0].user.id, 'bob');
  await act(async () => menus[1].props.onPress());
  assert.equal(calls.options[1].options.map(o => o.label).join(), 'Delete');
  await act(async () => calls.options[1].options[0].onPress());
  assert.deepEqual(calls.deleted, ['p2']);
  await unmount(tree);
});
