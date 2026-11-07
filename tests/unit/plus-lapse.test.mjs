import { expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// When Peekaboo+ ends, the two things that stay on the phone go back to free: a Plus app theme (back to Dark,
// with one restart) and a Plus app icon (back to the normal one). Free choices are left alone.
function loadLapse({ theme = 'dark', icon = 'classic', canChangeIcon = true } = {}) {
  const done = { savedTheme: null, reloads: 0, icon };
  const lib = loadLibrary('plusLapse', {
    mocks: {
      expo: { reloadAppAsync: async () => { done.reloads++; } },
      react: { useEffect() {} },
      'react-native': { AppState: { addEventListener: () => ({ remove() {} }) } },
      '@/lib/appIcons': {
        APP_ICONS: [{ key: 'classic', plus: false }, { key: 'midnight', plus: true }],
        CAN_CHANGE_APP_ICON: canChangeIcon,
        currentAppIcon: () => done.icon,
        setAppIcon: async (key) => { done.icon = key; },
      },
      '@/lib/plus': { plusSurelyOff: () => true, refreshServerPlus: async () => {}, watchMyPlus: () => () => {} },
      '@/theme': {
        PLUS_THEMES: ['gold', 'midnight', 'sunset'],
        themeChoice: theme,
        saveThemeChoice: async (choice) => { done.savedTheme = choice; },
      },
    },
  });
  return { lib, done };
}

it('a Plus theme goes back to Dark (one restart), and a Plus icon back to the normal one', async () => {
  const { lib, done } = loadLapse({ theme: 'gold', icon: 'midnight' });
  await lib.endPlusExtras();
  expect(done.icon).toBe('classic');
  expect(done.savedTheme).toBe('dark');
  expect(done.reloads).toBe(1);
});

it('free choices stay as they are: no restart, no icon change', async () => {
  const { lib, done } = loadLapse({ theme: 'light', icon: 'classic' });
  await lib.endPlusExtras();
  expect(done.icon).toBe('classic');
  expect(done.savedTheme).toBe(null);
  expect(done.reloads).toBe(0);
});

it('a phone that cannot change icons only gets its theme put back', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { lib, done } = loadLapse({ theme: 'sunset', icon: 'midnight', canChangeIcon: false });
  await lib.endPlusExtras();
  expect(done.icon).toBe('midnight');
  expect(done.savedTheme).toBe('dark');
});
