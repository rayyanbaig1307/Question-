const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen } = require('./harness.cjs');

const APP_STORE = 'https://apps.apple.com/app/id6829561855';
const TESTFLIGHT = 'https://testflight.apple.com/join/3DWqzxhS';

// Loads lib/invite.ts as if it ran on a phone (`os`) with an update channel (`channel`, null = Expo Go).
function loadInvite({ os, channel }) {
  const shared = [];
  const { exports } = loadScreen('src/lib/invite.ts', {
    'expo-updates': { channel },
    'react-native': { Platform: { OS: os }, Share: { share: async content => { shared.push(content); } } },
  });
  return { invite: exports, shared };
}

test('the App Store app invites with the App Store link and no Android download', () => {
  const { invite } = loadInvite({ os: 'ios', channel: 'production' });
  const message = invite.withAppLink('Come hang out');
  assert.equal(invite.IPHONE_LINK, APP_STORE);
  assert.match(message, /🍎 iPhone: https:\/\/apps\.apple\.com\/app\/id6829561855/);
  assert.doesNotMatch(message, /testflight/i);
  assert.doesNotMatch(message, /Android|\.apk/, 'an iPhone invite never points to the Android download');
});

test('test copies of the iPhone app (TestFlight, Expo Go) keep the TestFlight link', () => {
  for (const channel of ['preview', 'testing', null]) {
    const { invite } = loadInvite({ os: 'ios', channel });
    const message = invite.withAppLink('Come hang out');
    assert.equal(invite.IPHONE_LINK, TESTFLIGHT, `channel ${channel}`);
    assert.match(message, /🍎 iPhone: https:\/\/testflight\.apple\.com\/join\/3DWqzxhS/);
    assert.doesNotMatch(message, /Android|\.apk/);
  }
});

test('an Android phone adds the Android download line', () => {
  const { invite } = loadInvite({ os: 'android', channel: 'preview' });
  const lines = invite.withAppLink('Come hang out').split('\n');
  assert.equal(lines[0], 'Come hang out');
  assert.equal(lines[2], `📱 Android: ${invite.ANDROID_LINK}`);
  assert.equal(lines[3], `🍎 iPhone: ${TESTFLIGHT}`);
});

test('inviteFriends shares one message with your username and the links', async () => {
  const { invite, shared } = loadInvite({ os: 'ios', channel: 'production' });
  await invite.inviteFriends('alice');
  assert.equal(shared.length, 1);
  assert.match(shared[0].message, /I'm @alice – add me!/);
  assert.match(shared[0].message, new RegExp(APP_STORE.replace(/[.\/]/g, '\\$&')));
});
