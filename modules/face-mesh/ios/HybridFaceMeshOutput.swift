import AVFoundation
import Foundation
import MediaPipeTasksVision
import NitroModules
import VisionCamera

// A VisionCamera v5 camera output that runs Google's MediaPipe Face Landmarker on the live camera.
// It gets its own small video stream (like the ML Kit face detector does), finds up to `maxFaces` faces and
// hands back 478 points per face (in VisionCamera camera coordinates) plus 52 expression scores.
//
// How the points line up with the screen:
// 1. We ask AVFoundation to turn our frames upright (portrait), so MediaPipe sees faces the right way up.
// 2. MediaPipe answers in 0…1 of that upright frame. We turn that into pixels of the frame.
// 3. AVFoundation's own `metadataOutputRectConverted` turns frame pixels into camera coordinates. It knows
//    about the rotation and the selfie mirroring we asked for, so nothing is turned twice.
// 4. In JS, the Camera's `convertCameraPointToViewPoint` turns camera coordinates into screen points.
class HybridFaceMeshOutput: HybridCameraOutputSpec, NativeCameraOutput {
  private let queue = DispatchQueue(label: "com.peekaboo.facemesh", qos: .userInteractive)
  private let onFaces: (_ faces: [FaceMeshFace]) -> Void
  private let onError: (_ error: Error) -> Void
  private let maxFaces: Int
  private let wantsBlendshapes: Bool
  private var delegate: FaceMeshSampleDelegate?
  private var landmarker: FaceLandmarker?
  private var lastTimestamp = 0
  private var reportedError = false
  // After a frame with no faces we send one empty list, then stay quiet until a face comes back.
  private var sentEmpty = false

  let output = AVCaptureVideoDataOutput()
  let requiresAudioInput = false
  let requiresDepthFormat = false
  let mediaType: MediaType = .video
  let streamType: StreamType = .video
  var outputOrientation: CameraOrientation = .up {
    didSet { applyOrientation() }
  }
  var currentResolution: Size? {
    guard let connection = output.connection(with: .video) else { return nil }
    return connection.inputStreamResolution
  }
  // Face Landmarker works on 256 × 256 pictures inside, so a small stream is plenty and saves battery.
  var targetResolution: ResolutionRule {
    return .closestTo(Size(width: 480.0, height: 640.0))
  }

  init(_ options: FaceMeshOutputOptions) {
    self.onFaces = options.onFaces
    self.onError = options.onError
    self.maxFaces = max(1, min(4, Int(options.maxFaces ?? 2)))
    self.wantsBlendshapes = options.blendshapes ?? true
    super.init()

    // MediaPipe on iPhone wants 32-bit BGRA frames.
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    // If MediaPipe is still busy with the last frame, newer frames are dropped instead of piling up.
    output.alwaysDiscardsLateVideoFrames = true
    if #available(iOS 17.0, *) {
      output.automaticallyConfiguresOutputBufferDimensions = false
      output.deliversPreviewSizedOutputBuffers = true
    }
    let delegate = FaceMeshSampleDelegate { [weak self] buffer in
      self?.process(buffer)
    }
    self.delegate = delegate
    output.setSampleBufferDelegate(delegate, queue: queue)
  }

  func configure(config _: OutputConfiguration) {
    applyOrientation()
  }

  // Ask AVFoundation for upright frames, matching how the phone is held.
  private func applyOrientation() {
    guard let connection = output.connection(with: .video), connection.isVideoOrientationSupported else { return }
    let wanted: AVCaptureVideoOrientation
    switch outputOrientation {
    case .up: wanted = .portrait
    case .down: wanted = .portraitUpsideDown
    case .left: wanted = .landscapeRight
    default: wanted = .landscapeLeft // .right
    }
    if connection.videoOrientation != wanted {
      connection.videoOrientation = wanted
    }
    connection.preferredVideoStabilizationMode = .off
  }

  // Load the model the first time a frame arrives (on our own queue, so the camera doesn't stutter when it opens).
  private func loadLandmarker() -> FaceLandmarker? {
    if let landmarker { return landmarker }
    guard let path = FaceMeshModel.path() else {
      report(RuntimeError.error(withMessage: "face_landmarker.task is missing from the app."))
      return nil
    }
    do {
      let options = FaceLandmarkerOptions()
      options.baseOptions.modelAssetPath = path
      options.runningMode = .video
      options.numFaces = maxFaces
      options.minFaceDetectionConfidence = 0.5
      options.minFacePresenceConfidence = 0.5
      options.minTrackingConfidence = 0.5
      options.outputFaceBlendshapes = wantsBlendshapes
      options.outputFacialTransformationMatrixes = false
      let created = try FaceLandmarker(options: options)
      landmarker = created
      return created
    } catch {
      report(error)
      return nil
    }
  }

  private func process(_ buffer: CMSampleBuffer) {
    guard let landmarker = loadLandmarker() else { return }
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(buffer) else { return }
    let width = Double(CVPixelBufferGetWidth(pixelBuffer))
    let height = Double(CVPixelBufferGetHeight(pixelBuffer))
    guard width > 0, height > 0 else { return }

    // MediaPipe needs times that always go up.
    let seconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer))
    var timestamp = seconds.isFinite ? Int(seconds * 1000) : lastTimestamp + 33
    if timestamp <= lastTimestamp { timestamp = lastTimestamp + 1 }
    lastTimestamp = timestamp

    // Work out the frame-pixels → camera-coordinates mapping now, while this frame's settings are current.
    let toCamera = makeFrameToCameraMapping(width: width, height: height)

    let result: FaceLandmarkerResult
    do {
      let image = try MPImage(sampleBuffer: buffer)
      result = try landmarker.detect(videoFrame: image, timestampInMilliseconds: timestamp)
    } catch {
      report(error)
      return
    }

    var faces: [FaceMeshFace] = []
    faces.reserveCapacity(result.faceLandmarks.count)
    for (index, landmarks) in result.faceLandmarks.enumerated() {
      var points: [Double] = []
      points.reserveCapacity(landmarks.count * 3)
      for landmark in landmarks {
        let (x, y) = toCamera(Double(landmark.x) * width, Double(landmark.y) * height)
        points.append(x)
        points.append(y)
        points.append(Double(landmark.z))
      }
      var scores: [Double] = []
      if wantsBlendshapes, index < result.faceBlendshapes.count {
        // Put each score in its own slot (MediaPipe's index), so the order is always the same.
        let categories = result.faceBlendshapes[index].categories
        scores = [Double](repeating: 0, count: max(52, categories.count))
        for (position, category) in categories.enumerated() {
          let slot = category.index >= 0 && category.index < scores.count ? category.index : position
          scores[slot] = Double(category.score)
        }
      }
      faces.append(FaceMeshFace(points: points, blendshapes: scores))
    }

    if faces.isEmpty {
      if sentEmpty { return }
      sentEmpty = true
    } else {
      sentEmpty = false
    }
    onFaces(faces)
  }

  // AVFoundation's own conversion from this output's pixels to camera coordinates. It is a flat (affine)
  // mapping, so we sample three points once and reuse it for all 478 points.
  private func makeFrameToCameraMapping(width: Double, height: Double) -> (Double, Double) -> (Double, Double) {
    func convert(_ x: Double, _ y: Double) -> CGPoint {
      return output.metadataOutputRectConverted(
        fromOutputRect: CGRect(x: CGFloat(x), y: CGFloat(y), width: 0, height: 0)
      ).origin
    }
    let origin = convert(0, 0)
    let xAxis = convert(width, 0)
    let yAxis = convert(0, height)
    let ox = Double(origin.x)
    let oy = Double(origin.y)
    let xdx = Double(xAxis.x - origin.x) / width
    let xdy = Double(xAxis.y - origin.y) / width
    let ydx = Double(yAxis.x - origin.x) / height
    let ydy = Double(yAxis.y - origin.y) / height
    return { x, y in
      return (ox + xdx * x + ydx * y, oy + xdy * x + ydy * y)
    }
  }

  // Errors are passed on once, so a broken model doesn't flood JS with the same message 30 times a second.
  private func report(_ error: Error) {
    if reportedError { return }
    reportedError = true
    onError(error)
  }
}

final class FaceMeshSampleDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private let onSampleBuffer: (CMSampleBuffer) -> Void

  init(onSampleBuffer: @escaping (CMSampleBuffer) -> Void) {
    self.onSampleBuffer = onSampleBuffer
    super.init()
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    onSampleBuffer(sampleBuffer)
  }
}
