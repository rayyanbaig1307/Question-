import { DarkTheme, type Theme } from 'expo-router';

// One place for all the app's colors and sizes.
export const colors = {
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
} as const;

export const gradients = {
  brand: [colors.pink, colors.purple] as const,
  sunny: [colors.yellow, colors.orange] as const,
  ocean: [colors.blue, colors.purple] as const,
  night: ['#1B1030', colors.bg] as const,
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
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
    notification: colors.pink,
  },
};
