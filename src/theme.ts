import { File, Paths } from 'expo-file-system';
import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { Appearance } from 'react-native';

// ---------------------------------------------------------------------------
// Dark, Light or Match phone – plus the Peekaboo+ themes (Black & Gold, Midnight, Sunset). The choice is kept
// in a tiny file on the phone and read the moment the app starts, so every screen is drawn in the right colors
// straight away. Changing it restarts the app.
// ---------------------------------------------------------------------------

export type ThemeChoice = 'dark' | 'light' | 'system' | PlusTheme;
// The themes only Peekaboo+ members can pick (Settings checks usePlus()).
export type PlusTheme = 'gold' | 'midnight' | 'sunset';
export const PLUS_THEMES: readonly PlusTheme[] = ['gold', 'midnight', 'sunset'];
const ALL_CHOICES: readonly string[] = ['dark', 'light', 'system', ...PLUS_THEMES];
const THEME_FILE = 'peekaboo-theme.txt';

function readThemeChoice(): ThemeChoice {
  try {
    const file = new File(Paths.document, THEME_FILE);
    if (file.exists) {
      const saved = file.textSync().trim();
      // A saved Plus theme is still used here even if the person doesn't have Plus any more, so the app
      // always starts fine. Settings won't let anyone without Plus pick one.
      if (ALL_CHOICES.includes(saved)) return saved as ThemeChoice;
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
// The theme in use right now ("Match phone" turned into dark or light).
const activeTheme: Exclude<ThemeChoice, 'system'> = themeChoice === 'system' ? phoneScheme : themeChoice;
// Every theme but Light is a dark one (Sunset is a dusk sky, so it's dark too).
export const isDark = activeTheme !== 'light';

// Make the phone's own pop-ups and keyboards match too.
try {
  Appearance.setColorScheme(themeChoice === 'system' ? 'unspecified' : isDark ? 'dark' : 'light');
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

// ⭐ Peekaboo+ themes. The fun colors (pink for dares, green, yellow…) stay the same so nothing gets confusing;
// the background, cards, text, buttons and story rings change.

// Black & Gold: true black with polished-gold text, gold-edged cards and sparkling gold dust behind the
// Home and Chat pages.
const gold: typeof dark = {
  ...dark,
  bg: '#050403',
  surface: '#14100A',
  card: '#1E170D',
  cardPressed: '#2B2112',
  border: '#5A4420',
  text: '#F7E2A8',
  textMuted: '#CFAE6A',
  textFaint: '#8C7445',
  accent: '#E9B44C',
  onAccent: '#1A1006',
};

// Midnight: deep night sky with shooting stars behind the Home and Chat pages, and ice-blue buttons.
const midnight: typeof dark = {
  ...dark,
  bg: '#0A0820',
  surface: '#141038',
  card: '#1D1848',
  cardPressed: '#28215C',
  border: '#342C6E',
  text: '#EAF4FF',
  textMuted: '#A9BEDD',
  textFaint: '#6F84A8',
  accent: '#38B6FF',
  onAccent: '#06142E',
};

// Sunset: a dusk sky – purple at the top fading to pink and orange, with twinkling stars and glitter behind
// the Home and Chat pages. Warm cream text and a glowing orange-to-pink for buttons and story rings.
const sunset: typeof dark = {
  ...dark,
  bg: '#2B1A55',
  surface: '#38215F',
  card: '#47286B',
  cardPressed: '#56317C',
  border: '#6B3F8A',
  text: '#FFF1E6',
  textMuted: '#FFC9B0',
  textFaint: '#C99AB8',
  accent: '#FF8A3D',
  onAccent: '#FFFFFF',
};

const palettes = { dark, light, gold, midnight, sunset };
export const colors = palettes[activeTheme];

// Text boxes get a keyboard in the matching color.
export const keyboardAppearance: 'dark' | 'light' = isDark ? 'dark' : 'light';

// The main two-color blend (story rings, big buttons, the dare banner) and the soft glow behind some
// screens, for each theme.
type Blend = readonly [string, string, ...string[]];
const brandBlend: Record<typeof activeTheme, Blend> = {
  dark: [colors.pink, colors.purple],
  light: [colors.pink, colors.purple],
  // Polished gold: light catching the edge, then deeper gold.
  gold: ['#FFF0B8', '#E9B44C', '#A8741A'],
  midnight: ['#9BE7FF', '#38B6FF', '#7B5CFF'],
  sunset: ['#FFC15E', '#FF7A45', '#FF4F8B'],
};
// The letter pictures for people without a photo.
const avatarBlend: Record<typeof activeTheme, Blend> = {
  dark: [colors.blue, colors.purple],
  light: [colors.blue, colors.purple],
  gold: ['#3A2B12', '#1A1309'],
  midnight: ['#2B3FA8', '#6C4DFF'],
  sunset: ['#FF8A3D', '#B05CFF'],
};
const glowTop: Record<typeof activeTheme, string> = {
  dark: '#1B1030',
  light: '#FBE3F1',
  gold: '#2A1D0E',
  midnight: '#1E3A8A',
  sunset: '#8A4DFF',
};

// ⭐ The moving picture behind the Home and Chat pages for each Peekaboo+ theme (one of the chat
// backgrounds in components/chat/ChatBackground.tsx), or null for none.
const scenes: Record<typeof activeTheme, 'dust' | 'night' | 'golden' | null> = {
  dark: null,
  light: null,
  gold: 'dust',
  midnight: 'night',
  sunset: 'golden',
};
export const themeScene = scenes[activeTheme];
// On a theme with a scene, the Home and Chat pages are see-through so it shows.
export const pageBackground = themeScene ? 'transparent' : colors.bg;

export const gradients = {
  brand: brandBlend[activeTheme],
  sunny: [colors.yellow, colors.orange] as const,
  ocean: avatarBlend[activeTheme],
  night: [glowTop[activeTheme], colors.bg] as const,
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
