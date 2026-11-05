import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Dimensions: {}, Keyboard: {}, LayoutAnimation: {}, Platform: { OS: 'ios' } }));
const { keyboardOverlap } = await import('../../src/lib/useKeyboardLift.ts');

// An iPhone 12-sized screen (844 tall), a chat box from under the top bar (y 120) to the bottom, a home bar of 34.
const box = { y: 120, height: 724 };

it('lifts the message box exactly onto the keyboard, without the home-bar gap', () => {
  // Keyboard 336 tall: its top is at 508. The box bottom (844) minus 508, minus the 34 the box already keeps free.
  expect(keyboardOverlap(box, { screenY: 508, height: 336 }, 844, 34)).toBe(302);
});

it('works when the iPhone reports the keyboard top as 0 (Prefer Cross-Fade Transitions)', () => {
  expect(keyboardOverlap(box, { screenY: 0, height: 336 }, 844, 34)).toBe(302);
});

it('does nothing when the keyboard does not cover the box (Android already made room)', () => {
  expect(keyboardOverlap({ y: 120, height: 388 }, { screenY: 508, height: 336 }, 844, 0)).toBe(0);
});
