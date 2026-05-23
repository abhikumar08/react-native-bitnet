# ADR-002 — `BitnetEngine` design: handle registry, pimpl, single-threaded, atomic cancellation

> **Status:** Accepted. **Date:** 2026-04 (approx).
> **Stub note:** This document records the core design rationale referenced from [android/src/main/cpp/bitnet_engine.cpp:4](../../android/src/main/cpp/bitnet_engine.cpp#L4). The full design exploration (discarded alternatives, profiling data) was discussed verbally; this is the canonical record going forward.

## Context

The C++ inference engine sits between the JNI bridge above and `llama.cpp` below. Three forces shape its design:

1. **Cross-runtime safety.** JS holds a reference to a loaded model. That reference must survive multiple async operations, must not be a raw C++ pointer (which JS could leak, double-free, or use-after-free), and must be cheap to round-trip across the bridge.
2. **Portability.** The same C++ class needs to compile and run on Android (JNI), iOS (Obj-C++), and macOS (standalone test harness) without ifdef sprawl.
3. **Cancellation.** A streaming generation can take seconds to minutes. The consumer must be able to interrupt it from any thread without races or torn state.

## Decision

**Handle-based registry, not raw pointers.** Engines are owned by an `EngineRegistry` singleton ([bitnet_jni.cpp:33-60](../../android/src/main/cpp/bitnet_jni.cpp#L33-L60)) that maps `jlong` handle → `std::unique_ptr<BitnetEngine>`. JS sees a numeric handle; the registry is the only thing holding the actual instance. `dispose()` removes the entry, which destroys the `unique_ptr` and runs the destructor. A stale handle from JS resolves to `nullptr` instead of dereferencing freed memory.

**Pimpl idiom.** The public [bitnet_engine.h](../../android/src/main/cpp/bitnet_engine.h) exposes a thin facade; all `llama.cpp` headers and state live in [bitnet_engine.cpp](../../android/src/main/cpp/bitnet_engine.cpp). Consumers of the header (`bitnet_jni.cpp`, future iOS `Bitnet.mm`) don't pull `llama.h` transitively, which keeps compile times sane and means a llama.cpp ABI change doesn't ripple into the JNI layer.

**No JNI / Kotlin / RN types in the engine.** The engine takes `std::string` and returns `std::string`. The token callback is `std::function<CallbackResult(const std::string&)>`. The engine compiles standalone on macOS for testing — no Android dependencies leak through.

**Single-threaded per instance.** `generate()` is not safe to call concurrently on the same `BitnetEngine`. The single-flight gate at the Kotlin layer ([BitnetModule.kt:111-118](../../android/src/main/java/com/bitnet/BitnetModule.kt#L111-L118)) enforces this and rejects concurrent calls with `E_ENGINE_BUSY`. Two engines (two handles) can run concurrently — the constraint is per-instance.

**Atomic cancellation, callable from any thread.** `cancel()` flips a `std::atomic<bool>` on the engine. The decode loop checks the flag once per iteration and returns early with `finishReason: 'cancelled'`. The generation Promise resolves (not rejects) with the partial text — see [ADR-003](./003-streaming-api.md) for why "resolves with partial" beats "rejects on cancel".

## Consequences

**Accepted.**

- **Safe handles, slightly indirect access.** Every JNI call does a map lookup on the registry. The cost is one mutex acquisition per call — negligible compared to a single `llama_decode` step (~10–100ms).
- **Engine has no idea it's in React Native.** The iOS port can reuse `bitnet_engine.{h,cpp}` unchanged.
- **One generation per engine at a time.** Apps wanting parallel inference must load the model into two engines. This is explicit (two `Engine.load(...)` calls) rather than silent contention.
- **`cancel()` is non-blocking.** It returns immediately; the generation Promise resolves a few hundred milliseconds later when the next decode iteration checks the flag.

## Alternatives considered

1. **Raw pointer handles (`reinterpret_cast<jlong>(engine)`).** Rejected — a leaked or double-freed handle from JS would be a use-after-free on the native side, which would crash the process. The registry-with-lookup approach makes stale handles safe.
2. **Inherit from a JNI base class in the engine.** Rejected — kills portability; iOS port would need to mock the JNI types or fork the engine.
3. **Concurrent `generate()` on one instance with internal locking.** Rejected — `llama.cpp`'s context is not designed for it, and the locking would either serialize the calls (no benefit) or require deep refactoring of the decode loop.
4. **`cancel()` blocks until generation actually stops.** Rejected — the caller would deadlock if they called it from the same thread that's awaiting the generation Promise.

## References

- [bitnet_engine.cpp:4](../../android/src/main/cpp/bitnet_engine.cpp#L4) — comment pointing here.
- [bitnet_engine.h](../../android/src/main/cpp/bitnet_engine.h) — the pimpl facade.
- [bitnet_jni.cpp:33-60](../../android/src/main/cpp/bitnet_jni.cpp#L33-L60) — `EngineRegistry`.
- [BitnetModule.kt:111-118](../../android/src/main/java/com/bitnet/BitnetModule.kt#L111-L118) — single-flight gate.
- [ADR-003](./003-streaming-api.md) — cancellation as resolve-with-partial.
