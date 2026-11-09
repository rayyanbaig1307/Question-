// Where to load MediaPipe Tasks Vision from.
// Default: jsDelivr CDN (works for end users with no install step).
// Local:  append `?vision=local` to the URL after `npm install` to serve the
//         library from node_modules (useful offline or behind strict proxies).
const params = new URLSearchParams(location.search);
const useLocal = params.get('vision') === 'local';

export const VISION_VERSION = '0.10.14';
export const VISION_BASE = useLocal
  ? new URL('../node_modules/@mediapipe/tasks-vision', import.meta.url).href
  : `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
export const VISION_BUNDLE = `${VISION_BASE}/vision_bundle.mjs`;
export const VISION_WASM = `${VISION_BASE}/wasm`;

export const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Force CPU inference with `?delegate=cpu` (GPU is the default, with CPU fallback).
export const DELEGATE = (params.get('delegate') || 'GPU').toUpperCase();
export const DEBUG = params.get('debug') === '1';
export const INITIAL_FILTER = params.get('filter');
