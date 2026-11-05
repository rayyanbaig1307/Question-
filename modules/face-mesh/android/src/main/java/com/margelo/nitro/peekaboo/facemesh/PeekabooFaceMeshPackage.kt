package com.margelo.nitro.peekaboo.facemesh

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider

// Only here so React Native's autolinking loads our native library; there are no old-style modules.
class PeekabooFaceMeshPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider { HashMap() }

  companion object {
    init {
      PeekabooFaceMeshOnLoad.initializeNative()
    }
  }
}
