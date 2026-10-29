import { requireOptionalNativeModule } from 'expo';

import type { Message } from './chat';
import { deleteMedia, uploadMedia } from './media';
import { supabase } from './supabase';

// Recording and playing sound is a native part of the app. Expo Go has it, but an app built before voice notes
// were added doesn't – then the mic button is hidden and voice notes say to update the app.
export const Audio: typeof import('expo-audio') | null = requireOptionalNativeModule('ExpoAudio')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-audio')
  : null;

export const WAVEFORM_BARS = 40;
export const MAX_VOICE_MS = 60_000;
export const MIN_VOICE_MS = 700;

// Sound level (in decibels, -160 = silence … 0 = loudest) → a bar height from 0 to 100.
export function levelFromDecibels(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0;
  return Math.round(Math.min(1, Math.max(0, (db + 55) / 55)) * 100);
}

// Squeezes all the sound levels from a recording into a fixed number of bars.
export function toWaveform(levels: number[], bars = WAVEFORM_BARS): number[] {
  if (levels.length === 0) return new Array(bars).fill(8);
  return Array.from({ length: bars }, (_, bar) => {
    const from = Math.floor((bar * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((bar + 1) * levels.length) / bars));
    const chunk = levels.slice(from, to);
    return Math.max(8, Math.round(chunk.reduce((sum, level) => sum + level, 0) / chunk.length));
  });
}

// "0:07"
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export async function sendVoice(
  me: string,
  friend: string,
  uri: string,
  durationMs: number,
  waveform: number[],
): Promise<Message> {
  const media_path = await uploadMedia(me, 'voice', uri, 'audio');
  const { data, error } = await supabase
    .from('messages')
    .insert({
      sender_id: me,
      recipient_id: friend,
      kind: 'voice',
      media_path,
      audio_ms: Math.min(MAX_VOICE_MS, Math.round(durationMs)),
      waveform,
    })
    .select('*')
    .single();
  if (error) {
    await deleteMedia([media_path]);
    throw error;
  }
  return data as Message;
}
