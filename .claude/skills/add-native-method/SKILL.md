---
name: add-native-method
description: Add a new JS-facing method to the Bitnet TurboModule. Walks the Spec → codegen → Kotlin → JNI → C++ → JS facade order so the codegen contract is never broken. Trigger when the user asks to "add a method", "expose X to JS", or extend the Bitnet native API.
---

# Adding a new native method to the Bitnet TurboModule

This module is codegen-driven (`package.json::codegenConfig` → `BitnetSpec`/`NativeBitnetSpec`). Editing Kotlin or Obj-C++ before the TS Spec produces a class that no longer extends the regenerated base — the build will fail or, worse, silently shadow the spec. **Always start at the Spec.**

## The contract

The single source of truth is `src/NativeBitnet.ts`. Everything else is derived:

```
src/NativeBitnet.ts (Spec interface)
        │
        ▼ yarn prepare → codegen
NativeBitnetSpec (Kotlin)      BitnetSpec (Obj-C++)
        │                              │
extended by                     extended by
        ▼                              ▼
android/.../BitnetModule.kt    ios/Bitnet.mm
        │                              │
calls JNI external fun         calls C++ engine directly
        ▼
android/src/main/cpp/bitnet_jni.cpp
        │
        ▼
android/src/main/cpp/bitnet_engine.cpp (platform-agnostic)
        │
        ▼ exposed via
src/index.tsx (Engine class — public JS API)
```

## Steps (in order — do not reorder)

### 1. Define the method in the Spec

Edit [src/NativeBitnet.ts](../../../src/NativeBitnet.ts). Constraints:

- **Numbers only** at the boundary — handles are `number` (Double on the native side). No `bigint`, no string-encoded numbers.
- **Arrays / object arrays:** stringify on the JS side and pass `string` (JSON). Codegen support for arrays-of-objects is flaky on the RN version this repo pins. Mirror the pattern from `applyChatTemplate(rolesJson)` / `generate(stopSequencesJson)`.
- **String literal unions in return types:** type as `string`, narrow in the JS facade. See `finishReason` on `generate`.
- **Promises** for anything that can fail or take >1ms. `void` only for fire-and-forget (`cancelGeneration`, `disposeEngine`).
- **Engine handle** must be the first arg for any per-engine method.

### 2. Regenerate the spec bases

```sh
yarn prepare
```

This runs `bob build` and triggers codegen. If it fails, the Spec is broken — fix it before touching anything else.

Confirm the generated Kotlin base updated:
```sh
grep -A2 "abstract fun yourNewMethod" android/build/generated/source/codegen/java/com/bitnet/NativeBitnetSpec.kt
```

### 3. Implement in Kotlin

Edit [android/src/main/java/com/bitnet/BitnetModule.kt](../../../android/src/main/java/com/bitnet/BitnetModule.kt):

1. Add a `private external fun nativeYourMethod(...)` declaration. JNI types: `Long` for handles, `String`, `Int`/`Float`/`Boolean`. **Convert `Double` from the spec to `Long`/`Int`/`Float` at the boundary** — TurboModule numerics arrive as `Double`.
2. Add the `override fun` matching the codegen base signature (`Double` for numbers, `Promise` last).
3. Inside the override: validate, dispatch to a background `Thread { ... }.start()` if the work is non-trivial (anything calling into llama.cpp), and `promise.resolve(...)`/`promise.reject("E_CODE", "msg")`.
4. If the method runs on an engine handle: gate it through `EngineRegistry` validity — a disposed handle must reject with `E_ENGINE_DISPOSED` (see existing methods). Concurrent-call safety: if it touches the llama_context (KV cache), use the `busyHandles` map pattern from `generate()`.

### 4. Implement the JNI bridge

Edit [android/src/main/cpp/bitnet_jni.cpp](../../../android/src/main/cpp/bitnet_jni.cpp):

```cpp
extern "C" JNIEXPORT jstring JNICALL
Java_com_bitnet_BitnetModule_nativeYourMethod(JNIEnv *env, jobject thiz, jlong handle, ...) {
  auto *engine = EngineRegistry::instance().get(handle);
  if (!engine) return env->NewStringUTF("");  // or throw — match neighbors
  // ... call engine->yourMethod(...)
}
```

**Critical:**
- `JNIEXPORT` + `extern "C"` are both required. Default visibility is enforced by CMake (`CXX_VISIBILITY_PRESET default`) but the attributes still matter for name mangling.
- The JNI symbol name must be `Java_<package>_<class>_<method>` with `_` for dots and `_1` for literal underscores in the Java identifier.
- Resolve the engine through `EngineRegistry`, **not** by `reinterpret_cast<BitnetEngine*>(handle)`. The registry guards against use-after-dispose.
- For outbound strings with arbitrary UTF-8: use `env->NewString` over UTF-16, not `NewStringUTF` (see commit `fb77b0a` — JNI's "modified UTF-8" corrupts non-BMP code points).

### 5. Implement in the C++ engine (if needed)

If the method is engine work (not just plumbing), edit [bitnet_engine.h](../../../android/src/main/cpp/bitnet_engine.h) and [bitnet_engine.cpp](../../../android/src/main/cpp/bitnet_engine.cpp).

Keep the engine **platform-agnostic** — no JNI/JSI types, no Android logging APIs in headers. This file is reused unchanged for the iOS port (see [port-ios](../port-ios/SKILL.md)).

### 6. Stub on iOS

Edit [ios/Bitnet.mm](../../../ios/Bitnet.mm). For now (engine port pending), reject with `E_NOT_IMPLEMENTED` matching the existing stub pattern. The Obj-C++ signature comes from the regenerated `BitnetSpec.h`:

```sh
find ios/build -name "BitnetSpec.h" -exec grep -A4 yourMethod {} \;
```

### 7. Expose through the JS facade

Edit [src/index.tsx](../../../src/index.tsx). Add a method on the `Engine` class:

- Check `this.handle === null` → throw `makeEngineDisposedError()`.
- Narrow any `string` returns from the Spec back to their proper TS unions.
- For methods that emit events (like `generate`), filter by `event.handle === this.handle && event.requestId === <thisCallsRequestId>` so concurrent engines and just-cancelled calls don't cross-talk.

### 8. Verify

```sh
yarn typecheck && yarn lint
yarn example android   # the only way to confirm JNI symbol resolution
```

Then run [verify-streaming](../verify-streaming/SKILL.md) if the method touches the generate path, or just exercise it from the example app.

## Common failures

| Symptom | Cause |
|---|---|
| `UnsatisfiedLinkError: No implementation found for native ...` | Missing `JNIEXPORT`/`extern "C"`, mangled symbol name mismatch, or `abiFilters` excluded the build target. Run [debug-jni-symbols](../debug-jni-symbols/SKILL.md). |
| `BitnetModule.kt: class is not abstract and does not implement ...` | Spec changed, codegen ran, Kotlin override signature is stale. Re-run `yarn prepare` and update the override to match the new base. |
| Codegen doesn't regenerate | `yarn clean && yarn prepare` forces a fresh codegen pass. |
| String returns garbled for emoji / non-Latin | Used `NewStringUTF` instead of `NewString`. See commit `fb77b0a`. |
