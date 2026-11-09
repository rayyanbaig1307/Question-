import type { MysteryPost } from './guess';
import { deleteMedia, fixedSizePhoto, mediaFiles, uploadCapture, type Capture } from './media';
import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// 🕵️ Guess Who in a group chat: a photo posted into a group chat with no name on it. Everyone else in the group
// picks who they think sent it (from the people who were in the group when it was sent), then finds out – only
// they see the answer. It lasts 24 hours, like Guess Who with friends.
//
// It is NOT a group chat message: it is a Guess Who post (mystery_posts) with the group on it, so the sender's
// id is never sent to the other phones (see supabase/migrations/…_group_guess_who.sql). Guessing, reporting,
// blocking and deleting use the same calls as Guess Who with friends (lib/guess.ts).
// ---------------------------------------------------------------------------

// Every group Guess Who photo is a JPEG of exactly this size, so its size and shape can't hint at whose phone took
// it. On app downloads with Skia it is also saved by the same JPEG maker on every phone (see fixedSizePhoto in
// lib/media.ts for exactly what is promised, and what happens without Skia).
export const GROUP_GUESS_WIDTH = 1080;
export const GROUP_GUESS_HEIGHT = 1440;
export const GROUP_GUESS_PHOTOS_ONLY = 'Guess Who in groups is photos only for now';

// One group Guess Who, as the server shows it to you:
// - `options`: the people you can pick from (null on your own);
// - `poster`: who really sent it – null until you've guessed (or if it's yours);
// - `guess_count` / `right_count`: how many have guessed and how many got it right – null until you've guessed
//   (or if it's yours). Nobody is ever told who guessed what;
// - `others_count`: how many people can guess it (everyone who was in the group when it was sent, minus the sender).
export type GroupGuess = MysteryPost & { others_count: number };

export type GroupGuessFeed = { posts: GroupGuess[]; people: Map<string, Profile> };

// The server doesn't have group Guess Who yet: PostgREST says it can't find the function (PGRST202), or the
// database says there's no such function (42883). Any other error is a real problem.
function functionMissing(error: { code?: string | null }): boolean {
  return error.code === 'PGRST202' || error.code === '42883';
}

// The group Guess Whos in this group chat that you can see (newest first), with the profiles of the people to pick
// from. Returns null when the server doesn't have group Guess Who yet – then the chat simply shows none.
export async function fetchGroupGuesses(groupId: string): Promise<GroupGuessFeed | null> {
  const { data, error } = await supabase.rpc('group_mystery_feed', { grp: groupId });
  if (error) {
    if (functionMissing(error)) return null;
    throw error;
  }
  const posts = (data ?? []) as GroupGuess[];
  const ids = [...new Set(posts.flatMap((post) => [...(post.options ?? []), post.poster, post.my_guess]))].filter(
    (id): id is string => !!id,
  );
  const people = new Map<string, Profile>();
  if (ids.length > 0) {
    const { data: profiles, error: profileError } = await supabase.from('profiles').select('*').in('id', ids);
    if (profileError) throw profileError;
    for (const profile of (profiles ?? []) as Profile[]) people.set(profile.id, profile);
  }
  return { posts, people };
}

// Posts a photo into a group chat as a Guess Who. The photo is made the same size every time (1080 × 1440 JPEG)
// and saved in the shared Guess Who folder (the file name has no user id in it). The server checks the rest:
// you're in the group, the group has at least 3 people, and you haven't posted 3 today.
export async function postGroupGuess(userId: string, groupId: string, capture: Capture): Promise<void> {
  if (capture.kind !== 'photo') throw new Error(GROUP_GUESS_PHOTOS_ONLY);
  const uri = await fixedSizePhoto(capture.uri, GROUP_GUESS_WIDTH, GROUP_GUESS_HEIGHT);
  const { fields } = await uploadCapture(userId, 'mystery', { kind: 'photo', uri });
  const { error } = await supabase
    .from('mystery_posts')
    .insert({ user_id: userId, group_id: groupId, ...fields, caption: '' });
  if (error) {
    // Remove the file we just uploaded. If that fails too, still show the real reason it didn't work.
    await deleteMedia(mediaFiles(fields)).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}

// Live: a group Guess Who was posted or deleted in this group (or, with null, in any of your groups). The change
// only says which group – never who. Each listener gets its own channel name (two listeners on one name crash
// the realtime library – that was the 4 Nov launch crash).
let listener = 0;
export function subscribeToGroupGuesses(groupId: string | null, onChange: () => void): () => void {
  const channel = supabase.channel(`group-guess-${groupId ?? 'all'}-${++listener}`);
  channel.on(
    'postgres_changes',
    groupId
      ? { event: '*', schema: 'public', table: 'group_guess_pings', filter: `group_id=eq.${groupId}` }
      : { event: '*', schema: 'public', table: 'group_guess_pings' },
    () => onChange(),
  );
  channel.subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
