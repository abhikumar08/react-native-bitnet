# Types

Every public type exported by `react-native-bitnet`. Types live in [src/index.tsx](../../src/index.tsx) and [src/models.ts](../../src/models.ts); this page is the navigable index — definitions are copied verbatim from source.

## Engine types

### `EngineConfig`

Configuration for [`Engine.load`](./engine.md#engineloadconfig).

```ts
type EngineConfig = {
  // Exactly one of modelPath / modelRef is required.
  modelPath?: string;
  modelRef?: ModelRef;
  downloadOptions?: DownloadOptions;
  contextSize?: number;   // default 2048
  threads?: number;       // default 4
  batchSize?: number;     // default 512
};
```

- `modelPath` — absolute path to a GGUF file already on disk.
- `modelRef` — URL-like reference; the SDK downloads + caches. See [`ModelRef`](#modelref).
- `downloadOptions` — only used when `modelRef` is set. See [`DownloadOptions`](#downloadoptions).
- `contextSize` — KV cache size in tokens. Larger = more memory, longer history.
- `threads` — CPU threads for inference. Most devices peak at 4.
- `batchSize` — tokens per prompt-eval batch.

### `GenerationParams`

Per-call parameters for [`engine.generate`](./engine.md#enginegenerateprompt-params) and [`engine.stream`](./engine.md#enginestreamprompt-params).

```ts
type GenerationParams = {
  maxTokens?: number;            // default 256
  temperature?: number;          // default 0.8
  topK?: number;                 // default 40
  topP?: number;                 // default 0.95
  seed?: number;                 // default 0 (fresh seed)
  stop?: string | string[];      // OpenAI-style stop sequences
  repeatPenalty?: number;        // default 1.1, 1.0 disables
  repeatLastN?: number;          // default 64; 0 disables, -1 means full context
  frequencyPenalty?: number;     // default 0.0
  presencePenalty?: number;      // default 0.0
  signal?: AbortSignal;
  onToken?: (token: string) => void;
};
```

`stop` accepts a string or array. Matched sequence is trimmed from the returned `text` and is not emitted to `onToken`.

`repeatPenalty` is llama.cpp's multiplicative penalty; `frequencyPenalty` and `presencePenalty` are OpenAI's additive penalties. Both are exposed so callers can pick what matches the model they're targeting.

`signal` rejects the promise with [`AbortError`](./errors.md#aborterror) on abort. Distinct from [`engine.cancel()`](./engine.md#enginecancel), which resolves with `finishReason: 'cancelled'`.

`onToken` receives complete UTF-8 chunks only — multibyte characters never split across calls. Ignored by `engine.stream` (the iterator is the streaming surface there).

### `GenerationResult`

The resolved value of [`engine.generate`](./engine.md#enginegenerateprompt-params) and [`GenerationStream.result`](#generationstream).

```ts
type GenerationResult = {
  text: string;
  finishReason: FinishReason;
  usage: TokenUsage;
  wallTimeMs: number;
};
```

- `text` — the full generated text, with any matched `stop` sequence trimmed.
- `finishReason` — why generation ended. See [`FinishReason`](#finishreason).
- `usage` — token counts. See [`TokenUsage`](#tokenusage).
- `wallTimeMs` — wall-clock time spent in the `generate()` call.

### `FinishReason`

```ts
type FinishReason = 'length' | 'stop' | 'cancelled';
```

- `'length'` — hit `maxTokens`.
- `'stop'` — model emitted EOS or matched a `stop` sequence.
- `'cancelled'` — caller invoked [`engine.cancel()`](./engine.md#enginecancel).

`AbortSignal` aborts do *not* produce `'cancelled'` — they reject with [`AbortError`](./errors.md#aborterror) instead.

### `TokenUsage`

```ts
type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};
```

OpenAI-shaped counts. `totalTokens === promptTokens + completionTokens`.

### `GenerationChunk`

One chunk yielded by [`engine.stream`](./engine.md#enginestreamprompt-params).

```ts
type GenerationChunk = {
  delta: string;
};
```

`delta` is the incremental text since the previous chunk. The SDK buffers across UTF-8 boundaries so `delta` never contains a partial multi-byte sequence. The shape is an object (not a bare string) so future fields (logprobs, role, tool calls) can be added without breaking callers.

### `GenerationStream`

The return type of [`engine.stream`](./engine.md#enginestreamprompt-params).

```ts
type GenerationStream = AsyncIterable<GenerationChunk> & {
  result: Promise<GenerationResult>;
};
```

Consume via `for await`. Read the final [`GenerationResult`](#generationresult) on `stream.result` after the loop. Breaking out of the loop auto-cancels the underlying generation — see [streaming.md](./streaming.md).

### `ModelInfo`

The resolved value of [`engine.modelInfo`](./engine.md#enginemodelinfo).

```ts
type ModelInfo = {
  architecture: string;
  nVocab: number;
  nCtxTrain: number;
  nEmbd: number;
  modelSizeBytes: number;
};
```

- `architecture` — model architecture from GGUF metadata (e.g. `'llama'`, `'bitnet-b1.58'`).
- `nVocab` — vocabulary size.
- `nCtxTrain` — context length the model was trained at (informational; `contextSize` in `EngineConfig` can be smaller).
- `nEmbd` — embedding dimension.
- `modelSizeBytes` — file size of the loaded GGUF.

### `ChatMessage`

A single message in a chat conversation.

```ts
type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
```

Used by [`engine.applyChatTemplate`](./engine.md#engineapplychattemplatemessages-addassistantheader) and [`engine.chat.completions.create`](./chat-completions.md).

## Chat-completions facade types

The OpenAI-shaped facade. Params use this SDK's camelCase (`maxTokens`, etc.); results mirror OpenAI's wire format with snake_case sub-fields.

### `ChatCompletionCreateParams`

```ts
type ChatCompletionCreateParams = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  seed?: number;
  stop?: string | string[];
  repeatPenalty?: number;
  repeatLastN?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stream?: boolean;
};
```

`stream` selects the overload at the type level: `stream: true` returns [`ChatCompletionStream`](#chatcompletionstream); `stream?: false` (or omitted) returns [`ChatCompletion`](#chatcompletion).

### `ChatCompletionRequestOptions`

```ts
type ChatCompletionRequestOptions = {
  signal?: AbortSignal;
};
```

The second argument to `chat.completions.create`. Matches OpenAI's request-options shape so migrated call sites don't have to relocate their `AbortController` wiring.

### `ChatCompletion`

The non-streaming return value.

```ts
type ChatCompletion = {
  id: string;                  // synthetic 'chatcmpl-xxxxxx'
  object: 'chat.completion';
  created: number;             // epoch seconds
  model: string;               // from modelInfo().architecture
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
};
```

### `ChatCompletionChoice`

```ts
type ChatCompletionChoice = {
  index: number;
  message: { role: 'assistant'; content: string };
  finish_reason: ChatCompletionFinishReason;
};
```

Always exactly one choice — the SDK doesn't support `n > 1`.

### `ChatCompletionFinishReason`

```ts
type ChatCompletionFinishReason = 'stop' | 'length' | null;
```

The SDK's internal `'cancelled'` collapses to `'stop'` for OpenAI parity. Callers who need to distinguish cancellation should use the lower-level `engine.generate` / `engine.stream`.

### `ChatCompletionUsage`

```ts
type ChatCompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
```

Snake_case (matches OpenAI's wire format), in contrast with [`TokenUsage`](#tokenusage)'s camelCase.

### `ChatCompletionChunk`

One chunk in the streaming variant.

```ts
type ChatCompletionChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
};
```

### `ChatCompletionChunkChoice`

```ts
type ChatCompletionChunkChoice = {
  index: number;
  delta: { role?: 'assistant'; content?: string };
  finish_reason: ChatCompletionFinishReason;
};
```

First chunk carries `delta.role: 'assistant'`. Middle chunks carry `delta.content` only. The final chunk has an empty delta with `finish_reason` set.

### `ChatCompletionStream`

The streaming return value.

```ts
type ChatCompletionStream = AsyncIterable<ChatCompletionChunk>;
```

Unlike [`GenerationStream`](#generationstream), this has no `.result` Promise — the final chunk carries the `finish_reason` directly, matching OpenAI's wire format.

## Model lifecycle types

### `ModelRef`

```ts
type ModelRef = string;
```

A URL-like string identifying a model. Supported schemes:

- `hf://owner/repo/path/to/file.gguf` — HuggingFace, default revision `main`.
- `hf://owner/repo/path/to/file.gguf@revision` — explicit revision (branch, tag, or commit SHA).
- `https://example.com/model.gguf` — direct URL.
- `http://…` — same; not recommended for production.
- `file:///absolute/path/to/model.gguf` — passthrough; no download, no cache entry.

### `DownloadOptions`

```ts
type DownloadOptions = {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  authToken?: string;
  expectedSizeBytes?: number;
  expectedSha256?: string;
};
```

- `onProgress` — called for each progress event keyed by the download's `cacheKey`.
- `signal` — abort the download. Rejects with [`AbortError`](./errors.md#aborterror).
- `authToken` — sent as `Authorization: Bearer <token>`. Use for private HuggingFace repos.
- `expectedSizeBytes` — if set, validates `Content-Length` matches before starting. `-1` = unknown (default).
- `expectedSha256` — if set, validates the final file's SHA-256. Mismatch throws [`E_CHECKSUM_MISMATCH`](./errors.md#e_checksum_mismatch).

### `DownloadProgress`

Payload of the `onProgress` callback and the `BitnetDownloadProgress` event.

```ts
type DownloadProgress = {
  cacheKey: string;
  bytesDownloaded: number;
  totalBytes: number;     // -1 if the server didn't send Content-Length
  bytesPerSecond: number;
};
```

### `CachedModelEntry`

The shape returned by [`Models.download`](./models.md#modelsdownloadref-opts) and [`Models.list`](./models.md#modelslist).

```ts
type CachedModelEntry = {
  modelRef: string;          // canonical ref
  cacheKey: string;          // 16-char hex (sha256 prefix of modelRef)
  localPath: string;         // model.gguf when complete; model.gguf.part when not
  sizeBytes: number;         // re-stat'd from disk on each call
  expectedSizeBytes: number; // server Content-Length, or -1 if unknown
  complete: boolean;
  createdAt: number;         // epoch ms
  completedAt: number;       // epoch ms, or 0 if !complete
  sha256: string;            // computed if expectedSha256 was provided
  etag: string;              // server etag, used internally for If-Range on resume
  lastError?: string;        // only on incomplete entries: 'E_NETWORK', 'E_INTERRUPTED', etc.
  resolvedUrl: string;       // actual HTTPS URL fetched (after HF resolution)
};
```

`localPath` is consumable by [`Engine.load({ modelPath })`](./engine.md#engineloadconfig) when `complete` is true.

### `ResumeAllOptions`

Options for [`Models.resumeAll`](./models.md#modelsresumealloptions).

```ts
type ResumeAllOptions = {
  onProgress?: (ref: ModelRef, p: DownloadProgress) => void;
  skip?: ResumeSkipRules;
  concurrency?: number;   // default 1
  signal?: AbortSignal;
};
```

`concurrency: 1` is the default so concurrent resumes don't fight for bandwidth on a single connection.

### `ResumeSkipRules`

```ts
type ResumeSkipRules = {
  userCancelled?: boolean;        // default true
  checksumMismatch?: boolean;     // default true
  diskFull?: boolean;             // default true
  httpClientError?: boolean;      // default true
};
```

Each rule controls whether an interrupted entry is skipped during `resumeAll` based on its `lastError`. All default to `true` because these errors typically require user action — automatically retrying a `E_HTTP_4XX` (401, 403) or a `E_CHECKSUM_MISMATCH` without intervention just burns bandwidth.

### `ResumeAllResult`

```ts
type ResumeAllResult = {
  resumed: CachedModelEntry[];
  skipped: { entry: CachedModelEntry; reason: string }[];
  failed: { entry: CachedModelEntry; error: Error }[];
};
```

`reason` in `skipped` is one of `'userCancelled'`, `'checksumMismatch'`, `'diskFull'`, `'httpClientError'` — matches a `ResumeSkipRules` key.

## See also

- [Engine](./engine.md) — methods that consume these types.
- [Models](./models.md) — methods that consume these types.
- [Errors](./errors.md) — the `E_*` codes referenced in `lastError` and elsewhere.
