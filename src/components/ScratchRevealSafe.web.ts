import type { ScratchReveal as ScratchRevealType } from './ScratchReveal';

// The web version of the app has no scratch-off effect (it needs Skia, a native part of the phone app),
// so drop photos simply show normally there – the same as on a phone app built without Skia.
export const ScratchReveal: typeof ScratchRevealType | null = null;
