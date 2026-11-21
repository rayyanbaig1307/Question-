import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Deleting and leaving a group (src/lib/groups.ts). The server functions delete_peek_group / leave_peek_group decide
// who may; a server without them yet falls back to the old table deletes, and a delete the database quietly skipped
// (0 rows, no error) is never reported as done.

const missing = { code: 'PGRST202', message: 'Could not find the function public.delete_peek_group(grp) in the schema cache' };

// rpc: what each server function answers. deletes: what each table delete answers ({ error, count }).
function backend({ rpc = {}, deletes = {} } = {}) {
  const calls = { rpc: [], deletes: [] };
  const supabase = {
    rpc: async (name, args) => {
      calls.rpc.push([name, args]);
      return rpc[name] ?? { data: null, error: null };
    },
    from: (table) => ({
      delete: (options) => {
        const filters = [];
        const query = {
          eq(column, value) { filters.push([column, value]); return query; },
          then(resolve, reject) {
            calls.deletes.push({ table, options, filters });
            return Promise.resolve(deletes[table] ?? { error: null, count: 1 }).then(resolve, reject);
          },
        };
        return query;
      },
    }),
  };
  return { groups: loadLibrary('groups', { supabase }), calls };
}

const member = (userId) => ({ userId, profile: null, posted: false, postId: null, postedAt: null, late: false });

it('who may delete: the maker any time, or whoever is the only one left; never someone not in it', () => {
  const { groups } = backend();
  expect(groups.canDeleteGroup({ created_by: 'alice', members: ['alice', 'bob'].map(member) }, 'alice')).toBe(true);
  expect(groups.canDeleteGroup({ created_by: 'alice', members: ['alice', 'bob'].map(member) }, 'bob')).toBe(false);
  expect(groups.canDeleteGroup({ created_by: 'alice', members: ['bob'].map(member) }, 'bob')).toBe(true);
  expect(groups.canDeleteGroup({ created_by: null, members: ['bob'].map(member) }, 'bob')).toBe(true);
  expect(groups.canDeleteGroup({ created_by: 'alice', members: ['bob', 'cara'].map(member) }, 'alice')).toBe(false);
  // The maker left (or deleted their account): whoever has been in it longest (first in the list) counts instead.
  expect(groups.canDeleteGroup({ created_by: 'gone', members: ['bob', 'cara'].map(member) }, 'bob')).toBe(true);
  expect(groups.canDeleteGroup({ created_by: null, members: ['bob', 'cara'].map(member) }, 'bob')).toBe(true);
  expect(groups.canDeleteGroup({ created_by: null, members: ['bob', 'cara'].map(member) }, 'cara')).toBe(false);
  expect(groups.groupMaker({ created_by: 'cara', members: ['bob', 'cara'].map(member) })).toBe('cara');
  // The maker is no longer in it: the first one in the list, which the server sorts by joining time and then by id
  // (public.peek_group_status) – the same person the server lets delete it (private.group_maker).
  expect(groups.groupMaker({ created_by: 'gone', members: ['bob', 'cara'].map(member) })).toBe('bob');
  expect(groups.groupMaker({ created_by: 'gone', members: ['cara', 'bob'].map(member) })).toBe('cara');
  expect(groups.groupMaker({ created_by: null, members: [] })).toBe(null);
  expect(groups.aloneInGroup({ members: ['bob'].map(member) }, 'bob')).toBe(true);
  expect(groups.aloneInGroup({ members: ['bob', 'cara'].map(member) }, 'bob')).toBe(false);
});

it('deleting a group asks the server (delete_peek_group) and nothing else', async () => {
  const { groups, calls } = backend();
  await groups.deleteGroup('g1');
  expect(calls.rpc).toEqual([['delete_peek_group', { grp: 'g1' }]]);
  expect(calls.deletes).toEqual([]);
});

it('a refused delete keeps the server’s reason (no fallback)', async () => {
  const no = { code: 'P0001', message: 'Only the person who made this group can delete it. You can leave it instead.' };
  const { groups, calls } = backend({ rpc: { delete_peek_group: { data: null, error: no } } });
  await expect(groups.deleteGroup('g1')).rejects.toBe(no);
  expect(calls.deletes).toEqual([]);
});

it('a server without delete_peek_group yet: the old delete, counted', async () => {
  const { groups, calls } = backend({ rpc: { delete_peek_group: { data: null, error: missing } } });
  await groups.deleteGroup('g1');
  expect(calls.deletes).toEqual([{ table: 'peek_groups', options: { count: 'exact' }, filters: [['id', 'g1']] }]);
});

it('the old delete that the database quietly skipped (0 rows) is not reported as done', async () => {
  const { groups } = backend({ rpc: { delete_peek_group: { data: null, error: missing } }, deletes: { peek_groups: { error: null, count: 0 } } });
  await expect(groups.deleteGroup('g1')).rejects.toThrow(groups.ONLY_MAKER_DELETES);
});

it('leaving asks the server (leave_peek_group); without it yet, you take yourself out the old way', async () => {
  const ok = backend({ rpc: { leave_peek_group: { data: 'left', error: null } } });
  await expect(ok.groups.leaveGroup('g1', 'bob')).resolves.toBe('left');
  expect(ok.calls.rpc).toEqual([['leave_peek_group', { grp: 'g1' }]]);
  expect(ok.calls.deletes).toEqual([]);

  // You were the last one in it: the server deleted the group.
  const last = backend({ rpc: { leave_peek_group: { data: 'deleted', error: null } } });
  await expect(last.groups.leaveGroup('g1', 'bob')).resolves.toBe('deleted');

  const old = backend({ rpc: { leave_peek_group: { data: null, error: { ...missing, message: 'leave_peek_group missing' } } } });
  await expect(old.groups.leaveGroup('g1', 'bob')).resolves.toBe('left');
  expect(old.calls.deletes).toEqual([{ table: 'peek_group_members', options: { count: 'exact' }, filters: [['group_id', 'g1'], ['user_id', 'bob']] }]);
});

it('a refused leave keeps the server’s reason', async () => {
  const gone = { code: 'P0001', message: 'This group is gone' };
  const { groups, calls } = backend({ rpc: { leave_peek_group: { data: null, error: gone } } });
  await expect(groups.leaveGroup('g1', 'bob')).rejects.toBe(gone);
  expect(calls.deletes).toEqual([]);
});

it('taking someone out that the database quietly refused (0 rows) is not reported as done', async () => {
  const { groups } = backend({ deletes: { peek_group_members: { error: null, count: 0 } } });
  await expect(groups.removeFromGroup('g1', 'cara')).rejects.toThrow(/Only the person who made this group/);
  const fine = backend();
  await expect(fine.groups.removeFromGroup('g1', 'cara')).resolves.toBeUndefined();
});
