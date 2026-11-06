import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

let db;
let users;
const original = process.env.QA_ORIGINAL === '1';
before(async () => { db = await createLocalDatabase({ includeFixes: !original }); });
after(async () => { if (db) await db.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent, public.username_auth_log restart identity;');
  users = await seedUsers(db);
});
const own = (index, run) => asUser(db, users[index], run);
const rpc = (index, sql, params = []) => own(index, tx => tx.query(sql, params));
const rejected = async (run, pattern = /row-level security|permission denied|check constraint|violates|not|only|already|Pick|gone|birthday|letters|limit|day|today|date|look|time|your|cannot|over|error|argument/i) => assert.rejects(run, pattern);
async function post(index = 0, extra = {}) {
  const fields = { user_id: users[index], media_path: `${users[index]}/posts/${randomUUID()}.jpg`, ...extra };
  const keys = Object.keys(fields);
  const result = await rpc(index, `insert into public.posts (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(fields));
  return result.rows[0];
}
async function mystery(index = 0, extra = {}) {
  const path = `mystery/${randomUUID()}.jpg`;
  await own(index, tx => tx.query("insert into storage.objects(bucket_id,name) values ('media',$1)", [path]));
  const fields = { user_id: users[index], media_path: path, ...extra };
  const keys = Object.keys(fields);
  return (await rpc(index, `insert into public.mystery_posts (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(fields))).rows[0];
}
async function snap() {
  await friend(db, users[0], users[1]);
  return (await rpc(0, "insert into messages(sender_id,recipient_id,kind,media_path) values ($1,$2,'snap',$3) returning *", [users[0], users[1], `${users[0]}/snaps/${randomUUID()}.jpg`])).rows[0];
}
async function birthday(index, years = 25) {
  await rpc(index, "select set_birthday((current_date - make_interval(years => $1))::date)", [years]);
}

test('Every remaining public table has row level security enabled', async () => {
  const { rows } = await db.query("select tablename from pg_tables where schemaname='public' and not rowsecurity");
  assert.deepEqual(rows, []);
});
test('No public view bypasses row level security', async () => {
  const { rows } = await db.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' and not coalesce(c.reloptions @> array['security_invoker=true'],false)");
  assert.deepEqual(rows, []);
});
test('Privileged public RPCs are not executable by anonymous users', async () => {
  const { rows } = await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.proname <> 'username_available' and has_function_privilege('anon',p.oid,'execute')");
  assert.deepEqual(rows, []);
});
test('Anonymous users cannot read profiles or posts', async () => {
  await post();
  const result = await asUser(db, null, tx => tx.query('select * from public.posts'), 'anon');
  assert.deepEqual(result.rows, []);
});
test('Missing authenticated identity cannot create a post', async () => {
  await rejected(() => asUser(db, null, tx => tx.query('insert into posts(user_id,media_path) values ($1,$2)', [users[0], `${users[0]}/posts/a.jpg`])));
});
test('Username availability is case insensitive', async () => {
  assert.equal((await asUser(db, null, tx => tx.query("select username_available(' QA_USER_0 ') as free"), 'anon')).rows[0].free, false);
});
test('Users cannot change another profile', async () => {
  assert.equal((await rpc(1, "update profiles set bio='stolen' where id=$1 returning id", [users[0]])).rows.length, 0);
});
test('Users cannot move a profile to someone else', async () => {
  await rejected(() => rpc(0, 'update profiles set id=$1 where id=$2', [users[1], users[0]]));
});
for (const [field, value] of [['bio', 'x'.repeat(161)], ['display_name', 'x'.repeat(41)], ['username', "'; DROP TABLE profiles;--"], ['song_link_url', 'https://evil.invalid/track']]) {
  test(`Profile rejects invalid ${field}`, async () => {
    await rejected(() => rpc(0, `update profiles set ${field}=$1 where id=$2`, [value, users[0]]));
  });
}
test('Emoji and SQL-like captions are stored as harmless plain text', async () => {
  const caption = "👀 <script>alert('x')</script> '; DROP TABLE profiles;--";
  assert.equal((await post(0, { caption })).caption, caption);
  assert.equal((await db.query('select count(*)::int as total from profiles')).rows[0].total, users.length);
});
test('Overlong captions are rejected by the database', async () => { await rejected(() => post(0, { caption: 'x'.repeat(301) })); });
test('Wrong-type latitude and out-of-range numbers fail', async () => {
  await rpc(0, 'update profiles set location_sharing=true where id=$1', [users[0]]);
  for (const latitude of ['oops', -91, 91]) await rejected(() => rpc(0, 'insert into locations(user_id,latitude,longitude) values ($1,$2,0)', [users[0], latitude]), /invalid input|check constraint/i);
});
test('Public posts readable; private posts require friendship', async () => {
  const p = await post();
  assert.equal((await rpc(1, 'select id from posts where id=$1', [p.id])).rows.length, 1);
  await rpc(0, 'update profiles set is_private=true where id=$1', [users[0]]);
  assert.equal((await rpc(1, 'select id from posts where id=$1', [p.id])).rows.length, 0);
  await friend(db, users[0], users[1]);
  assert.equal((await rpc(1, 'select id from posts where id=$1', [p.id])).rows.length, 1);
});
test('Close-friends audience protects rows and media', async () => {
  await friend(db, users[0], users[1]);
  const p = await post(0, { audience: 'close_friends' });
  assert.equal((await rpc(1, 'select id from posts where id=$1', [p.id])).rows.length, 0);
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [p.media_path])).rows[0].allowed, false);
  await rpc(0, 'insert into close_friends(owner,friend) values ($1,$2)', [users[0], users[1]]);
  assert.equal((await rpc(1, 'select id from posts where id=$1', [p.id])).rows.length, 1);
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [p.media_path])).rows[0].allowed, true);
});
test('An unposted image cannot be read by strangers', async () => {
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [`${users[0]}/posts/unpublished.jpg`])).rows[0].allowed, false);
});
test('Deleting a close-friends post does not expose its orphaned photo', async () => {
  const p = await post(0, { audience: 'close_friends' });
  await rpc(0, 'delete from posts where id=$1', [p.id]);
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [p.media_path])).rows[0].allowed, false);
});
test('Post updates cannot point at someone else\'s file', async () => {
  const p = await post();
  await rejected(() => rpc(0, 'update posts set media_path=$1 where id=$2', [`${users[1]}/posts/private.jpg`, p.id]));
});
test('Blocking revokes posts and future messages', async () => {
  await friend(db, users[0], users[1]);
  const p = await post();
  await rpc(0, 'select block_user($1)', [users[1]]);
  assert.equal((await rpc(1, 'select id from posts where id=$1', [p.id])).rows.length, 0);
  await rejected(() => rpc(1, "insert into messages(sender_id,recipient_id,kind,body) values ($1,$2,'text','hello')", [users[1], users[0]]));
});
test('A user cannot forge another post owner', async () => { await rejected(() => post(0, { user_id: users[1] })); });
test('You cannot delete someone else\'s post', async () => {
  const p = await post();
  assert.equal((await rpc(1, 'delete from posts where id=$1 returning id', [p.id])).rows.length, 0);
});
test('Stories are friends only and expiry is server controlled', async () => {
  const s = (await rpc(0, 'insert into stories(user_id,media_path,expires_at) values ($1,$2,now()+interval \'99 years\') returning *', [users[0], `${users[0]}/stories/a.jpg`])).rows[0];
  assert.ok(new Date(s.expires_at) - new Date(s.created_at) <= 86_400_001);
  assert.equal((await rpc(1, 'select id from stories where id=$1', [s.id])).rows.length, 0);
  await friend(db, users[0], users[1]);
  assert.equal((await rpc(1, 'select id from stories where id=$1', [s.id])).rows.length, 1);
});
test('Nonfriends cannot send direct messages', async () => { await rejected(() => rpc(0, "insert into messages(sender_id,recipient_id,kind,body) values ($1,$2,'text','hi')", [users[0], users[1]])); });
test('Third parties cannot read a chat', async () => {
  const s = await snap();
  assert.equal((await rpc(2, 'select id from messages where id=$1', [s.id])).rows.length, 0);
  assert.equal((await rpc(2, 'select private.can_read_media($1) as allowed', [s.media_path])).rows[0].allowed, false);
});
test('Only recipient opens a snap; it can be replayed once', async () => {
  const s = await snap();
  await rpc(2, 'select open_snap($1)', [s.id]);
  assert.equal((await db.query('select opened_at from messages where id=$1', [s.id])).rows[0].opened_at, null);
  await rpc(1, 'select open_snap($1)', [s.id]);
  assert.equal((await rpc(1, 'select replay_snap($1) as ok', [s.id])).rows[0].ok, true);
  assert.equal((await rpc(1, 'select replay_snap($1) as ok', [s.id])).rows[0].ok, false);
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [s.media_path])).rows[0].allowed, false);
});
test('Saved snap is readable until unsaved', async () => {
  const s = await snap();
  await rpc(1, 'select open_snap($1)', [s.id]);
  await rpc(1, 'select set_snap_saved($1,true)', [s.id]);
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [s.media_path])).rows[0].allowed, true);
  await rpc(1, 'select set_snap_saved($1,false)', [s.id]);
  await rpc(1, 'select replay_snap($1)', [s.id]);
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [s.media_path])).rows[0].allowed, false);
});
test('Empty and huge messages fail; valid emojis survive', async () => {
  await friend(db, users[0], users[1]);
  for (const body of ['', 'x'.repeat(2001)]) await rejected(() => rpc(0, "insert into messages(sender_id,recipient_id,kind,body) values ($1,$2,'text',$3)", [users[0], users[1], body]));
  await rpc(0, "insert into messages(sender_id,recipient_id,kind,body) values ($1,$2,'text','🙂👀')", [users[0], users[1]]);
});
test('Duplicate likes are prevented', async () => {
  const p = await post();
  await rpc(1, 'insert into likes(post_id,user_id) values ($1,$2)', [p.id, users[1]]);
  await rejected(() => rpc(1, 'insert into likes(post_id,user_id) values ($1,$2)', [p.id, users[1]]));
});
test('Replies cannot refer to comments on a different post', async () => {
  const p = await post(); const q = await post();
  const comment = (await rpc(1, "insert into comments(post_id,user_id,body) values ($1,$2,'hello') returning id", [p.id, users[1]])).rows[0].id;
  await rejected(() => rpc(1, "insert into comments(post_id,user_id,body,parent_id) values ($1,$2,'reply',$3)", [q.id, users[1], comment]), /same post/i);
});
test('Turning off map sharing deletes the location immediately', async () => {
  await rpc(0, 'update profiles set location_sharing=true where id=$1', [users[0]]);
  await rpc(0, 'insert into locations(user_id,latitude,longitude) values ($1,43.6,-79.3)', [users[0]]);
  await rpc(0, 'update profiles set location_sharing=false where id=$1', [users[0]]);
  assert.equal((await db.query('select * from locations')).rows.length, 0);
});
test('Map locations remain hidden from nonfriends', async () => {
  await rpc(0, 'update profiles set location_sharing=true where id=$1', [users[0]]);
  await rpc(0, 'insert into locations(user_id,latitude,longitude) values ($1,43.6,-79.3)', [users[0]]);
  assert.equal((await rpc(1, 'select * from locations')).rows.length, 0);
});
test('Group creation rolls back completely if one member is not a friend', async () => {
  await rejected(() => rpc(0, "select create_peek_group('QA group', $1::uuid[], current_date)", [[users[1]]]), /friends/i);
  assert.equal((await db.query('select * from peek_groups')).rows.length, 0);
});
test('Groups reject empty names and more than 12 members', async () => {
  for (let i = 1; i < 14; i++) await friend(db, users[0], users[i]);
  await rejected(() => rpc(0, "select create_peek_group('', $1::uuid[], current_date)", [[users[1]]]));
  await rejected(() => rpc(0, "select create_peek_group('Too many', $1::uuid[], current_date)", [users.slice(1,14)]), /12 people/i);
});
test('Nonmembers cannot read or rename a group', async () => {
  await friend(db, users[0], users[1]);
  const grp = (await rpc(0, "select create_peek_group('QA group', $1::uuid[], current_date) as id", [[users[1]]])).rows[0].id;
  assert.equal((await rpc(2, 'select * from peek_groups')).rows.length, 0);
  await rejected(() => rpc(2, "select rename_peek_group($1,'stolen')", [grp]), /not in this group/i);
});
test('Friends list is available only to the owner or friends', async () => {
  await friend(db, users[0], users[1]);
  assert.equal((await rpc(2, 'select id from friends_of($1)', [users[0]])).rows.length, 0);
  assert.equal((await rpc(1, 'select id from friends_of($1)', [users[0]])).rows.length, 1);
});
test('Guess Who keeps poster hidden until a guess', async () => {
  await friend(db, users[0], users[1]); const p = await mystery();
  assert.equal((await rpc(1, 'select poster from mystery_feed()')).rows[0].poster, null);
  assert.equal((await rpc(1, 'select * from mystery_posts')).rows.length, 0);
  await rpc(1, 'select guess_mystery($1,$2)', [p.id, users[0]]);
  assert.equal((await rpc(1, 'select poster from mystery_feed()')).rows[0].poster, users[0]);
});
test('Guess Who reporting does not reveal the anonymous poster', async () => {
  await friend(db, users[0], users[1]); const p = await mystery();
  await rpc(1, "select report_mystery($1,'spam')", [p.id]);
  const rows = (await rpc(1, 'select reported_user_id from reports where content_id=$1', [p.id])).rows;
  assert.ok(rows.every(row => row.reported_user_id === null), 'the report must not expose the poster to the reporter');
  assert.equal((await db.query('select reported_user_id from reports where content_id=$1', [p.id])).rows[0].reported_user_id, users[0], 'moderators still need the real account');
});
test('Guess Who expiry cannot be extended by a client', async () => {
  const p = await mystery(0, { expires_at: '2099-01-01T00:00:00Z' });
  assert.ok(new Date(p.expires_at) - new Date(p.created_at) <= 86_400_001);
});
test('Keeps rows and files remain private', async () => {
  const path = `${users[0]}/keeps/private.jpg`;
  await rpc(0, "insert into keeps(user_id,media_path,media_type) values ($1,$2,'photo')", [users[0],path]);
  assert.equal((await rpc(1, 'select * from keeps')).rows.length, 0);
  assert.equal((await rpc(1, 'select private.can_read_media($1) as allowed', [path])).rows[0].allowed, false);
});
test('Legal acceptance is idempotent and cannot be forged for another user', async () => {
  await rpc(0, "select accept_legal('terms','qa-v1')");
  await rpc(0, "select accept_legal('terms','qa-v1')");
  assert.equal((await rpc(0, 'select * from legal_acceptances')).rows.length, 1);
  await rejected(() => rpc(1, "insert into legal_acceptances(user_id,document,version) values ($1,'terms','qa-v1')", [users[0]]));
});
test('Birthdays reject future, underage, over-100 and duplicate values', async () => {
  for (const date of ["current_date+1", "current_date-interval '12 years'", "current_date-interval '101 years'"]) await rejected(() => rpc(0, `select set_birthday((${date})::date)`));
  await birthday(0);
  await rejected(() => birthday(0));
});
test('Birthdays are private and immutable outside their RPC', async () => {
  await birthday(0);
  assert.equal((await rpc(1, 'select * from age_checks')).rows.length, 0);
  assert.equal((await rpc(0, "update age_checks set birthday='1990-01-01' returning user_id")).rows.length, 0);
});
test('Hit ups reject teens and teen targets', async () => {
  await birthday(0,17); await birthday(1,25);
  await rejected(() => rpc(0, 'select hit_up($1)', [users[1]]), /18/i);
  await rejected(() => rpc(1, 'select hit_up($1)', [users[0]]), /available/i);
});
test('Adults can hit up, ignore privately, and hit back atomically', async () => {
  await birthday(0); await birthday(1);
  assert.equal((await rpc(0, "select hit_up($1,'hello') as result", [users[1]])).rows[0].result,'sent');
  const hit = (await rpc(1,'select id from hit_ups')).rows[0].id;
  await rpc(1,'select respond_hit_up($1,false)',[hit]);
  assert.equal((await rpc(0,'select hit_up_status($1) as result',[users[1]])).rows[0].result,'sent');
  await rejected(() => rpc(0,'select ignored_at from hit_ups'),/permission denied/i);
});
test('Hit ups enforce the rolling daily limit', async () => {
  for (let i = 0; i < 12; i++) await birthday(i);
  for (let i = 1; i <= 10; i++) await rpc(0,'select hit_up($1)',[users[i]]);
  await rejected(() => rpc(0,'select hit_up($1)',[users[11]]),/10 hit ups/i);
});
test('Community ideas cannot forge vote counts or selection state', async () => {
  const { rows } = await rpc(0,"insert into dare_ideas(user_id,text,votes,hidden,used_on,created_at) values ($1,'Wear a silly hat today',99999,true,current_date-10,now()-interval '10 years') returning *",[users[0]]);
  assert.equal(rows[0].votes,0); assert.equal(rows[0].hidden,false); assert.equal(rows[0].used_on,null);
  assert.ok(Math.abs(Date.now()-new Date(rows[0].created_at))<10_000);
});
test('Backdating an idea cannot bypass one-per-day limit', async () => {
  await rpc(0,"insert into dare_ideas(user_id,text,created_at) values ($1,'Wear a silly hat today',now()-interval '10 years')",[users[0]]);
  await rejected(() => rpc(0,"insert into dare_ideas(user_id,text) values ($1,'Wear another silly hat')",[users[0]]));
});
test('Multi-row inserts cannot bypass the daily dare suggestion limit', async () => {
  await rejected(() => rpc(0,"insert into dare_ideas(user_id,text) values ($1,'Wear a silly hat today'),($1,'Wear another silly hat')",[users[0]]));
});
test('Dangerous community dare text is rejected on the server', async () => { await rejected(() => rpc(0,"insert into dare_ideas(user_id,text) values ($1,'Jump off a roof today')",[users[0]])); });
test('Notification preferences cannot be changed for another person', async () => { await rejected(() => rpc(0,'insert into notification_prefs(user_id,messages) values ($1,false)',[users[1]])); });
test('Storage cannot be uploaded into another user\'s folder', async () => { await rejected(() => rpc(0,"insert into storage.objects(bucket_id,name) values ('media',$1)",[`${users[1]}/posts/a.jpg`])); });
test('Storage rejects attempts to read another user\'s keeps', async () => {
  await rpc(0,"insert into storage.objects(bucket_id,name) values ('media',$1)",[`${users[0]}/keeps/a.jpg`]);
  assert.equal((await rpc(1,'select * from storage.objects')).rows.length,0);
});
test('Auth throttle RPC is reserved for the server role', async () => {
  await rejected(() => rpc(0,"select reserve_username_auth_attempt('fail','qa',8,15)"),/permission denied/i);
});
test('Auth throttle reservations allow only the configured count', async () => {
  let allowed=0;
  for(let i=0;i<20;i++) {
    const { rows }=await asUser(db,null,tx=>tx.query("select reserve_username_auth_attempt('fail','qa',8,15) as allowed"),'service_role');
    allowed+=Number(rows[0].allowed);
  }
  assert.equal(allowed,8);
});

test('Adding a public user immediately creates exactly one friendship', async () => {
  // Only an adult's public account makes friends at once (20261220000000_launch_safety.sql).
  await birthday(1);
  assert.equal((await rpc(0,'select send_friend_request($1) as state',[users[1]])).rows[0].state,'accepted');
  await rpc(0,'select send_friend_request($1)',[users[1]]);
  await rpc(1,'select send_friend_request($1)',[users[0]]);
  assert.equal((await db.query('select * from friendships')).rows.length,1);
});
test('Private accounts require recipient acceptance; strangers cannot accept', async () => {
  await rpc(1,'update profiles set is_private=true where id=$1',[users[1]]);
  assert.equal((await rpc(0,'select send_friend_request($1) as state',[users[1]])).rows[0].state,'pending');
  const id=(await rpc(1,'select id from friendships')).rows[0].id;
  await rpc(2,'select respond_to_friend_request($1,true)',[id]);
  assert.equal((await db.query('select status from friendships')).rows[0].status,'pending');
  await rpc(1,'select respond_to_friend_request($1,true)',[id]);
  assert.equal((await db.query('select status from friendships')).rows[0].status,'accepted');
});
test('Declining a private friend request removes it; self and blocked requests fail', async () => {
  await rpc(1,'update profiles set is_private=true where id=$1',[users[1]]);
  await rpc(0,'select send_friend_request($1)',[users[1]]);
  const id=(await rpc(1,'select id from friendships')).rows[0].id;
  await rpc(1,'select respond_to_friend_request($1,false)',[id]);
  assert.equal((await db.query('select * from friendships')).rows.length,0);
  await rejected(()=>rpc(0,'select send_friend_request($1)',[users[0]]),/yourself/);
  await rpc(1,'select block_user($1)',[users[0]]);
  await rejected(()=>rpc(0,'select send_friend_request($1)',[users[1]]),/cannot add/);
});
test('Group members can rename/add friends; duplicates do not create extra members', async () => {
  await friend(db,users[0],users[1]); await friend(db,users[1],users[2]);
  const grp=(await rpc(0,"select create_peek_group('QA', $1::uuid[],current_date) as id",[[users[1],users[1]]])).rows[0].id;
  await rpc(1,"select rename_peek_group($1,'Friends 👀')",[grp]);
  await rpc(1,'select add_to_peek_group($1,$2::uuid[],current_date)',[grp,[users[2],users[2]]]);
  assert.equal((await rpc(1,'select name from peek_groups where id=$1',[grp])).rows[0].name,'Friends 👀');
  assert.equal((await rpc(1,'select * from peek_group_members where group_id=$1',[grp])).rows.length,3);
});
test('Only group creator can remove someone else; members can leave; only creator deletes', async () => {
  await friend(db,users[0],users[1]); await friend(db,users[0],users[2]);
  const grp=(await rpc(0,"select create_peek_group('QA', $1::uuid[],current_date) as id",[[users[1],users[2]]])).rows[0].id;
  assert.equal((await rpc(1,'delete from peek_group_members where group_id=$1 and user_id=$2 returning user_id',[grp,users[2]])).rows.length,0);
  assert.equal((await rpc(1,'delete from peek_groups where id=$1 returning id',[grp])).rows.length,0);
  await rpc(1,'delete from peek_group_members where group_id=$1 and user_id=$2',[grp,users[1]]);
  assert.equal((await rpc(1,'select * from peek_groups')).rows.length,0);
  await rpc(0,'delete from peek_group_members where group_id=$1 and user_id=$2',[grp,users[2]]);
  await rpc(0,'delete from peek_groups where id=$1',[grp]);
  assert.equal((await db.query('select * from peek_group_members')).rows.length,0);
});
test('Group dates outside server timezone range are rejected',async()=>{
  await friend(db,users[0],users[1]);
  await rejected(()=>rpc(0,"select create_peek_group('QA',$1::uuid[],current_date+5)",[[users[1]]]),/date/);
});
test('Group nudges are member-only and rate limited',async()=>{
  await friend(db,users[0],users[1]);
  const grp=(await rpc(0,"select create_peek_group('QA',$1::uuid[],current_date) as id",[[users[1]]])).rows[0].id;
  await rejected(()=>rpc(2,'select nudge_group_member($1,$2,current_date)',[grp,users[1]]),/not in this group/);
  await rpc(0,'select nudge_group_member($1,$2,current_date)',[grp,users[1]]);
  await rejected(()=>rpc(0,'select nudge_group_member($1,$2,current_date)',[grp,users[1]]),/just nudged/);
  assert.equal((await db.query('select * from nudges')).rows.length,1);
});
test('Only the account owner can register/unregister its known push token',async()=>{
  await rpc(0,"select register_push_token('ExponentPushToken[qa-local-only]','ios')");
  assert.equal((await rpc(1,'select * from push_tokens')).rows.length,0);
  await rpc(1,"select unregister_push_token('ExponentPushToken[qa-local-only]')");
  assert.equal((await db.query('select user_id from push_tokens')).rows[0].user_id,users[0]);
  await rpc(0,"select unregister_push_token('ExponentPushToken[qa-local-only]')");
  assert.equal((await db.query('select user_id from push_tokens')).rows[0].user_id,null);
});
test('Muted messages and disabled likes do not queue pushes',async()=>{
  await friend(db,users[0],users[1]);
  await rpc(1,"select register_push_token('ExponentPushToken[qa-local-only]','ios')");
  await rpc(1,'insert into friend_settings(user_id,friend_id,mute_messages) values($1,$2,true)',[users[1],users[0]]);
  await rpc(0,"insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'text','quiet')",[users[0],users[1]]);
  assert.equal((await db.query('select * from net.sent')).rows.length,0);
  await rpc(1,'insert into notification_prefs(user_id,likes) values($1,false)',[users[1]]);
  const p=await post(1);
  await rpc(0,'insert into likes(post_id,user_id) values($1,$2)',[p.id,users[0]]);
  assert.equal((await db.query('select * from net.sent')).rows.length,0);
});
test('Expired unsaved peeks cannot be saved, replayed or downloaded',async()=>{
  const s=await snap();
  await db.query("update messages set opened_at=now()-interval '25 hours' where id=$1",[s.id]);
  assert.equal((await rpc(1,'select set_snap_saved($1,true) as ok',[s.id])).rows[0].ok,false);
  assert.equal((await rpc(1,'select replay_snap($1) as ok',[s.id])).rows[0].ok,false);
  assert.equal((await rpc(1,'select private.can_read_media($1) as ok',[s.media_path])).rows[0].ok,false);
});
test('Saved peeks remain available after 24 hours, except when blocked',async()=>{
  const s=await snap();
  await db.query("update messages set opened_at=now()-interval '25 hours',saved_at=now(),saved_by=$2 where id=$1",[s.id,users[1]]);
  assert.equal((await rpc(1,'select private.can_read_media($1) as ok',[s.media_path])).rows[0].ok,true);
  await rpc(0,'select block_user($1)',[users[1]]);
  assert.equal((await rpc(1,'select private.can_read_media($1) as ok',[s.media_path])).rows[0].ok,false);
});
test('Screenshot messages cannot be unsent',async()=>{
  await friend(db,users[0],users[1]);
  const id=(await rpc(0,"insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'screenshot','chat') returning id",[users[0],users[1]])).rows[0].id;
  assert.equal((await rpc(0,'delete from messages where id=$1 returning id',[id])).rows.length,0);
});
test('Guess Who accepts only one guess per user and hides expired posts',async()=>{
  await friend(db,users[0],users[1]); const p=await mystery();
  await rpc(1,'select guess_mystery($1,$2)',[p.id,users[2]]);
  await rpc(1,'select guess_mystery($1,$2)',[p.id,users[0]]);
  assert.equal((await db.query('select guess from mystery_guesses')).rows[0].guess,users[2]);
  await db.query("update mystery_posts set expires_at=now()-interval '1 hour' where id=$1",[p.id]);
  assert.equal((await rpc(1,'select * from mystery_feed()')).rows.length,0);
  await rejected(()=>rpc(1,'select guess_mystery($1,$2)',[p.id,users[0]]),/gone/);
});
test('Guess Who posts cannot claim another person\'s uploaded file',async()=>{
  const p=await mystery();
  await rejected(()=>rpc(1,'insert into mystery_posts(user_id,media_path) values($1,$2)',[users[1],p.media_path]));
});
test('Hit up settings Nobody and friends-of-friends are enforced',async()=>{
  await birthday(0);await birthday(1);
  await rpc(1,"update profiles set hit_ups_from='nobody' where id=$1",[users[1]]);
  await rejected(()=>rpc(0,'select hit_up($1)',[users[1]]),/available/);
  await rpc(1,"update profiles set hit_ups_from='friends_of_friends' where id=$1",[users[1]]);
  await rejected(()=>rpc(0,'select hit_up($1)',[users[1]]),/available/);
  await friend(db,users[0],users[2]);await friend(db,users[1],users[2]);
  assert.equal((await rpc(0,'select hit_up($1) as result',[users[1]])).rows[0].result,'sent');
});
test('Reciprocal hit ups connect once and preserve both introduction messages',async()=>{
  await birthday(0);await birthday(1);
  await rpc(0,"select hit_up($1,'first hello')",[users[1]]);
  assert.equal((await rpc(1,"select hit_up($1,'hello back') as result",[users[0]])).rows[0].result,'connected');
  assert.equal((await db.query('select * from friendships')).rows.length,1);
  assert.deepEqual((await db.query('select body from messages order by body')).rows.map(r=>r.body),['first hello','hello back']);
});
test('Only hit-up recipient can respond; duplicate replies cannot duplicate messages',async()=>{
  await birthday(0);await birthday(1);
  await rpc(0,"select hit_up($1,'hi')",[users[1]]);
  const hit=(await db.query('select id from hit_ups')).rows[0].id;
  await rejected(()=>rpc(2,'select respond_hit_up($1,true)',[hit]),/gone/);
  await rpc(1,'select respond_hit_up($1,true)',[hit]);
  await rejected(()=>rpc(1,'select respond_hit_up($1,true)',[hit]),/gone/);
  assert.equal((await db.query('select * from messages')).rows.length,1);
});
test('Dare votes increment/decrement exactly and cannot be forged for someone else',async()=>{
  const idea=(await rpc(0,"insert into dare_ideas(user_id,text) values($1,'Wear a silly hat today') returning id",[users[0]])).rows[0].id;
  for(let i=1;i<=5;i++)await rpc(i,'insert into dare_votes(idea_id,user_id) values($1,$2)',[idea,users[i]]);
  assert.equal((await db.query('select votes from dare_ideas')).rows[0].votes,5);
  await rpc(1,'delete from dare_votes where idea_id=$1',[idea]);
  assert.equal((await db.query('select votes from dare_ideas')).rows[0].votes,4);
  await rejected(()=>rpc(6,'insert into dare_votes(idea_id,user_id) values($1,$2)',[idea,users[7]]));
});
test('Three distinct reports hide a community dare, duplicate reports count once',async()=>{
  const idea=(await rpc(0,"insert into dare_ideas(user_id,text) values($1,'Wear a silly hat today') returning id",[users[0]])).rows[0].id;
  await rpc(1,"select report_dare_idea($1,'spam')",[idea]);await rpc(1,"select report_dare_idea($1,'spam')",[idea]);
  assert.equal((await db.query('select count(*)::int as n from reports')).rows[0].n,1);
  await rpc(2,"select report_dare_idea($1,'spam')",[idea]);await rpc(3,"select report_dare_idea($1,'spam')",[idea]);
  assert.equal((await db.query('select hidden from dare_ideas')).rows[0].hidden,true);
  assert.equal((await rpc(4,'select * from dare_ideas')).rows.length,0);
});
test('Daily dare picker is idempotent and will not choose future dates',async()=>{
  const idea=(await rpc(0,"insert into dare_ideas(user_id,text) values($1,'Wear a silly hat today') returning id",[users[0]])).rows[0].id;
  for(let i=1;i<=3;i++)await rpc(i,'insert into dare_votes(idea_id,user_id) values($1,$2)',[idea,users[i]]);
  // Only ideas the owner approved before today's dare started can run (20261220000000_launch_safety.sql).
  await db.query("update dare_ideas set approved_at=now()-interval '2 days' where id=$1",[idea]);
  const a=(await rpc(1,'select * from pick_daily_dare(private.current_dare_day())')).rows;
  const b=(await rpc(2,'select * from pick_daily_dare(private.current_dare_day())')).rows;
  assert.equal(a[0].idea_id,idea);assert.deepEqual(a,b);
  assert.equal((await rpc(1,'select * from pick_daily_dare(current_date+2)')).rows.length,0);
});
test('Post edits cannot change dare day, drop day or forfeit fields',async()=>{
  const p=await post(0,{dare_day:'2000-01-01'});
  const updated=(await rpc(0,"update posts set dare_day='2099-01-01',drop_day='2099-01-01',drop_late_seconds=-999,forfeit_text='forged' where id=$1 returning *",[p.id])).rows[0];
  assert.deepEqual(updated.dare_day,p.dare_day);assert.equal(updated.drop_day,null);assert.equal(updated.drop_late_seconds,null);assert.equal(updated.forfeit_text,null);
});
test('Drop timezone bounds reject nonsense inputs',async()=>{
  for(const offset of [-721,841])await rejected(()=>post(0,{drop_offset_minutes:offset}),/time zone/);
});
test('Current legal versions are self-recorded; invalid documents and huge versions fail',async()=>{
  await rejected(()=>rpc(0,"select accept_legal('invented','qa')"));
  await rejected(()=>rpc(0,"select accept_legal('terms',$1)",['x'.repeat(41)]));
  await rpc(0,"select accept_legal('terms','self-reported-version')");
  assert.equal((await rpc(1,'select * from legal_acceptances')).rows.length,0);
});
test('A push queue failure must not erase an otherwise valid chat message',async()=>{
  await friend(db,users[0],users[1]);
  await rpc(1,"select register_push_token('ExponentPushToken[qa-local-only]','ios')");
  await own(0,async tx=>{
    await tx.exec("set local test.push_failure='on'");
    await tx.query("insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'text','keep this message')",[users[0],users[1]]);
  });
  assert.equal((await db.query('select body from messages')).rows[0].body,'keep this message');
});

test('Post timestamps cannot be forged while editing',async()=>{
  const p=await post();
  const changed=(await rpc(0,"update posts set created_at='2099-01-01' where id=$1 returning created_at",[p.id])).rows[0].created_at;
  assert.deepEqual(changed,p.created_at);
});
test('Dare nominations require your own daily completion and stop at three',async()=>{
  for(let i=1;i<=5;i++)await friend(db,users[0],users[i]);
  await rejected(()=>rpc(0,'select dare_friends($1::uuid[])',[users.slice(1,6)]),/dare first/);
  const p=await post(0,{dare_day:'2000-01-01'});
  assert.equal((await rpc(0,'select dare_friends($1::uuid[],$2) as n',[users.slice(1,6),p.id])).rows[0].n,3);
  assert.equal((await rpc(0,'select dare_friends($1::uuid[],$2) as n',[users.slice(1,6),p.id])).rows[0].n,0);
  assert.equal((await db.query('select * from dare_nominations')).rows.length,3);
});
test('Completing the dare also completes pending nominations and streaks count correctly',async()=>{
  await friend(db,users[0],users[1]); const p=await post(0,{dare_day:'2000-01-01'});
  await rpc(0,'select dare_friends($1::uuid[],$2)',[[users[1]],p.id]);
  await post(1,{dare_day:'2000-01-01'});
  assert.ok((await db.query('select done_at from dare_nominations')).rows[0].done_at);
  const streak=(await rpc(0,'select * from dare_streaks()')).rows[0];
  assert.equal(streak.streak,1);assert.equal(streak.me_today,true);assert.equal(streak.them_today,true);
});
async function overdueNomination(){
  await friend(db,users[0],users[1]); const p=await post(0,{dare_day:'2000-01-01'});
  await rpc(0,'select dare_friends($1::uuid[],$2)',[[users[1]],p.id]);
  const id=(await db.query('select id from dare_nominations')).rows[0].id;
  await db.query("update dare_nominations set expires_at=now()-interval '1 hour' where id=$1",[id]);
  return id;
}
test('Forfeits require expiry, the original sender and a valid safe choice',async()=>{
  const nomination=await overdueNomination();
  await rejected(()=>rpc(2,"select give_forfeit($1,'mustache')",[nomination]),/not your dare/);
  await rejected(()=>rpc(0,"select give_forfeit($1,'invented')",[nomination]),/from the list/);
  const id=(await rpc(0,"select give_forfeit($1,'mustache') as id",[nomination])).rows[0].id;
  await rejected(()=>post(2,{forfeit_id:id}),/isn't yours/);
  const paid=await post(1,{forfeit_id:id,forfeit_text:'forged words'});
  assert.notEqual(paid.forfeit_text,'forged words');
  assert.equal((await db.query('select done_post_id from forfeits')).rows[0].done_post_id,paid.id);
  await rejected(()=>post(1,{forfeit_id:id}),/already paid/);
});
test('One statement cannot pay the same forfeit twice',async()=>{
  const nomination=await overdueNomination();
  const id=(await rpc(0,"select give_forfeit($1,'mustache') as id",[nomination])).rows[0].id;
  await rejected(()=>rpc(1,'insert into posts(user_id,media_path,forfeit_id) values($1,$2,$4),($1,$3,$4)',[users[1],`${users[1]}/posts/a.jpg`,`${users[1]}/posts/b.jpg`,id]));
});
test('Dare ratings are friend-only, anonymous, changeable and totals stay correct',async()=>{
  const p=await post(0,{dare_day:'2000-01-01'});await friend(db,users[0],users[1]);
  await rejected(()=>rpc(2,"select rate_dare($1,'iconic')",[p.id]),/friends/);
  await rejected(()=>rpc(0,"select rate_dare($1,'iconic')",[p.id]),/own dare/);
  await rejected(()=>rpc(1,"select rate_dare($1,'invented')",[p.id]),/Pick/);
  await rpc(1,"select rate_dare($1,'iconic')",[p.id]);
  await rpc(1,"select rate_dare($1,'mid')",[p.id]);
  assert.equal((await rpc(0,'select * from dare_hype_votes')).rows.length,0);
  const hype=(await rpc(0,'select dare_hype(p) as summary from posts p where id=$1',[p.id])).rows[0].summary;
  assert.equal(hype.iconic,0);assert.equal(hype.mid,1);
  await rpc(1,'select rate_dare($1,null)',[p.id]);
  assert.equal((await db.query('select * from dare_hype_votes')).rows.length,0);
});
test('Old legit/cap RPC still restricts votes to friends and one per account',async()=>{
  const p=await post(0,{dare_day:'2000-01-01'});await friend(db,users[0],users[1]);
  await rejected(()=>rpc(2,'select vote_dare($1,true)',[p.id]),/friends/);
  await rpc(1,'select vote_dare($1,true)',[p.id]);await rpc(1,'select vote_dare($1,false)',[p.id]);
  assert.equal((await db.query('select * from dare_verdicts')).rows.length,1);
  const verdict=(await rpc(0,'select dare_verdict(p) as summary from posts p where id=$1',[p.id])).rows[0].summary;
  assert.equal(verdict.legit,0);assert.equal(verdict.cap,1);
});
test('Expired Guess Who can still be reported for safety without exposing its poster',async()=>{
  await friend(db,users[0],users[1]);const p=await mystery();
  await db.query("update mystery_posts set expires_at=now()-interval '1 hour' where id=$1",[p.id]);
  await rpc(1,"select report_mystery($1,'spam')",[p.id]);
  assert.equal((await rpc(1,'select reported_user_id from reports')).rows.length,0);
});
test('Reports start open even if a client attempts to mark them reviewed',async()=>{
  const report=(await rpc(0,"insert into reports(reporter_id,reported_user_id,content_type,reason,status) values($1,$2,'user','spam','reviewed') returning status",[users[0],users[1]])).rows[0];
  assert.equal(report.status,'open');
});
test('Message sender cannot pre-forge the saved/replayed state',async()=>{
  await friend(db,users[0],users[1]);
  const message=(await rpc(0,"insert into messages(sender_id,recipient_id,kind,media_path,saved_at,saved_by,replayed_at) values($1,$2,'snap',$3,now(),$2,now()) returning *",[users[0],users[1],`${users[0]}/snaps/a.jpg`])).rows[0];
  assert.equal(message.saved_at,null);assert.equal(message.saved_by,null);assert.equal(message.replayed_at,null);
});
test('Message sender cannot forge its timestamp or recipient read time',async()=>{
  await friend(db,users[0],users[1]);
  const message=(await rpc(0,"insert into messages(sender_id,recipient_id,kind,body,created_at,opened_at) values($1,$2,'text','hi','2099-01-01',now()) returning *",[users[0],users[1]])).rows[0];
  assert.ok(Math.abs(Date.now()-new Date(message.created_at))<10_000);assert.equal(message.opened_at,null);
});
test('Voice/screenshot messages cannot exploit SQL null checks to omit their content',async()=>{
  await friend(db,users[0],users[1]);
  await rejected(()=>rpc(0,"insert into messages(sender_id,recipient_id,kind,audio_ms) values($1,$2,'voice',1000)",[users[0],users[1]]));
  await rejected(()=>rpc(0,"insert into messages(sender_id,recipient_id,kind) values($1,$2,'screenshot')",[users[0],users[1]]));
});
test('Waveform bars must be finite database integers between 0 and 100',async()=>{
  await friend(db,users[0],users[1]);
  for(const waveform of [[-1],[101],[null],Array(65).fill(50)]){
    await rejected(()=>rpc(0,"insert into messages(sender_id,recipient_id,kind,media_path,audio_ms,waveform) values($1,$2,'voice',$3,1000,$4)",[users[0],users[1],`${users[0]}/voice/a.m4a`,waveform]));
  }
});
test('Account-deletion mystery-file lookup is server-only and includes orphaned own uploads',async()=>{
  const p=await mystery(0);await mystery(1);
  await rpc(0,"insert into storage.objects(bucket_id,name) values('media','mystery/orphan-qa.jpg')");
  await rpc(0,'delete from mystery_posts where id=$1',[p.id]);
  await rejected(()=>rpc(0,'select * from account_mystery_files($1)',[users[0]]),/permission denied/);
  const paths=(await asUser(db,null,tx=>tx.query('select * from account_mystery_files($1)',[users[0]]),'service_role')).rows.map(row=>row.path);
  assert.deepEqual(paths.sort(),[p.media_path,'mystery/orphan-qa.jpg'].sort());
});
test('Adding existing members to a full group remains idempotent',async()=>{
  for(let i=1;i<12;i++)await friend(db,users[0],users[i]);
  const grp=(await rpc(0,"select create_peek_group('Full QA',$1::uuid[],current_date) as id",[users.slice(1,12)])).rows[0].id;
  await rpc(0,'select add_to_peek_group($1,$2::uuid[],current_date)',[grp,[users[1]]]);
  await db.query('insert into peek_group_members(group_id,user_id,added_by,joined_day) values($1,$2,$2,current_date) on conflict do nothing',[grp,users[0]]);
  assert.equal((await db.query('select count(*)::int as n from peek_group_members where group_id=$1',[grp])).rows[0].n,12);
});
