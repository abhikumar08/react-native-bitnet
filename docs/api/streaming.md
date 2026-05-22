# Streaming patterns

The SDK exposes **three** streaming surfaces, all backed by the same native generation. Picking the right one is the difference between a clean call site and fighting with iterator lifecycle.

| Surface | Returns | When to use |
|---|---|---|
| [`engine.generate(prompt, { onToken })`](./engine.md#enginegenerateprompt-params) | `Promise<GenerationResult>` | You want a final result + side-effect callbacks for tokens. Simplest. |
| [`engine.stream(prompt, params)`](./engine.md#enginestreamprompt-params) | [`GenerationStream`](./types.md#generationstream) | You want `for await` semantics + access to the final `GenerationResult`. |
| [`engine.chat.completions.create({ messages, stream: true })`](./chat-completions.md) | [`ChatCompletionStream`](./types.md#chatcompletionstream) | You're consuming chat-formatted messages and want OpenAI-shaped chunks. |

All three:
- Yield UTF-8 complete chunks only (multibyte characters never split).
- Honor `engine.cancel()` and `AbortSignal`.
- Fall under the single-flight rule — only one generation can be in flight on a given engine at a time. Concurrent calls reject with [`E_ENGINE_BUSY`](./errors.md#e_engine_busy).

## Decision tree

- **Render tokens into a UI as they arrive, then show a final summary?** → `engine.generate({ onToken })`. One `await`, one Promise.
- **Pipe tokens into another async pipeline (websocket, SSE response, etc.)?** → `engine.stream()`. `for await` is the right abstraction.
- **Building an OpenAI-compatible chat surface (your own SDK or app)?** → `engine.chat.completions.create({ stream: true })`. Output is wire-compatible with OpenAI's streaming protocol.

## `engine.generate({ onToken })` — callback style

```ts
let buffer = '';
const result = await engine.generate('Tell me a story.', {
  maxTokens: 256,
  onToken: (tok) => {
    buffer += tok;
    setUIText(buffer);
  },
});

// result.text === buffer (modulo any trimmed stop sequence)
console.log(`Done: ${result.finishReason}, ${result.usage.completionTokens} tokens`);
```

- The callback fires on the JS thread.
- If `onToken` throws, the SDK swallows the throw (it's an event listener); the generation continues. Don't rely on `onToken` for control flow.
- The final `result.text` is the **authoritative** value — `buffer` from concatenating `onToken` chunks should match, but if you need certainty, use `result.text`.

## `engine.stream()` — async iterator with `.result`

```ts
const stream = engine.stream('Tell me a story.', { maxTokens: 256 });

for await (const chunk of stream) {
  process.stdout.write(chunk.delta);
}
const result = await stream.result;
console.log(`\n[${result.finishReason}, ${result.usage.completionTokens} tokens]`);
```

### Breaking out of the loop

Breaking (or calling `iterator.return()`) **auto-cancels** the native generation:

```ts
let total = '';
for await (const chunk of stream) {
  total += chunk.delta;
  if (total.length > 500) break;
}
// At this point: native cancellation has been requested.
const result = await stream.result;
// result.finishReason === 'cancelled'
```

This is a consumer-initiated cancel — distinct from a `signal.abort()` (which would reject `stream.result` with `AbortError`).

### Concurrent consumers

`engine.stream` returns an iterable, **not** a re-iterable. Multiple `for await` loops over the same stream share the same backing iterator; they will race for chunks. If you need multiple consumers, fan out from a single loop yourself.

## `engine.chat.completions.create({ stream: true })` — OpenAI-shaped

```ts
const stream = await engine.chat.completions.create({
  messages: [{ role: 'user', content: 'Hi.' }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0].delta.content ?? '';
  if (delta) process.stdout.write(delta);
  if (chunk.choices[0].finish_reason) {
    console.log(`\n[${chunk.choices[0].finish_reason}]`);
  }
}
```

Differences from `engine.stream`:

- No `.result` Promise — the final chunk carries `finish_reason` directly (matches OpenAI's wire protocol).
- First chunk carries `delta.role: 'assistant'`; middle chunks carry only `delta.content`; the final chunk has an empty delta.
- Wraps `applyChatTemplate` internally, so [`E_NOT_TEMPLATABLE`](./errors.md#e_not_templatable) can surface synchronously before any chunk is yielded.
- `'cancelled'` from the underlying engine collapses to `'stop'` (OpenAI has no cancel concept).

## Cancel vs AbortSignal

The SDK distinguishes **two cancellation paths**:

|  | `engine.cancel()` | `AbortSignal.abort()` |
|---|---|---|
| Promise behavior | **Resolves** with `finishReason: 'cancelled'` and partial `text`. | **Rejects** with [`AbortError`](./errors.md#aborterror). |
| Iterator behavior (`engine.stream`) | Loop ends naturally; `stream.result` resolves with `'cancelled'`. | `next()` and `stream.result` reject with `AbortError`. |
| Reason propagation | Not applicable. | If `controller.abort(error)` was called with an `Error`, the SDK propagates that exact instance (Web spec behavior). |
| When to use | "Stop and tell me what you got so far." | "Stop and treat this as a thrown error." |

Pick based on whether your downstream code wants partial-result success or a thrown rejection. Both are first-class.

### Example: timeout via AbortSignal

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);

try {
  const result = await engine.generate(prompt, { signal: controller.signal });
  console.log(result.text);
} catch (e: any) {
  if (e.name === 'AbortError') {
    console.log('Timed out');
  }
} finally {
  clearTimeout(timeout);
}
```

### Example: stop-button via `engine.cancel`

```ts
const promise = engine.generate(prompt);
stopButton.onPress = () => engine.cancel();

const result = await promise;
if (result.finishReason === 'cancelled') {
  showPartial(result.text);   // user wanted what we have so far
}
```

## Single-flight invariant

Each `Engine` instance allows **one** generation at a time. Calling `generate` / `stream` / `chat.completions.create` while another is in flight throws [`E_ENGINE_BUSY`](./errors.md#e_engine_busy) synchronously — no Promise round-trip.

This is structural: the underlying `llama.cpp` context's KV cache cannot be shared across concurrent decodes. Two simultaneous calls would race on shared state.

If you need parallel generations, load multiple `Engine` instances:

```ts
const [a, b] = await Promise.all([
  Engine.load(config),
  Engine.load(config),
]);
const [resA, resB] = await Promise.all([
  a.generate(promptA),
  b.generate(promptB),
]);
```

(Note: each `Engine.load` allocates KV-cache memory. Two engines = 2× the memory of one. Don't load more than the device can hold.)

## Token routing internals (informational)

Tokens are emitted via React Native's event system on the `BitnetToken` channel, payload shape `{ handle, requestId, token }`. The SDK filters by **both** `handle` (to route between engines) and `requestId` (to route between concurrent calls on the same engine — though only one is in flight per engine, `requestId` defends against a just-cancelled call's residual tokens leaking into a new subscription).

Most consumers don't touch this layer; the higher-level surfaces in this page handle the filtering. See [events.md](./events.md) for the raw event shape if you need to subscribe directly (e.g. for telemetry).

## See also

- [engine.md](./engine.md) — full reference for `generate`, `stream`, `cancel`, `dispose`.
- [chat-completions.md](./chat-completions.md) — full reference for the OpenAI-shaped facade.
- [errors.md](./errors.md) — `E_ENGINE_BUSY`, `E_ENGINE_DISPOSED`, `AbortError`.
- [events.md](./events.md) — raw event payloads.
