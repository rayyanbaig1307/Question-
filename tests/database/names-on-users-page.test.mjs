// Names on the Supabase "Users" page (supabase/migrations/20270103000000_names_on_users_page.sql): each person's
// display name and username are copied onto their login. Runs all migrations in a local, in-memory PostgreSQL
// (PGlite) with invented users.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, createLocalDatabase, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 2);
});
const login = async (i) => (await db.query('select raw_user_meta_data as m from auth.users where id = $1', [users[i]])).rows[0].m ?? {};

test('Changing your name or username copies it onto your login, and keeps what was already there', async () => {
  await db.query(`update auth.users set raw_user_meta_data = '{"terms_version":"x","email_verified":true}'::jsonb where id = $1`, [users[0]]);
  await asUser(db, users[0], (tx) => tx.query("update profiles set display_name = 'Sunny Day', username = 'sunnyday' where id = $1", [users[0]]));
  const meta = await login(0);
  assert.equal(meta.display_name, 'Sunny Day');
  assert.equal(meta.username, 'sunnyday');
  assert.equal(meta.terms_version, 'x');
  assert.equal(meta.email_verified, true);
  // The other person's login is untouched.
  assert.notEqual((await login(1)).display_name, 'Sunny Day');
});

test('A profile still saves if the copy onto the login fails', async () => {
  await db.exec(`
    create or replace function private.refuse_login_change() returns trigger language plpgsql as $$
    begin raise exception 'login changes are refused in this test'; end $$;
    create trigger refuse_login_change before update on auth.users for each row execute function private.refuse_login_change();`);
  try {
    await asUser(db, users[1], (tx) => tx.query("update profiles set display_name = 'Still Saved' where id = $1", [users[1]]));
    assert.equal((await db.query('select display_name from profiles where id = $1', [users[1]])).rows[0].display_name, 'Still Saved');
  } finally {
    await db.exec('drop trigger refuse_login_change on auth.users; drop function private.refuse_login_change();');
  }
});
