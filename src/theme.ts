import { File, Paths } from 'expo-file-system';
import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { Appearance } from 'react-native';

// ---------------------------------------------------------------------------
// Dark, Light or Match phone. The choice is kept in a tiny file on the phone and read the moment the app
// starts, so every screen is drawn in the right colors straight away. Changing it restarts the app.
// ---------------------------------------------------------------------------

export type ThemeChoice = 'dark' | 'light' | 'system';
const THEME_FILE = 'peekaboo-theme.txt';

function readThemeChoice(): ThemeChoice {
  try {
    const file = new File(Paths.document, THEME_FILE);
    if (file.exists) {
      const saved = file.textSync().trim();
      if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
    }
  } catch {
    // no saved choice yet
  }
  return 'dark';
}

export async function saveThemeChoice(choice: ThemeChoice): Promise<void> {
  const file = new File(Paths.document, THEME_FILE);
  if (!file.exists) file.create();
  await file.write(choice);
}

export const themeChoice: ThemeChoice = readThemeChoice();
// What "Match phone" means right now.
export const phoneScheme = Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
export const isDark = themeChoice === 'system' ? phoneScheme === 'dark' : themeChoice === 'dark';

// Make the phone's own pop-ups and keyboards match too.
try {
  Appearance.setColorScheme(themeChoice === 'system' ? 'unspecified' : themeChoice);
} catch {
  // older phones: fine either way
}

// One place for all the app's colors and sizes.
const dark = {
  bg: '#0B0B10',
  surface: '#15151E',
  card: '#1E1E2A',
  cardPressed: '#272736',
  border: '#2E2E40',
  text: '#FFFFFF',
  textMuted: '#A6A6BD',
  textFaint: '#6E6E86',
  // Main brand color (buttons, highlights) – pink, with white text on top.
  accent: '#FF4F9A',
  onAccent: '#FFFFFF',
  yellow: '#FFE14D',
  pink: '#FF4F9A',
  purple: '#9B5CFF',
  blue: '#38B6FF',
  green: '#3DDC97',
  orange: '#FF8A3D',
  red: '#FF4D5E',
  black: '#000000',
  white: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.35)',
  overlayStrong: 'rgba(0,0,0,0.7)',
};

// The same pink/purple style on a soft, light background.
const light: typeof dark = {
  bg: '#FFF8FC',
  surface: '#FFFFFF',
  card: '#F4ECF8',
  cardPressed: '#E9DDF2',
  border: '#E2D4EE',
  text: '#1B1428',
  textMuted: '#625878',
  textFaint: '#9A90AC',
  accent: '#FF3D8E',
  onAccent: '#FFFFFF',
  yellow: '#F5C400',
  pink: '#FF3D8E',
  purple: '#8A4DFF',
  blue: '#1E9BEA',
  green: '#1DB97F',
  orange: '#FF7A1F',
  red: '#F0384A',
  black: '#000000',
  white: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.3)',
  overlayStrong: 'rgba(0,0,0,0.6)',
};

export const colors = isDark ? dark : light;

// Text boxes get a keyboard in the matching color.
export const keyboardAppearance: 'dark' | 'light' = isDark ? 'dark' : 'light';

export const gradients = {
  brand: [colors.pink, colors.purple] as const,
  sunny: [colors.yellow, colors.orange] as const,
  ocean: [colors.blue, colors.purple] as const,
  night: [isDark ? '#1B1030' : '#FBE3F1', colors.bg] as const,
};

export const radius = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const font = {
  hero: { fontSize: 44, fontWeight: '900', color: colors.text, letterSpacing: -1 },
  title: { fontSize: 28, fontWeight: '900', color: colors.text },
  heading: { fontSize: 20, fontWeight: '800', color: colors.text },
  body: { fontSize: 16, fontWeight: '500', color: colors.text },
  label: { fontSize: 14, fontWeight: '700', color: colors.textMuted },
  small: { fontSize: 13, fontWeight: '500', color: colors.textMuted },
} as const;

// Colors for the top bars and screen backgrounds that the navigator draws.
export const navigationTheme: Theme = {
  ...(isDark ? DarkTheme : DefaultTheme),
  colors: {
    ...(isDark ? DarkTheme : DefaultTheme).colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
    notification: colors.pink,
  },
};
