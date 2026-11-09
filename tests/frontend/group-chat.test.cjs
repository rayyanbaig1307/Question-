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
// guesses: what fetchGroupGuesses returns (null = a server without group Guess Who); fetchGuesses(n) instead
// answers the n-th load. card: a GroupGuessCard to use instead of the stand-in (e.g. the real one).
function fixture({ messages = [message()], send, search, missing = false, members = ['alice', 'bob'], myVotes = new Map(), vote, fetchVotes, fetchMessages, pinned = null, joinedAt = async () => '2026-11-01T00:00:00Z', plus = false, guesses = null, fetchGuesses, guessAnswer = async () => 'bob', card } = {}) {
  const calls = { stickers: [], pushed: [], sent: [], reports: [], pinned: [], deleted: [], options: [], reacted: [], stopped: 0, toasts: [], votes: [], voteFetches: [], joinFetches: [], loads: 0, onChange: null,
    reads: 0, guessFetches: [], guessListeners: [], guessStops: 0, guessed: [], mysteryReports: [], blocked: [], deletedGuesses: [] };
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
      fetchGroupMessages: async () => { calls.loads++; return fetchMessages ? fetchMessages(calls.loads) : messages; }, fetchGroupReads: async () => new Map(), fetchGroupChats: async () => new Map(), markGroupChatRead: async () => { calls.reads++; },
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
    // 🕵️ Group Guess Who: the list, its live listener, and the Guess Who calls the chat uses.
    '@/lib/groupGuess': {
      fetchGroupGuesses: async (...args) => { calls.guessFetches.push(args); return fetchGuesses ? fetchGuesses(calls.guessFetches.length) : guesses; },
      subscribeToGroupGuesses: (group, onChange) => { calls.guessListeners.push({ group, onChange }); return () => { calls.guessStops++; }; },
    },
    '@/lib/guess': {
      guessMystery: async (...args) => { calls.guessed.push(args); return guessAnswer(...args); },
      reportMystery: async (...args) => { calls.mysteryReports.push(args); },
      blockMysteryPoster: async id => { calls.blocked.push(id); },
      deleteMystery: async post => { calls.deletedGuesses.push(post.id); },
    },
    '@/lib/safety': { REPORT_REASONS: [{ code: 'spam', label: 'Spam 🗑️' }, { code: 'other', label: 'Something else 🤔' }] },
    ...(card ? { '@/components/groups/GroupGuessCard': { GroupGuessCard: card } } : {}),
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

// ---------------------------------------------------------------------------
// 🕵️ Guess Who in a group chat: a photo with no name on it; the group guesses who sent it. It is not a message,
// so the chat never shows a sender, avatar, reply, pin or reaction for it.
// ---------------------------------------------------------------------------
const { guessPost, guessPeople, loadGuessCard } = require('./group-guess-helpers.cjs');
const feed = (...posts) => ({ posts, people: guessPeople() });
const guessCards = tree => tree.root.findAllByType('GroupGuessCard');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
// (The screen runs in its own sandbox, so compare plain copies of its arrays.)
const plain = value => JSON.parse(JSON.stringify(value));
const keysOf = tree => { const list = tree.root.findByType('FlatList'); return plain(list.props.data.map(list.props.keyExtractor)); };

test('group Guess Whos sit between the messages by time, with their own keys, and end a run of messages', async () => {
  // The Guess Who has the same id as a message on purpose: their keys must still differ.
  const { screen } = fixture({
    messages: [message({ id: 'm3', body: 'later', created_at: '2026-11-04T13:00:00Z' }), message({ id: 'm1', body: 'earlier', created_at: '2026-11-04T12:00:00Z' })],
    guesses: feed(guessPost({ id: 'm1', created_at: '2026-11-04T12:30:00Z' })),
  });
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(keysOf(tree), ['m3', 'guess:m1', 'm1']);
    // bob's two messages are split by the Guess Who, so his name shows above both of them.
    assert.equal(texts(tree).filter(text => text === 'bob').length, 2);
    assert.equal(guessCards(tree).length, 1);
  } finally { await unmount(tree); }
});

test('without a Guess Who in between, a run of messages shows the name once (the run rule is unchanged)', async () => {
  const { screen } = fixture({
    messages: [message({ id: 'm3', body: 'later', created_at: '2026-11-04T13:00:00Z' }), message({ id: 'm1', body: 'earlier', created_at: '2026-11-04T12:00:00Z' })],
    guesses: feed(),
  });
  const tree = await renderScreen(screen);
  try {
    assert.equal(texts(tree).filter(text => text === 'bob').length, 1);
  } finally { await unmount(tree); }
});

test('a group Guess Who card is given no sender: no name, no avatar, no profile, never on your side', async () => {
  const { screen } = fixture({ members: ['alice', 'bob', 'carol', 'dave'], guesses: feed(guessPost()) });
  const tree = await renderScreen(screen);
  try {
    const [card] = guessCards(tree);
    const props = Object.keys(card.props).filter(key => key !== 'children').sort();
    assert.deepEqual(props, ['animate', 'busy', 'mediaUrl', 'now', 'onGuess', 'onMenu', 'onOpen', 'overlayUrl', 'people', 'post', 'posterUrl']);
    assert.equal(card.props.post.poster, null);
    // The card is not inside a message row, so no avatar or name is drawn next to it.
    let parent = card.parent;
    while (parent) { assert.notEqual(parent.type, 'StoryAvatar'); parent = parent.parent; }
    assert.equal(tree.root.findAllByType('StoryAvatar').length, 1, 'only bob\'s text message has an avatar');
    // Its photo link comes from the shared Guess Who folder.
    assert.equal(card.props.mediaUrl, 'file:///qa/mystery/g1.jpg');
  } finally { await unmount(tree); }
});

test('with the real card, nothing in the chat names who sent a Guess Who before you guess', async () => {
  // bob sent it. His profile is loaded (he is one of the people to pick from), but nothing points at him.
  const { screen } = fixture({ messages: [], members: ['alice', 'bob', 'carol', 'dave'], guesses: feed(guessPost()), card: loadGuessCard() });
  const tree = await renderScreen(screen);
  try {
    const shown = texts(tree);
    assert.ok(shown.includes('🕵️ Who sent this?'));
    for (const name of ['BOB', 'CAROL', 'DAVE']) assert.equal(shown.filter(text => text === name).length, 1, `${name} is only a choice`);
    assert.ok(!shown.some(text => /It was|Your Guess Who|guessed ·/.test(text)));
    assert.deepEqual(tree.root.findAllByType('Avatar').map(node => node.props.name), ['BOB', 'CAROL', 'DAVE']);
    assert.equal(tree.root.findAllByType('EmptyState').length, 0, 'a chat with only a Guess Who is not empty');
  } finally { await unmount(tree); }
});

test('guessing calls guessMystery with your pick, shows only you who it was, and loads the counts', async () => {
  let answer = feed(guessPost());
  const { screen, calls } = fixture({ messages: [], members: ['alice', 'bob', 'carol', 'dave'], card: loadGuessCard(),
    fetchGuesses: () => answer, guessAnswer: async () => 'bob' });
  const tree = await renderScreen(screen);
  try {
    const before = calls.guessFetches.length;
    answer = feed(guessPost({ my_guess: 'carol', poster: 'bob', guess_count: 2, right_count: 1 }));
    const carol = tree.root.findAllByType('Bouncy').find(node => node.props.accessibilityLabel === 'Guess CAROL');
    await act(async () => { await carol.props.onPress(); await flush(); });
    assert.deepEqual(calls.guessed, [['g1', 'carol']]);
    const shown = texts(tree);
    assert.ok(shown.includes('Nope! It was BOB 🙈'), JSON.stringify(shown));
    assert.ok(shown.includes('You guessed CAROL'));
    assert.ok(shown.includes('👀 2 of 3 guessed · 1 got it'));
    assert.equal(calls.guessFetches.length, before + 1, 'the Guess Whos are loaded again for the counts');
    assert.equal(tree.root.findAllByType('Bouncy').length, 0, 'one try only');
  } finally { await unmount(tree); }
});

test('a refused guess says why and keeps the choices', async () => {
  const { screen, calls } = fixture({ messages: [], card: loadGuessCard(), guesses: feed(guessPost()),
    guessAnswer: async () => { throw new Error('Pick someone from the group'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findAllByType('Bouncy')[0].props.onPress());
    assert.equal(calls.guessed.length, 1);
    assert.deepEqual(screen.calls.alerts.at(-1), ['Could not guess', 'Pick someone from the group']);
    assert.equal(tree.root.findAllByType('Bouncy').length, 3);
  } finally { await unmount(tree); }
});

test('the Guess Who menu: before guessing only Report; after guessing Report and Block; yours only Delete', async () => {
  const { screen, calls } = fixture({ messages: [], guesses: feed(
    guessPost({ id: 'open' }),
    guessPost({ id: 'done', my_guess: 'carol', poster: 'bob', guess_count: 1, right_count: 0 }),
    guessPost({ id: 'yours', mine: true, options: null, poster: 'alice', guess_count: 0, right_count: 0 }),
  ) });
  const tree = await renderScreen(screen);
  try {
    const card = id => guessCards(tree).find(node => node.props.post.id === id);
    const labels = () => plain(calls.options.at(-1).options.map(option => option.label));
    await act(() => card('open').props.onMenu());
    assert.deepEqual(labels(), ['Report']);
    await act(() => card('done').props.onMenu());
    assert.deepEqual(labels(), ['Report', 'Block whoever posted this']);
    await act(() => card('yours').props.onMenu());
    assert.deepEqual(labels(), ['Delete']);
    // Never the message menu (reply, pin, reactions, see profile).
    assert.equal(tree.root.findByType('MessageActions').props.visible, false);
  } finally { await unmount(tree); }
});

test('reporting a group Guess Who is anonymous: it uses reportMystery, never a report about a person', async () => {
  const { screen, calls } = fixture({ messages: [], guesses: feed(guessPost()) });
  const tree = await renderScreen(screen);
  try {
    await act(() => guessCards(tree)[0].props.onMenu());
    await act(() => calls.options.at(-1).options.find(option => option.label === 'Report').onPress());
    // The reasons open once the first menu has closed.
    await act(() => screen.calls.timers.at(-1)());
    assert.match(calls.options.at(-1).message, /won't know it was you/);
    await act(() => calls.options.at(-1).options.find(option => option.label === 'Spam 🗑️').onPress());
    assert.deepEqual(calls.mysteryReports, [['g1', 'spam']]);
    assert.deepEqual(calls.reports, [], 'no report naming a person');
  } finally { await unmount(tree); }
});

test('after guessing you can block whoever posted it; the card goes and the chat reloads', async () => {
  let answer = feed(guessPost({ my_guess: 'bob', poster: 'bob', guess_count: 1, right_count: 1 }));
  const { screen, calls } = fixture({ messages: [], fetchGuesses: () => answer });
  const tree = await renderScreen(screen);
  try {
    const loads = calls.loads;
    await act(() => guessCards(tree)[0].props.onMenu());
    await act(() => calls.options.at(-1).options.find(option => option.label === 'Block whoever posted this').onPress());
    const [title, warning, buttons] = screen.calls.alerts.at(-1);
    assert.equal(title, 'Block whoever posted this?');
    assert.match(warning, /Blocked accounts list/);
    // Once you've blocked them the server doesn't show it to you any more.
    answer = feed();
    await act(async () => { await buttons.find(button => button.text === 'Block').onPress(); await flush(); });
    assert.deepEqual(calls.blocked, ['g1']);
    assert.equal(guessCards(tree).length, 0);
    assert.equal(calls.loads, loads + 1);
  } finally { await unmount(tree); }
});

test('your own group Guess Who can be deleted for everyone', async () => {
  const { screen, calls } = fixture({ messages: [], guesses: feed(guessPost({ mine: true, options: null, poster: 'alice', guess_count: 2, right_count: 1 })) });
  const tree = await renderScreen(screen);
  try {
    await act(() => guessCards(tree)[0].props.onMenu());
    await act(() => calls.options.at(-1).options.find(option => option.label === 'Delete').onPress());
    const [title, warning, buttons] = screen.calls.alerts.at(-1);
    assert.equal(title, 'Delete this Guess Who?');
    assert.equal(warning, 'It will be gone for everyone.');
    await act(() => buttons.find(button => button.text === 'Delete').onPress());
    assert.deepEqual(calls.deletedGuesses, ['g1']);
    assert.equal(guessCards(tree).length, 0);
    assert.deepEqual(calls.toasts.at(-1), 'Deleted 🗑️');
  } finally { await unmount(tree); }
});

test('a server without group Guess Who (fetch gives null): the chat works exactly as before', async () => {
  const { screen, calls } = fixture({ messages: [], guesses: null });
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.guessFetches.length, 1);
    assert.equal(guessCards(tree).length, 0);
    assert.equal(tree.root.findByType('EmptyState').props.title, 'Say hi to the group!');
  } finally { await unmount(tree); }
  const withMessages = fixture({ guesses: null });
  const tree2 = await renderScreen(withMessages.screen);
  try {
    assert.deepEqual(keysOf(tree2), ['message1']);
    assert.ok(texts(tree2).includes('Hello group 👋'));
  } finally { await unmount(tree2); }
});

test('a Guess Who ping or the 15-second check loads only the Guess Whos: never the chat, never "read"', async () => {
  const { screen, calls } = fixture({ guesses: feed() });
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.guessListeners.length, 1);
    assert.equal(calls.guessListeners[0].group, 'squad');
    const loads = calls.loads, reads = calls.reads, fetches = calls.guessFetches.length;
    assert.ok(reads >= 1, 'opening the chat marks it read');
    await act(async () => { calls.guessListeners[0].onChange(); await flush(); });
    assert.equal(calls.guessFetches.length, fetches + 1);
    const [poll] = screen.calls.intervals.values();
    await act(async () => { poll(); await flush(); });
    assert.equal(calls.guessFetches.length, fetches + 2);
    assert.equal(calls.loads, loads, 'the messages are not loaded again');
    assert.equal(calls.reads, reads, 'the chat is not marked as read');
  } finally { await unmount(tree); }
});

test('a new Guess Who from the ping shows up; a failed load keeps the ones on screen', async () => {
  let answer = feed();
  const { screen, calls } = fixture({ fetchGuesses: () => { if (answer instanceof Error) throw answer; return answer; } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(guessCards(tree).length, 0);
    answer = feed(guessPost());
    await act(async () => { calls.guessListeners[0].onChange(); await flush(); });
    assert.equal(guessCards(tree).length, 1);
    answer = new Error('Network request failed');
    const warn = console.warn;
    console.warn = () => {};
    try { await act(async () => { calls.guessListeners[0].onChange(); await flush(); }); } finally { console.warn = warn; }
    assert.equal(guessCards(tree).length, 1);
  } finally { await unmount(tree); }
});

test('an older Guess Who answer that arrives after a newer one is dropped', async () => {
  const answers = [];
  const { screen, calls } = fixture({ fetchGuesses: () => new Promise(resolve => answers.push(resolve)) });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { calls.guessListeners[0].onChange(); await flush(); });
    assert.equal(answers.length, 2);
    await act(async () => { answers[1](feed()); await flush(); });
    await act(async () => { answers[0](feed(guessPost({ id: 'deleted' }))); await flush(); });
    assert.equal(guessCards(tree).length, 0);
  } finally { answers.forEach(resolve => resolve(null)); await unmount(tree); }
});

test('a Guess Who that has ended is hidden, and one that ends while the chat is open goes at the next check', async () => {
  const { screen } = fixture({ guesses: feed(
    guessPost({ id: 'over', expires_at: new Date(Date.now() - 1000).toISOString() }),
    guessPost({ id: 'soon', expires_at: new Date(Date.now() + 1500).toISOString() }),
  ) });
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(plain(guessCards(tree).map(card => card.props.post.id)), ['soon']);
    await new Promise(resolve => setTimeout(resolve, 1600));
    const [poll] = screen.calls.intervals.values();
    await act(async () => { poll(); await flush(); });
    assert.equal(guessCards(tree).length, 0);
  } finally { await unmount(tree); }
});

test('tapping a Guess Who photo opens it full screen', async () => {
  const { screen } = fixture({ guesses: feed(guessPost()) });
  const tree = await renderScreen(screen);
  try {
    await act(() => guessCards(tree)[0].props.onOpen());
    assert.equal(tree.root.findByType('ZoomableImage').props.uri, 'file:///qa/mystery/g1.jpg');
  } finally { await unmount(tree); }
});

test('leaving the chat also stops the Guess Who listener', async () => {
  const { screen, calls } = fixture({ guesses: feed() });
  const tree = await renderScreen(screen);
  await unmount(tree);
  assert.equal(calls.guessStops, 1);
  assert.equal(screen.calls.intervals.size, 0);
});
