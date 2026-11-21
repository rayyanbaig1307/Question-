import { expect, it, vi } from 'vitest';
import { loadEdge, request } from './edgeHarness.mjs';

// names: the media files the database hands out; pictures: the old group pictures (claim_avatar_cleanup).
// buckets: which storage each remove() went to, in order.
function service(names = [], pictures = []) {
  const buckets = [];
  const remove = vi.fn(async (paths) => ({ data: paths.map((name) => ({ name })), error: null }));
  const rpc = vi.fn(async (name, args) => name === 'media_cleanup_key_ok'
    ? { data: args.given === 'test-cleanup-secret', error: null }
    : { data: (name === 'claim_avatar_cleanup' ? pictures : names).map((name) => ({ name })), error: null });
  const from = (bucket) => ({ remove: async (paths) => { buckets.push(bucket); return remove(paths); } });
  return { admin: { rpc, storage: { from } }, rpc, remove, buckets };
}
const authorized = () => request({}, { headers: { 'x-cleanup-key': 'test-cleanup-secret' } });

it.each([undefined, '', 'wrong', 'Bearer forged'])('cleanup rejects an absent or incorrect key before deleting anything', async (key) => {
  const { admin, remove } = service(['old.jpg']);
  const response = await loadEdge('cleanup-media', admin)(request({}, { headers: key ? { 'x-cleanup-key': key } : {} }));
  expect(response.status).toBe(401);
  expect(remove).not.toHaveBeenCalled();
});

it('cleanup rejects unsupported HTTP methods', async () => {
  const { admin, rpc } = service();
  const response = await loadEdge('cleanup-media', admin)(request(undefined, { method: 'GET' }));
  expect(response.status).toBe(405);
  expect(rpc).not.toHaveBeenCalled();
});

it('cleanup distinguishes an unavailable key verifier from an invalid key', async () => {
  const { admin, rpc, remove } = service();
  rpc.mockResolvedValue({ data: null, error: { message: 'vault is offline; internal-secret-detail' } });
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('internal-secret-detail');
  expect(remove).not.toHaveBeenCalled();
});

it('cleanup claims paths through the race-protected SQL helper and deletes in bounded batches', async () => {
  const { admin, rpc, remove } = service(Array.from({ length: 250 }, (_, i) => `old/${i}.jpg`));
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('claim_media_cleanup', { max_files: 1000 });
  expect(remove.mock.calls.map(([paths]) => paths.length)).toEqual([100, 100, 50]);
  expect(await response.json()).toMatchObject({ removed: 250, found: 250 });
});

it('cleanup returns a service error and preserves retryable work when deletion fails mid-run', async () => {
  const { admin, remove } = service(Array.from({ length: 250 }, (_, i) => `old/${i}.jpg`));
  remove.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => ({ name: `old/${i}.jpg` })), error: null });
  remove.mockResolvedValueOnce({ data: null, error: { message: 'storage offline; sensitive-detail' } });
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.removed).toBe(100);
  expect(JSON.stringify(body)).not.toContain('sensitive-detail');
  expect(remove).toHaveBeenCalledTimes(2);
});

it('cleanup does not report success if the candidate/claim query fails', async () => {
  const { admin, rpc, remove } = service();
  rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'internal relation details' } });
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('internal relation details');
  expect(remove).not.toHaveBeenCalled();
});

it('cleanup counts only files Storage really removed after its eligibility guard', async () => {
  const { admin, remove } = service(['old/a.jpg', 'old/b.jpg']);
  remove.mockResolvedValue({ data: [{ name: 'old/a.jpg' }], error: null });
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ removed: 1, found: 2 });
});

it('cleanup handles an unexpected service rejection without leaking details', async () => {
  const { admin, rpc } = service();
  rpc.mockRejectedValue(new Error('internal database password detail'));
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('password');
});

it('cleanup also deletes old group pictures (deleted groups, changed pictures) from the avatars storage, in batches', async () => {
  const { admin, rpc, remove, buckets } = service(['old/a.jpg'], Array.from({ length: 150 }, (_, i) => `u/${i}.jpg`));
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('claim_avatar_cleanup', { max_files: 1000 });
  expect(buckets).toEqual(['media', 'avatars', 'avatars']);
  expect(remove.mock.calls.map(([paths]) => paths.length)).toEqual([1, 100, 50]);
  expect(await response.json()).toMatchObject({ removed: 1, found: 1, pictures: 150 });
});

it('cleanup still works on a database without the group picture list yet', async () => {
  const { admin, rpc, buckets } = service(['old/a.jpg']);
  const answer = rpc.getMockImplementation();
  rpc.mockImplementation(async (name, args) => name === 'claim_avatar_cleanup'
    ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    : answer(name, args));
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(200);
  expect(buckets).toEqual(['media']);
  expect(await response.json()).toMatchObject({ removed: 1, found: 1, pictures: 0 });
});

it('cleanup reports a failed group picture list as an error, without details', async () => {
  const { admin, rpc, buckets } = service(['old/a.jpg']);
  const answer = rpc.getMockImplementation();
  rpc.mockImplementation(async (name, args) => name === 'claim_avatar_cleanup'
    ? { data: null, error: { code: '57014', message: 'statement timeout; internal-detail' } }
    : answer(name, args));
  const response = await loadEdge('cleanup-media', admin)(authorized());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('internal-detail');
  expect(buckets).toEqual(['media']);
});
