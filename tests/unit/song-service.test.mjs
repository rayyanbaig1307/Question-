import { afterEach, expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';
afterEach(() => vi.useRealTimers());

const song = { trackId: 1, trackName: 'Song 👀', artistName: 'Artist', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg', previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a', trackViewUrl: 'https://music.apple.com/song/1' };
it('does not call the service for empty searches and safely encodes special characters', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ results: [song] }) }));
  const songs = loadLibrary('songs', { globals: { fetch, AbortController } });
  expect(await songs.searchSongs('   ')).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  const result = await songs.searchSongs(' 👀 & <script> ');
  expect(fetch.mock.calls[0][0]).toContain('term=%F0%9F%91%80%20%26%20%3Cscript%3E');
  expect(result[0].artworkUrl).toContain('300x300bb');
});

it('gives a controlled message when the music service fails', async () => {
  const songs = loadLibrary('songs', { globals: { fetch: async () => ({ ok: false }), AbortController } });
  await expect(songs.searchSongs('hi')).rejects.toThrow("Couldn't search for songs right now");
});

it('ends a stalled music search instead of leaving the screen waiting forever', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
  const songs = loadLibrary('songs', { globals: { fetch, AbortController } });
  const result = expect(songs.searchSongs('stalled')).rejects.toThrow('Search took too long');
  await vi.advanceTimersByTimeAsync(15_000);
  await result;
});

it.each(['javascript:alert(1)', 'file:///private/phone-file', 'https://music.apple.com.evil.invalid/phish', 'intent://danger'])('does not offer an unsafe profile song link: %s', (link) => {
  const songs = loadLibrary('songs');
  expect(songs.profileSong({ song_title: 'Hello', song_artist: 'Someone', song_artwork_url: song.artworkUrl100, song_preview_url: song.previewUrl, song_link_url: link })).toBeNull();
});

it('accepts complete Apple song details and rejects partial ones', () => {
  const songs = loadLibrary('songs');
  const profile = { song_title: 'Hello', song_artist: 'Someone', song_artwork_url: song.artworkUrl100, song_preview_url: song.previewUrl, song_link_url: song.trackViewUrl };
  expect(songs.profileSong(profile)).not.toBeNull();
  expect(songs.profileSong({ ...profile, song_preview_url: null })).toBeNull();
  expect(songs.songFields(null)).toEqual({ song_title: null, song_artist: null, song_artwork_url: null, song_preview_url: null, song_link_url: null });
});
