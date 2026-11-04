import type { Profile } from './types';

// ---------------------------------------------------------------------------
// Profile songs come from Apple's free iTunes Search (no account or key needed). We only keep the song's
// details and links: a 30-second preview to play, and the full song on Apple Music. No music is stored.
// ---------------------------------------------------------------------------

export type Song = {
  id: number;
  title: string;
  artist: string;
  artworkUrl: string;
  previewUrl: string;
  linkUrl: string;
};

type ItunesResult = {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
};

// Profiles can be edited outside this app too. Only open song links from Apple's music hosts.
function appleUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*(?:apple\.com|mzstatic\.com)\//i.test(value);
}

export async function searchSongs(term: string): Promise<Song[]> {
  const query = term.trim();
  if (!query) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `https://itunes.apple.com/search?media=music&entity=song&limit=25&term=${encodeURIComponent(query)}`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error("Couldn't search for songs right now");
    const data = (await response.json()) as { results?: ItunesResult[] };
    return (Array.isArray(data.results) ? data.results : [])
      .filter((r) => r && r.trackId && r.trackName && r.artistName && appleUrl(r.artworkUrl100) && appleUrl(r.previewUrl) && appleUrl(r.trackViewUrl))
      .map((r) => ({
        id: r.trackId!,
        title: r.trackName!,
        artist: r.artistName!,
        // A bigger cover than the tiny 100 px one.
        artworkUrl: r.artworkUrl100!.replace('100x100bb', '300x300bb'),
        previewUrl: r.previewUrl!,
        linkUrl: r.trackViewUrl!,
      }));
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Search took too long. Please try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// The song on someone's profile (or null if they haven't picked one).
export function profileSong(profile: Profile | null | undefined): Song | null {
  if (!profile?.song_title || !profile.song_artist || !profile.song_artwork_url || !profile.song_preview_url || !profile.song_link_url) {
    return null;
  }
  if (!appleUrl(profile.song_artwork_url) || !appleUrl(profile.song_preview_url) || !appleUrl(profile.song_link_url)) return null;
  return {
    id: 0,
    title: profile.song_title,
    artist: profile.song_artist,
    artworkUrl: profile.song_artwork_url,
    previewUrl: profile.song_preview_url,
    linkUrl: profile.song_link_url,
  };
}

export function songFields(song: Song | null) {
  return {
    song_title: song?.title.slice(0, 200) ?? null,
    song_artist: song?.artist.slice(0, 200) ?? null,
    song_artwork_url: song?.artworkUrl ?? null,
    song_preview_url: song?.previewUrl ?? null,
    song_link_url: song?.linkUrl ?? null,
  };
}
