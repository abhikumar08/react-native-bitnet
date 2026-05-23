# Streaming sequence: end-to-end chat turn

This document traces one chat turn through every layer of `react-native-bitnet`, from the user tapping "send" to the streamed tokens appearing in the UI. It complements [`architecture.md`](./architecture.md): that document is the static stack, this one is the dynamic story.

![Streaming sequence diagram](./diagrams/sequence-streaming.svg)

There are three phases. The first is pre-call setup: validating the abort signal, wiring up listeners, and acquiring the single-flight gate. The second is the streaming loop where the engine generates and tokens bubble back up. The third is completion, which forks into three outcomes — natural end, explicit cancel, or aborted signal.

## Phase 1 — pre-call setup

Before any native code runs, the TS layer does three things, in order.

**Synchronous abort fast-path.** If the caller passed `{ signal }` and the signal is already aborted at the call site, `Engine.stream()` throws an `AbortError` synchronously without crossing into native code. This matches the Web `AbortController` contract: an already-aborted signal should never cause work to start.

**Listener wiring.** The TS layer attaches a `BitnetToken` listener to React Native's `NativeEventEmitter` *before* the native call returns, and registers `signal.addEventListener('abort', ...)` for the in-flight abort case. Wiring before the downcall guarantees no token can fire before there's a listener for it.

**Single-flight gate.** The TS layer calls `NativeBitnet.generate(handle, requestId, params)`. Kotlin's `BitnetModule.generate` converts the handle to `Long` and checks a `ConcurrentHashMap<Long, Boolean>` keyed by engine handle. If the gate is already held (another call is in flight on the same engine), the Promise rejects with `E_ENGINE_BUSY` and no worker thread is spawned. Otherwise, the gate is acquired, a worker thread is spawned, and the JNI call proceeds. The `requestId` is the second positional argument because every `BitnetToken` event carries it back, which is how the JS layer demultiplexes concurrent generations on different engine handles.

> **Aside: applyChatTemplate.** This diagram starts at `stream(prompt, ...)` — the prompt is already a single string. If the caller is working with structured chat messages, they typically call `engine.applyChatTemplate(messages)` first to render the messages through the model's chat template (BitNet uses Llama 3's). That call is a separate synchronous downcall through every layer and returns the templated prompt; it isn't pictured here but the path mirrors Phase 1's downcall structure end-to-end.

## Phase 2 — generate (the streaming loop)

With the gate held and the listener wired, the JNI bridge calls `BitnetEngine::generate`, passing in a C++ lambda as the token callback. The engine starts its decode loop on the worker thread Kotlin spawned in Phase 1, so the React Native module thread is never blocked.

Inside the dashed `loop` box on the right of the diagram, one iteration looks like this:

1. `BitnetEngine` calls `llama_decode` to advance the model state by one token, then samples the next token using the configured `temperature` / `top_k` / `top_p` / `seed`.
2. The token id is converted to a UTF-8 piece via `llama_token_to_piece`.
3. The engine invokes the C++ callback that was passed in, with the piece string and the `requestId` it was given.
4. The callback (constructed in `bitnet_jni.cpp`) calls `emitToken(env, handle, requestId, piece)` — which uses `env->NewString` (not `NewStringUTF`, so 4-byte UTF-8 like emoji survives intact) and `env->CallVoidMethod` to invoke the corresponding Kotlin method on the module instance.
5. Kotlin's `emitToken` builds a `WritableMap` containing `{ handle, requestId, token }` and dispatches it through `DeviceEventEmitter` (specifically, `RCTDeviceEventEmitter.emit("BitnetToken", payload)`).
6. The event crosses back into JS, where `NativeEventEmitter` delivers it to the listener registered in Phase 1.
7. The listener filters the event by `event.handle === this.handle && event.requestId === this.requestId` — this is what stops concurrent engines or sequential calls on the same engine from cross-talking. Only matching events fire the consumer's `onToken(delta)` or yield the next chunk to the async iterator.

This loop runs once per token. On the Pixel 10 emulator, that's roughly once every two seconds; on a real DOTPROD-capable phone, expect 5–15 tokens per second. The decode itself dominates the wall-clock time. The full callback walk-up takes tens of microseconds and is irrelevant to user-visible latency.

The crucial design property visible in this phase: **the downcall and the upcall use different mechanisms**. Method calls go down as Promises (request/response). Token events come up as `DeviceEventEmitter` events (pub/sub). This asymmetry is the whole point. A Promise can only resolve once, so it cannot deliver N tokens. An event stream has no built-in mechanism for "request started" or "request finished", so it can't model a method call. Using both, each in the direction it's good at, is what `ADR-003` defends.

## Phase 3 — Completion (three outcomes)

The decode loop exits for one of three reasons, drawn as three labelled boxes at the bottom of the diagram. In every case, the TS layer's `.finally()` handler removes the `BitnetToken` listener registered in Phase 1 and releases the single-flight gate. Without listener removal, a second `generate()` call would fire its events into both the new listener *and* the old one, causing every token to appear in the UI twice.

### Outcome A — natural EOS

The model emits its end-of-sequence token, matches a configured `stop` sequence, or hits the `max_tokens` cap. The engine fills in a `GenerationResult` — the accumulated text, a `finish_reason`, the prompt-token count, the completion-token count, and the wall-clock time — and returns it to JNI. JNI serializes that struct to JSON; Kotlin parses it, builds a nested `WritableMap` (with a `usage` sub-map for OpenAI parity), and resolves the deferred Promise. The TS layer's `await` unblocks with a `GenerationResult` of shape `{ text, finishReason: 'length' | 'stop', usage: { promptTokens, completionTokens, totalTokens }, wallTimeMs }`. Tokens-per-second is not part of the result struct itself; it's a one-line JS-side derivation (`usage.completionTokens / (wallTimeMs / 1000)`) when callers want it.

### Outcome B — `engine.cancel()` resolves with partial text

The consumer calls `engine.cancel()` (or, equivalently, breaks out of the `for await` loop on a `stream()` — the cleanup path calls `NativeBitnet.cancelGeneration(handle)` directly for them). The TS layer dispatches `NativeBitnet.cancelGeneration`, which flips an `std::atomic<bool>` in the JNI `EngineRegistry`. The decode loop checks this flag once per iteration and returns early. The `GenerationResult` Promise still **resolves** (does not reject) with `finishReason: 'cancelled'` and `text` containing whatever was generated before the cancel. Treating cancellation as a successful resolution rather than a rejection is intentional: the partial text is typically still useful (it's what the user saw on screen) and `try/catch` should not be the cancel idiom.

### Outcome C — `AbortSignal` rejects with `AbortError`

If the caller passed `{ signal }` and the signal fires mid-stream, the abort listener registered in Phase 1 calls `NativeBitnet.cancelGeneration(handle)` directly (so the decode loop stops) and then rejects the Promise with an `AbortError`. For `stream()` consumers, the async iterator throws on the next `for await` step. This matches the Web `AbortController` contract — abort is an error, not a graceful exit — and is the inverse of Outcome B's "resolve with partial text" choice.

The Chat UI's `await engine.generate(...)` finally returns (or throws, for Outcome C). It typically uses this moment to switch the typing indicator off, persist the message, and enable the input field for the next turn.

## What this diagram glosses over

A few details that are present in the code but not in the diagram:

- **Backpressure.** None. The C++ callback fires synchronously on the worker thread, blocking it until the JNI call completes. The JS event loop is not consulted. On the rare devices where token generation could outpace the JS event loop's ability to process them, tokens queue up in the bridge.
- **Threading on the JNI side.** `emitToken` uses `env->CallVoidMethod`, which requires the calling thread to be attached to the JVM. Since the callback fires on the worker thread that Kotlin spawned (and which Kotlin attached to the JVM before crossing the JNI boundary), the env pointer is valid. A different threading scheme — say, the engine spawning its own thread — would need explicit `AttachCurrentThread` / `DetachCurrentThread` calls.

## Related documents

- [`architecture.md`](./architecture.md) — the static layer stack this diagram animates.
- [`sequence-model-lifecycle.md`](./sequence-model-lifecycle.md) — companion sequence for the download / cache / resume path.
- [`adr/003-streaming-api.md`](./adr/003-streaming-api.md) — why the streaming API has this exact shape, and what JSI would change.
- [`known-issues.md`](./known-issues.md) — current limitations including the `@@@@@@` divergence (compute-level, not bridge-level).
