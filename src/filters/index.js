import peekabooEyes from './peekabooEyes.js';
import tinyFace from './tinyFace.js';
import gigachin from './gigachin.js';
import brainBuffering from './brainBuffering.js';
import crybaby from './crybaby.js';
import bigMouth from './bigMouth.js';
import auraOverload from './auraOverload.js';
import heartEyes from './heartEyes.js';
import pixelPanic from './pixelPanic.js';

// Order matches the concept sheet, left-to-right, top-to-bottom.
export const FILTERS = [
  peekabooEyes,
  tinyFace,
  gigachin,
  brainBuffering,
  crybaby,
  bigMouth,
  auraOverload,
  heartEyes,
  pixelPanic,
];

export const byId = (id) => FILTERS.find((f) => f.id === id);
