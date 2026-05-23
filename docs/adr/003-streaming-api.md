# ADR-003 — Streaming API: TurboModule + JNI, promises down, events up

> **Status:** Accepted. **Date:** 2026-04 (approx).
> **Stub note:** This document records the streaming-API shape referenced from [sequence-streaming.md](../sequence-streaming.md). The JSI-vs-TurboModule design exploration was discussed verbally; this is the canonical record.

## Context

A streaming inference call has fundamentally asymmetric shape: one request goes down (the prompt + parameters), N events come up (the tokens, one per decode iteration), one response comes back at the end (the final `GenerationResult`). React Native offers two transport mechanisms across the JS/JVM boundary, neither of which models this directly:

- **TurboModule methods** are Promise-shaped: one call goes down, one Promise resolves up. Cannot deliver N intermediate values.
- **`DeviceEventEmitter` events** are pub/sub: many can fire, but there's no built-in notion of "this request started" or "this request finished."

A third option, **C++ TurboModule with JSI**, would let the native side hold a JS function reference and call it directly per token. JSI is faster (no bridge serialization) and lets the call shape be "function with callback" instead of split-request/event.

## Decision

**TurboModule + JNI, with method calls going down as Promises and tokens coming up as `DeviceEventEmitter` events.** Specifically:

- `generate(handle, requestId, params)` is the TurboModule spec method (`src/NativeBitnet.ts`) that returns `Promise<GenerationResult>`. It resolves once (at EOS, cancel, or abort). (`nativeGenerate` is the separate `private external` JNI entry point in `BitnetModule.kt`.)
- Tokens fire as `BitnetToken` events carrying `{ handle, requestId, token }` ([BitnetModule.kt:65-68](../../android/src/main/java/com/bitnet/BitnetModule.kt#L65-L68)). The JS layer demultiplexes by handle + requestId.
- `engine.cancel()` resolves the Promise with `finishReason: 'cancelled'` and partial text. It does **not** reject — partial text is typically still useful (the user already saw it on screen) and `try/catch` shouldn't be the cancel idiom.
- `AbortSignal` mid-stream rejects with `AbortError`, matching the Web contract.

## Consequences

**Accepted.**

- **Each transport in the direction it's good at.** The Promise carries the "started → done" lifecycle. The event stream carries the "here is the next token" payloads. Neither is shoehorned.
- **Plain RN, no JSI bootstrap.** Works on any RN version with TurboModules. No `installer.cpp` needed, no JSI runtime pointer captured at boot, no constraints on Hermes vs JSC.
- **Easy concurrency story.** Two engines (two handles) running concurrently emit on the same event channel; the JS layer filters by `event.handle === this.handle && event.requestId === this.requestId`.
- **Cost: extra bridge hop per token.** Every token serializes through the bridge as a `WritableMap`. Negligible at 5–15 tok/s (tens of microseconds vs hundreds of milliseconds for the decode). Would start mattering at 100+ tok/s, which BitNet isn't doing on mobile arm64.
- **Cost: cleanup is the listener's responsibility.** The TS `.finally()` handler must remove the `BitnetToken` listener and release the single-flight gate. Forgetting either is the classic "tokens appear twice in the UI" bug.

## Alternatives considered

1. **C++ TurboModule with JSI callback per token.** Rejected for now — needs custom installer wiring, doesn't compose cleanly with `AbortSignal`, and the per-token cost it saves doesn't show up at our throughput. Re-evaluate if a future model pushes throughput above ~50 tok/s on-device.
2. **`generate()` returns an `AsyncIterable` directly, no Promise.** Rejected — the OpenAI-shaped `chat.completions.create({ stream: true })` facade expects a Promise that resolves to a stream; making the primitive an iterable forces extra wrapping. The current `stream()` *does* return an iterable, and is built on top of the Promise-shaped `generate()`.
3. **Single `BitnetTokenStream` channel without `requestId`.** Rejected — two concurrent engines on different handles would cross-talk silently. `requestId` is the per-call disambiguator on top of the per-engine `handle`.
4. **Reject on cancel, not resolve.** Rejected — partial text is useful and the consumer would need a `try/catch` just to do the normal thing. See [ADR-002](./002-engine-design.md) "atomic cancellation".

## References

- [src/index.tsx](../../src/index.tsx) — `Engine.generate` / `Engine.stream` implementation, AbortSignal wiring.
- [src/NativeBitnet.ts](../../src/NativeBitnet.ts) — TurboModule spec, `generate(handle, requestId, ...)`.
- [BitnetModule.kt](../../android/src/main/java/com/bitnet/BitnetModule.kt) — single-flight gate, `emitToken` payload shape, worker-thread spawn.
- [bitnet_jni.cpp](../../android/src/main/cpp/bitnet_jni.cpp) — JNI callback bridge.
- [sequence-streaming.md](../sequence-streaming.md) — end-to-end walk-through of one chat turn.
- [ADR-002](./002-engine-design.md) — engine-side cancellation semantics.
