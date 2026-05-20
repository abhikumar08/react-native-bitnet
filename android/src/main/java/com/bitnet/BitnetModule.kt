package com.bitnet

import com.facebook.react.bridge.ReactApplicationContext

class BitnetModule(reactContext: ReactApplicationContext) :
  NativeBitnetSpec(reactContext) {

  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }

  companion object {
    const val NAME = NativeBitnetSpec.NAME
  }
}
