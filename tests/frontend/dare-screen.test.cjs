// The Daily Dare screen's link to community dare ideas. Ideas only become everyone's dare after the owner
// approves them (supabase/migrations/20261220000000_launch_safety.sql), so the link must not promise that a
// suggestion runs tomorrow.
const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, textOf, unmount, host } = require('./harness.cjs');

function dareScreen() {
  const routes = [];
  const screen = loadScreen('src/app/(app)/dare.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    'expo-router': {
      router: { push: route => routes.push(route) },
      useFocusEffect: callback => React.useEffect(callback, [callback]),
    },
    '@/components/PostGrid': { PostGrid: props => React.createElement('PostGrid', props, props.header, props.empty) },
    '@/lib/chat': { fetchDaresForMe: async () => [] },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/dareChain': {
      fetchDareChain: async () => ({ received: [], sent: [] }),
      fetchDareStreaks: async () => [],
      fetchForfeits: async () => [],
      MAX_DARES_PER_DAY: 3,
      nominationState: () => 'open',
      streakAtRisk: () => false,
      timeLeft: () => '1h',
    },
    '@/lib/communityDares': { syncCommunityDares: async () => {} },
    '@/lib/dares': {
      DARE_RULES: 'House rules',
      fetchDarePosts: async () => [],
      formatCountdown: () => '1h',
      nextDareAt: () => Date.now() + 3600000,
      todayDareDay: () => '2026-11-06',
      useDare: () => ({ text: 'QA dare', number: 1, author: null }),
    },
    '@/theme': { colors: {}, font: {}, gradients: { brand: [] }, radius: {}, space: {} },
  });
  return { screen, routes };
}

test('Dare screen: the dare ideas link says ideas are approved before they run, and opens the ideas', async () => {
  const { screen, routes } = dareScreen();
  const tree = await renderScreen(screen);
  try {
    await act(async () => {});
    const link = tree.root.findAll(node => node.type === 'Pressable' && node.props.accessibilityRole === 'link')
      .find(node => /Suggest/.test(textOf(node)));
    assert.ok(link, 'the ideas link is on the Dare screen');
    assert.match(textOf(link), /approve ideas before they run/);
    assert.doesNotMatch(textOf(link), /tomorrow/i, "a suggestion isn't promised to run tomorrow");
    await act(async () => { link.props.onPress(); });
    assert.deepEqual(routes, ['/dare-ideas']);
  } finally {
    await unmount(tree);
  }
});
