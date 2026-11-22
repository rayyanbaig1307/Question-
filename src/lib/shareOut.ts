import { Platform, Share } from 'react-native';

import { CAN_SAVE_TO_PHOTOS, saveToPhotos } from './keeps';
import { watermarkPhoto } from './watermark';

// ---------------------------------------------------------------------------
// The ONLY way a photo or video leaves Peekaboo: the phone's share sheet and Save to Photos.
// Photos that leave get the small Peekaboo wordmark (lib/watermark.ts); the file you gave is never changed, so
// the copy inside Peekaboo (story, post, peek, Keeps) stays clean. Videos go as they are for now (the wordmark
// on videos needs a new app download).
// tests/unit/exit-guard.test.mjs checks that no other file sends pictures out of the app.
// ---------------------------------------------------------------------------

export type OutKind = 'photo' | 'video';

// The share sheet can only take a file on iPhone (on Android the phone's share sheet ignores it).
export const CAN_SHARE_FILES = Platform.OS === 'ios';

// The wordmarked copy of a photo, or the clean file when the wordmark can't be added (so it always works).
async function outFile(uri: string, kind: OutKind): Promise<string> {
  if (kind !== 'photo') return uri;
  const marked = await watermarkPhoto(uri).catch(() => null);
  return marked ?? uri;
}

// Saves a photo (with the wordmark) or a video into the phone's Photos. Asks for permission the first time.
// 'no-permission' = the phone said no. 'not-possible' = this download can't save to Photos, or the phone
// couldn't save the file. Never throws.
export async function saveOut(uri: string, kind: OutKind): Promise<'saved' | 'no-permission' | 'not-possible'> {
  if (!CAN_SAVE_TO_PHOTOS) return 'not-possible';
  try {
    const file = await outFile(uri, kind);
    if (file !== uri) {
      try {
        return (await saveToPhotos(file)) ? 'saved' : 'no-permission';
      } catch (error) {
        // The marked copy wouldn't save: save the clean one instead.
        console.warn('Could not save the marked picture, saving the clean one', error);
      }
    }
    return (await saveToPhotos(uri)) ? 'saved' : 'no-permission';
  } catch (error) {
    console.warn('Could not save to Photos', error);
    return 'not-possible';
  }
}

// One share sheet at a time: a second tap while it's opening or open does nothing.
let sharing = false;

// Opens the phone's share sheet with the photo (with the wordmark) or video: Instagram, TikTok, Snapchat,
// Messages, AirDrop, Save Image… whatever the phone has. Only the file goes in it, no text (a text makes some
// apps leave the picture out). 'busy' = a share sheet is already opening. 'not-possible' = not on this phone
// (Android), or the share sheet failed (the button can be tapped again). Never throws.
export async function shareOut(uri: string, kind: OutKind): Promise<'shared' | 'dismissed' | 'busy' | 'not-possible'> {
  if (!CAN_SHARE_FILES) return 'not-possible';
  if (sharing) return 'busy';
  sharing = true;
  try {
    const file = await outFile(uri, kind);
    // The file stays where it is until the share sheet has closed (the phone's cache tidies it up later).
    const result = await Share.share({ url: file });
    return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
  } catch (error) {
    console.warn('Could not open the share sheet', error);
    return 'not-possible';
  } finally {
    sharing = false;
  }
}
