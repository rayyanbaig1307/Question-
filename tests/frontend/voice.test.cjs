const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host } = require('./harness.cjs');

function fixture({ preparing, stopFailure = false } = {}) {
  const calls = { recorded: 0, stopped: 0, sent: 0, pending: [] };
  const recorder = { prepareToRecordAsync: async () => { if (preparing) await preparing; }, record: () => { calls.recorded++; }, stop: async () => { calls.stopped++; if (stopFailure) throw new Error('Simulated recorder failure'); }, getStatus: () => ({ durationMillis: 1500, metering: -20 }), uri: 'file:///qa-voice.m4a' };
  const screen = loadScreen('src/components/VoiceNote.tsx', {
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePanGesture: options => options, useTapGesture: options => options, useExclusiveGestures: first => first },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, FadeIn: { duration: () => ({}) }, FadeOut: { duration: () => ({}) } },
    'react-native-worklets': { scheduleOnRN: (callback, ...args) => { const result = Promise.resolve(callback(...args)); calls.pending.push(result); return result; } },
    '@/lib/media': { useMediaUrl: () => null },
    '@/lib/voice': { Audio: { useAudioRecorder: () => recorder, RecordingPresets: { HIGH_QUALITY: {} }, getRecordingPermissionsAsync: async () => ({ granted: true }), setAudioModeAsync: async () => {} }, MAX_VOICE_MS: 60000, MIN_VOICE_MS: 1000, toWaveform: () => [50], levelFromDecibels: () => 50, formatDuration: () => '0:01' },
  });
  screen.Component = () => React.createElement(screen.exports.MicButton, { onRecorded: () => { calls.sent++; }, onHint() {} });
  return { screen, calls };
}
async function start(tree, calls, wait = true) {
  await act(async () => { tree.root.findByType('GestureDetector').props.gesture.onActivate(); if (wait) await Promise.all(calls.pending); });
}

test('leaving a voice recorder clears its polling timer and never sends a recording', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  await start(tree, calls);
  assert.equal(screen.calls.intervals.size, 1);
  await unmount(tree);
  assert.equal(screen.calls.intervals.size, 0);
  assert.equal(calls.sent, 0);
});

test('a recorder that finishes preparing after its screen closes never starts recording', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ preparing: pending });
  const tree = await renderScreen(screen);
  await start(tree, calls, false);
  await unmount(tree);
  release(); await act(() => Promise.all(calls.pending));
  assert.equal(calls.recorded, 0);
  assert.equal(screen.calls.intervals.size, 0);
});

test('recorder stop failure is handled without sending an incomplete file', async () => {
  const { screen, calls } = fixture({ stopFailure: true });
  const tree = await renderScreen(screen);
  try {
    await start(tree, calls);
    await act(async () => {
      tree.root.findByType('GestureDetector').props.gesture.onDeactivate({ translationX: 0 });
      const results = await Promise.allSettled(calls.pending);
      assert.ok(results.every(result => result.status === 'fulfilled'), 'recorder errors need a handled UI path');
    });
    assert.equal(calls.sent, 0);
    assert.equal(screen.calls.alerts.at(-1)[0], 'Could not record');
  } finally { await unmount(tree); }
});
