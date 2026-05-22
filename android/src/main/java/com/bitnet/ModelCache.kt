package com.bitnet

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

// Owns the on-disk layout under {context.filesDir}/bitnet-models/ and the
// meta.json schema. Keeps no in-memory state — every call re-reads from disk.
object ModelCache {
  const val DIR_NAME = "bitnet-models"
  private const val META_NAME = "meta.json"
  private const val PART_NAME = "model.gguf.part"
  private const val FINAL_NAME = "model.gguf"
  const val SCHEMA_VERSION = 1

  fun cacheRoot(context: Context): File =
    File(context.filesDir, DIR_NAME).also { it.mkdirs() }

  // Must mirror the JS canonicalization in src/models.ts (sha256(canonicalRef).slice(0,16)).
  fun cacheKeyFor(modelRef: String): String {
    val md = MessageDigest.getInstance("SHA-256")
    val bytes = md.digest(modelRef.toByteArray(Charsets.UTF_8))
    val sb = StringBuilder(32)
    for (i in 0 until 8) {
      sb.append("%02x".format(bytes[i]))
    }
    return sb.toString()
  }

  fun entryDir(context: Context, cacheKey: String): File =
    File(cacheRoot(context), cacheKey).also { it.mkdirs() }

  fun partFile(context: Context, cacheKey: String): File =
    File(entryDir(context, cacheKey), PART_NAME)

  fun finalFile(context: Context, cacheKey: String): File =
    File(entryDir(context, cacheKey), FINAL_NAME)

  fun metaFile(context: Context, cacheKey: String): File =
    File(entryDir(context, cacheKey), META_NAME)

  data class Meta(
    val modelRef: String,
    val resolvedUrl: String,
    val expectedSizeBytes: Long,
    val actualSizeBytes: Long,
    val etag: String,
    val expectedSha256: String,
    val actualSha256: String,
    val createdAt: Long,
    val completedAt: Long,
    val complete: Boolean,
    val lastError: String,
    val schemaVersion: Int = SCHEMA_VERSION,
  ) {
    fun toJson(): JSONObject = JSONObject().apply {
      put("modelRef", modelRef)
      put("resolvedUrl", resolvedUrl)
      put("expectedSizeBytes", expectedSizeBytes)
      put("actualSizeBytes", actualSizeBytes)
      put("etag", etag)
      put("expectedSha256", expectedSha256)
      put("actualSha256", actualSha256)
      put("createdAt", createdAt)
      put("completedAt", completedAt)
      put("complete", complete)
      put("lastError", lastError)
      put("schemaVersion", schemaVersion)
    }

    companion object {
      fun fromJson(json: JSONObject): Meta = Meta(
        modelRef = json.optString("modelRef", ""),
        resolvedUrl = json.optString("resolvedUrl", ""),
        expectedSizeBytes = json.optLong("expectedSizeBytes", -1L),
        actualSizeBytes = json.optLong("actualSizeBytes", -1L),
        etag = json.optString("etag", ""),
        expectedSha256 = json.optString("expectedSha256", ""),
        actualSha256 = json.optString("actualSha256", ""),
        createdAt = json.optLong("createdAt", 0L),
        completedAt = json.optLong("completedAt", 0L),
        complete = json.optBoolean("complete", false),
        lastError = json.optString("lastError", ""),
        schemaVersion = json.optInt("schemaVersion", 1),
      )
    }
  }

  fun readMeta(context: Context, cacheKey: String): Meta? {
    val f = metaFile(context, cacheKey)
    if (!f.exists()) return null
    return try {
      Meta.fromJson(JSONObject(f.readText(Charsets.UTF_8)))
    } catch (_: Throwable) {
      null
    }
  }

  // Atomic via temp + rename — survives a crash mid-write.
  fun writeMeta(context: Context, cacheKey: String, meta: Meta) {
    val dir = entryDir(context, cacheKey)
    val tmp = File(dir, "$META_NAME.tmp")
    tmp.writeText(meta.toJson().toString(), Charsets.UTF_8)
    val finalMeta = File(dir, META_NAME)
    if (!tmp.renameTo(finalMeta)) {
      finalMeta.writeBytes(tmp.readBytes())
      tmp.delete()
    }
  }

  fun delete(context: Context, modelRef: String): Boolean {
    val cacheKey = cacheKeyFor(modelRef)
    val dir = entryDir(context, cacheKey)
    if (!dir.exists()) return false
    return dir.deleteRecursively()
  }

  // Returns the JSON array used by listModels() — matches the CachedModelEntry
  // shape declared in src/models.ts.
  fun listJson(context: Context): String {
    val root = cacheRoot(context)
    val arr = org.json.JSONArray()
    val children = root.listFiles().orEmpty()
    for (child in children) {
      if (!child.isDirectory) continue
      val meta = readMeta(context, child.name) ?: continue
      val finalF = finalFile(context, child.name)
      val partF = partFile(context, child.name)
      val complete = meta.complete && finalF.exists()
      val localFile = when {
        complete -> finalF
        partF.exists() -> partF
        else -> continue
      }
      arr.put(JSONObject().apply {
        put("modelRef", meta.modelRef)
        put("cacheKey", child.name)
        put("localPath", localFile.absolutePath)
        put("sizeBytes", localFile.length())
        put("expectedSizeBytes", meta.expectedSizeBytes)
        put("complete", complete)
        put("createdAt", meta.createdAt)
        put("completedAt", meta.completedAt)
        put("sha256", meta.actualSha256)
        put("etag", meta.etag)
        if (meta.lastError.isNotEmpty()) put("lastError", meta.lastError)
        put("resolvedUrl", meta.resolvedUrl)
      })
    }
    return arr.toString()
  }

  fun isCached(context: Context, modelRef: String): Boolean {
    val cacheKey = cacheKeyFor(modelRef)
    val meta = readMeta(context, cacheKey) ?: return false
    if (!meta.complete) return false
    return finalFile(context, cacheKey).exists()
  }

  fun totalSize(context: Context): Long {
    val root = cacheRoot(context)
    if (!root.exists()) return 0L
    var total = 0L
    val stack = ArrayDeque<File>().apply { add(root) }
    while (stack.isNotEmpty()) {
      val f = stack.removeLast()
      if (f.isFile) total += f.length()
      else if (f.isDirectory) f.listFiles()?.forEach { stack.add(it) }
    }
    return total
  }

  // Called once at module init. Rewrites entries that were running when the
  // previous process died — they'd otherwise look "still in progress" forever.
  fun runCrashRecoverySweep(context: Context) {
    val root = cacheRoot(context)
    if (!root.exists()) return
    val children = root.listFiles().orEmpty()
    for (child in children) {
      if (!child.isDirectory) continue
      val meta = readMeta(context, child.name) ?: continue
      if (meta.complete) {
        if (!finalFile(context, child.name).exists()) {
          child.deleteRecursively()
        }
        continue
      }
      if (meta.lastError.isEmpty()) {
        writeMeta(context, child.name, meta.copy(lastError = "E_INTERRUPTED"))
      }
    }
  }
}
