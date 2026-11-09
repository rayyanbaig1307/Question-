const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('typescript');
const { loadScreen, renderScreen, act, button, unmount, host, textOf, readSource } = require('./harness.cjs');

const message = (changes = {}) => ({ id: 'message1', group_id: 'squad', sender_id: 'bob', kind: 'text', body: 'Hello group 👋', media_path: null, poster_path: null, overlay_path: null, media_type: null, created_at: '2026-11-04T12:00:00Z', ...changes });
// The app's real "does this proof count?" rule from src/lib/groupChat.ts (the rest of that file is mocked below).
function realProofRules() {
  const compiled = ts.transpileModule(readSource('src/lib/groupChat.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: id => ({ './media': {}, './supabase': { supabase: {} } })[id] });
  return { proofOutcome: module.exports.proofOutcome, proofCounts: module.exports.proofCounts, canVoteOnProof: module.exports.canVoteOnProof };
}
// joinedAt: when the person on screen (alice) joined the group – by default before every message here.
function fixture({ messages = [message()], send, search, missing = false, members = ['alice', 'bob'], myVotes = new Map(), vote, fetchVotes, fetchMessages, pinned = null, joinedAt = async () => '2026-11-01T00:00:00Z', plus = false } = {}) {
  const calls = { stickers: [], pushed: [], sent: [], reports: [], pinned: [], deleted: [], options: [], reacted: [], stopped: 0, toasts: [], votes: [], voteFetches: [], joinFetches: [], loads: 0, onChange: null };
  const group = { id: 'squad', name: 'Squad', pinned_message_id: pinned, members: members.map(userId => ({ userId, profile: { id: userId, username: userId, display_name: userId } })) };
  const noop = () => {};
  const stop = () => { calls.stopped++; };
  const screen = loadScreen('src/app/(app)/groups/chat/[id].tsx', {
    'expo-router': { router: { push: to => calls.pushed.push(to) }, useFocusEffect: callback => require('./harness.cjs').React.useEffect(callback, [callback]), useLocalSearchParams: () => ({ id: 'squad' }) },
    '@/lib/plus': { usePlus: () => plus },
    'expo-image-picker': { launchImageLibraryAsync: async () => ({ canceled: true }) },
    'expo-image': { Image: host('ExpoImage') },
    '@/components/ScreenHeader': { ScreenHeader: host('ScreenHeader'), RoundIconButton: host('RoundIconButton') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/GroupFaces': { GroupFaces: host('GroupFaces') },
    '@/components/DareComposer': { DareComposer: host('DareComposer') },
    '@/components/MessageActions': Object.fromEntries(['MessageActions', 'ReactionChips', 'ReplyQuote'].map(name => [name, host(name)])),
    '@/components/VoiceNote': { MicButton: host('MicButton'), VoiceBubble: host('VoiceBubble') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/components/ZoomableImage': { ZoomableImage: host('ZoomableImage') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: value => calls.toasts.push(value), showOptions: value => calls.options.push(value) }) },
    '@/lib/groupChat': {
      ...realProofRules(),
      fetchGroupMessages: async () => { calls.loads++; return fetchMessages ? fetchMessages(calls.loads) : messages; }, fetchGroupReads: async () => new Map(), fetchGroupChats: async () => new Map(), markGroupChatRead: async () => {},
      subscribeToGroupChat: (_group, onChange) => { calls.onChange = onChange; return stop; }, subscribeToGroup: () => stop,
      fetchMyProofVotes: async (...args) => { calls.voteFetches.push(args); return fetchVotes ? fetchVotes(...args) : new Map(myVotes); },
      fetchMyGroupJoin: async (...args) => { calls.joinFetches.push(args); return joinedAt(...args); },
      voteGroupProof: async (...args) => { calls.votes.push(args); if (vote) return vote(...args); return { legit: 1, cap: 0, mine: args[2] }; },
      sendGroupSticker: async (...args) => { calls.stickers.push(args); return message({ id: 'sticker1', sender_id: 'alice', kind: 'sticker', sticker: args[1], body: `Sticker: ${args[1]}` }); },
      sendGroupMessage: async (...args) => { calls.sent.push(args); if (send) await send(...args); return message({ id: 'sent', sender_id: 'alice', body: args[1] }); },
      deleteGroupMessage: async value => { calls.deleted.push(value.id); },
      pinGroupMessage: async (...args) => { calls.pinned.push(args); }, searchGroupMessages: async (_group, query) => search ? search(query) : [],
    },
    '@/lib/groups': { fetchGroup: async () => missing ? null : group },
    '@/lib/media': { useMediaUrls: paths => Object.fromEntries(paths.map(path => [path, `file:///qa/${path}`])) },
    '@/lib/reactions': { fetchReactions: async () => new Map(), subscribeToReactions: () => stop, toggleReaction: async (...args) => calls.reacted.push(args) },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/typing': { useGroupTyping: () => ({ typing: [], onTextChange: noop, clearTyping: noop }) },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: value => calls.reports.push(value) }) },
    '@/lib/voice': { Audio: null },
  });
  return { screen, calls };
}
function messageMenu(tree) { return tree.root.findAllByType('Pressable').find(node => node.props.onLongPress).props.onLongPress(); }
function sendButton(tree) { return tree.root.findAllByType('IconButton').find(node => node.props.label === 'Send'); }

test('a group video can be opened and played with its sound', async () => {
  const { screen } = fixture({ messages: [message({ kind: 'video', media_type: 'video', media_path: 'bob/group/video.mp4' })] });
  const tree = await renderScreen(screen);
  try {
    const media = tree.root.findAllByType('Pressable').find(node => node.props.onLongPress);
    assert.equal(typeof media.props.onPress, 'function', 'a paused video needs a playback action');
    await act(() => media.props.onPress());
    assert.ok(tree.root.findAllByType('VideoClip').some(node => node.props.playing && node.props.muted === false));
    await act(() => button(tree, 'Close media').props.onPress());
    assert.equal(tree.root.findAllByType('VideoClip').filter(node => node.props.playing).length, 0);
  } finally { await unmount(tree); }
});

test('reporting a group message preserves the offending message ID', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => messageMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === 'Report').onPress());
    assert.equal(calls.reports[0].contentType, 'group_message');
    assert.equal(calls.reports[0].contentId, 'message1');
    assert.equal(calls.reports[0].user.id, 'bob');
  } finally { await unmount(tree); }
});

test('rapid group Send presses create only one message', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ send: () => pending });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('hello'));
    const press = sendButton(tree).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    release();
    await act(() => Promise.all([a, b]));
    assert.equal(calls.sent.length, 1);
  } finally { release(); await unmount(tree); }
});

test('the next draft survives while a group message is being sent', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen } = fixture({ send: () => pending });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('first message'));
    let sending;
    await act(async () => { sending = sendButton(tree).props.onPress(); await Promise.resolve(); });
    await act(() => tree.root.findByType('TextInput').props.onChangeText('my next message'));
    release();
    await act(() => sending);
    assert.equal(tree.root.findByType('TextInput').props.value, 'my next message');
  } finally { release(); await unmount(tree); }
});

test('group reply attaches the selected message ID', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => messageMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === '↩ Reply').onPress());
    await act(() => tree.root.findByType('TextInput').props.onChangeText('reply 👋'));
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(calls.sent[0], ['squad', 'reply 👋', 'message1']);
  } finally { await unmount(tree); }
});

test('group pin and own-message delete point to the selected message', async () => {
  const { screen, calls } = fixture({ messages: [message({ sender_id: 'alice' })] });
  const tree = await renderScreen(screen);
  try {
    await act(() => messageMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === '📌 Pin to the top').onPress());
    assert.deepEqual(calls.pinned[0], ['squad', 'message1']);
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === 'Delete for everyone').onPress());
    assert.deepEqual(calls.deleted, ['message1']);
  } finally { await unmount(tree); }
});

test('a removed group hides the composer and every message', async () => {
  const { screen } = fixture({ missing: true });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('TextInput').length, 0);
    assert.equal(tree.root.findByType('EmptyState').props.title, 'This group is gone');
  } finally { await unmount(tree); }
});

test('leaving a group chat removes every subscription and polling timer', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  assert.equal(screen.calls.intervals.size, 1);
  await unmount(tree);
  assert.equal(screen.calls.intervals.size, 0);
  assert.equal(calls.stopped, 3);
});

test('an older group search response cannot erase newer matching results', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ search: query => query === 'old' ? delayed : [message({ id: 'fresh', body: 'fresh match' })] });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('ScreenHeader').props.right.props.onPress());
    await act(() => calls.options[0].options.find(item => item.label.includes('Search')).onPress());
    const input = () => tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'Search this chat');
    let old;
    await act(async () => { old = input().props.onChangeText('old'); await Promise.resolve(); });
    await act(() => input().props.onChangeText('fresh'));
    release([message({ id: 'old', body: 'old match' })]);
    await act(() => old);
    assert.equal(tree.root.findByType('FlatList').props.data[0]?.body, 'fresh match');
  } finally { release([]); await unmount(tree); }
});

// ---------------------------------------------------------------------------
// Group dares: the group votes Legit 🔥 or Cap 🧢 on each proof.
// ---------------------------------------------------------------------------
const dare = (changes = {}) => message({ id: 'dare1', sender_id: 'carol', kind: 'dare', body: 'Do ten jumps', ...changes });
const proof = (id, sender, votes = {}) => message({ id, sender_id: sender, kind: 'proof', body: null, dare_id: 'dare1', media_path: `${sender}/group/${id}.jpg`, media_type: 'photo', proof_legit: 0, proof_cap: 0, proof_legacy: false, ...votes });
const texts = tree => tree.root.findAllByType('Text').map(textOf);
const voteButton = (tree, label) => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === label);
const voteButtons = tree => tree.root.findAllByType('Pressable').filter(node => /^(Vote (legit|cap)|You said)/.test(node.props.accessibilityLabel ?? ''));

test('a proof is labelled by what the group decided so far', async () => {
  const { screen } = fixture({ members: ['alice', 'bob', 'carol'], messages: [
    proof('waiting', 'bob'),
    proof('counts', 'bob', { proof_legit: 2, proof_cap: 1 }),
    proof('tie', 'bob', { proof_legit: 1, proof_cap: 1 }),
    proof('capped', 'bob', { proof_cap: 2 }),
    proof('old', 'bob', { proof_legacy: true }),
    proof('oldVoted', 'bob', { proof_legacy: true, proof_cap: 1 }),
    proof('mine', 'alice'),
    dare(),
  ] });
  const tree = await renderScreen(screen);
  try {
    const shown = texts(tree);
    for (const label of ['⏳ Legit or cap? Vote!', '✅ Legit – it counts', '⚖️ Tie – not decided', "🧢 Cap – doesn't count", '✅ Did the dare', '⏳ Waiting for votes']) {
      assert.ok(shown.includes(label), `missing "${label}" in ${JSON.stringify(shown)}`);
    }
    // An old proof that someone voted cap on follows the normal rule.
    assert.equal(shown.filter(text => text === "🧢 Cap – doesn't count").length, 2);
    // Totals, without saying who voted what.
    assert.ok(shown.includes('🔥 2 · 🧢 1'));
    assert.ok(shown.includes('🔥 1 · 🧢 1'));
    assert.ok(!shown.some(text => text.includes('Did the dare') && text !== '✅ Did the dare'));
  } finally { await unmount(tree); }
});

test('Legit and Cap buttons show for everyone except the poster, and your own vote is highlighted', async () => {
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'], myVotes: new Map([['theirs', true]]), messages: [
    proof('theirs', 'bob', { proof_legit: 2 }), proof('mine', 'alice', { proof_cap: 1 }), dare(),
  ] });
  const tree = await renderScreen(screen);
  try {
    // Your own votes are fetched once, for the proofs on screen.
    assert.deepEqual(calls.voteFetches, [['alice', ['theirs', 'mine']]]);
    // Two buttons, on bob's proof only (none on your own proof).
    assert.equal(voteButtons(tree).length, 2);
    const chosen = voteButton(tree, 'You said legit. Tap to take your vote back')[0];
    assert.equal(chosen.props.accessibilityState.selected, true);
    assert.equal(voteButton(tree, 'Vote cap')[0].props.accessibilityState.selected, false);
    assert.equal(voteButton(tree, 'Vote legit').length, 0);
    // The poster still sees the totals on their own proof.
    assert.ok(texts(tree).includes('🔥 0 · 🧢 1'));
  } finally { await unmount(tree); }
});

test('no Legit or Cap buttons on proofs posted before you joined the group, only on newer ones', async () => {
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'], joinedAt: async () => '2026-11-04T12:00:00Z', messages: [
    proof('before', 'bob', { created_at: '2026-11-04T11:59:59.999Z', proof_legit: 1 }),
    proof('same', 'carol', { created_at: '2026-11-04T12:00:00Z' }),
    proof('after', 'carol', { created_at: '2026-11-04T12:30:00Z' }),
    dare(),
  ] });
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(calls.joinFetches, [['squad', 'alice']]);
    // Buttons on the proof posted the moment you joined and on the newer one; none on the older one.
    assert.equal(voteButtons(tree).length, 4);
    const shown = texts(tree);
    assert.equal(shown.filter(text => text === "You joined after this was posted, so you can't vote on it").length, 1);
    // The older proof's totals still show, and its label doesn't ask you to vote.
    assert.ok(shown.includes('🔥 1 · 🧢 0'));
    assert.equal(shown.filter(text => text === '⏳ Legit or cap? Vote!').length, 2);
    assert.ok(shown.includes('✅ Legit – it counts'), 'the older proof still shows what the group decided');
    assert.ok(!shown.includes('⏳ Waiting for votes'));
  } finally { await unmount(tree); }
});

test('a proof from before you joined that has no votes yet says it is waiting for votes, not "Vote!"', async () => {
  const { screen } = fixture({ joinedAt: async () => '2026-11-05T00:00:00Z', messages: [proof('old', 'bob'), dare()] });
  const tree = await renderScreen(screen);
  try {
    const shown = texts(tree);
    assert.equal(voteButtons(tree).length, 0);
    assert.ok(shown.includes('⏳ Waiting for votes'), JSON.stringify(shown));
    assert.ok(!shown.includes('⏳ Legit or cap? Vote!'));
    assert.ok(shown.includes("You joined after this was posted, so you can't vote on it"));
  } finally { await unmount(tree); }
});

test('removed and added back while the chat stays open: the join time is read again, so the buttons go', async () => {
  // alice had joined before bob's proof. While her chat is open she is removed and added back (a later join).
  let joined = '2026-11-01T00:00:00Z';
  const { screen, calls } = fixture({ joinedAt: async () => joined, messages: [proof('p1', 'bob'), dare()] });
  const tree = await renderScreen(screen);
  try {
    assert.equal(voteButtons(tree).length, 2);
    joined = '2026-11-05T09:00:00Z';
    // The next live change reloads the chat, and with it the join time.
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await new Promise(r => setTimeout(r, 0)); });
    assert.equal(calls.joinFetches.length, 2);
    assert.equal(voteButtons(tree).length, 0);
    assert.ok(texts(tree).includes("You joined after this was posted, so you can't vote on it"));
    assert.ok(texts(tree).includes('⏳ Waiting for votes'));
  } finally { await unmount(tree); }
});

test('a refused vote reads the join time again, so buttons that can never work go away', async () => {
  let joined = '2026-11-01T00:00:00Z';
  const { screen, calls } = fixture({ joinedAt: async () => joined, messages: [proof('p1', 'bob'), dare()],
    vote: () => { joined = '2026-11-05T09:00:00Z'; throw Object.assign(new Error('Only people who were in the group when this proof was posted can vote'), { code: 'P0001' }); } });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { await voteButton(tree, 'Vote legit')[0].props.onPress(); await new Promise(r => setTimeout(r, 0)); });
    assert.match(calls.toasts.at(-1), /^Vote not saved – /);
    assert.equal(calls.joinFetches.length, 2);
    assert.equal(voteButtons(tree).length, 0);
    assert.ok(texts(tree).includes("You joined after this was posted, so you can't vote on it"));
  } finally { await unmount(tree); }
});

test('an older join-time answer that arrives after a newer one is dropped', async () => {
  const answers = [];
  const { screen, calls } = fixture({ joinedAt: () => new Promise(resolve => answers.push(resolve)), messages: [proof('p1', 'bob'), dare()] });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await new Promise(r => setTimeout(r, 0)); });
    assert.equal(answers.length, 2);
    // The newer answer (you joined after the proof) comes first; the older one (before it) comes late.
    await act(async () => { answers[1]('2026-11-05T09:00:00Z'); await new Promise(r => setTimeout(r, 0)); });
    await act(async () => { answers[0]('2026-11-01T00:00:00Z'); await new Promise(r => setTimeout(r, 0)); });
    assert.equal(voteButtons(tree).length, 0);
  } finally { await unmount(tree); }
});

test('if your join time can\'t be loaded, the buttons still show and the server decides', async () => {
  const { screen, calls } = fixture({ joinedAt: async () => { throw new Error('offline'); }, messages: [proof('p1', 'bob'), dare()],
    vote: () => { throw Object.assign(new Error('Only people who were in the group when this proof was posted can vote'), { code: 'P0001' }); } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(voteButtons(tree).length, 2);
    await act(() => voteButton(tree, 'Vote legit')[0].props.onPress());
    assert.equal(calls.votes.length, 1);
    assert.match(calls.toasts.at(-1), /^Vote not saved – /);
    assert.equal(voteButton(tree, 'Vote legit').length, 1, 'nothing is highlighted after a refused vote');
  } finally { await unmount(tree); }
});

test('tapping your vote again takes it back, tapping the other one changes it, with a toast each time', async () => {
  let server = { legit: 2, cap: 0, mine: true };
  const { screen, calls } = fixture({ myVotes: new Map([['p1', true]]), messages: [proof('p1', 'bob', { proof_legit: 2 }), dare()],
    vote: (_me, _id, legit) => { server = { legit: legit === true ? 2 : 1, cap: legit === false ? 1 : 0, mine: legit }; return server; } });
  const tree = await renderScreen(screen);
  try {
    await act(() => voteButton(tree, 'You said legit. Tap to take your vote back')[0].props.onPress());
    assert.deepEqual(calls.votes[0], ['alice', 'p1', null]);
    assert.equal(calls.toasts.at(-1), 'Vote taken back');
    assert.ok(texts(tree).includes('🔥 1 · 🧢 0'));
    assert.equal(voteButton(tree, 'Vote legit').length, 1, 'nothing is highlighted after taking the vote back');
    await act(() => voteButton(tree, 'Vote cap')[0].props.onPress());
    assert.deepEqual(calls.votes[1], ['alice', 'p1', false]);
    assert.equal(calls.toasts.at(-1), 'You called cap 🧢');
    assert.equal(voteButton(tree, 'You said cap. Tap to take your vote back').length, 1);
    assert.ok(texts(tree).includes('🔥 1 · 🧢 1'));
    await act(() => voteButton(tree, 'Vote legit')[0].props.onPress());
    assert.deepEqual(calls.votes[2], ['alice', 'p1', true]);
    assert.equal(calls.toasts.at(-1), 'You said legit 🔥');
  } finally { await unmount(tree); }
});

test('a second tap while a vote is being sent does nothing', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ messages: [proof('p1', 'bob'), dare()], vote: () => pending });
  const tree = await renderScreen(screen);
  try {
    const legit = voteButton(tree, 'Vote legit')[0].props.onPress;
    await act(async () => { legit(); legit(); await Promise.resolve(); });
    assert.equal(voteButton(tree, 'Vote cap')[0].props.disabled, true, 'the buttons wait while the vote is sent');
    await act(async () => { voteButton(tree, 'Vote cap')[0].props.onPress(); await Promise.resolve(); });
    assert.equal(calls.votes.length, 1);
    release({ legit: 1, cap: 0, mine: true });
    await act(() => pending);
    assert.equal(voteButton(tree, 'Vote cap')[0].props.disabled, false);
  } finally { release({ legit: 1, cap: 0, mine: true }); await unmount(tree); }
});

test('a vote the server refuses shows a toast (an alert would not show on the web) and changes nothing', async () => {
  const { screen, calls } = fixture({ messages: [proof('p1', 'bob', { proof_legit: 1 }), dare()], vote: async () => { throw new Error('Only people in this group can vote'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => voteButton(tree, 'Vote cap')[0].props.onPress());
    assert.equal(calls.toasts.at(-1), 'Vote not saved – Only people in this group can vote');
    assert.equal(screen.calls.alerts.length, 0);
    assert.ok(texts(tree).includes('🔥 1 · 🧢 0'));
    assert.equal(voteButton(tree, 'Vote cap').length, 1, 'no vote is highlighted');
    assert.equal(voteButton(tree, 'Vote cap')[0].props.disabled, false, 'you can try again');
  } finally { await unmount(tree); }
});

test('the dare card counts only proofs that count, and "Do it" comes back while none of yours counts', async () => {
  const members = ['alice', 'bob', 'carol'];
  const card = tree => texts(tree).find(text => /did it|Nobody has done it|Everyone did it/.test(text));
  const doIt = tree => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === 'Do it and post proof');
  const render = async list => { const { screen } = fixture({ members, messages: [...list, dare()] }); return renderScreen(screen); };
  // bob's proof counts, carol's was called cap, yours is waiting.
  let tree = await render([proof('a', 'alice'), proof('b', 'bob', { proof_legit: 2 }), proof('c', 'carol', { proof_cap: 2 })]);
  try {
    assert.equal(card(tree), '1 of 3 did it: bob');
    assert.equal(doIt(tree).length, 1);
    assert.ok(texts(tree).includes('⏳ Your proof is waiting for votes'));
    assert.ok(!texts(tree).includes('✅ You did it'));
  } finally { await unmount(tree); }
  // Your newest proof was called cap (an older one is a tie): post new proof.
  tree = await render([proof('a2', 'alice', { proof_cap: 1 }), proof('a1', 'alice', { proof_legit: 1, proof_cap: 1 })]);
  try {
    assert.equal(card(tree), 'Nobody has done it yet');
    assert.equal(doIt(tree).length, 1);
    assert.ok(texts(tree).includes('🧢 The group said cap – post new proof?'));
  } finally { await unmount(tree); }
  // One of your proofs counts: done, even if a newer one was called cap.
  tree = await render([proof('a2', 'alice', { proof_cap: 1 }), proof('a1', 'alice', { proof_legit: 1 }), proof('b', 'bob', { proof_legacy: true })]);
  try {
    assert.equal(card(tree), '2 of 3 did it: you, bob');
    assert.equal(doIt(tree).length, 0);
    assert.ok(texts(tree).includes('✅ You did it'));
  } finally { await unmount(tree); }
  // Everyone's proof counts.
  tree = await render([proof('a', 'alice', { proof_legit: 1 }), proof('b', 'bob', { proof_legit: 2, proof_cap: 1 }), proof('c', 'carol', { proof_legit: 1 })]);
  try {
    assert.equal(card(tree), '🔥 Everyone did it!');
  } finally { await unmount(tree); }
  // A tie for everyone: nobody has done it.
  tree = await render([proof('a', 'alice', { proof_legit: 1, proof_cap: 1 }), proof('b', 'bob', { proof_legit: 1, proof_cap: 1 })]);
  try {
    assert.equal(card(tree), 'Nobody has done it yet');
    assert.ok(texts(tree).includes("⚖️ Your proof is a tie so far – it doesn't count yet"));
  } finally { await unmount(tree); }
});

test('a live vote from someone else changes only the totals, without loading the whole chat again', async () => {
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'], messages: [proof('p1', 'bob'), dare()] });
  const tree = await renderScreen(screen);
  try {
    const loadsBefore = calls.loads;
    await act(() => calls.onChange({ event: 'UPDATE', message: { id: 'p1', proof_legit: 2, proof_cap: 1 } }));
    assert.equal(calls.loads, loadsBefore);
    assert.ok(texts(tree).includes('🔥 2 · 🧢 1'));
    assert.ok(texts(tree).includes('✅ Legit – it counts'));
    assert.equal(texts(tree).find(text => text.includes('did it')), '1 of 3 did it: bob');
    // A new message still loads the chat.
    await act(() => calls.onChange({ event: 'INSERT', message: { id: 'new' } }));
    assert.equal(calls.loads, loadsBefore + 1);
  } finally { await unmount(tree); }
});

test('a proof without vote totals (a server without votes yet) counts at once and has no vote buttons; one with totals has them', async () => {
  const old = message({ id: 'p1', sender_id: 'bob', kind: 'proof', body: null, dare_id: 'dare1', media_path: 'bob/group/p1.jpg', media_type: 'photo' });
  const { screen } = fixture({ members: ['alice', 'bob', 'carol'], messages: [proof('p2', 'carol'), old, dare()] });
  const tree = await renderScreen(screen);
  try {
    assert.ok(texts(tree).includes('✅ Did the dare'));
    assert.ok(texts(tree).includes('⏳ Legit or cap? Vote!'));
    // Two buttons: on carol's proof only.
    assert.equal(voteButtons(tree).length, 2);
    assert.equal(texts(tree).find(text => text.includes('did it')), '1 of 3 did it: bob');
  } finally { await unmount(tree); }
});

test('the person who sent the dare gets Legit and Cap on the others\' proofs, but not on their own proof', async () => {
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'], messages: [proof('bobs', 'bob'), proof('alices', 'alice'), dare({ sender_id: 'alice' })] });
  const tree = await renderScreen(screen);
  try {
    assert.equal(voteButtons(tree).length, 2);
    await act(() => voteButton(tree, 'Vote legit')[0].props.onPress());
    assert.deepEqual(calls.votes, [['alice', 'bobs', true]]);
    assert.ok(texts(tree).includes('⏳ Waiting for votes'));
  } finally { await unmount(tree); }
});

test('an old proof counts until someone votes, and the others can still vote on it', async () => {
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'], messages: [proof('old', 'bob', { proof_legacy: true }), dare()],
    vote: (_me, _id, legit) => (legit === null ? { legit: 0, cap: 0, mine: null, legacy: false } : { legit: 0, cap: 1, mine: false, legacy: false }) });
  const tree = await renderScreen(screen);
  try {
    assert.ok(texts(tree).includes('✅ Did the dare'));
    assert.equal(texts(tree).find(text => text.includes('did it')), '1 of 3 did it: bob');
    await act(() => voteButton(tree, 'Vote cap')[0].props.onPress());
    assert.deepEqual(calls.votes, [['alice', 'old', false]]);
    assert.ok(texts(tree).includes("🧢 Cap – doesn't count"));
    assert.ok(texts(tree).includes('Nobody has done it yet'));
    // Taking the vote back: once anyone has voted, it is no longer an old proof, so it waits for votes.
    await act(() => voteButton(tree, 'You said cap. Tap to take your vote back')[0].props.onPress());
    assert.ok(texts(tree).includes('⏳ Legit or cap? Vote!'));
    assert.ok(!texts(tree).includes('✅ Did the dare'));
    assert.ok(texts(tree).includes('Nobody has done it yet'));
  } finally { await unmount(tree); }
});

test('an older "your votes" answer that arrives after you voted does not undo your vote', async () => {
  const answers = [];
  const { screen, calls } = fixture({ messages: [proof('p1', 'bob'), dare()], fetchVotes: () => new Promise(resolve => answers.push(resolve)) });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { answers[0](new Map()); });
    // A new message arrives: the chat loads again, and that "your votes" answer is still on its way.
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await new Promise(r => setTimeout(r, 0)); });
    assert.equal(answers.length, 2);
    await act(() => voteButton(tree, 'Vote legit')[0].props.onPress());
    assert.equal(voteButton(tree, 'You said legit. Tap to take your vote back').length, 1);
    await act(async () => { answers[1](new Map()); });
    assert.equal(voteButton(tree, 'You said legit. Tap to take your vote back').length, 1);
  } finally { answers.forEach(resolve => resolve(new Map())); await unmount(tree); }
});

test('an older "your votes" answer cannot replace a newer one', async () => {
  const answers = [];
  const { screen, calls } = fixture({ messages: [proof('p1', 'bob'), dare()], fetchVotes: () => new Promise(resolve => answers.push(resolve)) });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await new Promise(r => setTimeout(r, 0)); });
    assert.equal(answers.length, 2);
    await act(async () => { answers[1](new Map([['p1', true]])); });
    await act(async () => { answers[0](new Map()); });
    assert.equal(voteButton(tree, 'You said legit. Tap to take your vote back').length, 1);
  } finally { answers.forEach(resolve => resolve(new Map())); await unmount(tree); }
});

test('if your votes can\'t be loaded, the screen keeps the ones it shows', async () => {
  let fail = false;
  const { screen, calls } = fixture({ messages: [proof('p1', 'bob'), dare()], myVotes: new Map([['p1', true]]),
    fetchVotes: async () => { if (fail) throw new Error('Network request failed'); return new Map([['p1', true]]); } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(voteButton(tree, 'You said legit. Tap to take your vote back').length, 1);
    fail = true;
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await new Promise(r => setTimeout(r, 0)); });
    assert.equal(calls.voteFetches.length, 2);
    assert.equal(voteButton(tree, 'You said legit. Tap to take your vote back').length, 1);
  } finally { await unmount(tree); }
});

test('a reply to a proof and a pinned proof say "📸 Dare proof", never that the dare is done', async () => {
  const { screen } = fixture({ pinned: 'p1', messages: [message({ id: 'r1', sender_id: 'carol', body: 'no way', reply_to: 'p1' }), proof('p1', 'bob'), dare()] });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findByType('ReplyQuote').props.text, '📸 Dare proof');
    assert.ok(texts(tree).some(text => text.endsWith('📸 Dare proof')), JSON.stringify(texts(tree)));
    assert.ok(!texts(tree).some(text => text.includes('Did the dare')));
  } finally { await unmount(tree); }
});

test('a vote answer that arrives after a newer live update does not put old totals back', async () => {
  let release;
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol', 'dave'], messages: [proof('p1', 'bob'), dare()], vote: () => new Promise(resolve => { release = resolve; }) });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { voteButton(tree, 'Vote legit')[0].props.onPress(); await Promise.resolve(); });
    // Your vote, then dave's, arrive live before the answer to your vote.
    await act(() => calls.onChange({ event: 'UPDATE', message: { id: 'p1', proof_legit: 1, proof_cap: 0 } }));
    await act(() => calls.onChange({ event: 'UPDATE', message: { id: 'p1', proof_legit: 1, proof_cap: 1 } }));
    await act(async () => { release({ legit: 1, cap: 0, mine: true }); });
    assert.ok(texts(tree).includes('🔥 1 · 🧢 1'));
    assert.ok(texts(tree).includes('⚖️ Tie – not decided'));
    assert.equal(voteButton(tree, 'You said legit. Tap to take your vote back').length, 1);
    assert.equal(texts(tree).find(text => /did it|Nobody has done it/.test(text)), 'Nobody has done it yet');
  } finally { release?.({ legit: 1, cap: 0, mine: true }); await unmount(tree); }
});

test('a chat reload that set off before a live vote update does not put the old totals back', async () => {
  let release;
  const first = [proof('p1', 'bob'), dare()];
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'],
    fetchMessages: n => (n === 1 ? first : new Promise(resolve => { release = resolve; })) });
  const tree = await renderScreen(screen);
  try {
    // A new message arrives (the chat loads again), then a live vote before that load comes back.
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await Promise.resolve(); });
    await act(() => calls.onChange({ event: 'UPDATE', message: { id: 'p1', proof_legit: 2, proof_cap: 1 } }));
    await act(async () => { release([message({ id: 'new', sender_id: 'carol', body: 'look at this' }), ...first]); });
    assert.ok(texts(tree).includes('look at this'));
    assert.ok(texts(tree).includes('🔥 2 · 🧢 1'));
    assert.ok(texts(tree).includes('✅ Legit – it counts'));
  } finally { release?.(first); await unmount(tree); }
});

test('a chat reload brings in vote totals that changed while nothing was shown live', async () => {
  let list = [proof('p1', 'bob'), dare()];
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'], fetchMessages: () => list });
  const tree = await renderScreen(screen);
  try {
    list = [message({ id: 'new', sender_id: 'carol', body: 'hi' }), proof('p1', 'bob', { proof_cap: 2 }), dare()];
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await new Promise(r => setTimeout(r, 0)); });
    assert.ok(texts(tree).includes('🔥 0 · 🧢 2'));
    assert.ok(texts(tree).includes("🧢 Cap – doesn't count"));
  } finally { await unmount(tree); }
});

test('a chat reload that set off before your vote was answered does not put the old totals back', async () => {
  let release;
  const first = [proof('p1', 'bob'), dare()];
  const saved = new Map();   // your votes as the server has them
  const { screen, calls } = fixture({ members: ['alice', 'bob', 'carol'],
    fetchMessages: n => (n === 1 ? first : new Promise(resolve => { release = resolve; })),
    fetchVotes: async () => new Map(saved),
    vote: (_me, id, legit) => { saved.set(id, legit); return { legit: 1, cap: 0, mine: legit }; } });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { calls.onChange({ event: 'INSERT', message: { id: 'new' } }); await Promise.resolve(); });
    await act(() => voteButton(tree, 'Vote legit')[0].props.onPress());
    await act(async () => { release([message({ id: 'new', sender_id: 'carol', body: 'look at this' }), ...first]); });
    assert.ok(texts(tree).includes('look at this'));
    assert.ok(texts(tree).includes('🔥 1 · 🧢 0'));
    assert.equal(voteButton(tree, 'You said legit. Tap to take your vote back').length, 1);
  } finally { release?.(first); await unmount(tree); }
});

// 🏷️ Stickers in group chats: free ones send, Peekaboo+ ones only with Peekaboo+.
for (const [plus, id, sends] of [[false, 'caught', true], [false, 'plus-bff', false], [true, 'plus-bff', true]]) {
  test(`group sticker ${id} ${plus ? 'with' : 'without'} Peekaboo+: ${sends ? 'sent' : 'not sent, Peekaboo+ opens'}`, async () => {
    const { screen, calls } = fixture({ plus });
    const tree = await renderScreen(screen);
    await act(async () => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Send a sticker').props.onPress());
    await act(async () => tree.root.findByType('StickerPicker').props.onPickSpecial(id));
    assert.deepEqual(calls.stickers.map(args => args.slice(0, 2)), sends ? [['squad', id]] : []);
    assert.deepEqual(calls.pushed, sends ? [] : ['/plus']);
    if (sends) assert.deepEqual(tree.root.findAllByType('ChatSticker').map(node => node.props.id), [id]);
    await unmount(tree);
  });
}
