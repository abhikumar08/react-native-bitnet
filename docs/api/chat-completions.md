# Engine.chat.completions.create

OpenAI-shaped facade over [`engine.applyChatTemplate`](./engine.md#engineapplychattemplatemessages-addassistantheader) + [`engine.generate`](./engine.md#enginegenerateprompt-params) / [`engine.stream`](./engine.md#enginestreamprompt-params). Pure JS-layer adapter — no separate native call.

The method exists on every loaded `Engine` and is designed for **migration from the OpenAI Node SDK**: copy your existing call site verbatim, only the parameter casing differs (camelCase here vs snake_case there) and `engine.` replaces `openai.`.

```ts
const r = await engine.chat.completions.create({
  messages: [{ role: 'user', content: 'Hi.' }],
});
console.log(r.choices[0].message.content);
```

## Signature

Two overloads selected at the type level by `stream`:

```ts
// Non-streaming
chat.completions.create(
  params: ChatCompletionCreateParams & { stream?: false },
  options?: ChatCompletionRequestOptions
): Promise<ChatCompletion>

// Streaming
chat.completions.create(
  params: ChatCompletionCreateParams & { stream: true },
  options?: ChatCompletionRequestOptions
): Promise<ChatCompletionStream>
```

## Parameters

### `params` — [`ChatCompletionCreateParams`](./types.md#chatcompletioncreateparams)

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `messages` | [`ChatMessage[]`](./types.md#chatmessage) | yes | — | Conversation history. Roles: `'system'`, `'user'`, `'assistant'`. |
| `stream` | `boolean` | no | `false` | Selects the return-type overload. |
| `maxTokens` | `number` | no | `256` | Cap on generated tokens. |
| `temperature` | `number` | no | `0.8` | Sampling temperature. |
| `topK` | `number` | no | `40` | Top-K cutoff. |
| `topP` | `number` | no | `0.95` | Top-P cutoff. |
| `seed` | `number` | no | `0` | RNG seed. `0` = fresh. |
| `stop` | `string \| string[]` | no | `[]` | Stop sequences. |
| `repeatPenalty` | `number` | no | `1.1` | llama.cpp multiplicative penalty. |
| `repeatLastN` | `number` | no | `64` | Penalty window. |
| `frequencyPenalty` | `number` | no | `0.0` | OpenAI additive frequency penalty. |
| `presencePenalty` | `number` | no | `0.0` | OpenAI additive presence penalty. |

> Note: parameter names match this SDK's camelCase convention (`maxTokens`, `frequencyPenalty`), in contrast with OpenAI's wire-format snake_case (`max_tokens`, `frequency_penalty`). The **return** values match OpenAI's snake_case for drop-in destructuring.

### `options` — [`ChatCompletionRequestOptions`](./types.md#chatcompletionrequestoptions)

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `signal` | `AbortSignal` | no | — | Aborts the call. Rejects with [`AbortError`](./errors.md#aborterror). |

Matches the OpenAI Node SDK's second-arg shape so migrated call sites don't have to relocate their `AbortController` wiring.

## Returns

### Non-streaming — [`ChatCompletion`](./types.md#chatcompletion)

```ts
{
  id: 'chatcmpl-xxxxxx',          // synthetic, for log correlation
  object: 'chat.completion',
  created: 1716489600,             // epoch seconds
  model: 'llama',                  // from engine.modelInfo().architecture
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',       // 'stop' | 'length' | null
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
  },
}
```

Always exactly one choice (`choices.length === 1`) — the SDK doesn't support `n > 1`.

### Streaming — [`ChatCompletionStream`](./types.md#chatcompletionstream) = `AsyncIterable<ChatCompletionChunk>`

Yields one [`ChatCompletionChunk`](./types.md#chatcompletionchunk) per token, plus a final terminator chunk:

```ts
// First chunk — carries delta.role
{
  id, object: 'chat.completion.chunk', created, model,
  choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
}

// Middle chunks — content only
{ ..., choices: [{ index: 0, delta: { content: '!' }, finish_reason: null }] }

// Final chunk — empty delta with finish_reason
{ ..., choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
```

Unlike [`engine.stream`](./engine.md#enginestreamprompt-params), the streaming chat completion has no `.result` Promise — the `finish_reason` is on the last chunk.

## Throws

| Error | Condition | Recovery |
|---|---|---|
| [`E_ENGINE_DISPOSED`](./errors.md#e_engine_disposed) | Engine was disposed. | Load a new engine. |
| [`E_ENGINE_BUSY`](./errors.md#e_engine_busy) | Another generate/stream is in flight. | Await it or `engine.cancel()`. |
| [`E_NOT_TEMPLATABLE`](./errors.md#e_not_templatable) | Model has no recognized chat template. | Render manually + use `engine.generate`. |
| [`AbortError`](./errors.md#aborterror) | `options.signal` aborted. | Expected — handle. |
| `E_NOT_IMPLEMENTED` (iOS) | iOS inference port pending. | Use Android. |

For streaming, `AbortError` surfaces through both the iterator's `next()` and any cleanup path.

## Caveats

- **`'cancelled'` collapses to `'stop'`.** If [`engine.cancel()`](./engine.md#enginecancel) is called mid-stream, the facade reports `finish_reason: 'stop'` to match OpenAI's wire format (OpenAI has no notion of user-initiated cancel). Callers who need to distinguish cancellation should use the lower-level [`engine.generate`](./engine.md#enginegenerateprompt-params) / [`engine.stream`](./engine.md#enginestreamprompt-params).
- **Synthetic `id`, `created`, `model`.** The `id` is a random `chatcmpl-…` string for log correlation, not a server-side identifier. `created` is the JS-side epoch. `model` is the architecture string from `engine.modelInfo()`, not a specific HuggingFace ref.
- **Template required.** The model must ship a `tokenizer.chat_template` GGUF metadata field that llama.cpp recognizes (chatml, llama2, llama3, mistral, gemma, qwen, etc.). Models without one throw [`E_NOT_TEMPLATABLE`](./errors.md#e_not_templatable).

## Examples

### Non-streaming — minimal

```ts
import { Engine } from 'react-native-bitnet';

const engine = await Engine.load({
  modelRef: 'hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf',
});

const response = await engine.chat.completions.create({
  messages: [
    { role: 'system', content: 'You are a terse assistant.' },
    { role: 'user', content: 'What is 2+2?' },
  ],
  maxTokens: 32,
});

console.log(response.choices[0].message.content);
console.log(`Tokens: ${response.usage.total_tokens}`);
```

### Streaming

```ts
const stream = await engine.chat.completions.create({
  messages: [{ role: 'user', content: 'Write a haiku about coffee.' }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0].delta.content ?? '';
  process.stdout.write(delta);
  if (chunk.choices[0].finish_reason) {
    console.log(`\n[done: ${chunk.choices[0].finish_reason}]`);
  }
}
```

### With AbortController

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

try {
  const response = await engine.chat.completions.create(
    { messages: [{ role: 'user', content: 'Explain quantum tunneling.' }] },
    { signal: controller.signal }
  );
  console.log(response.choices[0].message.content);
} catch (e: any) {
  if (e.name === 'AbortError') {
    console.log('Timed out after 5s');
  }
}
```

### Streaming + AbortController

```ts
const controller = new AbortController();
const stream = await engine.chat.completions.create(
  { messages, stream: true },
  { signal: controller.signal }
);

try {
  for await (const chunk of stream) {
    if (userClickedStop) controller.abort();
    appendToken(chunk.choices[0].delta.content ?? '');
  }
} catch (e: any) {
  if (e.name === 'AbortError') {
    showStoppedState();
  } else {
    throw e;
  }
}
```

### Migrating from `openai`

```ts
// Before
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: '…' });
const r = await openai.chat.completions.create({
  model: 'gpt-4',
  messages,
  max_tokens: 256,      // snake_case
});

// After
import { Engine } from 'react-native-bitnet';
const engine = await Engine.load({ modelRef: 'hf://owner/repo/file.gguf' });
const r = await engine.chat.completions.create({
  // no `model` field — the loaded engine is the model
  messages,
  maxTokens: 256,       // camelCase
});

// r.choices[0].message.content is identical shape
// r.usage.{prompt|completion|total}_tokens is identical shape
```

## See also

- [`engine.generate`](./engine.md#enginegenerateprompt-params) — lower-level, distinguishes cancel from abort.
- [`engine.stream`](./engine.md#enginestreamprompt-params) — lower-level streaming with `.result`.
- [`engine.applyChatTemplate`](./engine.md#engineapplychattemplatemessages-addassistantheader) — render messages manually.
- [streaming.md](./streaming.md) — choosing between streaming surfaces.
- [types.md](./types.md) — `ChatCompletion*` type definitions.
