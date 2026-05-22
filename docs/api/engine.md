# Engine

The inference primitive. One `Engine` wraps one loaded model on the native side. The class is exported from the package root.

```ts
import { Engine } from 'react-native-bitnet';
```

## `Engine.load(config)`

Loads a model and creates a native engine.

### Signature

```ts
static load(config: EngineConfig): Promise<Engine>
```

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `config.modelPath` | `string` | one of | — | Absolute path to a GGUF file already on disk. Exactly one of `modelPath` / `modelRef` must be set. |
| `config.modelRef` | [`ModelRef`](./types.md#modelref) | one of | — | URL-like reference; SDK downloads + caches. See [Models.download](./models.md#modelsdownloadref-opts). |
| `config.downloadOptions` | [`DownloadOptions`](./types.md#downloadoptions) | no | — | Passed through to `Models.download` when `modelRef` is set. Ignored when `modelPath` is set. |
| `config.contextSize` | `number` | no | `2048` | KV cache size in tokens. |
| `config.threads` | `number` | no | `4` | CPU threads for inference. |
| `config.batchSize` | `number` | no | `512` | Tokens per prompt-eval batch. |

### Returns

`Promise<Engine>` — resolves with a ready-to-use engine instance.

### Throws

| Error | Condition | Recovery |
|---|---|---|
| `Error` (no `.code`) | Both `modelPath` and `modelRef` set, or neither set. | Pass exactly one. Will become `E_INVALID_CONFIG` in a future release. |
| `E_NOT_IMPLEMENTED` (iOS) | iOS inference port not landed yet. | Track [iOS port](../../.claude/skills/port-ios/SKILL.md) progress. |
| `E_*` download codes | When `modelRef` is set and the download fails. See [errors.md](./errors.md). | Per error code. |

### Example

```ts
import { Engine } from 'react-native-bitnet';

// Load from a cached/downloaded ref
const engine = await Engine.load({
  modelRef: 'hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf',
  contextSize: 4096,
  threads: 4,
});

// Or from a local path
const local = await Engine.load({
  modelPath: '/data/data/com.example/files/model.gguf',
});

// Or with download progress reporting
const withProgress = await Engine.load({
  modelRef: 'hf://owner/repo/file.gguf',
  downloadOptions: {
    onProgress: (p) => console.log(p.bytesDownloaded, '/', p.totalBytes),
  },
});
```

### See also

- [`Models.download`](./models.md#modelsdownloadref-opts) — explicit download outside of `Engine.load`.
- [`engine.dispose`](#enginedispose) — paired call to release native resources.

---

## `engine.generate(prompt, params?)`

Generate text from a prompt. Resolves with the final text plus metadata.

### Signature

```ts
generate(
  prompt: string,
  params?: GenerationParams
): Promise<GenerationResult>
```

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | `string` | yes | — | Raw text prompt. For chat formats, render via [`engine.applyChatTemplate`](#engineapplychattemplatemessages-addassistantheader) or use [`engine.chat.completions.create`](./chat-completions.md). |
| `params.maxTokens` | `number` | no | `256` | Cap on generated tokens. |
| `params.temperature` | `number` | no | `0.8` | Sampling temperature. `0` is greedy. |
| `params.topK` | `number` | no | `40` | Top-K sampling cutoff. |
| `params.topP` | `number` | no | `0.95` | Top-P (nucleus) sampling cutoff. |
| `params.seed` | `number` | no | `0` | RNG seed. `0` means "pick a fresh seed each call". |
| `params.stop` | `string \| string[]` | no | `[]` | OpenAI-style stop sequence(s). Matched string is trimmed from `text` and not emitted to `onToken`. |
| `params.repeatPenalty` | `number` | no | `1.1` | llama.cpp multiplicative penalty against tokens in the last `repeatLastN`. `1.0` disables. |
| `params.repeatLastN` | `number` | no | `64` | Window for `repeatPenalty` / `frequencyPenalty` / `presencePenalty`. `0` disables; `-1` means full context. |
| `params.frequencyPenalty` | `number` | no | `0.0` | OpenAI-style additive penalty proportional to recent frequency. |
| `params.presencePenalty` | `number` | no | `0.0` | OpenAI-style additive penalty for any prior occurrence. |
| `params.signal` | `AbortSignal` | no | — | Cancels the call. Rejects with [`AbortError`](./errors.md#aborterror). Distinct from [`engine.cancel()`](#enginecancel). |
| `params.onToken` | `(token: string) => void` | no | — | Streaming callback. Receives complete UTF-8 chunks only. |

### Returns

`Promise<GenerationResult>` — resolves with:

| Field | Type | Description |
|---|---|---|
| `text` | `string` | Full generated text with any matched `stop` trimmed. |
| `finishReason` | [`FinishReason`](./types.md#finishreason) | Why generation ended. |
| `usage` | [`TokenUsage`](./types.md#tokenusage) | Prompt/completion/total token counts. |
| `wallTimeMs` | `number` | Wall-clock time spent in the `generate()` call. |

**Cancel semantics:** if [`engine.cancel()`](#enginecancel) is called mid-flight, this Promise resolves with `finishReason: 'cancelled'` and partial `text`. It does **not** reject. For reject semantics, pass an `AbortSignal`.

### Throws

| Error | Condition | Recovery |
|---|---|---|
| [`E_ENGINE_DISPOSED`](./errors.md#e_engine_disposed) | Engine was disposed. | Load a new engine. |
| [`E_ENGINE_BUSY`](./errors.md#e_engine_busy) | Another `generate` / `stream` is in flight. | Await it, or call `engine.cancel()`. |
| [`AbortError`](./errors.md#aborterror) | `params.signal` aborted (sync or async). | Expected — re-throw or handle. |
| `E_NOT_IMPLEMENTED` (iOS) | iOS inference port not landed yet. | Use Android in the meantime. |

### Examples

**Basic:**

```ts
const result = await engine.generate('Write a haiku about coffee.', {
  maxTokens: 64,
  temperature: 0.7,
});
console.log(result.text);
console.log(`${result.finishReason}, ${result.usage.completionTokens} tokens`);
```

**With token streaming via callback:**

```ts
let buffer = '';
const result = await engine.generate('Tell me a story.', {
  maxTokens: 256,
  onToken: (tok) => {
    buffer += tok;
    updateUI(buffer);
  },
});
// result.text === buffer (modulo any trimmed stop sequence)
```

**With `AbortController`:**

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

try {
  await engine.generate(prompt, { signal: controller.signal });
} catch (e: any) {
  if (e.name === 'AbortError') {
    // 5-second timeout fired
  }
}
```

**With stop sequences:**

```ts
const result = await engine.generate(prompt, {
  stop: ['\nUser:', '\n\n'],
});
// If the model produced '...answer\nUser: ', `text` ends at '...answer' and
// finishReason is 'stop'.
```

### See also

- [`engine.stream`](#enginestreamprompt-params) — async iterator variant.
- [`engine.chat.completions.create`](./chat-completions.md) — OpenAI-shaped facade.
- [Streaming patterns](./streaming.md) — when to use which streaming surface.

---

## `engine.stream(prompt, params?)`

Streaming generation as an async iterable. Drop-in for OpenAI's `stream: true` callers.

### Signature

```ts
stream(
  prompt: string,
  params?: GenerationParams
): GenerationStream
```

Note: returns **synchronously** (no `Promise`). Native generation kicks off immediately; the iterator yields as tokens arrive.

### Parameters

Same as [`engine.generate`](#enginegenerateprompt-params) except `onToken` is ignored — the iterator IS the streaming surface.

### Returns

[`GenerationStream`](./types.md#generationstream) = `AsyncIterable<GenerationChunk> & { result: Promise<GenerationResult> }`.

| Surface | Type | Description |
|---|---|---|
| `for await (const chunk of stream)` | `{ delta: string }` | Yields one chunk per token. `delta` is the incremental text, never partial UTF-8. |
| `stream.result` | `Promise<GenerationResult>` | Resolves with the final result (matches `engine.generate` shape) after the loop ends. |

### Termination behavior

- **Loop completes naturally:** `stream.result` resolves with `finishReason: 'length'` or `'stop'`.
- **`break` out of the loop** (or call `iterator.return()`): SDK auto-invokes `engine.cancel()`. `stream.result` resolves with `finishReason: 'cancelled'` and partial `text`.
- **`signal` aborts:** parked `next()` calls and `stream.result` reject with [`AbortError`](./errors.md#aborterror).

### Throws

Same set as [`engine.generate`](#enginegenerateprompt-params). `E_ENGINE_BUSY` and `E_ENGINE_DISPOSED` throw synchronously from `stream()` itself. `AbortError` surfaces asynchronously via the iterator + `result` Promise.

### Examples

**Basic:**

```ts
const stream = engine.stream('Tell me a story.', { maxTokens: 256 });

for await (const chunk of stream) {
  process.stdout.write(chunk.delta);
}
const result = await stream.result;
console.log(`\nDone: ${result.finishReason}, ${result.usage.completionTokens} tokens`);
```

**Break to cancel:**

```ts
const stream = engine.stream(prompt);
let total = '';
for await (const chunk of stream) {
  total += chunk.delta;
  if (total.length > 500) break;     // auto-cancels native generation
}
const result = await stream.result;
// result.finishReason === 'cancelled', result.text === total (modulo final partial)
```

**With `AbortController`:**

```ts
const controller = new AbortController();
const stream = engine.stream(prompt, { signal: controller.signal });

try {
  for await (const chunk of stream) {
    if (Date.now() - startTime > 5000) controller.abort();
    appendToken(chunk.delta);
  }
  await stream.result;   // resolves normally if loop completes
} catch (e: any) {
  if (e.name === 'AbortError') {
    // either next() or stream.result rejected
  }
}
```

### See also

- [`engine.generate`](#enginegenerateprompt-params) — Promise-style with optional `onToken` callback.
- [`engine.chat.completions.create({ stream: true })`](./chat-completions.md) — OpenAI-shaped wrapper.
- [Streaming patterns](./streaming.md).

---

## `engine.chat`

Getter that returns the OpenAI-shaped facade. See [chat-completions.md](./chat-completions.md) for the full reference of `engine.chat.completions.create(params, options?)`.

```ts
const response = await engine.chat.completions.create({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hi.' },
  ],
});
console.log(response.choices[0].message.content);
```

---

## `engine.cancel()`

Cancels an in-flight generation. **Idempotent** — safe to call when nothing is in flight.

### Signature

```ts
cancel(): void
```

### Behavior

- If `generate()` is running, it resolves with `finishReason: 'cancelled'` and the partial `text` accumulated so far. It does **not** reject.
- If `stream()` is running, the iterator stops yielding, the underlying `Promise<GenerationResult>` resolves with `finishReason: 'cancelled'`, and so does `stream.result`.
- If no generation is running, this is a no-op.

For reject semantics on cancel, pass an `AbortSignal` instead — see [streaming.md](./streaming.md#cancel-vs-abortsignal).

### Throws

| Error | Condition |
|---|---|
| [`E_ENGINE_DISPOSED`](./errors.md#e_engine_disposed) | Engine was disposed. |

### Example

```ts
const promise = engine.generate(prompt);

// User taps a "Stop" button
stopButton.onPress = () => engine.cancel();

const result = await promise;
if (result.finishReason === 'cancelled') {
  console.log('Stopped at:', result.text);
}
```

---

## `engine.applyChatTemplate(messages, addAssistantHeader?)`

Renders a list of [`ChatMessage`](./types.md#chatmessage) into a prompt string using the model's `tokenizer.chat_template` GGUF metadata.

### Signature

```ts
applyChatTemplate(
  messages: ChatMessage[],
  addAssistantHeader?: boolean
): Promise<string>
```

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `messages` | [`ChatMessage[]`](./types.md#chatmessage) | yes | — | Conversation history. |
| `addAssistantHeader` | `boolean` | no | `true` | If true, ends the rendered prompt with the assistant header so the model knows to continue as the assistant. |

### Returns

`Promise<string>` — the rendered prompt, suitable for [`engine.generate`](#enginegenerateprompt-params) or [`engine.stream`](#enginestreamprompt-params).

### Throws

| Error | Condition | Recovery |
|---|---|---|
| [`E_ENGINE_DISPOSED`](./errors.md#e_engine_disposed) | Engine was disposed. | Load a new engine. |
| [`E_NOT_TEMPLATABLE`](./errors.md#e_not_templatable) | Model has no recognized chat template. | Render the prompt manually. |
| `E_NOT_IMPLEMENTED` (iOS) | iOS inference port pending. | Use Android. |

### Example

```ts
const prompt = await engine.applyChatTemplate([
  { role: 'system', content: 'You are a terse assistant.' },
  { role: 'user', content: 'What is 2+2?' },
]);
const result = await engine.generate(prompt);
console.log(result.text);
// Most consumers should prefer engine.chat.completions.create for this flow.
```

### See also

- [`engine.chat.completions.create`](./chat-completions.md) — wraps `applyChatTemplate` + `generate`/`stream`.

---

## `engine.modelInfo()`

Returns metadata about the loaded model.

### Signature

```ts
modelInfo(): Promise<ModelInfo>
```

### Returns

[`Promise<ModelInfo>`](./types.md#modelinfo).

### Throws

| Error | Condition |
|---|---|
| [`E_ENGINE_DISPOSED`](./errors.md#e_engine_disposed) | Engine was disposed. |
| `E_NOT_IMPLEMENTED` (iOS) | iOS inference port pending. |

### Example

```ts
const info = await engine.modelInfo();
console.log(`${info.architecture}, vocab=${info.nVocab}, trained_ctx=${info.nCtxTrain}`);
console.log(`${(info.modelSizeBytes / 1e9).toFixed(2)} GB`);
```

---

## `engine.dispose()`

Releases the native engine resources. **Idempotent** — calling twice is safe.

### Signature

```ts
dispose(): void
```

### Behavior

After `dispose()`:
- Every other method on this `Engine` instance rejects with [`E_ENGINE_DISPOSED`](./errors.md#e_engine_disposed).
- Native memory (KV cache, model weights for this engine) is freed. Other engines unaffected.
- Any in-flight generation completes naturally on the native side, but its Promise may reject with `E_ENGINE_DISPOSED` if it was using this instance to listen for tokens.

### Throws

Never — this is the one method that's safe to call on a disposed engine.

### Example

```ts
const engine = await Engine.load(config);
try {
  await engine.generate(prompt);
} finally {
  engine.dispose();
}
```

For React components, dispose on unmount:

```tsx
useEffect(() => {
  let engine: Engine | null = null;
  (async () => {
    engine = await Engine.load(config);
    setEngine(engine);
  })();
  return () => engine?.dispose();
}, []);
```

---

## See also

- [chat-completions.md](./chat-completions.md) — `engine.chat.completions.create` full reference.
- [streaming.md](./streaming.md) — when to use `onToken`, `stream()`, or the chat-completions stream.
- [models.md](./models.md) — explicit model download/cache management.
- [types.md](./types.md) — full type definitions.
- [errors.md](./errors.md) — every `E_*` code.
