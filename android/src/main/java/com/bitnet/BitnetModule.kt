package com.bitnet

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class BitnetModule(private val reactContext: ReactApplicationContext) :
  NativeBitnetSpec(reactContext) {

  companion object {
    const val NAME = NativeBitnetSpec.NAME

    init {
      // libllama.so and libggml.so are dependencies of libbitnet_rn.so
      // and load automatically via NEEDED entries — no explicit System.loadLibrary
      // needed for them.
      System.loadLibrary("bitnet_rn")
    }
  }

  init {
    // Recover any entries that were "in progress" when the previous process died.
    // Marks them with E_INTERRUPTED so the UI can present a resumable state.
    try {
      ModelCache.runCrashRecoverySweep(reactContext)
    } catch (_: Throwable) {
      // Crash recovery is best-effort — never break module init.
    }
  }

  // ---------------------------------------------------------------------------
  // Native methods. Implemented in cpp/bitnet_jni.cpp.
  // The Long handle on the Kotlin side is a reinterpret of a C++ pointer.
  // ---------------------------------------------------------------------------
  private external fun nativeLoadModel(
    modelPath: String, nCtx: Int, nThreads: Int, nBatch: Int): Long
  private external fun nativeGenerate(
    handle: Long, prompt: String,
    maxTokens: Int, temperature: Float, topK: Int, topP: Float, seed: Int,
    stopSequencesJson: String,
    repeatPenalty: Float, repeatLastN: Int,
    frequencyPenalty: Float, presencePenalty: Float): String
  private external fun nativeCancelGeneration(handle: Long)
  private external fun nativeApplyChatTemplate(
    handle: Long, rolesJson: String, addAssistantHeader: Boolean): String
  private external fun nativeGetModelInfo(handle: Long): String  // returns JSON
  private external fun nativeDisposeEngine(handle: Long)

  // ---------------------------------------------------------------------------
  // Token-streaming callback. C++ calls this from the generate thread; we
  // forward it as a JS event. Synchronization is implicit — JNI calls into
  // Kotlin run on the calling thread.
  // ---------------------------------------------------------------------------
  @Suppress("unused")
  private fun emitToken(handle: Long, token: String) {
    val map = WritableNativeMap().apply {
      putDouble("handle", handle.toDouble())
      putString("token", token)
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("BitnetToken", map)
  }

  // ---------------------------------------------------------------------------
  // TurboModule spec overrides — translate JS args → native, return promises.
  // ---------------------------------------------------------------------------

  override fun loadModel(
    modelPath: String, nCtx: Double, nThreads: Double, nBatch: Double, promise: Promise
  ) {
    try {
      val handle = nativeLoadModel(modelPath, nCtx.toInt(), nThreads.toInt(), nBatch.toInt())
      if (handle == 0L) {
        promise.reject("E_LOAD_FAILED", "Native loadModel returned null handle")
      } else {
        promise.resolve(handle.toDouble())
      }
    } catch (t: Throwable) {
      promise.reject("E_LOAD_FAILED", t.message ?: "loadModel threw", t)
    }
  }

  override fun disposeEngine(handle: Double) {
    nativeDisposeEngine(handle.toLong())
  }

  override fun generate(
    handle: Double, prompt: String,
    maxTokens: Double, temperature: Double, topK: Double, topP: Double, seed: Double,
    stopSequencesJson: String,
    repeatPenalty: Double, repeatLastN: Double,
    frequencyPenalty: Double, presencePenalty: Double,
    promise: Promise
  ) {
    // Run on a background thread so we don't block the JS thread for tens of seconds.
    Thread {
      try {
        val text = nativeGenerate(
          handle.toLong(), prompt,
          maxTokens.toInt(), temperature.toFloat(),
          topK.toInt(), topP.toFloat(), seed.toInt(),
          stopSequencesJson,
          repeatPenalty.toFloat(), repeatLastN.toInt(),
          frequencyPenalty.toFloat(), presencePenalty.toFloat())
        promise.resolve(text)
      } catch (t: Throwable) {
        promise.reject("E_GEN_FAILED", t.message ?: "generate threw", t)
      }
    }.start()
  }

  override fun cancelGeneration(handle: Double) {
    nativeCancelGeneration(handle.toLong())
  }

  override fun applyChatTemplate(
    handle: Double, rolesJson: String, addAssistantHeader: Boolean, promise: Promise
  ) {
    try {
      val rendered = nativeApplyChatTemplate(
        handle.toLong(), rolesJson, addAssistantHeader)
      promise.resolve(rendered)
    } catch (t: Throwable) {
      promise.reject("E_TEMPLATE_FAILED", t.message ?: "applyChatTemplate threw", t)
    }
  }

  override fun getModelInfo(handle: Double, promise: Promise) {
    try {
      val json = nativeGetModelInfo(handle.toLong())
      val parsed = org.json.JSONObject(json)
      val map = WritableNativeMap().apply {
        putString("architecture", parsed.getString("architecture"))
        putDouble("nVocab", parsed.getInt("nVocab").toDouble())
        putDouble("nCtxTrain", parsed.getInt("nCtxTrain").toDouble())
        putDouble("nEmbd", parsed.getInt("nEmbd").toDouble())
        putDouble("modelSizeBytes", parsed.getLong("modelSizeBytes").toDouble())
      }
      promise.resolve(map)
    } catch (t: Throwable) {
      promise.reject("E_INFO_FAILED", t.message ?: "getModelInfo threw", t)
    }
  }

  // ---------------------------------------------------------------------------
  // Model lifecycle — download, cache, list, delete. Delegates to ModelDownloader
  // (work + dedup map) and ModelCache (paths + meta IO). See ADR / plan doc for
  // the persistence model.
  // ---------------------------------------------------------------------------

  override fun startDownload(
    cacheKey: String,
    modelRef: String,
    url: String,
    authHeader: String,
    expectedSizeBytes: Double,
    expectedSha256: String,
    promise: Promise,
  ) {
    try {
      ModelDownloader.start(
        reactContext,
        cacheKey, modelRef, url, authHeader,
        expectedSizeBytes.toLong(), expectedSha256,
        promise,
      )
    } catch (t: Throwable) {
      promise.reject("E_NETWORK", t.message ?: "startDownload threw", t)
    }
  }

  override fun cancelDownload(cacheKey: String) {
    try {
      ModelDownloader.cancel(cacheKey)
    } catch (_: Throwable) {
      // best-effort
    }
  }

  override fun listModels(promise: Promise) {
    try {
      promise.resolve(ModelCache.listJson(reactContext))
    } catch (t: Throwable) {
      promise.reject("E_CACHE", t.message ?: "listModels threw", t)
    }
  }

  override fun deleteModel(modelRef: String, promise: Promise) {
    try {
      promise.resolve(ModelDownloader.deleteWithInFlightCheck(reactContext, modelRef))
    } catch (t: Throwable) {
      promise.reject("E_CACHE", t.message ?: "deleteModel threw", t)
    }
  }

  override fun getCacheSize(promise: Promise) {
    try {
      promise.resolve(ModelCache.totalSize(reactContext).toDouble())
    } catch (t: Throwable) {
      promise.reject("E_CACHE", t.message ?: "getCacheSize threw", t)
    }
  }

  override fun getCacheDir(promise: Promise) {
    try {
      promise.resolve(ModelCache.cacheRoot(reactContext).absolutePath)
    } catch (t: Throwable) {
      promise.reject("E_CACHE", t.message ?: "getCacheDir threw", t)
    }
  }

  override fun isModelCached(modelRef: String, promise: Promise) {
    try {
      promise.resolve(ModelCache.isCached(reactContext, modelRef))
    } catch (t: Throwable) {
      promise.reject("E_CACHE", t.message ?: "isModelCached threw", t)
    }
  }
}