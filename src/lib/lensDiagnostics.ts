// ---------------------------------------------------------------------------
// The small readout line for the 4 stretchy filters (🫥 🗿 😃 👾), shown only on the `testing` update channel
// (the owner's TestFlight builds) while one of them is on. It says how the camera picture is placed and whether
// pictures are being dropped, so one screenshot tells us what a phone does. Never on `production` or `preview`,
// in Expo Go or while developing (no channel there).
//
// No imports on purpose (tests/unit/lens-diagnostics.test.mjs runs this on its own). The readout itself is
// components/lens/warp/WarpDiagnostics.tsx; the numbers come from warp/FrameFeed.tsx.
//
// The line, for example `1920×1440 90→270m R✓ 30fps 390×844 ok`:
//   1920×1440  the camera picture's size in pixels
//   90→270m    the camera's label (degrees) → the turn drawn, "m" = mirrored (selfie camera)
//   R / C / F  how the turn was decided: R the rule, C the camera view's converter, F fixed 270 (neither knew)
//   ✓ ≈ ✗ ?    does the converter agree: ✓ yes, ≈ same turn but another size (normal while zoomed in),
//              ✗ a different turn, ? no converter yet
//   30fps      camera pictures per second
//   390×844    the camera view's size in screen points
//   ok         nothing went wrong. Otherwise the counts that aren't 0, always in this order:
//              late (a picture came over 0.1 s after the one before), gap (no picture for 1 s: the plain camera
//              showed), drop (pictures the camera dropped), oob (dropped because it ran out of pictures),
//              err (pictures that failed), dark (black pictures from the camera), cfg (camera set-ups since it
//              opened; shown only above 1)
// ---------------------------------------------------------------------------

// One number shared between threads (a FixedSynchronizable from react-native-worklets in FrameFeed).
export type WarpCounter = { getDirty(): number; setDirty(value: number): void };

// Everything FrameFeed counts for the readout. Only FrameFeed makes these (so only the new downloads ever have them).
export const WARP_STAT_NAMES = ['w', 'h', 'label', 'turn', 'mirror', 'fpsX10', 'late', 'gap', 'camErr', 'uiErr', 'drop', 'oob', 'dark', 'attempts'] as const;
export type WarpStatName = (typeof WARP_STAT_NAMES)[number];
export type WarpStats = Record<WarpStatName, WarpCounter>;

// The update channel this download listens on, or null (Expo Go, while developing, or if it can't be read).
export function updateChannel(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const updates = require('expo-updates') as { channel?: string | null };
    return typeof updates.channel === 'string' ? updates.channel : null;
  } catch {
    return null;
  }
}

// True only on the `testing` channel. `channel` is for the tests; the app leaves it out.
export function lensDiagnosticsOn(channel?: string | null): boolean {
  return (channel === undefined ? updateChannel() : channel) === 'testing';
}

// What one readout line is made from.
export type WarpLine = {
  // The camera picture's size (0 before the first one).
  w: number;
  h: number;
  // The camera's label and the turn drawn (degrees), and whether it is drawn mirrored.
  label: number;
  turn: number;
  mirror: boolean;
  // 0 rule, 1 converter, 2 fixed (warp/frameMatrix.ts placeShot).
  how: number;
  // warp/frameMatrix.ts compareMatrices against the converter, or null when there is no converter yet.
  agree: 'same' | 'turn' | 'differ' | null;
  fpsX10: number;
  view: { width: number; height: number };
  late: number;
  gap: number;
  drop: number;
  oob: number;
  err: number;
  dark: number;
  cfg: number;
};

const AGREE = { same: '✓', turn: '≈', differ: '✗' } as const;

// The readout line (see the top of this file).
export function formatWarpLine(s: WarpLine): string {
  const view = `${Math.round(s.view.width)}×${Math.round(s.view.height)}`;
  const parts: string[] = [];
  if (s.w > 0 && s.h > 0) {
    parts.push(`${Math.round(s.w)}×${Math.round(s.h)}`);
    parts.push(`${s.label}→${s.turn}${s.mirror ? 'm' : ''}`);
    parts.push(`${['R', 'C', 'F'][s.how] ?? '?'}${s.agree ? AGREE[s.agree] : '?'}`);
    parts.push(`${Math.round(s.fpsX10 / 10)}fps`);
  } else {
    parts.push('no picture yet');
  }
  parts.push(view);
  const problems: string[] = [];
  for (const [name, count] of [['late', s.late], ['gap', s.gap], ['drop', s.drop], ['oob', s.oob], ['err', s.err], ['dark', s.dark]] as const) {
    if (count > 0) problems.push(`${name}${count}`);
  }
  if (s.cfg > 1) problems.push(`cfg${s.cfg}`);
  parts.push(problems.length > 0 ? problems.join(' ') : 'ok');
  return parts.join(' ');
}
