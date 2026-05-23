# Errors

All SDK errors are standard `Error` instances. Typed errors carry a `.code` property (a string starting with `E_`). `AbortError` is the one exception — it follows the Web `AbortController` convention and uses `name === 'AbortError'`.

**Pattern-match on `.code`, not on `.message`.** Messages are human-readable and may change between releases; codes are stable.

```ts
try {
  await engine.generate('Hello');
} catch (e: any) {
  if (e.code === 'E_ENGINE_BUSY') return;
  if (e.name === 'AbortError') return;
  throw e;
}
```

## Engine errors

### `E_ENGINE_BUSY`

Another `generate()` / `stream()` / `chat.completions.create()` call is already in flight on the same `Engine` instance. The engine is single-flight per instance — `llama.cpp`'s KV cache cannot be safely shared across concurrent decodes.

**Thrown by:** [`engine.generate`](./engine.md#enginegenerateprompt-params), [`engine.stream`](./engine.md#enginestreamprompt-params), [`engine.chat.completions.create`](./chat-completions.md).

**Shape:**

```ts
Error & { code: 'E_ENGINE_BUSY' }
```

**Recovery:** await the in-flight call, or call [`engine.cancel()`](./engine.md#enginecancel) first.

```ts
try {
  await engine.generate(prompt);
} catch (e: any) {
  if (e.code === 'E_ENGINE_BUSY') {
    engine.cancel();
    // retry once the previous call settles
  }
}
```

### `E_ENGINE_DISPOSED`

A method was called on an engine after [`engine.dispose()`](./engine.md#enginedispose). Every method except `dispose` itself rejects with this code after disposal.

**Thrown by:** any `Engine` method other than `dispose`.

**Shape:**

```ts
Error & { code: 'E_ENGINE_DISPOSED' }
```

**Recovery:** load a fresh engine.

```ts
try {
  await engine.generate(prompt);
} catch (e: any) {
  if (e.code === 'E_ENGINE_DISPOSED') {
    engine = await Engine.load(config);
    await engine.generate(prompt);
  }
}
```

### `E_NOT_IMPLEMENTED`

The platform doesn't implement this method yet. Currently only iOS — the inference engine port is in progress; lifecycle methods (`Models.*`) work on iOS, but `Engine.load` / `generate` / `applyChatTemplate` / `modelInfo` reject with this code.

**Thrown by (iOS only, today):** [`Engine.load`](./engine.md#engineloadconfig), [`engine.generate`](./engine.md#enginegenerateprompt-params), [`engine.stream`](./engine.md#enginestreamprompt-params), [`engine.applyChatTemplate`](./engine.md#engineapplychattemplatemessages-addassistantheader), [`engine.modelInfo`](./engine.md#enginemodelinfo).

**Shape:**

```ts
Error & { code: 'E_NOT_IMPLEMENTED' }
```

**Recovery:** none in code — track the iOS port status. Pattern-match this code in cross-platform apps to show a graceful fallback (e.g. "On-device inference is currently Android-only").

### `E_NOT_TEMPLATABLE`

The loaded GGUF has no `tokenizer.chat_template` metadata that `llama.cpp` recognizes (chatml, llama2, llama3, mistral, gemma, qwen, etc.). The model can still be used with `engine.generate(prompt)` directly — just not with `applyChatTemplate` or `chat.completions.create`.

**Thrown by:** [`engine.applyChatTemplate`](./engine.md#engineapplychattemplatemessages-addassistantheader), and transitively by [`engine.chat.completions.create`](./chat-completions.md) (which calls `applyChatTemplate` internally).

**Shape:**

```ts
Error & { code: 'E_NOT_TEMPLATABLE' }
```

**Recovery:** render the prompt manually for that model and call `engine.generate` / `engine.stream` instead.

```ts
try {
  await engine.chat.completions.create({ messages });
} catch (e: any) {
  if (e.code === 'E_NOT_TEMPLATABLE') {
    const prompt = renderManually(messages); // your own template
    return engine.generate(prompt);
  }
  throw e;
}
```

### `E_LOAD_FAILED`

The native side failed to load the model — either `loadModel` returned a null handle or threw (corrupt/incompatible GGUF, out of memory, unreadable file). Distinct from the download/cache errors below: the file was present, but the engine couldn't initialize from it.

**Thrown by:** [`Engine.load`](./engine.md#engineloadconfig) (after any download step succeeds).

**Shape:**

```ts
Error & { code: 'E_LOAD_FAILED' }
```

**Recovery:** verify the GGUF is a supported BitNet/llama.cpp quantization and not truncated. Re-download with a checksum (`downloadOptions.expectedSha256`) if corruption is suspected.

### `E_GEN_FAILED`

The native `generate()` decode threw unexpectedly (not a cancel, not an abort — an actual engine fault mid-decode).

**Thrown by:** [`engine.generate`](./engine.md#enginegenerateprompt-params), [`engine.stream`](./engine.md#enginestreamprompt-params), and transitively [`engine.chat.completions.create`](./chat-completions.md).

**Shape:**

```ts
Error & { code: 'E_GEN_FAILED' }
```

**Recovery:** none automatic — surface to the user. A recurring `E_GEN_FAILED` on a model that previously worked usually points to a corrupted KV cache state; dispose and reload the engine.

### `E_TEMPLATE_FAILED`

The native `applyChatTemplate()` threw. Distinct from [`E_NOT_TEMPLATABLE`](#e_not_templatable): the model *has* a chat template, but rendering it failed (malformed template metadata, unexpected message shape).

**Thrown by:** [`engine.applyChatTemplate`](./engine.md#engineapplychattemplatemessages-addassistantheader), and transitively [`engine.chat.completions.create`](./chat-completions.md).

**Shape:**

```ts
Error & { code: 'E_TEMPLATE_FAILED' }
```

**Recovery:** fall back to rendering the prompt manually and calling `engine.generate` / `engine.stream`.

### `E_INFO_FAILED`

The native `getModelInfo()` threw while reading GGUF metadata.

**Thrown by:** [`engine.modelInfo`](./engine.md#enginemodelinfo).

**Shape:**

```ts
Error & { code: 'E_INFO_FAILED' }
```

**Recovery:** none automatic — the engine is still usable for generation even if metadata can't be read.

## Download / cache errors

### `E_INVALID_REF`

`modelRef` is unparseable. Recognized schemes: `hf://owner/repo/file.gguf[@revision]`, `https://…`, `http://…`, `file:///absolute/path`.

**Thrown by:** [`Models.download`](./models.md#modelsdownloadref-opts), [`Models.isCached`](./models.md#modelsiscachedref), [`Models.delete`](./models.md#modelsdeleteref), [`Models.resolve`](./models.md#modelsresolveref), and transitively [`Engine.load`](./engine.md#engineloadconfig) when given a bad `modelRef`.

**Shape:** plain `Error` with the prefix `E_INVALID_REF:` in the message (see [src/models.ts:102](../../src/models.ts#L102)). Not yet exposed via `.code` — pattern-match the message prefix for now. Tracked as a doc gap; will get `.code = 'E_INVALID_REF'` in a future release.

### `E_NETWORK`

Network I/O failure during download (DNS, connection reset, TLS error, etc.).

**Thrown by:** [`Models.download`](./models.md#modelsdownloadref-opts), [`Engine.load`](./engine.md#engineloadconfig) with `modelRef`.

**Shape:**

```ts
Error & { code: 'E_NETWORK' }
```

**Recovery:** retry — typically transient. The `.part` file is preserved, so the next call resumes from the same byte offset.

### `E_HTTP_4XX`

Server returned a 4xx status code. `401` includes a hint in the message to set `downloadOptions.authToken` for private HuggingFace repos.

**Thrown by:** [`Models.download`](./models.md#modelsdownloadref-opts), [`Engine.load`](./engine.md#engineloadconfig) with `modelRef`.

**Shape:**

```ts
Error & { code: 'E_HTTP_4XX' }
```

**Recovery:** check the error message — `401`/`403` usually means auth is missing or wrong; `404` means the `modelRef` doesn't exist (likely a typo).

### `E_HTTP_5XX`

Server returned a 5xx status code. Treat as retryable.

**Thrown by:** [`Models.download`](./models.md#modelsdownloadref-opts), [`Engine.load`](./engine.md#engineloadconfig) with `modelRef`.

**Shape:**

```ts
Error & { code: 'E_HTTP_5XX' }
```

**Recovery:** exponential backoff + retry. The `.part` file is preserved.

### `E_DISK_FULL`

Out of storage during write. The partial `.part` file is preserved — once space is freed, the next call to `Models.download` resumes from the current offset.

**Thrown by:** [`Models.download`](./models.md#modelsdownloadref-opts), [`Engine.load`](./engine.md#engineloadconfig) with `modelRef`.

**Shape:**

```ts
Error & { code: 'E_DISK_FULL' }
```

**Recovery:** free space (e.g. call `Models.delete` on other refs), then retry.

### `E_CHECKSUM_MISMATCH`

The downloaded file's SHA-256 didn't match `downloadOptions.expectedSha256`. The `.part` file is removed — the next call starts fresh.

**Thrown by:** [`Models.download`](./models.md#modelsdownloadref-opts), [`Engine.load`](./engine.md#engineloadconfig) with `modelRef`.

**Shape:**

```ts
Error & { code: 'E_CHECKSUM_MISMATCH' }
```

**Recovery:** verify the expected hash is correct. If the model was legitimately updated upstream, drop `expectedSha256` (or update it) and retry.

### `E_DOWNLOAD_CANCELLED`

Internal code raised when the native downloader is cancelled. The SDK converts this into an [`AbortError`](#aborterror) before surfacing it to JS callers — you will normally see `AbortError`, not `E_DOWNLOAD_CANCELLED`, in user code.

**Internal trigger:** `NativeBitnet.cancelDownload` or `AbortSignal` abort.

**JS-facing shape:** see [`AbortError`](#aborterror).

### `E_CACHE`

A cache filesystem operation threw — listing, deleting, sizing, resolving the cache dir, or checking whether a ref is cached. Fires on both Android and iOS (the lifecycle layer is implemented on both platforms).

**Thrown by:** [`Models.list`](./models.md#modelslist), [`Models.delete`](./models.md#modelsdeleteref), [`Models.cacheSize`](./models.md#modelscachesize), [`Models.cacheDir`](./models.md#modelscachedir), [`Models.isCached`](./models.md#modelsiscachedref).

**Shape:**

```ts
Error & { code: 'E_CACHE' }
```

**Recovery:** usually a transient or permissions issue on the app's private storage. Retry once; if it persists, the cache directory may be unreadable.

### `E_INTERRUPTED` (not a thrown error)

Unlike the codes above, `E_INTERRUPTED` is **never thrown or rejected** — it is a sentinel value written to the `lastError` field of an incomplete [`CachedModelEntry`](./types.md#cachedmodelentry) when a download is cut short by process death. The crash-recovery sweep on module init marks such entries so the UI can present a resumable state. You only ever read it off `Models.list()` results, never `catch` it.

## Generic errors

### `AbortError`

`AbortSignal` aborted before the operation completed. Web-standard shape — `name === 'AbortError'` and no `.code`. Used uniformly for `Engine.generate`, `Engine.stream`, `Engine.chat.completions.create`, `Models.download`, and `Models.resumeAll`.

**Thrown by:** any method that accepts a `signal: AbortSignal`.

**Shape:**

```ts
Error & { name: 'AbortError' }
```

If `controller.abort(reason)` was called with an `Error` instance as the reason, the SDK propagates that exact instance instead of wrapping in a fresh `AbortError` (matches the Web spec). If the reason is a string, it becomes the `AbortError`'s `message`.

```ts
const controller = new AbortController();
try {
  await engine.generate(prompt, { signal: controller.signal });
} catch (e: any) {
  if (e.name === 'AbortError') {
    // user-initiated abort — show a "stopped" UI state
    return;
  }
  throw e;
}
```

**Distinct from [`engine.cancel()`](./engine.md#enginecancel):** `cancel()` does *not* reject the in-flight Promise. It resolves with `finishReason: 'cancelled'` and partial `text`. Use `AbortSignal` when you want a reject; use `engine.cancel()` when you want a resolve.

### Validation errors (no `.code` — known gap)

Two paths in [src/index.tsx](../../src/index.tsx) throw plain `Error` without a `.code`:

- `'Engine.load: provide either modelPath or modelRef, not both.'` — both passed.
- `'Engine.load: modelPath or modelRef must be provided.'` — neither passed.

These will be promoted to `E_INVALID_CONFIG` (with `.code`) in a future release. For now, pattern-match the message prefix or just let them bubble — they only fire on programmer error and are not catchable conditions in normal use.

## Error code parity across platforms

Every code in this catalog should fire on both Android and iOS with the same trigger condition. The exception today is `E_NOT_IMPLEMENTED`, which iOS uses as a placeholder for the in-progress engine port. Because iOS short-circuits the engine methods with `E_NOT_IMPLEMENTED`, the engine-side native failures (`E_LOAD_FAILED`, `E_GEN_FAILED`, `E_TEMPLATE_FAILED`, `E_INFO_FAILED`) are Android-only today — they only become reachable on iOS once the port lands. The cache codes (`E_CACHE`, the download codes) already fire on both platforms.

If you observe a code firing on one platform but not the other for the same trigger, it's a bug — please file it.
