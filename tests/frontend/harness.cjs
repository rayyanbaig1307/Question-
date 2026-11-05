const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const renderer = require('react-test-renderer');
const { execFileSync } = require('node:child_process');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, '../..');
const originalRevision = 'a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1';

function readSource(relative) {
  if (process.env.QA_ORIGINAL === '1') {
    return execFileSync('git', ['show', `${originalRevision}:${relative.replace(/\\/g, '/')}`], { cwd: root, encoding: 'utf8' });
  }
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function host(name) {
  return function Host(props) {
    if (name === 'Modal' && !props.visible) return null;
    return React.createElement(name, props, props.children);
  };
}

function loadScreen(relative, overrides = {}) {
  const calls = { alerts: [], toasts: [], routes: [], timers: [], intervals: new Map() };
  const componentNames = ['Avatar', 'Button', 'DareRulesSheet', 'PostPreview', 'StoryPreview', 'ScreenHeader', 'VideoClip', 'TextField', 'FormScreen', 'EmptyState', 'LegalText', 'KeyboardSafeView', 'StoryAvatar'];
  const modules = {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': {
      ...Object.fromEntries(['View', 'Text', 'Pressable', 'Switch', 'ScrollView', 'RefreshControl', 'KeyboardAvoidingView', 'Modal', 'Image', 'ActivityIndicator', 'TextInput'].map(name => [name, host(name)])),
      FlatList: props => React.createElement('FlatList', props,
        props.ListHeaderComponent,
        props.data?.length ? props.data.map((item, index) => React.createElement(React.Fragment, { key: props.keyExtractor?.(item, index) ?? index }, props.renderItem({ item, index }))) : props.ListEmptyComponent,
        props.ListFooterComponent),
      StyleSheet: { create: value => value, absoluteFill: {} },
      Platform: { OS: 'android' },
      Alert: { alert: (...args) => calls.alerts.push(args) },
      useWindowDimensions: () => ({ width: 320, height: 568 }),
    },
    '@expo/vector-icons/Ionicons': host('Ionicons'),
    'expo-haptics': { notificationAsync: async () => {}, impactAsync: async () => {}, selectionAsync: async () => {}, NotificationFeedbackType: { Success: 'success' }, ImpactFeedbackStyle: { Light: 'light' } },
    'expo-router': { router: Object.fromEntries(['back', 'push', 'replace', 'dismissTo'].map(name => [name, (...args) => calls.routes.push([name, ...args])])), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg' }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '@/theme': { colors: {}, font: {}, radius: {}, space: {} },
    '@/components/Overlays': { useOverlays: () => ({ showToast: (...args) => calls.toasts.push(args) }) },
    '@/lib/auth': { useMe: () => ({ userId: 'alice', profile: { id: 'alice', username: 'alice', display_name: 'Alice' } }) },
    '@/lib/errors': { friendlyError: e => e.message || String(e) },
    '@/lib/cleanWords': { checkClean: () => null },
    '@/lib/friends': { fetchFriends: async () => [] },
    '@/lib/media': { resizePhoto: async uri => uri },
    '@/lib/dares': { todayDareDay: () => '2026-11-04', useDare: () => ({ text: 'QA dare' }) },
    '@/lib/drop': { lateLabel: () => ({ onTime: true, text: 'On time' }) },
    '@/lib/legal': { useDareRulesAccepted: () => ({ accepted: true }) },
    '@/lib/chat': { sendSnap: async () => {} },
    '@/lib/posts': { createPost: async () => ({ id: 'qa-post', drop_late_seconds: 0 }) },
    '@/lib/stories': { createStory: async () => {} },
    '@/lib/storyRings': { refreshStoryBadges: async () => {}, setStoryRings: () => {}, useStoryBadge: () => null },
    '@/lib/guess': { postMystery: async () => {} },
    '@/components/SocialSignIn': { SOCIAL_SIGN_IN_AVAILABLE: false, SocialSignInButtons: host('SocialSignInButtons') },
  };
  for (const name of componentNames) modules[`@/components/${name === 'VideoClip' ? 'VideoClipSafe' : name}`] = { [name]: host(name) };
  Object.assign(modules, overrides);
  const source = readSource(relative);
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, console,
    setTimeout: callback => { calls.timers.push(callback); return calls.timers.length; }, clearTimeout: () => {},
    setInterval: callback => { const id = Symbol('interval'); calls.intervals.set(id, callback); return id; }, clearInterval: id => calls.intervals.delete(id),
    require: id => {
      if (!(id in modules)) throw new Error(`Missing isolated test mock for ${id}`);
      return modules[id];
    },
  });
  vm.runInContext(compiled, context, { filename: relative });
  return { Component: module.exports.default, exports: module.exports, calls, modules, getBinding: name => vm.runInContext(name, context) };
}

async function renderScreen(screen) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(screen.Component)); });
  return tree;
}
async function act(callback) { await renderer.act(async () => { await callback(); }); }
function textOf(node) { return typeof node === 'string' ? node : node.children?.map(textOf).join('') || ''; }
function button(tree, title) { return tree.root.findAllByType('Button').find(node => node.props.title === title || (title instanceof RegExp && title.test(node.props.title))); }
function option(tree, title) { return tree.root.findAllByType('Pressable').find(node => textOf(node).startsWith(title) || node.findAllByType('Text').some(child => textOf(child) === title)); }
async function unmount(tree) { await act(() => tree.unmount()); }

module.exports = { React, renderer, loadScreen, renderScreen, act, textOf, button, option, unmount, readSource, host };

