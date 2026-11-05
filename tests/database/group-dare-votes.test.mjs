// Group dares: the group votes "Legit 🔥" or "Cap 🧢" on each proof
// (supabase/migrations/20261216000000_group_dare_votes.sql).
// Every check runs the real migrations in a local, in-memory PostgreSQL (PGlite) with invented people.
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  applyMigrationFile, asUser, createLocalDatabase, friend, initializeDatabase, migrationSql, remainingMigrations, seedUsers,
} from './local-db.mjs';

const VOTES_MIGRATION = '20261216000000_group_dare_votes.sql';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 8);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const failure = (run) => run.then(() => 'ok', (error) => error.message);
// A vote; gives back the new totals and your vote. (Whether it is still an old proof is checked on its own:
// a new proof never is.)
const voteWithFlag = async (i, proof, legit, expected = users[i]) =>
  (await rpc(i, 'select public.vote_group_proof($1, $2, $3) as r', [proof, legit, expected])).rows[0].r;
const vote = async (i, proof, legit, expected = users[i]) => {
  const { legacy, ...result } = await voteWithFlag(i, proof, legit, expected);
  assert.equal(typeof legacy, 'boolean');
  return result;
};
const totals = async (proof) =>
  (await db.query('select proof_legit as legit, proof_cap as cap, proof_legacy as legacy from group_messages where id = $1', [proof])).rows[0];
// The real count, straight from the votes table.
const counted = async (proof) => (await db.query(
  'select count(*) filter (where legit)::int as legit, count(*) filter (where not legit)::int as cap from group_proof_votes where proof_id = $1',
  [proof])).rows[0];
const streak = async (i, j) => (await rpc(i, 'select public.chat_dare_streak($1) as n', [users[j]])).rows[0].n;
const counts = async (proof) => (await db.query(
  'select private.group_proof_counts(proof_legit, proof_cap, proof_legacy) as ok from group_messages where id = $1', [proof])).rows[0].ok;

// A group with users[0] (who makes it) and the given others. Everyone is friends with users[0].
async function makeGroup(members = [1, 2, 3, 4]) {
  for (const i of members) await friend(db, users[0], users[i]);
  return (await rpc(0, "select create_peek_group('Squad',$1::uuid[],current_date) as id", [members.map((i) => users[i])])).rows[0].id;
}
async function message(grp, i, fields) {
  const row = { group_id: grp, sender_id: users[i], ...fields };
  const keys = Object.keys(row);
  return (await rpc(i, `insert into group_messages(${keys}) values(${keys.map((_, n) => `$${n + 1}`)}) returning *`, Object.values(row))).rows[0];
}
const dareFrom = (grp, i, body = 'Do ten jumps') => message(grp, i, { kind: 'dare', body });
const proofFrom = (grp, i, dare, extra = {}) =>
  message(grp, i, { kind: 'proof', dare_id: dare, media_path: `${users[i]}/group/${randomUUID()}.jpg`, media_type: 'photo', ...extra });
async function pushTo(i) {
  const token = `ExponentPushToken[qa-votes-${i}]`;
  await db.query("insert into push_tokens(token,user_id,platform) values($1,$2,'ios') on conflict (token) do update set user_id = excluded.user_id", [token, users[i]]);
  return token;
}
const pushesTo = async (token) => (await db.query("select body->0->>'title' as title, body->0->>'body' as body from net.sent where body->0->>'to' = $1 order by id", [token])).rows;
const at = (proof, days) => db.query(`update group_messages set created_at = now() - interval '${days} days' where id = $1`, [proof]);

// ---------------------------------------------------------------------------
// 1. A new proof doesn't count yet
// ---------------------------------------------------------------------------
test('A new proof starts with no votes and does not count, even if the app sends totals or the old-proof flag', async () => {
  const grp = await makeGroup();
  const dare = await dareFrom(grp, 0);
  const proof = await proofFrom(grp, 1, dare.id, { proof_legit: 5, proof_cap: 0, proof_legacy: true });
  assert.deepEqual({ legit: proof.proof_legit, cap: proof.proof_cap, legacy: proof.proof_legacy }, { legit: 0, cap: 0, legacy: false });
  // Any other new message too (the app can't make a "pre-counted" text either).
  const text = await message(grp, 2, { body: 'hello', proof_legit: 3, proof_cap: 1, proof_legacy: true });
  assert.deepEqual({ legit: text.proof_legit, cap: text.proof_cap, legacy: text.proof_legacy }, { legit: 0, cap: 0, legacy: false });
  assert.equal(await counts(proof.id), false);
  assert.equal(await streak(0, 1), 0);
  assert.equal(await streak(1, 0), 0);
});

// ---------------------------------------------------------------------------
// 2. Who can vote
// ---------------------------------------------------------------------------
test('Everyone in the group except the poster can vote, the dare sender too; others are refused with a clear message', async () => {
  const grp = await makeGroup();
  const dare = await dareFrom(grp, 0);
  const proof = await proofFrom(grp, 1, dare.id);
  assert.match(await failure(vote(1, proof.id, true)), /can't vote on your own proof/);
  assert.match(await failure(vote(5, proof.id, true)), /Only people in this group can vote/);
  assert.match(await failure(vote(2, randomUUID(), true)), /This proof is gone/);
  assert.match(await failure(vote(2, dare.id, true)), /only vote on proof for a group dare/);
  const text = await message(grp, 3, { body: 'nice' });
  assert.match(await failure(vote(2, text.id, false)), /only vote on proof/);
  // The account on screen must be the one that is logged in (like block_user).
  assert.match(await failure(vote(2, proof.id, true, users[3])), /login has changed/);
  assert.match(await failure(vote(2, proof.id, true, null)), /login has changed/);
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select public.vote_group_proof($1,true,$2)', [proof.id, users[2]]), 'authenticated')), /log in/);
  await assert.rejects(() => asUser(db, null, (tx) => tx.query('select public.vote_group_proof($1,true,$2)', [proof.id, users[2]]), 'anon'), /permission denied/);
  // Nothing was saved by any refused vote.
  assert.deepEqual(await counted(proof.id), { legit: 0, cap: 0 });
  // The person who sent the dare can vote, and so can everyone else in the group.
  assert.deepEqual(await vote(0, proof.id, true), { legit: 1, cap: 0, mine: true });
  assert.deepEqual(await vote(2, proof.id, false), { legit: 1, cap: 1, mine: false });
  // Someone removed from the group can't vote any more.
  await db.query('delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[3]]);
  assert.match(await failure(vote(3, proof.id, true)), /Only people in this group can vote/);
});

test('A block between the voter and the poster (either way) stops the vote, without saying there is a block', async () => {
  const grp = await makeGroup();
  const dare = await dareFrom(grp, 0);
  const proof = await proofFrom(grp, 1, dare.id);
  await rpc(2, 'select block_user($1)', [users[1]]);       // the voter blocked the poster
  await rpc(1, 'select block_user($1)', [users[3]]);       // the poster blocked the voter
  assert.match(await failure(vote(2, proof.id, true)), /This proof is gone/);
  assert.match(await failure(vote(3, proof.id, false)), /This proof is gone/);
  assert.deepEqual(await counted(proof.id), { legit: 0, cap: 0 });
  // Somebody else in the group still can.
  assert.deepEqual(await vote(4, proof.id, true), { legit: 1, cap: 0, mine: true });
});

// ---------------------------------------------------------------------------
// 3. One vote each, changeable, anonymous; the totals always match the votes
// ---------------------------------------------------------------------------
test('One vote each: voting again, changing and taking back a vote keep the totals equal to the votes', async () => {
  const grp = await makeGroup();
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  const steps = [
    [2, true, { legit: 1, cap: 0, mine: true }],
    [2, true, { legit: 1, cap: 0, mine: true }],     // the same vote twice is still one vote
    [3, false, { legit: 1, cap: 1, mine: false }],
    [2, false, { legit: 0, cap: 2, mine: false }],   // changed
    [3, null, { legit: 0, cap: 1, mine: null }],     // taken back
    [3, null, { legit: 0, cap: 1, mine: null }],     // taking back again changes nothing
    [3, true, { legit: 1, cap: 1, mine: true }],
    [0, true, { legit: 2, cap: 1, mine: true }],
  ];
  for (const [who, legit, expected] of steps) {
    assert.deepEqual(await vote(who, proof.id, legit), expected, `user ${who} votes ${legit}`);
    const now = await totals(proof.id);
    assert.deepEqual({ legit: now.legit, cap: now.cap }, await counted(proof.id));
    assert.deepEqual({ legit: now.legit, cap: now.cap }, { legit: expected.legit, cap: expected.cap });
  }
  assert.equal((await db.query('select count(*)::int as n from group_proof_votes where proof_id = $1', [proof.id])).rows[0].n, 3);
});

test('Votes are anonymous: you see only your own vote; everyone in the group sees the totals', async () => {
  const grp = await makeGroup();
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  await vote(2, proof.id, true);
  await vote(3, proof.id, false);
  assert.deepEqual((await rpc(2, 'select proof_id, user_id, legit from group_proof_votes')).rows, [{ proof_id: proof.id, user_id: users[2], legit: true }]);
  assert.deepEqual((await rpc(3, 'select legit from group_proof_votes')).rows, [{ legit: false }]);
  // The poster and the others can't find out who voted what.
  for (const i of [0, 1, 4, 5]) assert.deepEqual((await rpc(i, 'select * from group_proof_votes')).rows, [], `user ${i}`);
  await assert.rejects(() => asUser(db, null, (tx) => tx.query('select * from group_proof_votes'), 'anon'), /permission denied/);
  // Everyone in the group reads the totals on the proof itself; an outsider doesn't.
  for (const i of [0, 1, 4]) {
    assert.deepEqual((await rpc(i, 'select proof_legit, proof_cap from group_messages where id = $1', [proof.id])).rows, [{ proof_legit: 1, proof_cap: 1 }]);
  }
  assert.deepEqual((await rpc(5, 'select proof_legit from group_messages where id = $1', [proof.id])).rows, []);
  // The totals reach phones live through group_messages (members can read it); the votes table is never sent.
  const live = (await db.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('group_messages','group_proof_votes')")).rows.map((r) => r.tablename);
  assert.deepEqual(live, ['group_messages']);
});

test('Many votes, one after another in any order, keep the totals equal to the votes table', async () => {
  const grp = await makeGroup([1, 2, 3, 4, 5, 6, 7]);
  const dare = await dareFrom(grp, 0);
  const proofs = [await proofFrom(grp, 1, dare.id), await proofFrom(grp, 2, dare.id)];
  const choices = [true, false, null];
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  const work = [];
  for (let n = 0; n < 120; n++) {
    const proof = proofs[next() % 2];
    let who = next() % 8;
    if (who === (proof === proofs[0] ? 1 : 2)) who = 0;
    work.push(vote(who, proof.id, choices[next() % 3]));
  }
  // (PGlite runs these one at a time; votes at the very same moment are checked by tests/database/concurrency.mjs.)
  await Promise.all(work);
  for (const proof of proofs) {
    const now = await totals(proof.id);
    assert.deepEqual({ legit: now.legit, cap: now.cap }, await counted(proof.id));
  }
});

test('A vote only counts while the voter is in the group: spare accounts that join, vote and leave change nothing', async () => {
  // The dare sender 0, the doer 1 and members 2 and 3, who all say cap.
  const grp = await makeGroup([1, 2, 3]);
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  for (const i of [0, 2, 3]) await vote(i, proof.id, false);
  // The doer brings in spare accounts (friends of theirs) one at a time: each joins, votes legit and leaves.
  for (const puppet of [5, 6, 7]) {
    await friend(db, users[1], users[puppet]);
    await rpc(1, 'select add_to_peek_group($1,$2::uuid[],current_date)', [grp, [users[puppet]]]);
    assert.equal((await vote(puppet, proof.id, true)).legit, 1);
    await rpc(puppet, 'delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[puppet]]);
    assert.deepEqual(await totals(proof.id), { legit: 0, cap: 3, legacy: false });
  }
  assert.deepEqual(await counted(proof.id), { legit: 0, cap: 3 });
  assert.equal(await counts(proof.id), false);
  assert.equal(await streak(0, 1), 0);
  // Someone the group's maker removes loses their votes too, and the totals are counted again.
  await rpc(0, 'delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[3]]);
  assert.deepEqual(await totals(proof.id), { legit: 0, cap: 2, legacy: false });
  // Back in the group: they can vote again (their old vote is not remembered).
  await rpc(0, 'select add_to_peek_group($1,$2::uuid[],current_date)', [grp, [users[3]]]);
  assert.deepEqual((await rpc(3, 'select * from group_proof_votes')).rows, []);
  assert.deepEqual(await vote(3, proof.id, true), { legit: 1, cap: 2, mine: true });
});

test('Leaving one group keeps your votes in your other groups, and the votes on your own proofs', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const other = await makeGroup([1, 2, 4]);
  const here = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  const there = await proofFrom(other, 1, (await dareFrom(other, 0)).id);
  const mine = await proofFrom(grp, 2, here.dare_id);
  await vote(2, here.id, true);
  await vote(2, there.id, true);
  await vote(3, mine.id, false);
  await rpc(2, 'delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[2]]);
  assert.deepEqual(await totals(here.id), { legit: 0, cap: 0, legacy: false });
  assert.deepEqual(await totals(there.id), { legit: 1, cap: 0, legacy: false });
  assert.deepEqual(await totals(mine.id), { legit: 0, cap: 1, legacy: false });
  // A whole group with votes in it can still be deleted by its maker.
  await rpc(0, 'delete from peek_groups where id = $1', [other]);
  assert.equal((await db.query('select count(*)::int as n from group_proof_votes where proof_id = $1', [there.id])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from group_messages where group_id = $1', [other])).rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// 4. When a proof counts
// ---------------------------------------------------------------------------
test('A proof counts only with more Legit than Cap votes: no votes, a tie or more Cap votes do not count', async () => {
  const grp = await makeGroup();
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  assert.equal(await counts(proof.id), false);                    // no votes
  await vote(2, proof.id, true);
  assert.equal(await counts(proof.id), true);                     // 1 – 0
  await vote(3, proof.id, false);
  assert.equal(await counts(proof.id), false);                    // 1 – 1 tie
  await vote(4, proof.id, false);
  assert.equal(await counts(proof.id), false);                    // 1 – 2 cap
  await vote(0, proof.id, true);
  await vote(4, proof.id, true);
  assert.equal(await counts(proof.id), true);                     // 3 – 1
  // The same rule as the app (proofOutcome in src/lib/groupChat.ts).
  const rule = async (legit, cap, legacy) => (await db.query('select private.group_proof_counts($1,$2,$3) as ok', [legit, cap, legacy])).rows[0].ok;
  assert.deepEqual(
    [await rule(0, 0, false), await rule(0, 0, true), await rule(1, 0, false), await rule(1, 1, true), await rule(0, 1, true), await rule(2, 1, false)],
    [false, true, true, false, false, true]);
});

// ---------------------------------------------------------------------------
// 5. The dare streak
// ---------------------------------------------------------------------------
test('A counting proof keeps the dare streak going for both the doer and the dare sender; a tie or cap one does not', async () => {
  const grp = await makeGroup();
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  await vote(2, proof.id, true);
  assert.equal(await streak(0, 1), 1);
  assert.equal(await streak(1, 0), 1);
  // Someone else in the group isn't part of this streak.
  assert.equal(await streak(0, 2), 0);
  assert.equal(await streak(2, 1), 0);
  // The votes change: a tie, then cap. The proof stops counting, here too.
  await vote(3, proof.id, false);
  assert.equal(await streak(0, 1), 0);
  await vote(4, proof.id, false);
  assert.equal(await streak(1, 0), 0);
  // And back to legit.
  await vote(3, proof.id, true);
  await vote(4, proof.id, true);
  assert.equal(await streak(0, 1), 1);
});

test('The streak mixes group dares with one-to-one chat dares and keeps the 3-day rule', async () => {
  const grp = await makeGroup();
  // A one-to-one chat dare from users[1] to users[0], confirmed ✅ (the existing way).
  const chat = (await rpc(1, "insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'dare','Sing a song') returning id", [users[1], users[0]])).rows[0].id;
  await rpc(0, 'select claim_chat_dare($1)', [chat]);
  await rpc(1, 'select confirm_chat_dare($1, true)', [chat]);
  assert.equal(await streak(0, 1), 1);
  // A group dare from users[0] that users[1] did, two days ago: 2 in a row.
  const first = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  await vote(2, first.id, true);
  await at(first.id, 2);
  assert.equal(await streak(0, 1), 2);
  // A group dare from users[1] that users[0] did, four days ago (2 days before the one above): 3 in a row.
  const second = await proofFrom(grp, 0, (await dareFrom(grp, 1, 'Wear a hat')).id);
  await vote(3, second.id, true);
  await at(second.id, 4);
  assert.equal(await streak(1, 0), 3);
  // One that is more than 3 days older than the one before it ends the streak there.
  const old = await proofFrom(grp, 1, (await dareFrom(grp, 0, 'Dance')).id);
  await vote(2, old.id, true);
  await at(old.id, 8);
  assert.equal(await streak(0, 1), 3);
  // Two counting proofs for one dare count once (the first one).
  const again = await proofFrom(grp, 1, first.dare_id);
  await vote(2, again.id, true);
  assert.equal(await streak(0, 1), 3);
});

test('A proof for your own dare never feeds a streak with yourself, but the group still votes on it', async () => {
  const grp = await makeGroup();
  const proof = await proofFrom(grp, 0, (await dareFrom(grp, 0)).id);
  assert.deepEqual(await vote(1, proof.id, true), { legit: 1, cap: 0, mine: true });
  assert.equal(await counts(proof.id), true);
  assert.equal(await streak(0, 0), 0);
  for (const i of [1, 2, 3]) assert.equal(await streak(0, i), 0, `user ${i}`);
});

// ---------------------------------------------------------------------------
// 6. Proofs from before the update
// ---------------------------------------------------------------------------
test('Proofs from before the update keep counting until someone votes; the flag is only set by the update', async () => {
  // A database like the one just before this update, with a group dare and its proofs made the old way.
  const old = await initializeDatabase(await PGlite.create(), { includeFixes: false });
  try {
    for (const name of await remainingMigrations()) if (name < VOTES_MIGRATION) await applyMigrationFile(old, name);
    const people = await seedUsers(old, 5);
    const as = (i, sql, args = []) => asUser(old, people[i], (tx) => tx.query(sql, args));
    for (const i of [1, 2, 3]) await friend(old, people[0], people[i]);
    const grp = (await as(0, "select create_peek_group('Old crew',$1::uuid[],current_date) as id", [[people[1], people[2], people[3]]])).rows[0].id;
    const dare = (await as(0, "insert into group_messages(group_id,sender_id,kind,body) values($1,$2,'dare','Do ten jumps') returning id", [grp, people[0]])).rows[0].id;
    const insertProof = async (i) => (await as(i, "insert into group_messages(group_id,sender_id,kind,dare_id,media_path,media_type) values($1,$2,'proof',$3,$4,'photo') returning id",
      [grp, people[i], dare, `${people[i]}/group/${randomUUID()}.jpg`])).rows[0].id;
    const oldProof = await insertProof(1);
    const untouched = await insertProof(2);
    const oldText = (await as(2, "insert into group_messages(group_id,sender_id,body) values($1,$2,'hi') returning id", [grp, people[2]])).rows[0].id;

    await applyMigrationFile(old, VOTES_MIGRATION);
    const flags = async (id) => (await old.query('select proof_legit, proof_cap, proof_legacy from group_messages where id = $1', [id])).rows[0];
    assert.deepEqual(await flags(oldProof), { proof_legit: 0, proof_cap: 0, proof_legacy: true });
    assert.deepEqual(await flags(untouched), { proof_legit: 0, proof_cap: 0, proof_legacy: true });
    assert.equal((await flags(oldText)).proof_legacy, false);
    const oldStreak = async (i = 1) => (await as(0, 'select chat_dare_streak($1) as n', [people[i]])).rows[0].n;
    assert.equal(await oldStreak(), 1, 'an old proof with no votes still counts');
    assert.equal(await oldStreak(2), 1);
    const oldVote = async (i, legit, proof = oldProof) => (await as(i, 'select vote_group_proof($1,$2,$3) as r', [proof, legit, people[i]])).rows[0].r;
    // Taking back a vote you never gave changes nothing: still nobody has voted.
    assert.deepEqual(await oldVote(2, null), { legit: 0, cap: 0, mine: null, legacy: true });
    assert.equal(await oldStreak(), 1);
    // Once someone votes, the normal rule applies: one cap vote and it doesn't count.
    assert.deepEqual(await oldVote(2, false), { legit: 0, cap: 1, mine: false, legacy: false });
    assert.equal(await oldStreak(), 0);
    // ...for good: taking that vote back leaves it with no votes, which doesn't count any more.
    assert.deepEqual(await oldVote(2, null), { legit: 0, cap: 0, mine: null, legacy: false });
    assert.equal(await oldStreak(), 0);
    assert.equal((await flags(oldProof)).proof_legacy, false);
    await oldVote(2, true);
    assert.equal(await oldStreak(), 1);
    await oldVote(3, false);
    assert.equal(await oldStreak(), 0, 'a tie does not count, even for an old proof');
    // An old proof whose only voter deletes their account doesn't count again either.
    assert.deepEqual(await oldVote(3, true, untouched), { legit: 1, cap: 0, mine: true, legacy: false });
    await old.query('delete from auth.users where id = $1', [people[3]]);
    assert.deepEqual(await flags(untouched), { proof_legit: 0, proof_cap: 0, proof_legacy: false });
    assert.equal(await oldStreak(2), 0);

    // A proof made after the update is not an old one, and running the update again doesn't change anything.
    const newProof = await insertProof(1);
    const stillOld = await insertProof(2);
    await old.query('update group_messages set proof_legacy = true where id = $1', [stillOld]);   // (as if from before)
    assert.equal((await flags(newProof)).proof_legacy, false);
    await old.exec(await migrationSql(VOTES_MIGRATION));
    assert.equal((await flags(newProof)).proof_legacy, false);
    assert.equal((await flags(stillOld)).proof_legacy, true);
    // (people[3]'s cap vote went with their account.)
    assert.deepEqual(await flags(oldProof), { proof_legit: 1, proof_cap: 0, proof_legacy: false });
  } finally { await old.close(); }
});

test('An old proof already counted: its doer gets a "cap" push, but no "The group says legit" push', async () => {
  const old = await initializeDatabase(await PGlite.create(), { includeFixes: false });
  try {
    for (const name of await remainingMigrations()) if (name < VOTES_MIGRATION) await applyMigrationFile(old, name);
    const people = await seedUsers(old, 5);
    const as = (i, sql, args = []) => asUser(old, people[i], (tx) => tx.query(sql, args));
    for (const i of [1, 2, 3, 4]) await friend(old, people[0], people[i]);
    const grp = (await as(0, "select create_peek_group('Old crew',$1::uuid[],current_date) as id", [[people[1], people[2], people[3], people[4]]])).rows[0].id;
    const dare = (await as(0, "insert into group_messages(group_id,sender_id,kind,body) values($1,$2,'dare','Do ten jumps') returning id", [grp, people[0]])).rows[0].id;
    const insertProof = async (i) => (await as(i, "insert into group_messages(group_id,sender_id,kind,dare_id,media_path,media_type) values($1,$2,'proof',$3,$4,'photo') returning id",
      [grp, people[i], dare, `${people[i]}/group/${randomUUID()}.jpg`])).rows[0].id;
    const legitFirst = await insertProof(1);
    const capFirst = await insertProof(2);
    await applyMigrationFile(old, VOTES_MIGRATION);
    for (const [i, token] of [[1, 'ExponentPushToken[qa-old-1]'], [2, 'ExponentPushToken[qa-old-2]']]) {
      await old.query("insert into push_tokens(token,user_id,platform) values($1,$2,'ios')", [token, people[i]]);
    }
    await old.exec('truncate net.sent restart identity');
    const oldVote = (i, proof, legit) => as(i, 'select vote_group_proof($1,$2,$3)', [proof, legit, people[i]]);
    const titles = async (token) => (await old.query("select body->0->>'title' as t from net.sent where body->0->>'to' = $1 order by id", [token])).rows.map((r) => r.t);
    // It already counted, and still does: no "legit" push.
    await oldVote(3, legitFirst, true);
    await oldVote(4, legitFirst, true);
    assert.deepEqual(await titles('ExponentPushToken[qa-old-1]'), []);
    // Cap first: the doer hears about it once; when the group comes round to legit, no "legit" push either.
    await oldVote(3, capFirst, false);
    await oldVote(4, capFirst, true);
    await oldVote(0, capFirst, true);
    assert.deepEqual(await titles('ExponentPushToken[qa-old-2]'), ['Someone called cap on your proof 🧢']);
    // A proof made after the update still gets its "legit" push.
    const fresh = await insertProof(1);
    await oldVote(3, fresh, true);
    assert.deepEqual(await titles('ExponentPushToken[qa-old-1]'), ['The group says legit 🔥']);
  } finally { await old.close(); }
});

test('App users cannot set the totals or the old-proof flag, and cannot write votes directly', async () => {
  const grp = await makeGroup();
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  await vote(2, proof.id, false);
  for (const i of [0, 1, 2]) {
    const changed = await rpc(i, 'update group_messages set proof_legit = 9, proof_cap = 0, proof_legacy = true where id = $1 returning id', [proof.id]);
    assert.deepEqual(changed.rows, [], `user ${i}`);
  }
  assert.deepEqual(await totals(proof.id), { legit: 0, cap: 1, legacy: false });
  for (const sql of [
    'insert into group_proof_votes(proof_id,user_id,legit) values($1,$2,true)',
    'update group_proof_votes set legit = true where proof_id = $1 and user_id = $2',
    'delete from group_proof_votes where proof_id = $1 and user_id = $2',
  ]) {
    await assert.rejects(() => rpc(2, sql, [proof.id, users[2]]), /permission denied/, sql);
  }
  await assert.rejects(() => rpc(2, 'truncate group_proof_votes'), /permission denied/);
  assert.deepEqual(await counted(proof.id), { legit: 0, cap: 1 });
  assert.equal(await streak(0, 1), 0);
  // The helpers are for the database only.
  for (const fn of ['private.group_proof_counts(integer,integer,boolean)', 'private.recount_group_proof(uuid)', 'private.recount_group_proof_votes()',
    'private.drop_votes_of_leaver()', 'private.lock_group_proofs_of_account()']) {
    for (const role of ['authenticated', 'anon']) {
      assert.equal((await db.query('select has_function_privilege($1, $2, \'EXECUTE\') as ok', [role, fn])).rows[0].ok, false, `${role} ${fn}`);
    }
  }
  await assert.rejects(() => rpc(2, 'select private.recount_group_proof($1)', [proof.id]), /permission denied/);
});

// ---------------------------------------------------------------------------
// 7. Notifications
// ---------------------------------------------------------------------------
test('The proof push no longer says the dare is done, and the Chat list line matches', async () => {
  const grp = await makeGroup();
  const tokens = [await pushTo(0), await pushTo(2)];
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  for (const token of tokens) {
    const last = (await pushesTo(token)).at(-1);
    assert.match(last.body, /: 📸 Posted proof – legit or cap\?$/);
  }
  const all = (await db.query("select body::text as b from net.sent")).rows.map((r) => r.b).join('\n');
  assert.doesNotMatch(all, /Did the dare/);
  const summary = (await rpc(2, 'select * from my_group_chats()')).rows.find((r) => r.group_id === grp);
  assert.equal(summary.last_body, '📸 Posted proof – legit or cap?');
  assert.equal(summary.last_sender, users[1]);
  assert.ok(proof.id);
});

test('The doer gets one "cap" push and one "legit" push per proof at most, however the votes change', async () => {
  const grp = await makeGroup();
  const doer = await pushTo(1);
  const voters = [];
  for (const i of [0, 2, 3, 4]) voters.push(await pushTo(i));
  const proof = await proofFrom(grp, 1, (await dareFrom(grp, 0)).id);
  await db.query('truncate net.sent restart identity');
  await vote(2, proof.id, false);
  let pushes = await pushesTo(doer);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Someone called cap on your proof 🧢');
  assert.match(pushes[0].body, /Squad is voting: legit or cap\?/);
  // Flipping back and forth, more cap votes, taking back and voting again: no more cap pushes.
  await vote(2, proof.id, null);
  await vote(2, proof.id, false);
  await vote(3, proof.id, false);
  await vote(3, proof.id, true);
  await vote(3, proof.id, false);
  assert.equal((await pushesTo(doer)).length, 1);
  // The group says legit (3 – 2): one push.
  await vote(0, proof.id, true);
  await vote(4, proof.id, true);
  await vote(3, proof.id, true);
  pushes = await pushesTo(doer);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].title, 'The group says legit 🔥');
  assert.match(pushes[1].body, /Squad: your proof for "Do ten jumps" counts ✅/);
  // It stops counting and starts again: no second legit push.
  await vote(0, proof.id, false);
  await vote(4, proof.id, false);
  await vote(0, proof.id, true);
  await vote(4, proof.id, true);
  assert.equal((await pushesTo(doer)).length, 2);
  // Voters never get a push about it.
  for (const token of voters) assert.deepEqual(await pushesTo(token), [], token);
  // A doer who has since blocked the dare's sender can't see that dare: the push doesn't quote it.
  const second = await proofFrom(grp, 1, (await dareFrom(grp, 0, 'Secret words')).id);
  await rpc(1, 'select block_user($1)', [users[0]]);
  await vote(2, second.id, true);
  pushes = (await pushesTo(doer)).filter((push) => !push.title.startsWith('👯'));   // (not the new chat messages' pushes)
  assert.equal(pushes.length, 3);
  assert.match(pushes[2].body, /Squad: your proof for "the dare" counts ✅/);
  assert.doesNotMatch(pushes[2].body, /Secret words/);
});

test('Vote pushes respect a muted group chat, leaving the group and the doer\'s notification settings', async () => {
  const grp = await makeGroup();
  const dare = await dareFrom(grp, 0);
  // Muted the group chat: no vote pushes.
  const mutedToken = await pushTo(1);
  await rpc(1, 'select set_group_chat_muted($1, true)', [grp]);
  const muted = await proofFrom(grp, 1, dare.id);
  await vote(2, muted.id, false);
  await vote(3, muted.id, true);
  await vote(4, muted.id, true);
  assert.deepEqual(await pushesTo(mutedToken), []);
  // Message notifications turned off: none either.
  const offToken = await pushTo(2);
  await db.query('insert into notification_prefs(user_id, messages) values($1, false) on conflict (user_id) do update set messages = false', [users[2]]);
  const off = await proofFrom(grp, 2, dare.id);
  await db.query('truncate net.sent restart identity');
  await vote(3, off.id, false);
  await vote(1, off.id, true);
  await vote(4, off.id, true);
  assert.deepEqual(await pushesTo(offToken), []);
  // Left the group: their proof can still be voted on, but they get no push about it.
  const goneToken = await pushTo(3);
  const left = await proofFrom(grp, 3, dare.id);
  await db.query('delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[3]]);
  await db.query('truncate net.sent restart identity');
  await vote(4, left.id, false);
  await vote(1, left.id, true);
  await vote(0, left.id, true);
  assert.deepEqual(await pushesTo(goneToken), []);
  assert.deepEqual(await totals(left.id), { legit: 2, cap: 1, legacy: false });
});

// ---------------------------------------------------------------------------
// 8. Deleted accounts
// ---------------------------------------------------------------------------
test('Deleting an account takes its votes away and counts the proofs again', async () => {
  const grp = await makeGroup();
  // The dare comes from users[2] (not the group's maker, whose account would take the whole group with it).
  const dare = await dareFrom(grp, 2);
  const proof = await proofFrom(grp, 1, dare.id);
  const other = await proofFrom(grp, 4, dare.id);
  await vote(2, proof.id, true);
  await vote(3, proof.id, true);
  await vote(4, proof.id, false);
  await vote(3, other.id, false);
  await vote(0, other.id, true);
  await vote(1, other.id, true);
  await db.query('delete from auth.users where id = $1', [users[3]]);
  assert.deepEqual(await totals(proof.id), { legit: 1, cap: 1, legacy: false });
  assert.deepEqual(await totals(other.id), { legit: 2, cap: 0, legacy: false });
  for (const id of [proof.id, other.id]) {
    const now = await totals(id);
    assert.deepEqual({ legit: now.legit, cap: now.cap }, await counted(id));
  }
  // The dare sender voted and is deleted: their dare, its proofs and every vote on them go, without an error.
  await db.query('delete from auth.users where id = $1', [users[2]]);
  assert.equal((await db.query('select count(*)::int as n from group_messages where id = any($1)', [[dare.id, proof.id, other.id]])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from group_proof_votes')).rows[0].n, 0);
  // The doer's account deleted: their proof and its votes go.
  const third = await proofFrom(grp, 4, (await dareFrom(grp, 0, 'Wear a hat')).id);
  await vote(1, third.id, true);
  await db.query('delete from auth.users where id = $1', [users[4]]);
  assert.equal((await db.query('select count(*)::int as n from group_proof_votes')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from group_messages where id = $1', [third.id])).rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// 9. Everything else about proofs still works
// ---------------------------------------------------------------------------
test('Proofs keep working with files, reports, the clean-up and the message rules', async () => {
  const grp = await makeGroup();
  const dare = await dareFrom(grp, 0);
  const proof = await proofFrom(grp, 1, dare.id);
  await vote(2, proof.id, true);
  // Members can open the proof's file; someone outside can't.
  assert.equal((await rpc(3, 'select private.can_read_media($1) as ok', [proof.media_path])).rows[0].ok, true);
  assert.equal((await rpc(5, 'select private.can_read_media($1) as ok', [proof.media_path])).rows[0].ok, false);
  // The clean-up still sees the file as in use.
  assert.equal((await db.query('select private.media_path_in_use($1, 7) as used', [proof.media_path])).rows[0].used, true);
  // A member can report it; the report keeps the file as evidence.
  await rpc(3, "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'group_message',$3,'spam')", [users[3], users[1], proof.id]);
  assert.deepEqual((await db.query('select object_name from private.report_media_evidence')).rows.map((r) => r.object_name), [proof.media_path]);
  // The message rules still refuse a proof without a photo or video type, and a proof for a dare in another group.
  assert.match(await failure(message(grp, 2, { kind: 'proof', dare_id: dare.id, media_path: `${users[2]}/group/x.jpg` })), /group_messages_media_kind/);
  for (const i of [5]) await friend(db, users[0], users[i]);
  const elsewhere = (await rpc(0, "select create_peek_group('Other',$1::uuid[],current_date) as id", [[users[5]]])).rows[0].id;
  assert.match(await failure(proofFrom(elsewhere, 5, dare.id)), /That dare is gone/);
  // An old proof that breaks today's rules (saved before them) can still be voted on.
  await db.exec('set session_replication_role = replica');
  const broken = (await db.query("insert into group_messages(group_id,sender_id,kind,dare_id,media_path,body) values($1,$2,'proof',$3,$4,$5) returning id",
    [grp, users[3], dare.id, `${users[3]}/group/old.jpg`, 'y'.repeat(2500)])).rows[0].id;
  await db.exec('set session_replication_role = origin');
  assert.deepEqual(await vote(2, broken, true), { legit: 1, cap: 0, mine: true });
  // The proof's sender can still delete it for everyone; its votes go with it.
  await rpc(1, 'delete from group_messages where id = $1', [proof.id]);
  assert.equal((await db.query('select count(*)::int as n from group_proof_votes where proof_id = $1', [proof.id])).rows[0].n, 0);
});
