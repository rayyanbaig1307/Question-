// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the shapes every Main Character file shares (docs/MAIN_CHARACTER.md).
// Types only, no imports on purpose: the tests and every other Main Character file can load this on its own.
//
// "art 0–1" below means a character picture's own 0–1 space after its centred 9:16 crop: 0,0 is the top left
// of the picture and 1,1 the bottom right.
// ---------------------------------------------------------------------------

// One point: [x, y].
export type Pt = [number, number];

// Where the face goes in one character picture, in art 0–1 (after its centred 9:16 crop).
export type ArtAnchors = {
  eyes: [Pt, Pt];                     // eye middles (between the eye corners): picture-left, then picture-right
  nose: Pt;                           // nose tip
  chin: Pt;                           // chin (MediaPipe point 152 on the painted face) – kept for checks, not the fit
  forehead: Pt;                       // top of the forehead (point 10) – used by the fit's height
  hole: Pt[];                         // 36 points round the face hole, from the top, clockwise on screen
  faceWidth: number;                  // 0–1 of the picture width
  skinTone: [number, number, number]; // 0–255 (skin plate and the gentle tone pull)
  toneSure: boolean;                  // false = we couldn't find real skin colour: no tone pull for this character
};

export type ArtFile = number | string;           // a bundled require() id, or a file:// on the phone
export type ArtFrom = 'app' | 'online';          // 'app' = comes inside the app, 'online' = from the art bucket

// One character you can put your face into.
export type CharacterArt = {
  key: string;            // `${from}:${slug}` ('app:street-boss'), never the same as a scene's key
  slug: string;           // 'street-boss'
  name: string;           // 'Street Boss'
  from: ArtFrom;
  file: ArtFile;
  anchors: ArtAnchors;
  scene: string | null;   // slug of its own scene (bundled ones), or null
};

// One scene (the picture behind the character). Its key is `${from}-scene:${slug}` ('app-scene:neon-street'), so a
// scene and a character with the same file name never get the same key.
export type SceneArt = { key: string; slug: string; name: string; from: ArtFrom; file: ArtFile };
