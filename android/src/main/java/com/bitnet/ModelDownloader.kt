package com.bitnet

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// Owns the actual downloading. One singleton OkHttpClient + a fixed-size
// thread pool (max 4 concurrent downloads). The Map<cacheKey, RunningDownload>
// gives JS-level dedup: concurrent calls for the same modelRef share one
// network task. Disk artifacts (ModelCache) are the source of truth across
// restarts; this in-memory map is just the current session's task registry.
object ModelDownloader {
  private val executor: ExecutorService = Executors.newFixedThreadPool(4)

  private val client = OkHttpClient.Builder()
    .followRedirects(true)
    .followSslRedirects(true)
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .build()

  private val running = ConcurrentHashMap<String, RunningDownload>()

  class RunningDownload(val cacheKey: String, val modelRef: String) {
    val pendingPromises: MutableList<Promise> =
      Collections.synchronizedList(mutableListOf())
    @Volatile var call: Call? = null
    @Volatile var cancelled: Boolean = false
    @Volatile var deletePending: Boolean = false
  }

  fun isRunning(cacheKey: String): Boolean = running.containsKey(cacheKey)

  fun hasActiveDownloads(): Boolean = running.isNotEmpty()

  fun start(
    context: ReactApplicationContext,
    cacheKey: String,
    modelRef: String,
    url: String,
    authHeader: String,
    expectedSizeBytes: Long,
    expectedSha256: String,
    promise: Promise,
  ) {
    val existing = running[cacheKey]
    if (existing != null) {
      existing.pendingPromises.add(promise)
      return
    }

    // Cache-hit fast path. Resolve inline without spinning up the foreground
    // service — if we did start it, the executor would resolve so quickly that
    // stopService() would race onCreate's startForeground(), and Android 14's
    // 5-second timer crashes the app on next launch.
    val priorMeta = ModelCache.readMeta(context, cacheKey)
    val finalFile = ModelCache.finalFile(context, cacheKey)
    if (priorMeta?.complete == true && finalFile.exists()) {
      val result = WritableNativeMap().apply {
        putString("localPath", finalFile.absolutePath)
        putDouble("sizeBytes", finalFile.length().toDouble())
        putString("sha256", priorMeta.actualSha256)
        putBoolean("resumed", false)
      }
      promise.resolve(result)
      return
    }

    val r = RunningDownload(cacheKey, modelRef)
    r.pendingPromises.add(promise)
    running[cacheKey] = r

    BitnetDownloadService.ensureRunning(context)

    executor.submit {
      try {
        runDownload(context, r, url, authHeader, expectedSizeBytes, expectedSha256)
      } catch (t: Throwable) {
        terminate(context, r, "E_NETWORK", t.message ?: "download threw")
      } finally {
        running.remove(cacheKey)
        BitnetDownloadService.stopIfIdle(context)
      }
    }
  }

  fun cancel(cacheKey: String) {
    val r = running[cacheKey] ?: return
    r.cancelled = true
    r.call?.cancel()
  }

  // Cancels in-flight (if any) AND marks for deletion. The worker checks the
  // flag in its finally and removes the directory.
  fun deleteWithInFlightCheck(context: ReactApplicationContext, modelRef: String): Boolean {
    val cacheKey = ModelCache.cacheKeyFor(modelRef)
    val r = running[cacheKey]
    if (r != null) {
      r.deletePending = true
      r.cancelled = true
      r.call?.cancel()
      return true
    }
    return ModelCache.delete(context, modelRef)
  }

  private fun runDownload(
    context: ReactApplicationContext,
    r: RunningDownload,
    url: String,
    authHeader: String,
    expectedSizeBytes: Long,
    expectedSha256: String,
  ) {
    val cacheKey = r.cacheKey
    val modelRef = r.modelRef
    val partFile = ModelCache.partFile(context, cacheKey)
    val finalFile = ModelCache.finalFile(context, cacheKey)

    val priorMeta = ModelCache.readMeta(context, cacheKey)
    if (priorMeta?.complete == true && finalFile.exists()) {
      val result = WritableNativeMap().apply {
        putString("localPath", finalFile.absolutePath)
        putDouble("sizeBytes", finalFile.length().toDouble())
        putString("sha256", priorMeta.actualSha256)
        putBoolean("resumed", false)
      }
      resolveAll(r, result)
      return
    }

    val partSize = if (partFile.exists()) partFile.length() else 0L
    val priorEtag = priorMeta?.etag.orEmpty()
    val canResume = partSize > 0 && priorEtag.isNotEmpty()
    val now = System.currentTimeMillis()

    val builder = Request.Builder().url(url).get()
    if (authHeader.isNotEmpty()) builder.addHeader("Authorization", authHeader)
    if (canResume) {
      builder.addHeader("Range", "bytes=$partSize-")
      builder.addHeader("If-Range", priorEtag)
    }

    val call = client.newCall(builder.build())
    r.call = call

    val response = try {
      call.execute()
    } catch (ioe: IOException) {
      if (r.cancelled) {
        finalizeCancellation(context, r, url, expectedSizeBytes, expectedSha256, priorMeta, partSize, priorEtag, now)
        return
      }
      val code = if ((ioe.message ?: "").contains("ENOSPC", ignoreCase = true)) "E_DISK_FULL" else "E_NETWORK"
      terminate(context, r, code, ioe.message ?: "I/O error")
      return
    }

    response.use { resp ->
      val code = resp.code
      val responseEtag = resp.header("ETag").orEmpty().ifEmpty { priorEtag }
      val bodyLen = resp.body?.contentLength() ?: -1L

      val expectedTotal: Long
      val appendMode: Boolean
      val startOffset: Long

      when {
        code == 416 -> {
          if (partFile.exists() && expectedSizeBytes > 0 && partFile.length() >= expectedSizeBytes) {
            if (finalFile.exists()) finalFile.delete()
            partFile.renameTo(finalFile)
            ModelCache.writeMeta(context, cacheKey, ModelCache.Meta(
              modelRef = modelRef, resolvedUrl = url,
              expectedSizeBytes = expectedSizeBytes, actualSizeBytes = finalFile.length(),
              etag = responseEtag, expectedSha256 = expectedSha256, actualSha256 = "",
              createdAt = priorMeta?.createdAt ?: now, completedAt = now,
              complete = true, lastError = "",
            ))
            val result = WritableNativeMap().apply {
              putString("localPath", finalFile.absolutePath)
              putDouble("sizeBytes", finalFile.length().toDouble())
              putString("sha256", "")
              putBoolean("resumed", true)
            }
            resolveAll(r, result)
            return
          }
          partFile.delete()
          terminate(context, r, "E_NETWORK", "416 Range Not Satisfiable; restart needed")
          return
        }
        code == 206 && canResume -> {
          appendMode = true
          startOffset = partSize
          expectedTotal = if (bodyLen >= 0) partSize + bodyLen else expectedSizeBytes
        }
        code == 200 -> {
          appendMode = false
          startOffset = 0L
          expectedTotal = if (bodyLen >= 0) bodyLen else expectedSizeBytes
          if (partFile.exists()) partFile.delete()
        }
        code == 401 -> {
          terminate(context, r, "E_HTTP_4XX", "HTTP 401 Unauthorized (check authToken for private repos)")
          return
        }
        code in 400..499 -> {
          terminate(context, r, "E_HTTP_4XX", "HTTP $code")
          return
        }
        code >= 500 -> {
          terminate(context, r, "E_HTTP_5XX", "HTTP $code")
          return
        }
        else -> {
          terminate(context, r, "E_NETWORK", "Unexpected HTTP $code")
          return
        }
      }

      // Persist start-of-download meta. From here on the .part file size is
      // the canonical progress count — no further meta writes until terminal.
      ModelCache.writeMeta(context, cacheKey, ModelCache.Meta(
        modelRef = modelRef, resolvedUrl = url,
        expectedSizeBytes = expectedTotal, actualSizeBytes = startOffset,
        etag = responseEtag, expectedSha256 = expectedSha256, actualSha256 = "",
        createdAt = priorMeta?.createdAt ?: now, completedAt = 0L,
        complete = false, lastError = "",
      ))

      val computeDigest = expectedSha256.isNotEmpty() && !appendMode
      val digest = if (computeDigest) MessageDigest.getInstance("SHA-256") else null

      val raf = RandomAccessFile(partFile, "rw")
      raf.seek(startOffset)
      var downloaded = startOffset
      var lastEmitMs = System.currentTimeMillis()
      var lastEmitBytes = downloaded
      val buffer = ByteArray(64 * 1024)

      try {
        val stream = resp.body!!.byteStream()
        while (true) {
          if (r.cancelled) break
          val n = stream.read(buffer)
          if (n <= 0) break
          raf.write(buffer, 0, n)
          if (digest != null) digest.update(buffer, 0, n)
          downloaded += n
          val nowMs = System.currentTimeMillis()
          if (nowMs - lastEmitMs >= 250L || downloaded - lastEmitBytes >= 1024L * 1024L) {
            val elapsed = (nowMs - lastEmitMs).coerceAtLeast(1L)
            val bps = (downloaded - lastEmitBytes) * 1000L / elapsed
            emitProgress(context, cacheKey, downloaded, expectedTotal, bps)
            lastEmitMs = nowMs
            lastEmitBytes = downloaded
          }
        }
      } catch (ioe: IOException) {
        raf.close()
        if (r.cancelled) {
          finalizeCancellation(context, r, url, expectedSizeBytes, expectedSha256, priorMeta, downloaded, responseEtag, now)
          return
        }
        val errCode = if ((ioe.message ?: "").contains("ENOSPC", ignoreCase = true)) "E_DISK_FULL" else "E_NETWORK"
        terminate(context, r, errCode, ioe.message ?: "I/O error")
        return
      }
      raf.close()

      if (r.cancelled) {
        finalizeCancellation(context, r, url, expectedSizeBytes, expectedSha256, priorMeta, downloaded, responseEtag, now)
        return
      }

      val actualSha256 = digest?.digest()?.joinToString("") { "%02x".format(it) }.orEmpty()
      if (expectedSha256.isNotEmpty() && actualSha256.isNotEmpty() &&
          !actualSha256.equals(expectedSha256, ignoreCase = true)) {
        partFile.delete()
        ModelCache.writeMeta(context, cacheKey, ModelCache.Meta(
          modelRef = modelRef, resolvedUrl = url,
          expectedSizeBytes = expectedTotal, actualSizeBytes = 0L,
          etag = responseEtag, expectedSha256 = expectedSha256, actualSha256 = "",
          createdAt = priorMeta?.createdAt ?: now, completedAt = 0L,
          complete = false, lastError = "E_CHECKSUM_MISMATCH",
        ))
        rejectAll(r, "E_CHECKSUM_MISMATCH", "SHA-256 mismatch")
        return
      }

      if (finalFile.exists()) finalFile.delete()
      if (!partFile.renameTo(finalFile)) {
        rejectAll(r, "E_NETWORK", "Failed to promote .part to final file")
        return
      }

      ModelCache.writeMeta(context, cacheKey, ModelCache.Meta(
        modelRef = modelRef, resolvedUrl = url,
        expectedSizeBytes = expectedTotal, actualSizeBytes = downloaded,
        etag = responseEtag, expectedSha256 = expectedSha256, actualSha256 = actualSha256,
        createdAt = priorMeta?.createdAt ?: now, completedAt = System.currentTimeMillis(),
        complete = true, lastError = "",
      ))

      // Guaranteed final 100% event
      emitProgress(context, cacheKey, downloaded, expectedTotal, 0L)

      val result = WritableNativeMap().apply {
        putString("localPath", finalFile.absolutePath)
        putDouble("sizeBytes", downloaded.toDouble())
        putString("sha256", actualSha256)
        putBoolean("resumed", appendMode)
      }
      resolveAll(r, result)
    }
  }

  private fun finalizeCancellation(
    context: ReactApplicationContext,
    r: RunningDownload,
    url: String,
    expectedSizeBytes: Long,
    expectedSha256: String,
    priorMeta: ModelCache.Meta?,
    downloadedSoFar: Long,
    etag: String,
    createdAt: Long,
  ) {
    if (r.deletePending) {
      ModelCache.delete(context, r.modelRef)
    } else {
      val meta = priorMeta?.copy(
        actualSizeBytes = downloadedSoFar,
        lastError = "E_DOWNLOAD_CANCELLED",
      ) ?: ModelCache.Meta(
        modelRef = r.modelRef, resolvedUrl = url,
        expectedSizeBytes = expectedSizeBytes, actualSizeBytes = downloadedSoFar,
        etag = etag, expectedSha256 = expectedSha256, actualSha256 = "",
        createdAt = createdAt, completedAt = 0L,
        complete = false, lastError = "E_DOWNLOAD_CANCELLED",
      )
      ModelCache.writeMeta(context, r.cacheKey, meta)
    }
    rejectAll(r, "E_DOWNLOAD_CANCELLED", "Cancelled")
  }

  private fun terminate(
    context: ReactApplicationContext, r: RunningDownload, code: String, message: String
  ) {
    val priorMeta = ModelCache.readMeta(context, r.cacheKey)
    if (priorMeta != null) {
      val partSize = ModelCache.partFile(context, r.cacheKey)
        .let { if (it.exists()) it.length() else 0L }
      ModelCache.writeMeta(context, r.cacheKey, priorMeta.copy(
        actualSizeBytes = partSize,
        lastError = code,
      ))
    }
    rejectAll(r, code, message)
  }

  private fun resolveAll(r: RunningDownload, result: WritableNativeMap) {
    synchronized(r.pendingPromises) {
      for (p in r.pendingPromises) {
        try {
          val copy = WritableNativeMap().apply { merge(result) }
          p.resolve(copy)
        } catch (_: Throwable) {
        }
      }
      r.pendingPromises.clear()
    }
  }

  private fun rejectAll(r: RunningDownload, code: String, message: String) {
    synchronized(r.pendingPromises) {
      for (p in r.pendingPromises) {
        try { p.reject(code, message) } catch (_: Throwable) {}
      }
      r.pendingPromises.clear()
    }
  }

  private fun emitProgress(
    context: ReactApplicationContext, cacheKey: String,
    downloaded: Long, total: Long, bps: Long,
  ) {
    val map = WritableNativeMap().apply {
      putString("cacheKey", cacheKey)
      putDouble("bytesDownloaded", downloaded.toDouble())
      putDouble("totalBytes", total.toDouble())
      putDouble("bytesPerSecond", bps.toDouble())
    }
    try {
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("BitnetDownloadProgress", map)
    } catch (_: Throwable) {
      // JS bridge may be suspended (app backgrounded). Drop silently — the
      // .part file size remains the source of truth for current progress.
    }
  }

}
