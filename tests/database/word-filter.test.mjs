// OPEN-01: the word filter is enforced by the database, not only by the app.
// Runs every migration in a local, in-memory PostgreSQL (PGlite). Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

const NAME_NOT_ALLOWED = "Let's keep it clean – that word can't be in a username or name.";
const WORD_NOT_ALLOWED = "That word isn't allowed on Peekaboo.";

let db;
let users;
before(async () => { db = await createLocalDatabase({ includeFixes: process.env.QA_ORIGINAL !== '1' }); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
// The database said no with the friendly sentence and the "check failed" code (23514).
async function blocked(run, message) {
  await assert.rejects(run, (error) => {
    assert.equal(error.message, message);
    assert.equal(error.code, '23514');
    return true;
  });
}
const nameBlocked = (run) => blocked(run, NAME_NOT_ALLOWED);
const wordBlocked = (run) => blocked(run, WORD_NOT_ALLOWED);
const profile = async (i) => (await db.query('select username, display_name, bio from profiles where id=$1', [users[i]])).rows[0];
const setOwn = (i, column, value) => rpc(i, `update profiles set ${column}=$2 where id=$1 returning id`, [users[i], value]);

async function post(i = 0, caption = '') {
  return (await rpc(i, 'insert into posts(user_id,media_path,caption) values($1,$2,$3) returning id',
    [users[i], `${users[i]}/posts/${randomUUID()}.jpg`, caption])).rows[0].id;
}
async function mystery(i = 0, caption = '') {
  const path = `mystery/${randomUUID()}.jpg`;
  await rpc(i, "insert into storage.objects(bucket_id,name) values ('media',$1)", [path]);
  return rpc(i, 'insert into mystery_posts(user_id,media_path,caption) values($1,$2,$3) returning id', [users[i], path, caption]);
}
async function adult(i) {
  await rpc(i, 'select set_birthday((current_date - make_interval(years => 25))::date)');
}
async function group(name, i = 0, j = 1) {
  await friend(db, users[i], users[j]);
  return (await rpc(i, 'select create_peek_group($1,$2::uuid[],current_date) as id', [name, [users[j]]])).rows[0].id;
}
// Writes a row the way old data looks (from before this filter), skipping the triggers just for this write.
async function legacy(sql, args) {
  await db.transaction(async (tx) => {
    await tx.exec("set local session_replication_role = 'replica'");
    await tx.query(sql, args);
  });
}

test('A direct (authenticated) change of your own username to f.u.c.k is rejected', async () => {
  await nameBlocked(() => setOwn(0, 'username', 'f.u.c.k'));
  assert.equal((await profile(0)).username, 'qa_user_0');
  // A normal rename still works.
  assert.equal((await setOwn(0, 'username', 'brand_new_name')).rows.length, 1);
  assert.equal((await profile(0)).username, 'brand_new_name');
});

test('Usernames reject swearing and slurs, including disguised spellings', async () => {
  // "big dick" and "DICK" aren't written like a real name, so the real-name rule doesn't let them through.
  for (const name of ['f.u.c.k', 'fuckboy', 'n1gg3r', 'sh1t', 'b.i.t.c.h', 'cocksucker_9', 'hitler88', 'big dick', 'DICK']) {
    await nameBlocked(() => setOwn(0, 'username', name));
  }
});

// The owner's choice: a display name (the name shown on a profile) may swear, like a bio. Only @usernames can't.
test('Display names allow swearing, however it is written', async () => {
  for (const name of ['f u c k', 'F.U.C.K', 'ｆｕｃｋ', '𝐟𝐮𝐜𝐤', 'ⓕⓤⓒⓚ', '\u{1CCDB}\u{1CCEA}\u{1CCD8}\u{1CCE0}', 'big dick', 'DICK', 'Total Bitch', 'Wanker 😀', 'Fuck Off', 'sh1t head']) {
    assert.equal((await setOwn(0, 'display_name', name)).rows.length, 1, name);
    assert.equal((await profile(0)).display_name, name);
  }
});

test('Display names reject slurs: dots, spaces, numbers and fancy letters', async () => {
  // Fancy letters: full-width, bold, circled and the newer "outlined" ones (here "RETARD").
  for (const name of ['n i g g e r', 'F.A.G.G.O.T', 'n1gg3r', 'Big R3tard', 'ｒｅｔａｒｄ', '𝐤𝐢𝐤𝐞', 'ⓢⓟⓘⓒ',
    '\u{1CCE7}\u{1CCDA}\u{1CCE9}\u{1CCD6}\u{1CCE7}\u{1CCD9}', 'Total Wetback', 'Tranny 😀']) {
    await wordBlocked(() => setOwn(0, 'display_name', name));
  }
  assert.equal((await profile(0)).display_name, 'QA 0');
});

test('Real names and innocent names are allowed, the same as in the app', async () => {
  for (const name of ['Moby Dick', 'Alex Cock', 'Dick Smith', 'Scunthorpe', 'Ishita', 'Pornsak', 'Nazir', 'Dickens', 'Cockburn', 'Shitake Sam']) {
    assert.equal((await setOwn(0, 'display_name', name)).rows.length, 1, name);
  }
  for (const name of ['scunthorpe', 'ishita', 'pornsak', 'nazir', 'dickens', 'class_act']) {
    assert.equal((await setOwn(0, 'username', name)).rows.length, 1, name);
  }
  // The username check ('name') keeps the real-name rule: "Dick" and "Cock" pass only when written like a name,
  // with a capital letter. Display names no longer use this check, so it is asked directly here.
  const nameWord = async (text) => (await db.query("select private.blocked_word($1,'name') as w", [text])).rows[0].w;
  for (const text of ['Moby Dick', 'Alex Cock', 'Dick Smith', 'Moby Dïck']) assert.equal(await nameWord(text), null, text);
  for (const [text, word] of [['big dick', 'dick'], ['DICK', 'dick'], ['big cock', 'cock'], ['DiCk', 'dick'], ['big dïck', 'dick']]) {
    assert.equal(await nameWord(text), word, text);
  }
});

test('Bios allow everyday swearing but not slurs', async () => {
  assert.equal((await setOwn(0, 'bio', 'living my best fucking life')).rows.length, 1);
  await wordBlocked(() => setOwn(0, 'bio', 'no f a g g o t s'));
  await wordBlocked(() => setOwn(0, 'bio', 'ｒｅｔａｒｄ'));
  assert.equal((await profile(0)).bio, 'living my best fucking life');
});

test('Post captions (new and edited) allow swearing but reject slurs', async () => {
  const id = await post(0, 'holy shit what a view');
  await wordBlocked(() => post(0, 'look at this n1gg4'));
  await wordBlocked(() => rpc(0, 'update posts set caption=$2 where id=$1', [id, 'what a retard']));
  assert.equal((await db.query('select caption from posts where id=$1', [id])).rows[0].caption, 'holy shit what a view');
});

test('Guess Who captions reject slurs', async () => {
  await mystery(0, 'guess who, bitches');
  await wordBlocked(() => mystery(0, 'guess who, you kike'));
});

test('Comments reject slurs but allow swearing', async () => {
  const id = await post(0);
  await rpc(1, 'insert into comments(user_id,post_id,body) values($1,$2,$3)', [users[1], id, 'fuck yeah']);
  await wordBlocked(() => rpc(1, 'insert into comments(user_id,post_id,body) values($1,$2,$3)', [users[1], id, 'shut up t.r.a.n.n.y']));
});

test('Hit up messages reject slurs', async () => {
  await adult(0); await adult(1); await adult(2);
  await wordBlocked(() => rpc(0, 'select hit_up($1,$2)', [users[1], 'hey you sp1c']));
  assert.equal((await db.query('select count(*)::int as n from hit_ups')).rows[0].n, 0);
  assert.equal((await rpc(0, 'select hit_up($1,$2) as r', [users[2], 'damn, nice pics']).then((r) => r.rows[0].r)), 'sent');
});

test('Community dare ideas reject slurs', async () => {
  await wordBlocked(() => rpc(0, 'insert into dare_ideas(user_id,text) values($1,$2)', [users[0], 'Call your friend a f4gg0t today']));
  await rpc(1, 'insert into dare_ideas(user_id,text) values($1,$2)', [users[1], 'Wear a silly hat all day']);
});

test('Group names reject slurs, when made and when renamed', async () => {
  await wordBlocked(() => group('The Pakis'));
  const id = await group('The Besties');
  await wordBlocked(() => rpc(0, 'select rename_peek_group($1,$2)', [id, 'Wetback Crew']));
  assert.equal((await db.query('select name from peek_groups where id=$1', [id])).rows[0].name, 'The Besties');
});

test('Private chat stays unfiltered: 1:1 and group chat, text and dares alike', async () => {
  // The owner's explicit exception: private chat between friends is never word-filtered. (Dares have their own
  // safety rules now – tests/database/dare-safety.test.mjs.) A dare card is a chat message too (sent from inside a chat, from "Dare back" or from "Dare a friend"), so 1:1 dares behave the same
  // as group dares. "Dare a friend" keeps its own check in the app (src/app/(app)/dare-friend.tsx).
  await friend(db, users[0], users[1]);
  const send = (kind, body) => rpc(0, 'insert into messages(sender_id,recipient_id,kind,body) values($1,$2,$3,$4) returning id', [users[0], users[1], kind, body]);
  // Innocent dares that only look bad with the gaps taken out ("be an errand" holds "beaner", "drag head" holds "raghead").
  for (const body of ['Be an errand runner for the day', 'Drag head first into the pool', 'Sing loudly, no bullshit']) {
    assert.equal((await send('dare', body)).rows.length, 1, body);
  }
  // Dares with slurs are refused since the owner's dare safety rule (20261224000000_dare_safety.sql): a dare
  // is never allowed to be hateful. Plain chat messages stay unfiltered.
  await assert.rejects(send('dare', 'Say hi to the chinks next door'), /no hate, bullying or slurs/);
  await send('text', 'you absolute faggot lol');
  // Editing a dare's text is not checked either (the same as a chat message).
  const dare = (await send('dare', 'Wear socks on your hands')).rows[0].id;
  await db.query("update messages set body='Be an errand runner' where id=$1", [dare]);
  const id = await group('Chat Crew');
  await rpc(0, "insert into group_messages(group_id,sender_id,kind,body) values($1,$2,'text',$3)", [id, users[0], 'nigga please']);
  await rpc(0, "insert into group_messages(group_id,sender_id,kind,body) values($1,$2,'dare',$3)", [id, users[0], 'Be an errand runner for the day']);
  // No word-filter trigger is left on private chat tables.
  const { rows } = await db.query(
    "select tgrelid::regclass::text as t from pg_trigger where tgname='word_filter' and tgrelid in ('public.messages'::regclass,'public.group_messages'::regclass)",
  );
  assert.deepEqual(rows, []);
});

test('Invisible characters and look-alike letters do not sneak words past the filter', async () => {
  const ZWSP = '\u200B';
  const hidden = [
    `cu${ZWSP}nt`, 'sh\u00ADit', 'c\u2060unt', 'fu\uFEFFck', 'bi\u200Dtch', 'fu\u{E0020}ck', 'f\u180Euck', 'cu\u034Fnt',
    'fu\uFE0Fck', 'sh\u200Eit',
    // Cyrillic and Greek letters that look like Latin ones.
    '\u0441unt', 'n\u0456gger', '\u0421UNT', 'f\u03C5ck', 'w\u04BBore', 'sh\u0456t', '\u0455hit', 'p\u043Ern',
  ];
  // Usernames can't hold these letters anyway (the format rule), but the word filter runs first and says no.
  for (const name of hidden) {
    await nameBlocked(() => setOwn(0, 'username', name));
  }
  // Display names may swear, but the same tricks don't sneak a slur in.
  const hiddenSlurs = [
    `ki${ZWSP}ke`, 'fa\u00ADggot', 's\u2060pic', 'ret\uFEFFard', 'ch\u200Dink', 'tr\u{E0020}anny', 'k\u180Eike', 'go\u034Fok',
    'dy\uFE0Fke', 'co\u200Eon',
    // Cyrillic and Greek letters that look like Latin ones.
    '\u0441hink', 'n\u0456gger', '\u0421HINK', 'f\u03B1ggot', 'w\u0435tback', '\u0455pic', 'k\u0456k\u0435', 'p\u0430ki',
    'g\u03BF\u03BFk', 'retar\u0501',
  ];
  for (const name of hiddenSlurs) {
    await wordBlocked(() => setOwn(0, 'display_name', name));
  }
  assert.equal((await profile(0)).display_name, 'QA 0');
  await wordBlocked(() => setOwn(0, 'bio', `cu${ZWSP}nt n\u0456gger`));
  await wordBlocked(() => setOwn(0, 'bio', `n${ZWSP}igger`));
  await wordBlocked(() => post(0, 'r\u00ADetard'));
  // Ordinary Russian, Greek and emoji text is still fine.
  for (const name of ['\u0410\u043B\u0435\u043A\u0441\u0435\u0439', '\u0391\u03BB\u03AD\u03BE\u03B1\u03BD\u03B4\u03C1\u03BF\u03C2', 'Love \u2764\uFE0F', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} fam']) {
    assert.equal((await setOwn(0, 'display_name', name)).rows.length, 1, name);
  }
  assert.equal((await profile(0)).bio, '');
});

test('Old rows that already hold a blocked word do not block unrelated changes', async () => {
  await legacy('update profiles set username=$2, display_name=$3, bio=$4 where id=$1', [users[0], 'fuckboy', 'Big Retard', 'retard']);
  const id = await post(0, 'fine');
  await legacy('update posts set caption=$2 where id=$1', [id, 'old nigger caption']);
  // Unrelated columns can still change.
  assert.equal((await rpc(0, 'update profiles set is_private=true where id=$1 returning id', [users[0]])).rows.length, 1);
  assert.equal((await rpc(0, 'update posts set audience=audience where id=$1 returning id', [id])).rows.length, 1);
  // Re-saving the same text is not a change either (the edit-profile screen saves every field).
  assert.equal((await rpc(0, 'update profiles set username=username, display_name=display_name, bio=bio where id=$1 returning id', [users[0]])).rows.length, 1);
  // But changing a blocked field to another blocked word is still stopped, and fixing it works.
  await wordBlocked(() => setOwn(0, 'bio', 'retards'));
  await wordBlocked(() => setOwn(0, 'display_name', 'Big Retards'));
  await nameBlocked(() => setOwn(0, 'username', 'fuckboy_2'));
  assert.equal((await setOwn(0, 'username', 'nice_name')).rows.length, 1);
  // Swearing is fine in a display name now, so this fixes the old slur.
  assert.equal((await setOwn(0, 'display_name', 'Big Shit')).rows.length, 1);
});

test('Apple / Google sign-up never fails because of a blocked name: it gets a safe one instead', async () => {
  const signUp = async (meta) => {
    const id = randomUUID();
    await db.query('insert into auth.users(id,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3)', [id, meta, { provider: 'google' }]);
    return (await db.query('select username, display_name from profiles where id=$1', [id])).rows[0];
  };
  // A slur in the shared name: the username and the shown name both become the safe "user" + numbers one.
  for (const meta of [{ name: 'n1gg3r' }, { full_name: 'ｆａｇｇｏｔ' }, { full_name: 'K I K E' }, { username: 'k1ke_lol', display_name: 'K\u0456ke' }]) {
    const row = await signUp(meta);
    assert.match(row.username, /^user[0-9a-f]{6}$/, JSON.stringify(meta));
    assert.equal(row.display_name, row.username, JSON.stringify(meta));
    // Allowed by the filter, so the person can carry on and pick a name in the app.
    assert.equal((await db.query("select private.blocked_word($1,'name') as w", [row.display_name])).rows[0].w, null);
  }
  // Swearing in the shared name: the username still gets a safe one, but the shown name is kept as it is.
  for (const meta of [{ full_name: 'Fuck Face' }, { username: 'fuck_you', display_name: 'Fuck You' }, { name: 'Total Bitch' }]) {
    const row = await signUp(meta);
    assert.match(row.username, /^user[0-9a-f]{6}$/, JSON.stringify(meta));
    assert.equal(row.display_name, meta.display_name ?? meta.full_name ?? meta.name, JSON.stringify(meta));
  }
  // A clean username with a slur as the display name keeps the username, and the shown name becomes the username.
  const id = randomUUID();
  await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [id, { username: 'goodname', display_name: 'Total Retard' }]);
  assert.deepEqual((await db.query('select username, display_name from profiles where id=$1', [id])).rows[0], { username: 'goodname', display_name: 'goodname' });
  // A clean username with swearing in the display name keeps both.
  const swears = randomUUID();
  await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [swears, { username: 'goodname2', display_name: 'Total Bitch' }]);
  assert.deepEqual((await db.query('select username, display_name from profiles where id=$1', [swears])).rows[0], { username: 'goodname2', display_name: 'Total Bitch' });
  // Real names written like names still come through.
  const moby = randomUUID();
  await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [moby, { full_name: 'Moby Dick' }]);
  assert.deepEqual((await db.query('select username, display_name from profiles where id=$1', [moby])).rows[0], { username: 'mobydick', display_name: 'Moby Dick' });
});

test('Numbers added to a taken username never spell a blocked word', async () => {
  // "nigg" is fine, but "nigg4123" reads as a slur once 4 → a. Every sign-up must still work.
  for (let i = 0; i < 40; i++) {
    await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [randomUUID(), { username: 'nigg' }]);
  }
  const { rows } = await db.query("select username from profiles where username like 'nigg%' or username like 'user%'");
  assert.equal(rows.length, 40);
  for (const { username } of rows) {
    assert.equal((await db.query("select private.blocked_word($1,'name') as w", [username])).rows[0].w, null, username);
  }
});

test('Only the server can use the sign-up name check', async () => {
  const check = (role) => asUser(db, null, (tx) => tx.query("select public_name_allowed('fuckboy','Alex') as ok"), role);
  assert.equal((await check('service_role')).rows[0].ok, false);
  assert.equal((await asUser(db, null, (tx) => tx.query("select public_name_allowed('alex','Moby Dick') as ok"), 'service_role')).rows[0].ok, true);
  await assert.rejects(() => check('authenticated'), /permission denied/);
  await assert.rejects(() => check('anon'), /permission denied/);
  await assert.rejects(() => rpc(0, "select private.blocked_word('x','name')"), /permission denied/);
});

test('The sign-up name check: no swearing in the username; the display name may swear but not hold a slur', async () => {
  const allowed = async (username, displayName) => (await asUser(db, null,
    (tx) => tx.query('select public_name_allowed($1,$2) as ok', [username, displayName]), 'service_role')).rows[0].ok;
  for (const displayName of ['Fuck Off', 'F U C K', 'ｆｕｃｋ', 'big dick', 'Total Bitch', 'Shït Happens']) {
    assert.equal(await allowed('alex', displayName), true, displayName);
  }
  for (const displayName of ['n1gg3r', 'F.A.G.G.O.T', 'ｒｅｔａｒｄ', 'ki\u200Bke', '\u0441hink', 'Wétbáck', 'Big Sp1c']) {
    assert.equal(await allowed('alex', displayName), false, displayName);
  }
  for (const username of ['f.u.c.k', 'fuckboy', 'sh1t_head', 'n1gg3r']) {
    assert.equal(await allowed(username, 'Alex'), false, username);
  }
});

test('Accented letters do not sneak words past the filter, and accented real names still save', async () => {
  // "ü", "ï" and so on used to turn into a gap, so "fück" read as "f ck".
  // Swearing: refused in a username (the word filter says no before the format rule does).
  for (const name of ['fück', 'cünt', 'shït', 'FÜCK', 'f̈uck', 'big dïck', 'nïgger']) {
    await nameBlocked(() => setOwn(0, 'username', name));
  }
  // Slurs: refused in a display name too.
  for (const name of ['nïgger', 'Fággót', 'Big Rétárd', 'KÏKE', 'spíc', 'chi\u0308nk', 'Wétbáck']) {
    await wordBlocked(() => setOwn(0, 'display_name', name));
  }
  // Swearing with accents is fine in a display name.
  assert.equal((await setOwn(0, 'display_name', 'Fück Öff')).rows.length, 1);
  await wordBlocked(() => setOwn(0, 'bio', 'what a nïgger'));
  await wordBlocked(() => post(0, 'rétárd'));
  await wordBlocked(() => rpc(0, 'insert into dare_ideas(user_id,text) values($1,$2)', [users[0], 'Call your friend a fággót']));
  for (const name of ['José', 'Zoë', 'Björk', 'Renée', 'Łukasz', 'Ñandú', 'Ågot', 'Алёна', 'Ζωή', 'Νίκος', 'Moby Dïck', 'Dïck Smith', 'Nguyễn Văn Phúc']) {
    assert.equal((await setOwn(0, 'display_name', name)).rows.length, 1, name);
  }
  assert.equal((await setOwn(0, 'bio', 'café, crème brûlée, mañana, Grüße, açúcar, teşekkür, cześć, cảm ơn')).rows.length, 1);
});

// Counts how often the word check really runs, without changing its answers. Puts the real check back afterwards.
async function countScans(run) {
  const original = (await db.query("select pg_get_functiondef('private.blocked_word(text,text)'::regprocedure) as def")).rows[0].def;
  await db.exec(`
    create sequence if not exists public.qa_word_scans;
    select nextval('public.qa_word_scans');
    grant usage on sequence public.qa_word_scans to public;
  `);
  await db.exec(original.replace('private.blocked_word(', 'private.qa_blocked_word_real('));
  await db.exec(`
    create or replace function private.blocked_word(value text, place text)
    returns text language plpgsql volatile strict set search_path = '' as $$
    begin
      perform nextval('public.qa_word_scans');
      return private.qa_blocked_word_real(value, place);
    end;
    $$;
  `);
  const scans = async () => Number((await db.query('select last_value from public.qa_word_scans')).rows[0].last_value);
  try {
    return await run(scans);
  } finally {
    await db.exec(original);
    await db.exec('drop function private.qa_blocked_word_real(text, text); drop sequence public.qa_word_scans;');
  }
}

// Every (table, column, place) the word filter triggers are set up to check.
async function filteredColumns() {
  const { rows } = await db.query(`
    select c.relname as table, encode(t.tgargs, 'escape') as args
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'word_filter' and n.nspname = 'public' order by 1`);
  return rows.flatMap(({ table, args }) => {
    const list = args.split('\\000').filter(Boolean);
    const pairs = [];
    for (let i = 0; i < list.length; i += 2) pairs.push({ table, column: list[i], place: list[i + 1] });
    return pairs;
  });
}

test('Huge texts are not scanned by the word filter: the length limit refuses them instead', async () => {
  const huge = `${'nigger '.repeat(400_000)}fuck`; // about 2.8 million characters
  await countScans(async (scans) => {
    const id = await post(0);
    await friend(db, users[0], users[1]);
    const start = await scans();
    // Someone else's row: refused by the access rules (RLS) – and the text was never scanned.
    await assert.rejects(() => rpc(1, 'insert into comments(user_id,post_id,body) values($1,$2,$3)', [users[0], id, huge]), /row-level security/);
    // Your own bio: refused by the length limit, not by the word filter.
    await assert.rejects(() => setOwn(0, 'bio', huge), (error) => {
      assert.equal(error.code, '23514');
      assert.equal(error.constraint, 'profiles_bio_length');
      return true;
    });
    await assert.rejects(() => post(0, huge), (error) => error.code === '23514' && error.message !== WORD_NOT_ALLOWED);
    await assert.rejects(() => group(huge), (error) => error.code === '23514' && error.message !== WORD_NOT_ALLOWED);
    assert.equal(await scans(), start, 'the huge texts were scanned');
    // Up to 2000 characters is still checked (bios are refused by the word filter first, then by the length limit).
    await wordBlocked(() => setOwn(0, 'bio', `${'a '.repeat(997)}nigger`.padEnd(2000, ' ')));
    assert.equal(await scans(), start + 1);
    // Normal text is unchanged.
    assert.equal((await setOwn(0, 'bio', 'living my best fucking life')).rows.length, 1);
    await nameBlocked(() => setOwn(0, 'username', 'f.u.c.k'));
    await wordBlocked(() => setOwn(0, 'display_name', 'n.i.g.g.e.r'));
  });
});

test('Each public column is checked in the right place: only usernames block swearing', async () => {
  assert.deepEqual(await filteredColumns(), [
    { table: 'comments', column: 'body', place: 'content' },
    { table: 'dare_ideas', column: 'text', place: 'content' },
    { table: 'hit_ups', column: 'message', place: 'content' },
    { table: 'mystery_posts', column: 'caption', place: 'content' },
    { table: 'peek_groups', column: 'name', place: 'content' },
    { table: 'posts', column: 'caption', place: 'content' },
    { table: 'profiles', column: 'username', place: 'name' },
    { table: 'profiles', column: 'display_name', place: 'content' },
    { table: 'profiles', column: 'bio', place: 'content' },
  ]);
});

test('Every filtered column refuses text over 2000 characters, even padded with spaces', async () => {
  // The filter skips texts over 2000 characters, so each filtered column must refuse them by itself.
  const columns = await filteredColumns();
  assert.equal(columns.length, 9, JSON.stringify(columns));
  await adult(0); await adult(1);
  const id = await post(0);
  const ids = {
    profiles: users[0],
    posts: id,
    mystery_posts: (await mystery(0, 'guess')).rows[0].id,
    comments: (await rpc(1, 'insert into comments(user_id,post_id,body) values($1,$2,$3) returning id', [users[1], id, 'nice'])).rows[0].id,
    hit_ups: (await rpc(0, 'select hit_up($1,$2)', [users[1], 'hey']), (await db.query('select id from hit_ups')).rows[0].id),
    dare_ideas: (await rpc(0, 'insert into dare_ideas(user_id,text) values($1,$2) returning id', [users[0], 'Wear a silly hat all day'])).rows[0].id,
    peek_groups: await group('The Besties', 0, 2),
  };
  for (const { table, column } of columns) {
    assert.ok(ids[table], `no test row for ${table}`);
    for (const value of [`kike${' '.repeat(2001)}`, `${' '.repeat(2001)}kike`, `kike${'\t'.repeat(2001)}`, 'x'.repeat(2001)]) {
      // As the database owner, so only the table's own rules (not the access rules) decide.
      await assert.rejects(
        () => db.query(`update public.${table} set ${column}=$2 where id=$1`, [ids[table], value]),
        (error) => {
          assert.equal(error.code, '23514', `${table}.${column}: ${error.message}`);
          assert.ok(error.constraint, `${table}.${column} was refused by "${error.message}", not by a length limit`);
          return true;
        },
        `${table}.${column} took ${JSON.stringify(value.slice(0, 8))}…`,
      );
    }
  }
});

test('The word filter says so loudly when it is set up with a column that does not exist', async () => {
  await db.exec(`
    create table public.qa_scratch(id int primary key, caption text);
    create trigger word_filter before insert or update on public.qa_scratch
      for each row execute function private.enforce_word_filter('captoin', 'content');
  `);
  try {
    await assert.rejects(() => db.query("insert into public.qa_scratch values (1, 'hello')"), /captoin/);
    await db.exec(`
      drop trigger word_filter on public.qa_scratch;
      create trigger word_filter before insert or update on public.qa_scratch
        for each row execute function private.enforce_word_filter('caption');
    `);
    await assert.rejects(() => db.query("insert into public.qa_scratch values (2, 'hello')"), /word filter/i);
    await db.exec(`
      drop trigger word_filter on public.qa_scratch;
      create trigger word_filter before insert or update on public.qa_scratch
        for each row execute function private.enforce_word_filter('caption', 'everywhere');
    `);
    await assert.rejects(() => db.query("insert into public.qa_scratch values (3, null)"), /everywhere/);
    await db.exec(`
      drop trigger word_filter on public.qa_scratch;
      create trigger word_filter before insert or update on public.qa_scratch
        for each row execute function private.enforce_word_filter('caption', 'content');
    `);
    assert.equal((await db.query("insert into public.qa_scratch values (4, 'hello') returning id")).rows.length, 1);
    await assert.rejects(() => db.query("insert into public.qa_scratch values (5, 'k1ke')"), /isn't allowed/);
  } finally {
    await db.exec('drop table public.qa_scratch');
  }
  // Every real word filter trigger names columns that exist, with a known place.
  for (const { table, column, place } of await filteredColumns()) {
    const { rows } = await db.query(
      "select 1 from pg_attribute where attrelid=$1::regclass and attname=$2 and not attisdropped", [`public.${table}`, column]);
    assert.equal(rows.length, 1, `${table}.${column}`);
    assert.ok(['name', 'content'].includes(place), `${table}.${column}: ${place}`);
  }
});
