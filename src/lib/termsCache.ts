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
// The other documents (like the Dare Safety Rules), in their own file so the Terms file keeps its old shape.
const DOCS_FILE_NAME = 'peekaboo-docs-agreed.json';

function readFile<T>(name: string): Record<string, T> {
  try {
    const file = new File(Paths.document, name);
    if (!file.exists) return {};
    const saved = JSON.parse(file.textSync());
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function writeFile(name: string, value: unknown) {
  try {
    const file = new File(Paths.document, name);
    if (!file.exists) file.create();
    file.write(JSON.stringify(value));
  } catch {
    // Not saved this time: the app just checks with the server again next time.
  }
}

// { "<user id>": "<terms version they agreed to>" }
let known: Record<string, string> = readFile<string>(FILE_NAME);
// { "<user id>": { "<document>": "<version they agreed to>" } }
let knownDocs: Record<string, Record<string, string>> = readFile<Record<string, string>>(DOCS_FILE_NAME);

function write() {
  writeFile(FILE_NAME, known);
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

// Has this person agreed to exactly this version of another document (like the Dare Safety Rules) on this phone?
// Then "Send" on a drop or a dare doesn't have to wait for the server to ask again (it still checks quietly).
export function knownAgreedDoc(userId: string, document: string, version: string): boolean {
  const docs = knownDocs[userId];
  return !!docs && typeof docs === 'object' && docs[document] === version;
}

export function rememberAgreedDoc(userId: string, document: string, version: string) {
  if (knownAgreedDoc(userId, document, version)) return;
  knownDocs = { ...knownDocs, [userId]: { ...(knownDocs[userId] ?? {}), [document]: version } };
  writeFile(DOCS_FILE_NAME, knownDocs);
}

export function forgetAgreed(userId: string) {
  if (userId in knownDocs) {
    const { [userId]: _goneDocs, ...restDocs } = knownDocs;
    knownDocs = restDocs;
    writeFile(DOCS_FILE_NAME, knownDocs);
  }
  if (!(userId in known)) return;
  const { [userId]: _gone, ...rest } = known;
  known = rest;
  write();
}
