// The app never imports this file: it reaches the native part through NitroModules.createHybridObject
// ('FaceMeshFactory') behind a guard (see src/lib/faceMesh.ts), so phones without it don't crash.
// The spec file is what nitrogen reads to write the native glue code.
export type { FaceMeshFace, FaceMeshFactory, FaceMeshOutputOptions } from './specs/FaceMeshFactory.nitro'
