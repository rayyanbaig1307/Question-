// ---------------------------------------------------------------------------
// Every request to the server now has a time limit.
//
// On its own, the phone's fetch waits for an answer forever. On a weak signal an answer can get lost, and then
// the Send button kept spinning and the screen never closed (the owner's drop on 22 Nov, on 1 bar). Now each
// request gives up after a while, so the screens and the outbox (lib/outbox.ts) can try again or say
// "Couldn't send" instead of waiting forever.
//
// The limits:
// - 20 seconds to read or save rows, run a database function, or make a small storage call (a link, a copy,
//   a delete).
// - 30 seconds for the login server (/auth/v1/), for example logging in.
// - 90 seconds to renew your login (a "refresh"). That one is special: the server swaps your login for a new one
//   the moment it gets the request. If the phone gave up early and never saw the answer, it would later send the
//   old login again, the server would say "already used", and you'd be logged out. So a slow answer (38 seconds
//   was seen on 1 bar) is always waited for.
// - 60 seconds for the server functions (/functions/v1/).
// - A file upload: 30 seconds plus 1 second for every 16 KB, at most 10 minutes. A 500 KB photo gets about
//   61 seconds and a 6 MB video about 7 minutes (that's about 128 kbit/s). If an upload runs out of time, the next
//   try of the SAME file gets three times as long (then nine times…), so a very slow signal that does work still
//   gets the file there in the end, instead of being cut off at the same point every time.
//
// supabase.ts hands this fetch to Supabase, which uses it for everything: rows, storage, login and functions.
// ---------------------------------------------------------------------------

export const DATA_LIMIT_MS = 20_000;
export const LOGIN_LIMIT_MS = 30_000;
export const REFRESH_LIMIT_MS = 90_000;
export const FUNCTION_LIMIT_MS = 60_000;
export const UPLOAD_BASE_MS = 30_000;
export const UPLOAD_BYTES_PER_SECOND = 16 * 1024;
export const UPLOAD_MAX_MS = 10 * 60_000;
// Each time an upload of the same file ran out of time, its next try gets this many times as long.
export const UPLOAD_GROWTH = 3;

// Uploads that ran out of time, by address (a file's name is chosen once, so every try of it has the same
// address), and how many times. Forgotten once an answer comes back.
const outOfTime = new Map<string, number>();
const OUT_OF_TIME_KEPT = 50;

// How big a file being uploaded is (null when the body isn't a file: text, JSON or nothing).
function bodySize(body: unknown): number | 'unknown' | null {
  if (!body || typeof body !== 'object') return null;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') return (body as ArrayBuffer).byteLength;
  const blob = body as { size?: unknown; slice?: unknown };
  if (typeof blob.size === 'number' && typeof blob.slice === 'function') return blob.size;
  // Some other kind of body (like a form with a file in it): its size isn't known, so it gets the longest wait.
  return 'unknown';
}

function isUpload(url: string, init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  return url.includes('/storage/v1/object/') && (method === 'POST' || method === 'PUT') && bodySize(init?.body) !== null;
}

// How long a request may take before it's given up, in milliseconds.
export function deadlineFor(url: string, init?: RequestInit): number {
  if (url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token')) return REFRESH_LIMIT_MS;
  if (url.includes('/auth/v1/')) return LOGIN_LIMIT_MS;
  if (url.includes('/functions/v1/')) return FUNCTION_LIMIT_MS;
  if (isUpload(url, init)) {
    const size = bodySize(init?.body);
    const growth = UPLOAD_GROWTH ** (outOfTime.get(url) ?? 0);
    const most = UPLOAD_MAX_MS * growth;
    if (size === 'unknown' || size === null) return most;
    return Math.min(most, UPLOAD_BASE_MS + Math.ceil((size / UPLOAD_BYTES_PER_SECOND) * 1000 * growth));
  }
  return DATA_LIMIT_MS;
}

// An upload ran out of time: its next try gets longer.
function noteOutOfTime(url: string) {
  outOfTime.set(url, (outOfTime.get(url) ?? 0) + 1);
  if (outOfTime.size > OUT_OF_TIME_KEPT) outOfTime.delete(outOfTime.keys().next().value as string);
}

// fetch, with the time limit above. If the caller passes its own way to cancel (a signal), that still works too.
// The clock stops as soon as the answer is in (the phone's fetch only answers once the whole reply has arrived).
export function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String((input as { url?: unknown }).url ?? input);
  const limit = deadlineFor(url, init);
  const upload = isUpload(url, init);
  const controller = new AbortController();
  const callerSignal = init?.signal ?? null;
  const passOn = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', passOn);
  }
  // Given up after the limit: the request fails with an "AbortError", which Supabase treats as no answer.
  const timer = setTimeout(() => {
    if (upload) noteOutOfTime(url);
    controller.abort();
  }, limit);
  const tidy = () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', passOn);
  };
  let request: Promise<Response>;
  try {
    request = fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    tidy();
    return Promise.reject(error);
  }
  return request.then(
    (response) => {
      tidy();
      // An answer came back: the next upload to this address starts from the normal limit again.
      if (upload) outOfTime.delete(url);
      return response;
    },
    (error) => {
      tidy();
      throw error;
    },
  );
}
