# Models

The `Models` namespace owns the SDK's download + cache layer. Most consumers use [`Engine.load({ modelRef })`](./engine.md#engineloadconfig) and never touch `Models` directly — but the namespace is exposed for explicit control over downloads, listing, and cache management.

```ts
import { Models } from 'react-native-bitnet';
```

## `Models.download(ref, opts?)`

Downloads (or returns the cached entry for) a `modelRef`. Idempotent: re-downloading a complete entry resolves instantly with the same shape.

### Signature

```ts
Models.download(
  ref: ModelRef,
  opts?: DownloadOptions
): Promise<CachedModelEntry>
```

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `ref` | [`ModelRef`](./types.md#modelref) | yes | — | `hf://owner/repo/file.gguf[@revision]`, `https://…`, or `file:///…`. |
| `opts.onProgress` | `(p: DownloadProgress) => void` | no | — | Per-progress-event callback. See [`DownloadProgress`](./types.md#downloadprogress). |
| `opts.signal` | `AbortSignal` | no | — | Aborts the download. Rejects with [`AbortError`](./errors.md#aborterror). |
| `opts.authToken` | `string` | no | — | Sent as `Authorization: Bearer <token>`. For private HuggingFace repos. |
| `opts.expectedSizeBytes` | `number` | no | `-1` | Validates `Content-Length` matches. `-1` = unknown. |
| `opts.expectedSha256` | `string` | no | `''` | Validates final file SHA-256. Mismatch throws `E_CHECKSUM_MISMATCH`. |

### Returns

`Promise<CachedModelEntry>` — see [`CachedModelEntry`](./types.md#cachedmodelentry).

`localPath` is consumable by [`Engine.load({ modelPath })`](./engine.md#engineloadconfig) when `complete` is `true`.

For `file://` refs, returns a passthrough entry with `cacheKey: ''`, `localPath` set to the absolute path, and `complete: true` — no download, no cache file written.

### Throws

| Error | Condition |
|---|---|
| [`E_INVALID_REF`](./errors.md#e_invalid_ref) | Bad scheme or malformed ref. |
| [`E_NETWORK`](./errors.md#e_network) | Network I/O failure. |
| [`E_HTTP_4XX`](./errors.md#e_http_4xx) | Server 4xx. `401`/`403` likely needs `authToken`. |
| [`E_HTTP_5XX`](./errors.md#e_http_5xx) | Server 5xx — retryable. |
| [`E_DISK_FULL`](./errors.md#e_disk_full) | Out of storage. `.part` preserved. |
| [`E_CHECKSUM_MISMATCH`](./errors.md#e_checksum_mismatch) | SHA-256 mismatch. `.part` removed. |
| [`AbortError`](./errors.md#aborterror) | `signal` aborted, or another caller's cancel triggered. |

### In-process deduplication

If two callers invoke `Models.download(ref)` concurrently with the same canonical ref, the SDK runs **one** native download. Both callers receive the same `CachedModelEntry`. Progress events fire for any caller that registered an `onProgress` callback.

Cancellation follows `AbortSignal.any` semantics — the underlying download only aborts when **all** subscribers have aborted. A single subscriber's `abort()` removes them from the set but lets the download continue for the others.

### Examples

**Basic:**

```ts
import { Models } from 'react-native-bitnet';

const entry = await Models.download(
  'hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf'
);
console.log(entry.localPath);   // ready for Engine.load({ modelPath })
console.log(entry.sizeBytes);
```

**With progress:**

```ts
const entry = await Models.download(modelRef, {
  onProgress: (p) => {
    const pct = p.totalBytes > 0
      ? Math.round((p.bytesDownloaded / p.totalBytes) * 100)
      : 0;
    console.log(`${pct}% (${(p.bytesPerSecond / 1e6).toFixed(1)} MB/s)`);
  },
});
```

**With auth + checksum:**

```ts
const entry = await Models.download(modelRef, {
  authToken: process.env.HF_TOKEN,
  expectedSha256: 'a1b2c3d4…',
  expectedSizeBytes: 1_234_567_890,
});
```

**With AbortController:**

```ts
const controller = new AbortController();
cancelButton.onPress = () => controller.abort();

try {
  await Models.download(modelRef, { signal: controller.signal });
} catch (e: any) {
  if (e.name === 'AbortError') showCancelledState();
  else throw e;
}
```

---

## `Models.list()`

Returns all cache entries — including incomplete (paused / failed) downloads.

### Signature

```ts
Models.list(): Promise<CachedModelEntry[]>
```

### Returns

`Promise<CachedModelEntry[]>`. Each entry is re-stat'd from disk on each call so `sizeBytes` and `complete` reflect current state.

### Example

```ts
const all = await Models.list();
for (const m of all) {
  if (!m.complete) {
    console.log(`Resumable: ${m.modelRef} (${m.sizeBytes} / ${m.expectedSizeBytes} bytes)`);
    console.log(`Last error: ${m.lastError ?? 'unknown'}`);
  }
}
```

---

## `Models.cacheSize()`

Total bytes used by the cache directory.

### Signature

```ts
Models.cacheSize(): Promise<number>
```

### Returns

`Promise<number>` — sum of all file sizes under the cache directory.

### Example

```ts
const bytes = await Models.cacheSize();
console.log(`Cache: ${(bytes / 1e9).toFixed(2)} GB`);
```

---

## `Models.delete(ref)`

Removes a cached model.

### Signature

```ts
Models.delete(ref: ModelRef): Promise<boolean>
```

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `ref` | [`ModelRef`](./types.md#modelref) | yes | Canonical or raw ref. Both refer to the same cache entry. |

### Returns

`Promise<boolean>` — `true` if the entry existed and was removed; `false` if no such entry.

### Throws

[`E_INVALID_REF`](./errors.md#e_invalid_ref) for unparseable refs.

### Example

```ts
const removed = await Models.delete('hf://owner/repo/file.gguf');
console.log(removed ? 'Deleted' : 'Not cached');
```

---

## `Models.isCached(ref)`

Whether `ref` resolves to a complete cached file.

### Signature

```ts
Models.isCached(ref: ModelRef): Promise<boolean>
```

### Returns

`Promise<boolean>` — `true` only if a complete (non-`.part`) cache entry exists for the canonical form of `ref`.

### Throws

[`E_INVALID_REF`](./errors.md#e_invalid_ref) for unparseable refs.

### Example

```ts
if (await Models.isCached(modelRef)) {
  // skip the download UI; go straight to Engine.load
}
```

---

## `Models.cacheDir()`

Absolute path of the cache root directory.

### Signature

```ts
Models.cacheDir(): Promise<string>
```

### Returns

`Promise<string>` — absolute path on the device's filesystem.

- **Android:** `{context.filesDir}/bitnet-models/` — internal app storage; survives upgrades; user can clear via Settings → Storage.
- **iOS:** `{NSApplicationSupportDirectory}/bitnet-models/` — not in `NSCachesDirectory`, which the OS could evict mid-session.

### Example

```ts
console.log(await Models.cacheDir());
// Android: /data/data/com.example/files/bitnet-models
// iOS:     /var/mobile/Containers/Data/Application/<UUID>/Library/Application Support/bitnet-models
```

---

## `Models.resumeAll(options?)`

Bulk-resumes interrupted downloads. **Opt-in** — the SDK never resumes silently.

### Signature

```ts
Models.resumeAll(options?: ResumeAllOptions): Promise<ResumeAllResult>
```

### Parameters

See [`ResumeAllOptions`](./types.md#resumealloptions).

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `options.onProgress` | `(ref: ModelRef, p: DownloadProgress) => void` | no | — | Per-entry progress callback. |
| `options.skip` | [`ResumeSkipRules`](./types.md#resumeskiprules) | no | all `true` | Which `lastError` kinds to skip. |
| `options.concurrency` | `number` | no | `1` | Parallel resumes. Default 1 so they don't fight for bandwidth. |
| `options.signal` | `AbortSignal` | no | — | Aborts the bulk operation. In-flight entries each get the signal. |

### Returns

`Promise<ResumeAllResult>` — see [`ResumeAllResult`](./types.md#resumeallresult).

`resumed` = entries that completed; `skipped` = entries the `skip` rules filtered out (with `reason`); `failed` = entries that errored (with `error`).

### Example

```ts
const r = await Models.resumeAll({
  onProgress: (ref, p) => {
    console.log(`${ref}: ${p.bytesDownloaded}/${p.totalBytes}`);
  },
  concurrency: 2,
  skip: {
    userCancelled: true,        // user explicitly cancelled — don't auto-resume
    checksumMismatch: true,     // bad hash — needs human action
    diskFull: false,            // try again; user may have freed space
    httpClientError: true,      // 4xx — likely auth issue
  },
});

console.log(`Resumed: ${r.resumed.length}`);
console.log(`Skipped: ${r.skipped.map((s) => `${s.entry.modelRef}: ${s.reason}`).join(', ')}`);
console.log(`Failed: ${r.failed.length}`);
```

---

## `Models.resolve(ref)`

Canonicalizes a `modelRef` synchronously. Useful for log keys, cache lookups, dedup checks.

### Signature

```ts
Models.resolve(ref: ModelRef): { url: string; cacheKey: string }
```

### Returns

| Field | Type | Description |
|---|---|---|
| `url` | `string` | Resolved HTTP(S) URL (e.g. HuggingFace `resolve/<revision>` URL). |
| `cacheKey` | `string` | 16-char hex (SHA-256 prefix of canonical ref). `''` for `file://` refs. |

### Throws

[`E_INVALID_REF`](./errors.md#e_invalid_ref) for unparseable refs.

### Example

```ts
const { url, cacheKey } = Models.resolve('hf://owner/repo/file.gguf');
console.log(cacheKey);   // e.g. 'a1b2c3d4e5f6a7b8'
```

---

## Resume semantics

Resume is **automatic and implicit** when `Models.download(ref)` is called for a ref with an existing `.part` file — the SDK sends a `Range`/`If-Range` request to continue from the current byte offset. If the server's ETag has changed (upstream file updated), the download restarts cleanly.

State **survives app restart, force-stop, and OS kill**. The on-disk `.part` file's size IS the persisted progress count. After process death, the next `Models.list()` call shows the entry with `complete: false` and `lastError: 'E_INTERRUPTED'`.

`Models.resumeAll` is the explicit batch surface; for one-off resumes, `Models.download(ref)` does the right thing on its own.

## See also

- [`Engine.load({ modelRef })`](./engine.md#engineloadconfig) — usually all you need.
- [types.md](./types.md) — `CachedModelEntry`, `DownloadOptions`, `ResumeAllOptions`, etc.
- [errors.md](./errors.md) — download error codes.
- [events.md](./events.md) — the raw `BitnetDownloadProgress` event the higher-level `onProgress` callbacks are built on.
