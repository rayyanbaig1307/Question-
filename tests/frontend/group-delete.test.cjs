const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen } = require('./harness.cjs');

// 🚪 Leave / 🗑️ Delete a group (the owner, 21 Nov): the person who made the group can delete it any time; anyone who
// is the only one left can delete it; everyone else can leave. Plain-English confirm text, then the Chat list.
// This loads the real menu helper (src/components/groups/leaveOrDelete.ts) used by the group chat ⋯ menu and the
// Group Peek screen ⋯ menu.
const member = userId => ({ userId, profile: null, posted: false, postId: null, postedAt: null, late: false });
const group = (members, createdBy = 'alice') => ({ id: 'squad', name: 'Squad', created_by: createdBy, created_at: '2026-11-01T00:00:00Z', members: members.map(member) });

function loadHelper({ deleteGroup, leaveGroup } = {}) {
  const calls = { deleted: [], left: [], toasts: [] };
  const helper = loadScreen('src/components/groups/leaveOrDelete.ts', {
    '@/lib/groups': {
      // The real rules (canDeleteGroup / aloneInGroup) live in src/lib/groups.ts; tests/unit/group-delete.test.mjs
      // checks those. The same rules here, so the menu can be checked on its own.
      groupMaker: g => (g.created_by && g.members.some(m => m.userId === g.created_by) ? g.created_by : g.members[0]?.userId ?? null),
      canDeleteGroup: (g, me) => {
        const maker = g.created_by && g.members.some(m => m.userId === g.created_by) ? g.created_by : g.members[0]?.userId ?? null;
        return g.members.some(m => m.userId === me) && (maker === me || g.members.length === 1);
      },
      aloneInGroup: (g, me) => g.members.length === 1 && g.members[0].userId === me,
      deleteGroup: async id => { calls.deleted.push(id); if (deleteGroup) await deleteGroup(id); },
      leaveGroup: async (...args) => { calls.left.push(args); return leaveGroup ? leaveGroup(...args) : 'left'; },
    },
  });
  const options = (g, me) => helper.exports.leaveOrDeleteOptions(g, me, value => calls.toasts.push(value));
  return { helper, calls, options };
}
// Arrays made inside the loaded file are from another "realm", so they're copied before comparing.
const plain = value => JSON.parse(JSON.stringify(value));
const labels = options => plain(options.map(option => option.label));
const press = async (options, label) => options.find(option => option.label === label).onPress();
// Press the confirm alert's button (`text`) and wait for what it does.
async function confirm(helper, text) {
  const [, , buttons] = helper.calls.alerts.at(-1);
  await buttons.find(b => b.text === text).onPress();
}

test('the maker of a group with others in it can leave or delete it', () => {
  const { options } = loadHelper();
  assert.deepEqual(labels(options(group(['alice', 'bob', 'cara']), 'alice')), ['🚪 Leave group', '🗑️ Delete group']);
});

test('someone who did not make the group, with others still in it, can only leave', () => {
  const { options } = loadHelper();
  assert.deepEqual(labels(options(group(['alice', 'bob']), 'bob')), ['🚪 Leave group']);
  assert.deepEqual(labels(options(group(['alice', 'bob', 'cara']), 'cara')), ['🚪 Leave group']);
});

test('the maker left (or deleted their account): whoever has been in it longest is in charge and can delete it', () => {
  const { options } = loadHelper();
  // Members are in joining order: bob joined first.
  assert.deepEqual(labels(options(group(['bob', 'cara'], null), 'bob')), ['🚪 Leave group', '🗑️ Delete group']);
  assert.deepEqual(labels(options(group(['bob', 'cara'], 'gone'), 'bob')), ['🚪 Leave group', '🗑️ Delete group']);
  assert.deepEqual(labels(options(group(['bob', 'cara'], null), 'cara')), ['🚪 Leave group']);
});

test('the only person left can delete the group – even if they did not make it – and is not offered Leave', () => {
  const { options } = loadHelper();
  assert.deepEqual(labels(options(group(['bob']), 'bob')), ['🗑️ Delete group']);
  assert.deepEqual(labels(options(group(['bob'], null), 'bob')), ['🗑️ Delete group']);
  assert.deepEqual(labels(options(group(['alice']), 'alice')), ['🗑️ Delete group']);
});

test('deleting asks first in plain English, then deletes, says so and goes to the Chat list', async () => {
  const { helper, calls, options } = loadHelper();
  await press(options(group(['alice', 'bob']), 'alice'), '🗑️ Delete group');
  const [title, message, buttons] = helper.calls.alerts.at(-1);
  assert.equal(title, 'Delete "Squad"?');
  assert.match(message, /for everyone in it/);
  assert.match(message, /Nobody's own posts or drops are deleted/);
  assert.match(message, /can't undo this/);
  assert.deepEqual(plain(buttons.map(b => b.text)), ['Cancel', 'Delete group']);
  assert.equal(calls.deleted.length, 0, 'nothing happens before you say yes');
  await confirm(helper, 'Delete group');
  assert.deepEqual(calls.deleted, ['squad']);
  assert.deepEqual(calls.toasts, ['Group deleted 🗑️']);
  assert.deepEqual(plain(helper.calls.routes), [['dismissTo', { pathname: '/', params: { page: 'chat' } }]]);
});

test('the only person left gets the "only one left" words', async () => {
  const { helper, options } = loadHelper();
  await press(options(group(['bob']), 'bob'), '🗑️ Delete group');
  assert.match(helper.calls.alerts.at(-1)[1], /^You're the only one left in this group/);
});

test('leaving asks first, then leaves, says so and goes to the Chat list', async () => {
  const { helper, calls, options } = loadHelper();
  await press(options(group(['alice', 'bob']), 'bob'), '🚪 Leave group');
  const [title, message, buttons] = helper.calls.alerts.at(-1);
  assert.equal(title, 'Leave "Squad"?');
  assert.match(message, /won't see this group or its chat any more/);
  assert.doesNotMatch(message, /takes over/, 'only said to the maker');
  assert.deepEqual(plain(buttons.map(b => b.text)), ['Cancel', 'Leave']);
  await confirm(helper, 'Leave');
  assert.deepEqual(plain(calls.left), [['squad', 'bob']]);
  assert.deepEqual(calls.toasts, ['You left Squad']);
  assert.deepEqual(plain(helper.calls.routes), [['dismissTo', { pathname: '/', params: { page: 'chat' } }]]);
});

test('the last one out (someone else joined back in a moment ago, say) is told the group is deleted', async () => {
  const { calls, helper, options } = loadHelper({ leaveGroup: async () => 'deleted' });
  await press(options(group(['alice', 'bob']), 'bob'), '🚪 Leave group');
  await confirm(helper, 'Leave');
  assert.deepEqual(calls.toasts, ["You left Squad – nobody was left, so it's deleted 🗑️"]);
});

test('the maker leaving is told the longest-standing member takes over', async () => {
  const { helper, options } = loadHelper();
  await press(options(group(['alice', 'bob']), 'alice'), '🚪 Leave group');
  assert.match(helper.calls.alerts.at(-1)[1], /whoever has been in it the longest takes over/);
});

test('a refused delete or leave says why and stays put', async () => {
  const { helper, calls, options } = loadHelper({
    deleteGroup: async () => { throw new Error('Only the person who made this group can delete it. You can leave it instead.'); },
    leaveGroup: async () => { throw new Error('This group is gone'); },
  });
  await press(options(group(['alice', 'bob']), 'alice'), '🗑️ Delete group');
  await confirm(helper, 'Delete group');
  assert.deepEqual(helper.calls.alerts.at(-1).slice(0, 2), ['Could not delete the group', 'Only the person who made this group can delete it. You can leave it instead.']);
  await press(options(group(['alice', 'bob']), 'bob'), '🚪 Leave group');
  await confirm(helper, 'Leave');
  assert.deepEqual(helper.calls.alerts.at(-1).slice(0, 2), ['Could not leave the group', 'This group is gone']);
  assert.deepEqual(calls.toasts, []);
  assert.deepEqual(helper.calls.routes, []);
});
