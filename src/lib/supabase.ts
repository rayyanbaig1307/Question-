import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

// These come from the .env file (see .env.example).
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

// If the .env file is missing, the app shows a friendly "setup needed" screen instead of crashing.
export const isSupabaseConfigured = supabaseUrl.startsWith('https://') && supabaseKey.length > 0;

export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : 'https://setup-needed.supabase.co',
  isSupabaseConfigured ? supabaseKey : 'setup-needed',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);

// Keep the login fresh only while the app is open on screen.
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});
