// Shared pieces for the 🕵️ group Guess Who screen tests (not a test file itself).
const { React, loadScreen, host } = require('./harness.cjs');

// A group Guess Who as the server sends it. By default someone else's, not guessed yet: no poster, no counts.
// It ends 5 hours from now.
const guessPost = (changes = {}) => ({
  id: 'g1', media_path: 'mystery/g1.jpg', media_type: 'photo', poster_path: null, overlay_path: null, caption: '',
  created_at: '2026-11-04T12:30:00Z', expires_at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
  mine: false, options: ['bob', 'carol', 'dave'], my_guess: null, poster: null, guess_count: null, right_count: null, others_count: 3,
  ...changes,
});

// Profiles of the people in the group, as fetchGroupGuesses returns them (the poster is one of them).
const profile = id => ({ id, username: id, display_name: id.toUpperCase(), avatar_path: `${id}/avatar.jpg` });
const guessPeople = (ids = ['alice', 'bob', 'carol', 'dave']) => new Map(ids.map(id => [id, profile(id)]));

// The real card component (src/components/groups/GroupGuessCard.tsx), with stand-ins for the animation library.
function loadGuessCard() {
  const chain = { springify: () => chain, damping: () => chain, stiffness: () => chain, delay: () => chain };
  const animatedHost = name => function AnimatedHost({ entering: _entering, ...props }) { return React.createElement(name, props, props.children); };
  return loadScreen('src/components/groups/GroupGuessCard.tsx', {
    'expo-image': { Image: host('ExpoImage') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: animatedHost('AnimatedView'), Text: animatedHost('Text') },
      ZoomIn: chain, FadeInDown: chain,
      Easing: { out: value => value, quad: 'quad' },
      useSharedValue: initial => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current,
      useAnimatedStyle: callback => callback(),
      withDelay: (_ms, value) => value,
      withTiming: value => value,
    },
  }).exports.GroupGuessCard;
}

module.exports = { guessPost, guessPeople, profile, loadGuessCard };
