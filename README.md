# react-native-bitnet

React Native TurboModule wrapper around a native BitNet engine (bitnet.cpp/llama.cpp) for on-device GGUF inference.

## Current status

- Android: inference engine + model lifecycle (download/cache/resume) implemented
- iOS: model lifecycle (download/cache/resume) implemented; inference engine port is in progress
- Native ABI: arm64-v8a only on Android

## Installation

```sh
yarn add react-native-bitnet
```

Then install native dependencies for your app as usual:

```sh
# React Native 0.60+ usually autolinks
# iOS users should run pod install in their ios directory
```

## Quick start

```ts
import { Engine } from 'react-native-bitnet';

async function run() {
	// One-call setup: SDK downloads (with resume support), caches,
	// and loads the model. Cache key is derived from the modelRef,
	// so a second call resolves instantly.
	const engine = await Engine.load({
		modelRef: 'hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf',
		contextSize: 2048,
		threads: 4,
		batchSize: 512,
		downloadOptions: {
			onProgress: ({ bytesDownloaded, totalBytes }) => {
				console.log(`downloaded ${bytesDownloaded}/${totalBytes}`);
			},
		},
	});

	// Alternative: load a model whose file you already have on disk.
	// const engine = await Engine.load({
	//   modelPath: '/data/data/<your.app.id>/files/model.gguf',
	// });

	try {
		const { text, finishReason, usage, wallTimeMs } = await engine.generate(
			'Hello, my name is',
			{
				maxTokens: 64,
				temperature: 0.8,
				topK: 40,
				topP: 0.95,
				seed: 42,
				onToken: (token) => {
					// Streaming token callback
					console.log(token);
				},
			}
		);

		console.log('Final output:', text);
		console.log(`Stopped: ${finishReason} after ${usage.completionTokens} tokens in ${wallTimeMs} ms`);
	} finally {
		engine.dispose();
	}
}
```

## Integration guide

### 1. Get a model onto the device

Two options — pick whichever fits:

**(A) Let the SDK handle the lifecycle (recommended).** Pass `modelRef` to `Engine.load`:

```ts
const engine = await Engine.load({
	modelRef: 'hf://owner/repo/file.gguf',          // HuggingFace
	// or: modelRef: 'https://example.com/model.gguf',
});
```

The SDK downloads (with resume), caches under app-private storage, and surfaces progress. See [Model lifecycle](#model-lifecycle) below.

**(B) Manage the file yourself.** Sideload via `adb push`, bundle as an asset, use your own downloader, etc. Then pass an absolute path:

```ts
const engine = await Engine.load({
	modelPath: '/data/data/<your.app.id>/files/model.gguf',
});
```

Bypasses all SDK caching — no metadata is written, no progress is emitted.

### 2. Create an engine instance

Use `Engine.load(config)` once per model instance.

```ts
const engine = await Engine.load({
	modelPath,
	contextSize: 2048, // optional
	threads: 4,        // optional
	batchSize: 512,    // optional
});
```

### 3. Generate text (with optional streaming)

`engine.generate(prompt, params)` resolves with a `GenerationResult` — the final text plus usage and finish-reason metadata. If you pass `onToken`, partial tokens are streamed as they arrive.

```ts
const { text, finishReason, usage, wallTimeMs } = await engine.generate(prompt, {
	maxTokens: 256,
	temperature: 0.8,
	topK: 40,
	topP: 0.95,
	seed: 0,
	stop: ['<|start_header_id|>'],   // OpenAI-style; string or string[]
	repeatPenalty: 1.15,             // llama.cpp-style; 1.0 disables
	frequencyPenalty: 0.0,           // OpenAI-style; additive
	presencePenalty: 0.0,
	onToken: (token) => {
		// Append token to UI incrementally
	},
});

// `finishReason` is 'length' | 'stop' | 'cancelled'.
// `usage` is { promptTokens, completionTokens, totalTokens }.
```

Or use the async-iterator style — drop-in for callers migrating from OpenAI's `stream: true`:

```ts
const stream = engine.stream(prompt, { maxTokens: 256, temperature: 0.8 });
for await (const chunk of stream) {
	process.stdout.write(chunk.delta);
}
// Final metadata (finishReason, usage, wallTimeMs) is awaited on .result:
const { finishReason, usage } = await stream.result;
```

Breaking out of the loop auto-cancels the underlying generation:

```ts
for await (const chunk of engine.stream(prompt)) {
	if (chunk.delta.includes('STOP')) break;  // iterator.return() fires NativeBitnet.cancelGeneration(handle) directly
}
```

`.result` always resolves (never rejects on cancel) — on early break it
resolves with `finishReason: 'cancelled'` and `text` containing whatever
streamed before the break.

#### Drop-in for OpenAI-API callers

If you have existing code written against `openai.chat.completions.create(...)`,
the same call shape works against an `Engine`. The result mirrors OpenAI's wire
format (`choices`, `usage`, snake_case sub-fields) so response-handling code
keeps working unchanged.

```ts
// Non-streaming.
const response = await engine.chat.completions.create({
	messages: [
		{ role: 'system', content: 'You are helpful.' },
		{ role: 'user', content: 'Hi' },
	],
	maxTokens: 256,
});
console.log(response.choices[0].message.content);
console.log(response.usage.prompt_tokens, response.usage.completion_tokens);

// Streaming.
const stream = await engine.chat.completions.create({
	messages: [{ role: 'user', content: 'Tell me a story' }],
	stream: true,
});
for await (const chunk of stream) {
	process.stdout.write(chunk.choices[0].delta.content ?? '');
}
```

Param names follow this SDK's camelCase convention (`maxTokens`,
`frequencyPenalty`, …); migrating call sites rename their param keys but the
response destructuring stays identical to OpenAI code.

#### Aborting with AbortController

`engine.generate`, `engine.stream`, and `engine.chat.completions.create` all
accept an `AbortSignal`. When the signal aborts, the in-flight call rejects
with `AbortError` (web-standard) — the iterator throws on the awaiting
consumer, and the `.result` Promise rejects.

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 500);

// generate()
try {
	await engine.generate(prompt, { signal: ac.signal });
} catch (e) {
	if ((e as Error).name === 'AbortError') {
		// aborted before generation completed
	}
}

// stream()
const stream = engine.stream(prompt, { signal: ac.signal });
try {
	for await (const chunk of stream) ui.append(chunk.delta);
} catch (e) {
	if ((e as Error).name === 'AbortError') { /* aborted */ }
}

// chat.completions.create — signal lives in the second-arg options object,
// matching `openai.chat.completions.create(body, { signal })` exactly.
const ccStream = await engine.chat.completions.create(
	{ messages, stream: true },
	{ signal: ac.signal }
);
```

If `signal.aborted` is already `true` at the call site, the call throws
synchronously (or rejects on the next microtask for `generate`) without
entering native — no model load, no decode kicks off.

`AbortSignal` is intentionally distinct from `engine.cancel()`. The
former *rejects* with `AbortError` (use when the caller treats the
operation as failed/abandoned); the latter resolves the Promise with
`finishReason: 'cancelled'` and the partial `text` (use when the caller
wants to keep what was generated). Pick whichever matches your call style.

### 4. Use chat templates (recommended for chat models)

`applyChatTemplate` renders model-specific prompt formatting from GGUF metadata.

```ts
const renderedPrompt = await engine.applyChatTemplate(
	[
		{ role: 'system', content: 'You are a helpful assistant.' },
		{ role: 'user', content: 'Write a haiku about compilers.' },
	],
	true
);

const { text: answer } = await engine.generate(renderedPrompt, {
	maxTokens: 128,
});
```

### 5. Read model metadata

```ts
const info = await engine.modelInfo();
console.log(info.architecture, info.nVocab, info.nCtxTrain, info.nEmbd);
```

### 6. Cancel and dispose

- `engine.cancel()` asks native generation to stop
- `engine.dispose()` must be called when done to release native resources

```ts
const pending = engine.generate(longPrompt, { onToken: console.log });

// Later, based on user action:
engine.cancel();

// `pending` resolves (does NOT reject) with whatever was generated so far.
const result = await pending;
// result.finishReason === 'cancelled'
// result.text contains the partial output up to the cancel point.
engine.dispose();
```

## API reference

The detailed, OpenAI-style API reference lives under **[docs/api/](./docs/api/README.md)**. One file per resource:

- **[docs/api/engine.md](./docs/api/engine.md)** — `Engine.load`, `generate`, `stream`, `cancel`, `applyChatTemplate`, `modelInfo`, `dispose`.
- **[docs/api/chat-completions.md](./docs/api/chat-completions.md)** — `engine.chat.completions.create` (the OpenAI-shaped facade).
- **[docs/api/models.md](./docs/api/models.md)** — `Models.download`, `list`, `cacheSize`, `delete`, `isCached`, `cacheDir`, `resumeAll`, `resolve`.
- **[docs/api/types.md](./docs/api/types.md)** — every exported type.
- **[docs/api/errors.md](./docs/api/errors.md)** — every `E_*` code and `AbortError`.
- **[docs/api/events.md](./docs/api/events.md)** — raw `BitnetToken` / `BitnetDownloadProgress` event payloads.
- **[docs/api/streaming.md](./docs/api/streaming.md)** — patterns for `onToken`, `stream()`, `chat.completions.create({ stream: true })`, cancel vs `AbortSignal`.

Errors carry a `.code` property starting with `E_*` for typed pattern-matching (e.g. `E_ENGINE_BUSY`, `E_ENGINE_DISPOSED`). `AbortError` uses `name === 'AbortError'` (Web `AbortController` convention). See [docs/api/errors.md](./docs/api/errors.md) for the catalog.

## Model lifecycle

The SDK can own the entire model lifecycle so consumers don't have to: auto-download from HuggingFace or a URL, cache locally, resume interrupted downloads, list/delete cached models.

### `Models` namespace

```ts
import { Models } from 'react-native-bitnet';

// Download (returns existing cached entry instantly if already complete).
const entry = await Models.download(
	'hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf',
	{
		onProgress: (p) => console.log(p.bytesDownloaded, p.totalBytes),
		// signal: abortController.signal,  // optional cancellation
		// authToken: 'hf_xxx',              // private repo auth
	}
);
console.log(entry.localPath);  // ready for Engine.load({ modelPath })

// List everything currently in the cache — including paused / failed downloads.
const all = await Models.list();
for (const m of all) {
	if (!m.complete) {
		console.log('Resumable:', m.modelRef, m.lastError, m.sizeBytes);
	}
}

// Cache management
await Models.cacheSize();                 // total bytes used
await Models.delete('hf://...');          // returns true if removed
await Models.isCached('hf://...');        // boolean
const dir = await Models.cacheDir();      // absolute path

// Bulk resume of interrupted downloads (opt-in; SDK never resumes silently).
const r = await Models.resumeAll({
	onProgress: (ref, p) => console.log(ref, p.bytesDownloaded),
	concurrency: 1,  // default: one at a time so they don't fight for bandwidth
	skip: { userCancelled: true, checksumMismatch: true, diskFull: true, httpClientError: true },
});
console.log('Resumed:', r.resumed.length, 'Failed:', r.failed.length);
```

### Supported `modelRef` formats

- `hf://owner/repo/path/to/file.gguf` — HuggingFace, default revision `main`
- `hf://owner/repo/path/to/file.gguf@revision` — explicit revision (branch, tag, or commit)
- `https://example.com/model.gguf` — any direct URL
- `file:///absolute/path/to/model.gguf` — passthrough, no download (Engine loads from the path directly)

### Reference

- [`CachedModelEntry`](./docs/api/types.md#cachedmodelentry) — shape returned by `Models.list` / `Models.download`.
- [`DownloadOptions`](./docs/api/types.md#downloadoptions), [`ResumeAllOptions`](./docs/api/types.md#resumealloptions) — option types.
- [Download / cache error codes](./docs/api/errors.md#download--cache-errors) — `E_INVALID_REF`, `E_NETWORK`, `E_HTTP_4XX`, `E_HTTP_5XX`, `E_DISK_FULL`, `E_CHECKSUM_MISMATCH`, etc.

### Resume semantics

Resume is automatic and implicit when you call `Models.download(ref)` again — the SDK detects the `.part` file and sends a `Range`/`If-Range` request. If the server's ETag changed (file was updated), the download restarts cleanly.

State survives app restart, force-stop, and OS kill. The on-disk `.part` file size IS the persisted progress count. After a process death, the next call to `Models.list()` shows the entry with `complete:false` and `lastError:"E_INTERRUPTED"`.

### Cache directory

- **Android:** `{context.filesDir}/bitnet-models/{cacheKey}/` (internal app storage; survives upgrades; user can clear via Settings → Storage)
- **iOS:** `{NSApplicationSupportDirectory}/bitnet-models/{cacheKey}/` (not in `NSCachesDirectory` — OS would otherwise evict mid-session)

## Host app integration (background downloads)

For downloads to survive the user backgrounding the app, hosts must add platform-specific configuration.

### Android

The library declares the necessary permissions and the `BitnetDownloadService` foreground service in its `AndroidManifest.xml` (merged into the host app at build time). The host **must** request the runtime notification permission on Android 13+ before starting a download:

```ts
import { PermissionsAndroid, Platform } from 'react-native';

if (Platform.OS === 'android' && Platform.Version >= 33) {
	await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}
```

If the user denies the permission the download still works — only the foreground-service notification is suppressed.

### iOS

Add the background URLSession bridge to your AppDelegate so iOS can deliver completion when the app was suspended mid-download:

```objc
// AppDelegate.mm
#import <react-native-bitnet/BitnetDownloader.h>

- (void)application:(UIApplication *)application
  handleEventsForBackgroundURLSession:(NSString *)identifier
                    completionHandler:(void (^)(void))completionHandler {
  [BitnetDownloader storeCompletionHandler:completionHandler
                             forIdentifier:identifier];
}
```

Without this, downloads still work in the foreground but won't resume reliably when the app is suspended for long periods.

### Private HuggingFace repos

```ts
const engine = await Engine.load({
	modelRef: 'hf://your-org/private-repo/model.gguf',
	downloadOptions: { authToken: 'hf_xxx' },  // becomes "Authorization: Bearer hf_xxx"
});
```

The SDK doesn't store the token — bring your own secure storage (e.g. `react-native-keychain`).

### Convenience export

`Bitnet.load` is an alias of `Engine.load`.

## Behavior and platform notes

- Streaming tokens are emitted through the `BitnetToken` native event internally.
- Download progress is emitted through `BitnetDownloadProgress`, keyed by `cacheKey`.
- Concurrent generation on the same engine instance is not supported.
- Concurrent downloads of the same `modelRef` are deduplicated — only one network task runs, all callers share the result.
- iOS inference engine is not wired yet: `Engine.load` on iOS will run the download (if `modelRef` was passed) and then fail when it tries to load the engine. The lifecycle APIs (`Models.download`, `Models.list`, etc.) work today on iOS.
- Android build is configured for arm64-v8a only.

## Example app

See `example/src/App.tsx` for an end-to-end sample that:

- Downloads a model via `Models.download('hf://...')`
- Loads it with `Engine.load({ modelPath })`
- Streams tokens via `engine.chat.completions.create({ stream: true })` and `engine.stream()` (`for await` loop)
- Reads final text and usage from `stream.result`
- Disposes engine on unmount

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT
