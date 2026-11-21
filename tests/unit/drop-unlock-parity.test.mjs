// "Posting your drop opens every drop until the next drop goes off": the app (nextDropAt in src/lib/drop.ts) and
// the database (private.next_drop_at in supabase/migrations/20261228000000_drop_unlock.sql) must agree on that
// moment to the millisecond, for every day and every time zone – otherwise a card shows as open while the
// server still refuses its photo (a grey box), or the other way round. They must also agree on the whole rule
// (dropDayOpen and private.drop_open_for), including the extra hour for older drops. Runs locally in PGlite;
// no live project.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase, seedUsers } from '../database/local-db.mjs';
import { loadLibrary } from './libHarness.mjs';

let db;
let drop;
beforeAll(async () => {
  drop = loadLibrary('drop');
  db = await createLocalDatabase();
});
afterAll(async () => { await db?.close(); });

describe('the app and the database agree when the next drop goes off', () => {
  it('for 1,200 days (including month, year and leap-day ends) and time zones from -12:00 to +14:00', async () => {
    const offsets = [-720, -600, -480, -300, -210, -60, 0, 60, 330, 345, 480, 570, 600, 780, 840];
    const { rows } = await db.query(`
      select d::date::text as day, o as offset_minutes,
             (extract(epoch from private.next_drop_at(d::date, o)) * 1000)::bigint::text as at
        from generate_series(date '2025-12-01', date '2029-03-14', interval '1 day') d, unnest($1::int[]) o`, [offsets]);
    expect(rows.length).toBe(1200 * offsets.length);
    const different = rows.filter((row) => drop.nextDropAt(row.day, row.offset_minutes) !== Number(row.at));
    expect(different.slice(0, 5)).toEqual([]);
  });
  it('a missing time zone counts as UTC on both sides', async () => {
    const { rows: [row] } = await db.query("select (extract(epoch from private.next_drop_at('2026-11-20', null)) * 1000)::bigint::text as at");
    expect(drop.nextDropAt('2026-11-20', null)).toBe(Number(row.at));
  });
});

describe('the app and the database agree whether a drop is open', () => {
  it('just before and after the next drop goes off, and just before and after the extra hour for older drops', async () => {
    const [me] = await seedUsers(db, 1);
    const checked = [];
    // One transaction, so the database's clock (now()) stands still while we compare.
    await db.transaction(async (tx) => {
      await tx.exec('set local session_replication_role = replica'); // write drops for any day, like the database tests
      const { rows: [clock] } = await tx.query(`
        select (extract(epoch from now()) * 1000)::bigint::text as now_ms,
               ((now() at time zone 'utc')::date - 1)::text as day,
               (now() at time zone 'utc')::date::text as next_day,
               ((now() at time zone 'utc')::date - 4)::text as older_day`);
      const nowMs = Number(clock.now_ms);
      // My drop from yesterday, "posted" from a made-up time zone that puts its next drop `minutes` from now.
      for (const minutes of [-90, -62, -58, -30, -2, 2, 30]) {
        const { rows: [{ offset }] } = await tx.query(`
          select round(extract(epoch from ((date '${clock.day}' + 1) + make_interval(mins => private.drop_minute(date '${clock.day}' + 1)))
                       - ((now() at time zone 'utc') + make_interval(mins => $1::int))) / 60)::int as offset`, [minutes]);
        await tx.query('delete from posts where user_id = $1', [me]);
        await tx.query(
          `insert into posts(user_id, media_path, drop_day, drop_offset_minutes, drop_late_seconds)
           values ($1, $2, $3, $4, 0)`, [me, `${me}/posts/mine.jpg`, clock.day, offset]);
        const mine = { days: new Set([clock.day]), windows: [{ day: clock.day, until: drop.nextDropAt(clock.day, offset) }] };
        for (const day of [clock.older_day, clock.day, clock.next_day]) {
          const { rows: [{ open }] } = await tx.query('select private.drop_open_for($1, $2::date) as open', [me, day]);
          checked.push({ minutes, day, database: open, app: drop.dropDayOpen(mine, day, nowMs) });
        }
      }
    });
    expect(checked.filter((c) => c.database !== c.app)).toEqual([]);
    // And the rule itself: a drop from the new day locks when the next drop goes off; older ones an hour later.
    const open = (minutes, day) => checked.find((c) => c.minutes === minutes && c.day === day).app;
    const [older, same, newer] = [...new Set(checked.map((c) => c.day))];
    expect([30, 2, -2, -30, -58, -62, -90].map((m) => open(m, newer))).toEqual([true, true, false, false, false, false, false]);
    expect([30, 2, -2, -30, -58, -62, -90].map((m) => open(m, older))).toEqual([true, true, true, true, true, false, false]);
    expect([30, -90].map((m) => open(m, same))).toEqual([true, true]); // a day you posted: always open
  });
});
