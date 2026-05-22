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

### `Engine.load(config: EngineConfig): Promise<Engine>`

Creates a native engine and loads the model.

`EngineConfig` — provide exactly one of `modelPath` or `modelRef`:

- `modelPath?: string` — absolute path to a GGUF file on disk
- `modelRef?: string` — `hf://owner/repo/file.gguf[@revision]` or `https://...` (SDK downloads + caches)
- `downloadOptions?: DownloadOptions` — progress callback, abort signal, auth token (only used with `modelRef`)
- `contextSize?: number` (default `2048`)
- `threads?: number` (default `4`)
- `batchSize?: number` (default `512`)

### `engine.generate(prompt: string, params?: GenerationParams): Promise<GenerationResult>`

Generates text from a prompt. Resolves with the final text plus metadata; if `engine.cancel()` was called mid-flight, resolves with the partial text and `finishReason: 'cancelled'` (never rejects on cancel).

`GenerationParams`:

- `maxTokens?: number` (default `256`)
- `temperature?: number` (default `0.8`)
- `topK?: number` (default `40`)
- `topP?: number` (default `0.95`)
- `seed?: number` (default `0` — engine treats `0` as "pick a fresh seed")
- `stop?: string | string[]` — OpenAI-style stop sequence(s). The matched string is trimmed from the returned text and never emitted to `onToken`.
- `repeatPenalty?: number` (default `1.1`, `1.0` disables) — llama.cpp-style multiplicative penalty against tokens seen in the last `repeatLastN` positions.
- `repeatLastN?: number` (default `64`) — window used by `repeatPenalty`, `frequencyPenalty`, and `presencePenalty`.
- `frequencyPenalty?: number` (default `0.0`) — OpenAI-style additive penalty proportional to recent frequency.
- `presencePenalty?: number` (default `0.0`) — OpenAI-style additive penalty for any prior occurrence.
- `onToken?: (token: string) => void` — optional streaming callback. Receives complete UTF-8 chunks only (the SDK buffers across token boundaries so multibyte characters never split).

`GenerationResult`:

- `text: string` — the full generated text, with any matched `stop` trimmed.
- `finishReason: 'length' | 'stop' | 'cancelled'` — `'length'` = hit `maxTokens`; `'stop'` = model emitted EOS or a `stop` sequence matched; `'cancelled'` = caller invoked `engine.cancel()`.
- `usage: { promptTokens, completionTokens, totalTokens }` — OpenAI-shaped token counts.
- `wallTimeMs: number` — wall-clock time spent in this `generate()` call.

### `engine.cancel(): void`

Cancels an in-flight generation.

### `engine.applyChatTemplate(messages: ChatMessage[], addAssistantHeader?: boolean): Promise<string>`

Renders a chat prompt using model metadata template.

`ChatMessage`:

- `role: 'system' | 'user' | 'assistant'`
- `content: string`

### `engine.modelInfo(): Promise<ModelInfo>`

Returns metadata:

- `architecture: string`
- `nVocab: number`
- `nCtxTrain: number`
- `nEmbd: number`
- `modelSizeBytes: number`

### `engine.dispose(): void`

Releases native engine resources. After dispose, calls throw an error.

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

### `CachedModelEntry` shape (returned by `Models.list` and `Models.download`)

```ts
{
	modelRef: string;          // canonical ref
	cacheKey: string;          // 16-char hex (sha256 prefix of modelRef)
	localPath: string;         // model.gguf when complete; model.gguf.part when not
	sizeBytes: number;         // re-stat'd from disk on each call
	expectedSizeBytes: number; // server Content-Length, or -1 if unknown
	complete: boolean;         // true => Engine.load({ modelPath: entry.localPath }) is ready to use
	createdAt: number;         // epoch ms
	completedAt: number;       // epoch ms, or 0 if !complete
	sha256: string;            // computed if expectedSha256 was provided
	etag: string;              // server etag, used internally for If-Range on resume
	lastError?: string;        // only on incomplete entries: "E_NETWORK", "E_INTERRUPTED", etc.
	resolvedUrl: string;       // the actual HTTPS URL fetched (after HF resolution)
}
```

### Resume semantics

Resume is automatic and implicit when you call `Models.download(ref)` again — the SDK detects the `.part` file and sends a `Range`/`If-Range` request. If the server's ETag changed (file was updated), the download restarts cleanly.

State survives app restart, force-stop, and OS kill. The on-disk `.part` file size IS the persisted progress count. After a process death, the next call to `Models.list()` shows the entry with `complete:false` and `lastError:"E_INTERRUPTED"`.

### Error codes (thrown from `Models.download` / `Engine.load`)

| Code | Meaning |
|---|---|
| `E_INVALID_REF` | Unparseable `modelRef` |
| `E_NETWORK` | I/O failure |
| `E_HTTP_4XX` | Server returned 4xx (401 includes a hint to set `authToken`) |
| `E_HTTP_5XX` | Server returned 5xx — retryable |
| `E_DISK_FULL` | Out of storage; `.part` is preserved for later resume |
| `E_CHECKSUM_MISMATCH` | Provided `expectedSha256` didn't match — `.part` removed |
| `E_DOWNLOAD_CANCELLED` | User cancel via `cancelDownload` or `AbortSignal` (re-thrown as `AbortError`) |

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

- Loads a model
- Calls `modelInfo()`
- Streams tokens with `onToken`
- Reads final output from `generate`
- Disposes engine

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT
