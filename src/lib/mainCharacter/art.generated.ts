// Made by scripts/make-main-character-assets.py – don't change by hand.
// The Main Character art that comes inside the app (docs/FACE_MESH.md, "Main Character Mode"). iPhone only:
// art.generated.ts (the empty list) is what Android and web get, so their updates don't carry these pictures.
// This is the empty list.
import type { ArtAnchors } from './types';

export type BundledCharacter = { slug: string; name: string; image: number; scene: string; anchors: ArtAnchors };
export type BundledScene = { slug: string; name: string; image: number };

export const BUNDLED_CHARACTERS: BundledCharacter[] = [];

export const BUNDLED_SCENES: BundledScene[] = [];
