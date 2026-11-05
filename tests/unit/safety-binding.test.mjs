import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

it('the block request binds the approving user as well as the target', async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  const lib = loadLibrary('safety', { supabase: { rpc } });
  await lib.blockUser('target-B', 'approving-A');
  expect(rpc).toHaveBeenCalledExactlyOnceWith('block_user', { target: 'target-B', expected_user_id: 'approving-A' });
});

it('a report sends the approving user so row security can reject an account switch', async () => {
  const insert = vi.fn();
  const chain = query({ error: null });
  chain.insert = (row) => { insert(row); return chain; };
  const lib = loadLibrary('safety', { supabase: { from: () => chain } });
  await lib.reportContent({ reporterUserId: 'approving-A', reportedUserId: 'target-B', contentType: 'group_message', contentId: 'group-message-1', reason: 'spam' });
  expect(insert).toHaveBeenCalledExactlyOnceWith({ reporter_id: 'approving-A', reported_user_id: 'target-B', content_type: 'group_message', content_id: 'group-message-1', reason: 'spam' });
});
