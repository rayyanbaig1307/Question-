const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount } = require('./harness.cjs');

// The dare box: a dare the safety rules don't allow shows why and is NOT sent; a fine one is sent.
function composer(notAllowed) {
  const sent = [];
  const Composer = loadScreen('src/components/DareComposer.tsx', {
    '@/lib/dareSafety': { checkDare: dare => notAllowed(dare) },
  }).exports.DareComposer;
  return { Composer, sent };
}

async function tryDare(dare, notAllowed) {
  const { Composer, sent } = composer(notAllowed);
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(Composer, { visible: true, friendName: 'Bob', onClose() {}, onSend: async d => { sent.push(d); return true; } })); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText(dare));
  await act(async () => tree.root.findByType('Button').props.onPress());
  const alerts = tree.root.findAll(node => node.props.accessibilityRole === 'alert').map(node => [].concat(node.props.children).join(''));
  await unmount(tree);
  return { sent, alerts };
}

test('a dare that breaks the rules shows why and is not sent', async () => {
  const { sent, alerts } = await tryDare('bad dare', () => 'Not allowed 🙏');
  assert.deepEqual(sent, []);
  assert.ok(alerts.includes('Not allowed 🙏'), JSON.stringify(alerts));
});

test('a fine dare is sent', async () => {
  const { sent, alerts } = await tryDare('Do 20 push-ups', () => null);
  assert.deepEqual(sent, ['Do 20 push-ups']);
  assert.deepEqual(alerts, []);
});
