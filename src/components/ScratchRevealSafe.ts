import { TurboModuleRegistry } from 'react-native';

import type { ScratchReveal as ScratchRevealType } from './ScratchReveal';

// The scratch effect draws with Skia, a native part of the app. Expo Go has it, but an app built before it was
// added doesn't – so only load it when it's there (otherwise drop photos simply show normally).
export const ScratchReveal: typeof ScratchRevealType | null = TurboModuleRegistry.get('RNSkiaModule')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./ScratchReveal').ScratchReveal
  : null;
