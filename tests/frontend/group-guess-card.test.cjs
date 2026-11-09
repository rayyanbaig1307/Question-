const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, unmount, textOf } = require('./harness.cjs');
const { guessPost, guessPeople, loadGuessCard } = require('./group-guess-helpers.cjs');

// 🕵️ The group Guess Who card on its own (src/components/groups/GroupGuessCard.tsx). It must never give away who
// sent it before you guess: no name, no picture, and the sender looks just like everyone else you can pick.
const GroupGuessCard = loadGuessCard();

async function renderCard(post, changes = {}) {
  const calls = { guesses: [], opened: 0, menus: 0 };
  let tree;
  await act(async () => {
    tree = renderer.create(React.createElement(GroupGuessCard, {
      post, people: guessPeople(), now: Date.now(), mediaUrl: 'file:///qa/mystery/g1.jpg', posterUrl: undefined, overlayUrl: undefined,
      busy: false, animate: false,
      onGuess: choice => calls.guesses.push(choice), onOpen: () => { calls.opened++; }, onMenu: () => { calls.menus++; },
      ...changes,
    }));
  });
  return { tree, calls };
}
const texts = tree => tree.root.findAllByType('Text').map(textOf);
const pills = tree => tree.root.findAllByType('Bouncy');

test('before you guess: no name or picture of the sender, just everyone to pick from, each once', async () => {
  // bob sent it, and his profile is right there in `people` – the card must not use it to point at him.
  const { tree } = await renderCard(guessPost());
  try {
    const shown = texts(tree);
    assert.ok(shown.includes('🕵️ Who sent this?'));
    assert.ok(shown.includes('5h left') || shown.includes('4h left'), JSON.stringify(shown));
    assert.deepEqual(pills(tree).map(node => node.props.accessibilityLabel), ['Guess BOB', 'Guess CAROL', 'Guess DAVE']);
    // The only pictures are the three choices, all drawn the same way.
    assert.deepEqual(tree.root.findAllByType('Avatar').map(node => node.props.size), [26, 26, 26]);
    for (const name of ['BOB', 'CAROL', 'DAVE']) assert.equal(shown.filter(text => text === name).length, 1);
    assert.ok(!shown.some(text => /It was|Your Guess Who/.test(text)));
    assert.ok(shown.includes('3 people can guess'));
  } finally { await unmount(tree); }
});

test('counts are only shown once you have guessed, even if they came with the card', async () => {
  const { tree } = await renderCard(guessPost({ guess_count: 2, right_count: 1 }));
  try {
    assert.ok(!texts(tree).some(text => text.includes('guessed ·')));
  } finally { await unmount(tree); }
});

test('tapping a name makes your guess; while it is sent the names wait', async () => {
  const { tree, calls } = await renderCard(guessPost());
  try {
    await act(() => pills(tree).find(node => node.props.accessibilityLabel === 'Guess CAROL').props.onPress());
    assert.deepEqual(calls.guesses, ['carol']);
  } finally { await unmount(tree); }
  const busy = await renderCard(guessPost(), { busy: true });
  try {
    assert.ok(pills(busy.tree).every(node => node.props.disabled === true));
    assert.equal(busy.tree.root.findAllByType('ActivityIndicator').length, 1);
  } finally { await unmount(busy.tree); }
});

test('after a wrong guess: who it really was, what you picked, and the counts', async () => {
  const { tree } = await renderCard(guessPost({ my_guess: 'carol', poster: 'bob', guess_count: 2, right_count: 1 }));
  try {
    const shown = texts(tree);
    assert.ok(shown.includes('Nope! It was BOB 🙈'), JSON.stringify(shown));
    assert.ok(shown.includes('You guessed CAROL'));
    assert.ok(shown.includes('👀 2 of 3 guessed · 1 got it'));
    assert.equal(pills(tree).length, 0);
    assert.equal(tree.root.findAllByType('Avatar')[0].props.name, 'BOB');
  } finally { await unmount(tree); }
});

test('after a right guess: "You got it!", and no "You guessed"', async () => {
  const { tree } = await renderCard(guessPost({ my_guess: 'bob', poster: 'bob', guess_count: 1, right_count: 1 }), { animate: true });
  try {
    const shown = texts(tree);
    assert.ok(shown.includes('You got it! It was BOB 🎯'), JSON.stringify(shown));
    assert.ok(!shown.some(text => text.startsWith('You guessed')));
    assert.ok(shown.includes('👀 1 of 3 guessed · 1 got it'));
  } finally { await unmount(tree); }
});

test('your own Guess Who: no choices, no name, just the counts', async () => {
  const { tree } = await renderCard(guessPost({ mine: true, options: null, poster: 'alice', guess_count: 0, right_count: 0 }));
  try {
    const shown = texts(tree);
    assert.ok(shown.includes('🕵️ Your Guess Who'));
    assert.ok(shown.includes('👀 0 of 3 guessed · 0 got it'));
    assert.equal(pills(tree).length, 0);
    assert.equal(tree.root.findAllByType('Avatar').length, 0);
    assert.ok(!shown.some(text => /ALICE|It was/.test(text)));
  } finally { await unmount(tree); }
});

test('the ⋯ button and holding the photo open the menu; tapping the photo opens it', async () => {
  const { tree, calls } = await renderCard(guessPost({ mine: true, options: null, poster: 'alice', guess_count: 0, right_count: 0 }));
  try {
    const more = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Guess Who options');
    await act(() => more.props.onPress());
    const photo = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Open photo');
    await act(() => photo.props.onLongPress());
    assert.equal(calls.menus, 2);
    await act(() => photo.props.onPress());
    assert.equal(calls.opened, 1);
    assert.equal(tree.root.findByType('ExpoImage').props.source.uri, 'file:///qa/mystery/g1.jpg');
  } finally { await unmount(tree); }
});

test('the last hour counts down in minutes', async () => {
  const { tree } = await renderCard(guessPost({ expires_at: new Date(Date.now() + 20 * 60_000 + 30_000).toISOString() }));
  try {
    assert.ok(texts(tree).includes('20m left'), JSON.stringify(texts(tree)));
  } finally { await unmount(tree); }
});
