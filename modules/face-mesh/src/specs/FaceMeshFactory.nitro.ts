import type { HybridObject } from 'react-native-nitro-modules'
import type { CameraOutput } from 'react-native-vision-camera'

// One face that Google's MediaPipe Face Landmarker found in a camera frame.
export interface FaceMeshFace {
  // 478 face points, packed as x0, y0, z0, x1, y1, z1, …
  // x and y are VisionCamera "camera coordinates" (turn them into screen points with the Camera's
  // convertCameraPointToViewPoint). z is MediaPipe's depth: smaller = closer to the camera, roughly the same
  // scale as x across the frame.
  points: number[]
  // 52 expression scores from 0 to 1 (smiles, blinks, jaw open, …) in MediaPipe's order. Empty when
  // blendshapes are turned off.
  blendshapes: number[]
}

export interface FaceMeshOutputOptions {
  // How many faces to follow at once (default 2). More faces = slower.
  maxFaces?: number
  // Also work out the 52 expression scores (default true). Costs about 1–2 ms per face.
  blendshapes?: boolean
  // Called with the faces of every frame that was looked at (an empty list when no face is seen).
  onFaces: (faces: FaceMeshFace[]) => void
  // Called when something went wrong (for example the model file is missing).
  onError: (error: Error) => void
}

export interface FaceMeshFactory
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  // True when the face_landmarker.task model file is inside the app.
  isModelReady(): boolean
  // A camera output to put in the Camera's `outputs`, next to the photo output.
  createFaceMeshOutput(options: FaceMeshOutputOptions): CameraOutput
}
