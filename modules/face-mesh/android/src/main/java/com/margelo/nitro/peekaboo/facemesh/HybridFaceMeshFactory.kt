package com.margelo.nitro.peekaboo.facemesh

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import com.margelo.nitro.camera.HybridCameraOutputSpec

// Makes face mesh camera outputs. JS reaches it with NitroModules.createHybridObject('FaceMeshFactory').
@DoNotStrip
@Keep
class HybridFaceMeshFactory : HybridFaceMeshFactorySpec() {
  @DoNotStrip
  @Keep
  override fun isModelReady(): Boolean {
    val context = NitroModules.applicationContext ?: return false
    return try {
      context.assets.open(FaceMeshModel.FILE_NAME).use { true }
    } catch (_: Throwable) {
      false
    }
  }

  @DoNotStrip
  @Keep
  override fun createFaceMeshOutput(options: FaceMeshOutputOptions): HybridCameraOutputSpec {
    return HybridFaceMeshOutput(options)
  }
}

internal object FaceMeshModel {
  const val FILE_NAME = "face_landmarker.task"
}
