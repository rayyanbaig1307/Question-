// Group dares: the app (proofOutcome / proofCounts in src/lib/groupChat.ts) and the database
// (private.group_proof_counts in supabase/migrations/20261216000000_group_dare_votes.sql) must agree on when a
// proof counts. Runs locally in PGlite with the real migrations; no live project.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createLocalDatabase } from '../database/local-db.mjs';
import { loadLibrary } from './libHarness.mjs';

let db;
let lib;
beforeAll(async () => {
  lib = loadLibrary('groupChat', { mocks: { './media': {} } });
  db = await createLocalDatabase();
});
afterAll(async () => { await db?.close(); });

it('the app and the database agree on when a group dare proof counts', async () => {
  const cases = [];
  for (let legit = 0; legit <= 4; legit++) {
    for (let cap = 0; cap <= 4; cap++) for (const legacy of [false, true]) cases.push([legit, cap, legacy]);
  }
  const { rows } = await db.query(
    'select n, private.group_proof_counts(l, c, g) as ok from unnest($1::int[], $2::int[], $3::boolean[]) with ordinality as x(l, c, g, n) order by n',
    [cases.map((c) => c[0]), cases.map((c) => c[1]), cases.map((c) => c[2])],
  );
  expect(rows.map((r) => r.ok)).toEqual(
    cases.map(([legit, cap, legacy]) => lib.proofCounts({ proof_legit: legit, proof_cap: cap, proof_legacy: legacy })),
  );
});
