const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, act, host } = require('./harness.cjs');
const renderer = require('react-test-renderer');

// The swipeable Chat ← Camera → Home pages.
// Phones must keep the real native pager; the web gets a stand-in that tells the home screen the same things.

test('on phones the home pager is still the real native pager, animated the same way', () => {
  function NativePagerView() { return null; }
  const wrapped = [];
  const screen = loadScreen('src/components/home/HomePager.tsx', {
    'react-native': { Animated: { createAnimatedComponent: component => { wrapped.push(component); return { animated: component }; } } },
    'react-native-pager-view': { __esModule: true, default: NativePagerView },
  });
  assert.deepEqual(wrapped, [NativePagerView]);
  assert.equal(screen.exports.HomePager.animated, NativePagerView);
});

test('the home screen still sends the same pager settings and the native-driver swipe event', () => {
  const { readSource } = require('./harness.cjs');
  const source = readSource('src/app/(app)/index.tsx');
  assert.match(source, /import \{ HomePager, type HomePagerRef \} from '@\/components\/home\/HomePager'/);
  assert.doesNotMatch(source, /react-native-pager-view/, 'the screen must not load the native pager itself (it crashes the web)');
  const pager = source.slice(source.indexOf('<HomePager'), source.indexOf('</HomePager>'));
  for (const prop of ['ref={pager}', 'initialPage={START_PAGE}', 'onPageScroll={swipe.onPageScroll}', 'onPageScrollStateChanged=', 'onPageSelected=', 'Haptics.selectionAsync()']) {
    assert.ok(pager.includes(prop), `missing ${prop}`);
  }
  assert.match(source, /Animated\.event\(\[\{ nativeEvent: \{ position, offset \} \}\], \{ useNativeDriver: true \}\)/);
});

test('the app opens on Home, and the page, the swipe animation and the pager all start there together', () => {
  const { readSource } = require('./harness.cjs');
  const source = readSource('src/app/(app)/index.tsx');
  // The owner (7 Nov): Home first, not the camera.
  assert.match(source, /const START_PAGE = HOME;/);
  // If these disagreed, the camera could be switched on while Home is showing (or the tabs would point at the wrong page).
  assert.match(source, /useState\(START_PAGE\)/);
  assert.match(source, /new Animated\.Value\(START_PAGE\)/);
  assert.doesNotMatch(source, /useState\(CAMERA\)|new Animated\.Value\(CAMERA\)|initialPage=\{CAMERA\}/);
});

function loadWebPager() {
  const scrolls = [];
  const ScrollView = React.forwardRef(function ScrollView(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollTo: options => scrolls.push({ ...options }) }));
    return React.createElement('ScrollView', props, props.children);
  });
  const screen = loadScreen('src/components/home/HomePager.web.tsx', {
    'react-native': { View: host('View'), ScrollView, StyleSheet: { create: value => value } },
  });
  return { screen, scrolls };
}

test('the web pager starts on the first page asked for and reports swipes like the native pager', async () => {
  const { screen, scrolls } = loadWebPager();
  const events = [];
  const pager = React.createRef();
  let tree;
  await act(() => {
    tree = renderer.create(React.createElement(screen.exports.HomePager, {
      ref: pager,
      initialPage: 1,
      onPageScroll: event => events.push(['scroll', event.nativeEvent.position, Number(event.nativeEvent.offset.toFixed(3))]),
      onPageSelected: event => events.push(['selected', event.nativeEvent.position]),
      onPageScrollStateChanged: event => events.push(['state', event.nativeEvent.pageScrollState]),
    }, React.createElement('Page', { key: 'chat' }), React.createElement('Page', { key: 'camera' }), React.createElement('Page', { key: 'home' })));
  });
  // Nothing is shown until the pager knows its size.
  assert.equal(tree.root.findAllByType('ScrollView').length, 0);
  await act(() => tree.root.findByType('View').props.onLayout({ nativeEvent: { layout: { width: 300, height: 600 } } }));
  const scroller = tree.root.findByType('ScrollView');
  assert.equal(scroller.props.horizontal, true);
  assert.equal(scroller.props.pagingEnabled, true);
  // Three full-size pages, and it jumps (without animation) to the camera page.
  assert.deepEqual(tree.root.findAllByType('Page').length, 3);
  assert.deepEqual(scrolls, [{ x: 300, y: 0, animated: false }]);

  const scrollTo = x => act(() => scroller.props.onScroll({ nativeEvent: { contentOffset: { x, y: 0 } } }));
  // That jump is not a swipe: it is reported as a position only.
  await scrollTo(300);
  assert.deepEqual(events, [['scroll', 1, 0]]);
  events.length = 0;

  // A finger drags most of the way to Home and lets go there.
  await scrollTo(400);
  await scrollTo(550);
  assert.deepEqual(events, [['scroll', 1, 0.333], ['state', 'dragging'], ['scroll', 1, 0.833]]);
  events.length = 0;
  await scrollTo(600);
  await act(() => screen.calls.timers.at(-1)()); // the scroll has been still for a moment
  assert.deepEqual(events, [['scroll', 2, 0], ['selected', 2], ['state', 'idle']]);
  events.length = 0;

  // Tapping the Chat tab: the page is picked at once, then it glides there.
  await act(() => pager.current.setPage(0));
  assert.deepEqual(events, [['selected', 0], ['state', 'settling']]);
  assert.deepEqual(scrolls.at(-1), { x: 0, y: 0, animated: true });
  events.length = 0;
  await scrollTo(120);
  await scrollTo(0);
  await act(() => screen.calls.timers.at(-1)());
  assert.deepEqual(events, [['scroll', 0, 0.4], ['scroll', 0, 0], ['state', 'idle']]);
  events.length = 0;

  // Asking for the page you're already on does nothing.
  await act(() => pager.current.setPage(0));
  assert.deepEqual(events, []);
  // A page number that doesn't exist goes to the nearest real page.
  await act(() => pager.current.setPage(7));
  assert.deepEqual(events, [['selected', 2], ['state', 'settling']]);
  assert.deepEqual(scrolls.at(-1), { x: 600, y: 0, animated: true });
  await act(() => tree.unmount());
});

test('the web pager also accepts the phone-style swipe tracker object', async () => {
  const { screen } = loadWebPager();
  const seen = [];
  const tracker = { __getHandler: () => event => seen.push({ ...event.nativeEvent }) };
  let tree;
  await act(() => {
    tree = renderer.create(React.createElement(screen.exports.HomePager, { initialPage: 0, onPageScroll: tracker },
      React.createElement('Page', { key: 'a' }), React.createElement('Page', { key: 'b' })));
  });
  await act(() => tree.root.findByType('View').props.onLayout({ nativeEvent: { layout: { width: 200, height: 400 } } }));
  await act(() => tree.root.findByType('ScrollView').props.onScroll({ nativeEvent: { contentOffset: { x: 50, y: 0 } } }));
  assert.deepEqual(seen, [{ position: 0, offset: 0.25 }]);
  await act(() => tree.unmount());
});

test('on the web, swiping past the first page (Chat) does not make the browser go back a page', async () => {
  const { screen } = loadWebPager();
  let tree;
  await act(() => {
    tree = renderer.create(React.createElement(screen.exports.HomePager, { initialPage: 0 },
      React.createElement('Page', { key: 'a' }), React.createElement('Page', { key: 'b' })));
  });
  await act(() => tree.root.findByType('View').props.onLayout({ nativeEvent: { layout: { width: 200, height: 400 } } }));
  const flat = [tree.root.findByType('ScrollView').props.style].flat(Infinity).reduce((all, part) => ({ ...all, ...(part || {}) }), {});
  // A sideways swipe that runs out of pages stays inside the pager (on touch screens it would otherwise
  // count as the browser's "swipe back" gesture and leave the app).
  assert.equal(flat.overscrollBehaviorX, 'contain');
  await act(() => tree.unmount());
});

test('the web pager takes its settings from the same list as the phone pager', () => {
  const { readSource } = require('./harness.cjs');
  const phone = readSource('src/components/home/HomePager.tsx');
  const web = readSource('src/components/home/HomePager.web.tsx');
  // One shared list of settings (HomePagerProps), so the type check notices if the home screen starts
  // sending something new that the web pager doesn't know about.
  assert.match(phone, /export type HomePagerProps\b/);
  assert.match(web, /import type \{[^}]*\bHomePagerProps\b[^}]*\} from '\.\/HomePager'/);
  assert.match(web, /forwardRef<HomePagerRef, HomePagerProps>/);
  // The phone pager itself is still exactly the animated native pager.
  assert.match(phone, /= Animated\.createAnimatedComponent\(PagerView\)/);
});
