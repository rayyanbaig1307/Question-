import { File, Paths } from 'expo-file-system';

// ---------------------------------------------------------------------------
// Remembers on this phone that you've agreed to the Terms, so the app doesn't have to wait for the server
// at every start-up (that wait showed a blank cover for a split second after the Peekaboo logo).
//
// The server stays the one that decides: the check still runs in the background every time, and if it ever
// says you need to agree (the Terms changed), the Terms page shows as before. If that background check fails
// (no internet), someone this phone already knows has agreed just carries on.
// ---------------------------------------------------------------------------

const FILE_NAME = 'peekaboo-terms-agreed.json';

// { "<user id>": "<terms version they agreed to>" }
function read(): Record<string, string> {
  try {
    const file = new File(Paths.document, FILE_NAME);
    if (!file.exists) return {};
    const saved = JSON.parse(file.textSync());
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

let known: Record<string, string> = read();

function write() {
  try {
    const file = new File(Paths.document, FILE_NAME);
    if (!file.exists) file.create();
    file.write(JSON.stringify(known));
  } catch {
    // Not saved this time: the app just checks with the server again next start-up.
  }
}

// Has this person agreed to exactly this version on this phone?
export function knownAgreed(userId: string, version: string): boolean {
  return known[userId] === version;
}

// Has this person agreed to any version on this phone (so they've finished making their account)?
export function knownAgreedAny(userId: string): boolean {
  return typeof known[userId] === 'string';
}

export function rememberAgreed(userId: string, version: string) {
  if (known[userId] === version) return;
  known = { ...known, [userId]: version };
  write();
}

export function forgetAgreed(userId: string) {
  if (!(userId in known)) return;
  const { [userId]: _gone, ...rest } = known;
  known = rest;
  write();
}
