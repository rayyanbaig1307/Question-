const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen } = require('./harness.cjs');

function locationHarness({ permission, position, write } = {}) {
  const writes = [], spots = [];
  let sharing = false;
  const api = loadScreen('src/lib/location.ts', {
    'expo-location': {
      requestForegroundPermissionsAsync: permission || (async () => ({ granted: true })),
      getForegroundPermissionsAsync: async () => ({ granted: true }),
      getCurrentPositionAsync: position || (async () => ({ coords: { latitude: 43, longitude: -79 } })), Accuracy: { Balanced: 3 },
    },
    './profiles': { updateMyProfile: async (id, changes) => { writes.push(changes.location_sharing); if (write) await write(changes.location_sharing, writes.length); sharing = changes.location_sharing; return { id, location_sharing: sharing }; } },
    './supabase': { supabase: { from: () => ({ upsert: async value => { spots.push(value); return { error: null }; } }) } },
  }).exports;
  return { api, writes, spots, get sharing() { return sharing; } };
}
async function tick() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test('hide wins when an older show request is still asking for location permission', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const fixture = locationHarness({ permission: () => delayed });
  const show = fixture.api.setLocationSharing('alice', true);
  await fixture.api.setLocationSharing('alice', false);
  release({ granted: true });
  await show;
  assert.equal(fixture.sharing, false, 'accepting an old permission request must not turn location sharing back on');
  assert.equal(fixture.spots.length, 0);
});

test('hide wins when an older profile update finishes late', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const fixture = locationHarness({ write: async (_share, number) => { if (number === 1) await delayed; } });
  const show = fixture.api.setLocationSharing('alice', true);
  await tick();
  const hide = fixture.api.setLocationSharing('alice', false);
  await tick();
  release();
  await Promise.all([show, hide]);
  assert.equal(fixture.sharing, false, 'a delayed show save must never undo the later hide action');
});

test('a pending GPS response is discarded after location sharing is hidden', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const fixture = locationHarness({ position: () => delayed });
  const show = fixture.api.setLocationSharing('alice', true);
  await tick();
  await fixture.api.setLocationSharing('alice', false);
  release({ coords: { latitude: 43, longitude: -79 } });
  await show;
  assert.equal(fixture.spots.length, 0, 'a position obtained for an obsolete request must not be uploaded');
});

test('permission refusal never enables sharing or uploads a location', async () => {
  const fixture = locationHarness({ permission: async () => ({ granted: false }) });
  assert.equal(await fixture.api.setLocationSharing('alice', true), null);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.spots.length, 0);
});

test('a GPS failure does not leave the screen unaware that its sharing preference was saved', async () => {
  const fixture = locationHarness({ position: async () => { throw new Error('Simulated GPS failure'); } });
  const profile = await fixture.api.setLocationSharing('alice', true);
  assert.equal(profile.location_sharing, fixture.sharing);
  assert.equal(profile.location_sharing, true);
});
