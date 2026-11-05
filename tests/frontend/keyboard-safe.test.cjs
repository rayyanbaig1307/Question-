// The message box stays above the keyboard (src/components/KeyboardSafeView.tsx + src/lib/keyboard.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('typescript');
const { React, renderer, act, host, readSource } = require('./harness.cjs');

// Loads the real component and the real keyboard code with a stand-in phone.
function load(os) {
  const listeners = new Map();
  const animations = [];
  const rn = {
    View: host('View'), KeyboardAvoidingView: host('KeyboardAvoidingView'), Platform: { OS: os },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    Keyboard: { addListener: (name, listener) => { listeners.set(name, listener); return { remove: () => listeners.delete(name) }; } },
    LayoutAnimation: { configureNext: config => animations.push(config), Types: { keyboard: 'keyboard' } },
  };
  const compile = (relative, modules) => {
    const module = { exports: {} };
    const code = ts.transpileModule(readSource(relative), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require: id => { if (!(id in modules)) throw new Error(`Missing mock for ${id}`); return modules[id]; } });
    return module.exports;
  };
  const keyboard = compile('src/lib/keyboard.ts', { react: React, 'react-native': rn });
  const view = compile('src/components/KeyboardSafeView.tsx', { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': rn, '@/lib/keyboard': keyboard });
  return { ...view, keyboard, listeners, animations };
}

async function render(loaded, props) {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(loaded.KeyboardSafeView, { style: { flex: 1 }, ...props }, React.createElement('Text', null, 'message box')));
  });
  return tree;
}
const lift = tree => {
  const style = [].concat(tree.root.findByType('View').props.style).filter(Boolean);
  return Object.assign({}, ...style).paddingBottom;
};

test('iPhone: the content moves up by the keyboard height, minus the home-bar space the box already keeps', async () => {
  const phone = load('ios');
  const tree = await render(phone, { bottomInset: 34 });
  try {
    assert.equal(lift(tree), 0);
    await act(() => phone.listeners.get('keyboardWillShow')({ duration: 250, endCoordinates: { height: 336, screenY: 508 } }));
    assert.equal(lift(tree), 302);
    assert.deepEqual(JSON.parse(JSON.stringify(phone.animations.at(-1))), { duration: 250, update: { type: 'keyboard' } });
    await act(() => phone.listeners.get('keyboardWillHide')({ duration: 250, endCoordinates: { height: 0, screenY: 844 } }));
    assert.equal(lift(tree), 0);
  } finally { await act(() => tree.unmount()); }
  assert.equal(phone.listeners.size, 0, 'leaving the screen stops listening to the keyboard');
});

test('iPhone with "Prefer Cross-Fade Transitions": iOS says the keyboard starts at 0, the box still moves up', async () => {
  // React Native's KeyboardAvoidingView treats this as "the keyboard covers nothing" – the bug in the owner's screenshot.
  const phone = load('ios');
  const tree = await render(phone, { bottomInset: 34 });
  try {
    await act(() => phone.listeners.get('keyboardWillShow')({ duration: 0, endCoordinates: { height: 336, screenY: 0 } }));
    assert.equal(lift(tree), 302);
  } finally { await act(() => tree.unmount()); }
});

test('iPhone: if the "will show" message is missed, the "did show" one still moves the box up (once)', async () => {
  const phone = load('ios');
  const tree = await render(phone, { bottomInset: 0 });
  try {
    await act(() => phone.listeners.get('keyboardDidShow')({ endCoordinates: { height: 300, screenY: 544 } }));
    assert.equal(lift(tree), 300);
    const before = phone.animations.length;
    await act(() => phone.listeners.get('keyboardDidShow')({ duration: 250, endCoordinates: { height: 300, screenY: 544 } }));
    assert.equal(phone.animations.length, before, 'no extra animation when nothing changes');
    await act(() => phone.listeners.get('keyboardDidHide')({}));
    assert.equal(lift(tree), 0);
  } finally { await act(() => tree.unmount()); }
});

test('Android keeps KeyboardAvoidingView exactly as before', async () => {
  const phone = load('android');
  const tree = await render(phone, { bottomInset: 24, androidBehavior: 'padding' });
  try {
    const avoiding = tree.root.findByType('KeyboardAvoidingView');
    assert.equal(avoiding.props.behavior, 'padding');
    assert.equal(avoiding.props.keyboardVerticalOffset, -24);
    assert.equal(phone.listeners.size, 0, 'no iPhone keyboard listeners on Android');
  } finally { await act(() => tree.unmount()); }
});

test('how much the keyboard covers: its height; only without a height, from where it starts', () => {
  const { keyboardOverlap } = load('ios').keyboard;
  assert.equal(keyboardOverlap({ height: 336, screenY: 508 }, 844), 336);
  assert.equal(keyboardOverlap({ height: 336, screenY: 0 }, 844), 336);
  assert.equal(keyboardOverlap({ height: 0, screenY: 500 }, 844), 344);
  assert.equal(keyboardOverlap({ height: 0, screenY: 0 }, 844), 0);
  assert.equal(keyboardOverlap({ height: 0, screenY: 900 }, 844), 0);
  assert.equal(keyboardOverlap(undefined, 844), 0);
});

test('both chat screens and the dare and hit-up boxes use it (the iPhone path), with the home-bar space taken off in chats', () => {
  for (const file of ['src/app/(app)/chat/[id].tsx', 'src/app/(app)/groups/chat/[id].tsx']) {
    const source = readSource(file);
    assert.match(source, /<KeyboardSafeView style=\{styles\.fill\} bottomInset=\{insets\.bottom\} androidBehavior="padding">/, file);
    assert.doesNotMatch(source, /<KeyboardAvoidingView/, file);
  }
  for (const file of ['src/components/DareComposer.tsx', 'src/components/HitUpButton.tsx']) {
    assert.match(readSource(file), /<KeyboardSafeView /, file);
    assert.doesNotMatch(readSource(file), /<KeyboardAvoidingView/, file);
  }
});
