package com.margelo.nitro.peekaboo.facemesh

import android.graphics.Matrix
import android.os.SystemClock
import android.util.Size
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.margelo.nitro.NitroModules
import com.margelo.nitro.camera.CameraOrientation
import com.margelo.nitro.camera.HybridCameraOutputSpec
import com.margelo.nitro.camera.MediaType
import com.margelo.nitro.camera.MirrorMode
import com.margelo.nitro.camera.extensions.converters.toSize
import com.margelo.nitro.camera.extensions.surfaceRotation
import com.margelo.nitro.camera.public.NativeCameraOutput
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors

// A VisionCamera v5 camera output that runs Google's MediaPipe Face Landmarker on the live camera.
// It adds its own small CameraX ImageAnalysis stream (like the ML Kit face detector does), finds up to
// `maxFaces` faces and hands back 478 points per face (in VisionCamera camera coordinates) plus 52 scores.
//
// How the points line up with the screen:
// 1. CameraX turns each frame upright (setOutputImageRotationEnabled), so MediaPipe sees faces the right way up.
// 2. MediaPipe answers in 0…1 of that upright frame. We turn that into pixels of the frame.
// 3. CameraX's sensor → frame matrix (which includes that rotation) is turned around to go frame → sensor,
//    and sensor coordinates are VisionCamera's camera coordinates on Android.
// 4. In JS, the Camera's `convertCameraPointToViewPoint` turns camera coordinates into screen points.
class HybridFaceMeshOutput(
  options: FaceMeshOutputOptions,
) : HybridCameraOutputSpec(),
  ImageAnalysis.Analyzer,
  NativeCameraOutput {
  override val mediaType: MediaType = MediaType.VIDEO
  override var mirrorMode: MirrorMode = MirrorMode.AUTO
  override var outputOrientation: CameraOrientation = CameraOrientation.UP
    set(value) {
      field = value
      imageAnalysis?.targetRotation = value.surfaceRotation
    }
  override val currentResolution: com.margelo.nitro.camera.Size?
    get() = imageAnalysis?.resolutionInfo?.resolution?.toSize()

  private val onFaces = options.onFaces
  private val onError = options.onError
  private val maxFaces = ((options.maxFaces ?: 2.0).toInt()).coerceIn(1, 4)
  private val wantsBlendshapes = options.blendshapes ?: true
  private val executor = Executors.newSingleThreadExecutor()
  private var imageAnalysis: ImageAnalysis? = null
  private var landmarker: FaceLandmarker? = null
  private var lastTimestamp = 0L
  private var reportedError = false
  // After a frame with no faces we send one empty list, then stay quiet until a face comes back.
  private var sentEmpty = false
  @Volatile private var disposed = false

  override fun createUseCase(
    mirrorMode: MirrorMode,
    config: NativeCameraOutput.Config,
  ): NativeCameraOutput.PreparedUseCase {
    // Face Landmarker works on 256 × 256 pictures inside, so a small stream is plenty and saves battery.
    val resolutionSelector =
      ResolutionSelector
        .Builder()
        .setResolutionStrategy(
          ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
        ).build()
    val analysis =
      ImageAnalysis
        .Builder()
        .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
        .setOutputImageRotationEnabled(true)
        .setTargetRotation(outputOrientation.surfaceRotation)
        .setResolutionSelector(resolutionSelector)
        // If MediaPipe is still busy, only the newest frame waits; older ones are dropped.
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
    return NativeCameraOutput.PreparedUseCase(analysis) {
      this.imageAnalysis = analysis
      this.mirrorMode = mirrorMode
      analysis.setAnalyzer(executor, this)
    }
  }

  override fun dispose() {
    disposed = true
    imageAnalysis?.clearAnalyzer()
    // Close MediaPipe on its own thread, after any frame it's working on.
    executor.execute {
      try {
        landmarker?.close()
      } catch (_: Throwable) {
      }
      landmarker = null
    }
    executor.shutdown()
    super.dispose()
  }

  // Load the model the first time a frame arrives (on our own thread, so opening the camera stays quick).
  private fun loadLandmarker(): FaceLandmarker? {
    landmarker?.let { return it }
    val context = NitroModules.applicationContext
    if (context == null) {
      report(Error("No app context for the face mesh."))
      return null
    }
    return try {
      // Read the model into memory ourselves, so it works whether or not the APK compressed the file.
      val bytes = context.assets.open(FaceMeshModel.FILE_NAME).use { it.readBytes() }
      val model = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder())
      model.put(bytes)
      model.rewind()
      val base =
        BaseOptions
          .builder()
          .setModelAssetBuffer(model)
          .setDelegate(Delegate.CPU)
          .build()
      val options =
        FaceLandmarker.FaceLandmarkerOptions
          .builder()
          .setBaseOptions(base)
          .setRunningMode(RunningMode.VIDEO)
          .setNumFaces(maxFaces)
          .setMinFaceDetectionConfidence(0.5f)
          .setMinFacePresenceConfidence(0.5f)
          .setMinTrackingConfidence(0.5f)
          .setOutputFaceBlendshapes(wantsBlendshapes)
          .setOutputFacialTransformationMatrixes(false)
          .build()
      FaceLandmarker.createFromOptions(context, options).also { landmarker = it }
    } catch (error: Throwable) {
      report(error)
      null
    }
  }

  override fun analyze(imageProxy: ImageProxy) {
    try {
      if (disposed) return
      val landmarker = loadLandmarker() ?: return
      val width = imageProxy.width.toDouble()
      val height = imageProxy.height.toDouble()
      if (width <= 0 || height <= 0) return

      // Frame pixels → sensor (camera) coordinates, worked out while this frame's settings are current.
      val toCamera = makeFrameToCameraMapping(imageProxy)

      // MediaPipe needs times that always go up.
      var timestamp = SystemClock.uptimeMillis()
      if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1
      lastTimestamp = timestamp

      val bitmap = imageProxy.toBitmap()
      val image = BitmapImageBuilder(bitmap).build()
      val result =
        try {
          landmarker.detectForVideo(image, timestamp)
        } finally {
          image.close()
        }

      val blendshapes = if (wantsBlendshapes) result.faceBlendshapes().orElse(null) else null
      val faces =
        result.faceLandmarks().mapIndexed { index, landmarks ->
          val points = DoubleArray(landmarks.size * 3)
          val point = FloatArray(2)
          landmarks.forEachIndexed { i, landmark ->
            point[0] = (landmark.x() * width).toFloat()
            point[1] = (landmark.y() * height).toFloat()
            toCamera.mapPoints(point)
            points[i * 3] = point[0].toDouble()
            points[i * 3 + 1] = point[1].toDouble()
            points[i * 3 + 2] = landmark.z().toDouble()
          }
          // Put each score in its own slot (MediaPipe's index), so the order is always the same.
          val categories = blendshapes?.getOrNull(index)
          val scores =
            if (categories == null) {
              DoubleArray(0)
            } else {
              DoubleArray(maxOf(52, categories.size)).also { out ->
                categories.forEachIndexed { position, category ->
                  val slot = category.index()
                  out[if (slot in out.indices) slot else position] = category.score().toDouble()
                }
              }
            }
          FaceMeshFace(points, scores)
        }

      if (faces.isEmpty()) {
        if (sentEmpty) return
        sentEmpty = true
      } else {
        sentEmpty = false
      }
      onFaces(faces.toTypedArray())
    } catch (error: Throwable) {
      report(error)
    } finally {
      imageProxy.close()
    }
  }

  // CameraX gives sensor → frame. We need frame → sensor, so turn the matrix around.
  private fun makeFrameToCameraMapping(imageProxy: ImageProxy): Matrix {
    val sensorToFrame = Matrix(imageProxy.imageInfo.sensorToBufferTransformMatrix)
    val frameToSensor = Matrix()
    if (!sensorToFrame.invert(frameToSensor)) {
      throw Error("Could not turn around CameraX's sensor-to-frame matrix.")
    }
    return frameToSensor
  }

  // Errors are passed on once, so a broken model doesn't flood JS with the same message 30 times a second.
  private fun report(error: Throwable) {
    if (reportedError) return
    reportedError = true
    onError(error)
  }
}
