---
name: verify-streaming
description: End-to-end smoke test that token streaming works after a change to the engine, JNI, Kotlin, or JS event-emitter layers. Builds, installs, sends a known prompt from the example app, and asserts streamed tokens arrive on the JS side with the right handle/requestId. Use after touching anything on the generate path.
---

# Verifying token streaming end-to-end

The streaming path crosses five layers — any single one breaking gives subtly different symptoms, often a JS Promise that never resolves or an event that fires for the wrong engine. This SKILL is the smoke test to catch regressions before they ship.

## The path

```
Engine.generate() in src/index.tsx
    │ assigns requestId, subscribes to "BitnetToken" events filtered by handle+requestId
    ▼
NativeBitnet.generate(...) — TurboModule call
    │
    ▼
BitnetModule.generate(...) in BitnetModule.kt
    │ marks busyHandles[handle], spawns Thread { ... }
    ▼
nativeGenerate JNI in bitnet_jni.cpp
    │ TokenCallback fires per token, calls back into Kotlin emitToken(handle, requestId, token)
    ▼
BitnetEngine::generate(...) in bitnet_engine.cpp (llama.cpp decode loop)
    │
    ▼ emit
RCTDeviceEventEmitter → "BitnetToken" → NativeEventEmitter listener in src/index.tsx
```

A regression at any layer typically presents as: (a) Promise never resolves; (b) tokens arrive with wrong `handle`; (c) tokens leak from a cancelled call; (d) Promise resolves but text is empty.

## Prerequisites

- Connected arm64 device or emulator: `adb shell getprop ro.product.cpu.abi` should be `arm64-v8a`. See [debug-jni-symbols](../debug-jni-symbols/SKILL.md) if not.
- A GGUF model already pushed to the device. Use [push-model](../push-model/SKILL.md) or download via the in-app flow once.
- Example app built fresh: `yarn clean && yarn prepare && yarn example android` from repo root.

## The smoke test

### 1. Clean state, fresh install

```sh
adb shell am force-stop bitnet.example
adb logcat -c
yarn example android
```

Wait for the app to boot. In Metro logs, confirm:

```
"fabric":true,"concurrentRoot":true
```

If those aren't there, New Architecture isn't active and the TurboModule path won't be exercised. Verify [example/android/gradle.properties](../../../example/android/gradle.properties) has `newArchEnabled=true`.

### 2. Single-shot generation

In the example app:
1. Pick the model that's on the device (or download it).
2. Tap **Load model** — should reach "Loaded" state with no errors.
3. Type a short prompt (e.g. `Tell me a haiku about coffee`).
4. Tap **Send**.

Observe in the app's on-screen ScrollView **and** logcat:

```sh
adb logcat -s ReactNativeJS:V | grep -i "token\|generate" | head -40
```

Expectations:
- Tokens stream in (multiple updates, not just a single final message).
- Each token log line includes the same `handle` and `requestId`.
- The final result includes `finishReason` of `'length'`, `'stop'`, or `'cancelled'` and a `usage` object with non-zero `completionTokens`.
- The Promise resolves; the UI exits the "Generating…" state.

### 3. Cancellation behavior

While a generation is mid-flight:
1. Tap **Cancel** (or trigger via `AbortController.abort()`).
2. Generation should stop within a few tokens (the cancel atomic is checked per decode step in `BitnetEngine::generate`).
3. The Promise should reject with an `AbortError` (`error.name === 'AbortError'`) **or** resolve with `finishReason === 'cancelled'` depending on which path was taken (see [src/index.tsx:cancel](../../../src/index.tsx) and commit `2e23d71`).
4. No further tokens for that `requestId` should appear in logcat after cancel returns.

### 4. Concurrency / busy guard

With one engine loaded, fire two `generate()` calls back-to-back without awaiting the first:

```js
const a = engine.generate({ prompt: 'one' });
const b = engine.generate({ prompt: 'two' });   // should reject E_ENGINE_BUSY
```

Expectations:
- `a` streams normally and resolves.
- `b` rejects immediately with `error.code === 'E_ENGINE_BUSY'`.
- Tokens from `a` never have `requestId` matching `b`'s.

### 5. Dispose hygiene

After `engine.dispose()`, any subsequent call (`generate`, `applyChatTemplate`, `getModelInfo`) must reject with `error.code === 'E_ENGINE_DISPOSED'` (commit `dff70eb`). Run this from the example app's REPL panel or by ad-hoc code if available.

### 6. UTF-8 round-trip

Send a prompt containing emoji and non-Latin characters:

```
Write one sentence in Japanese, then 🦀
```

Expectations: the streamed and final text both render correctly with no replacement characters (`�`) and no garbled bytes. This is the regression test for commit `fb77b0a` — `NewString` vs `NewStringUTF`.

## What "pass" looks like

A run that passes all six checks above means the streaming path is healthy. If any check fails:

| Failure | Likely layer | Next skill |
|---|---|---|
| App crashes on first generate, logcat shows `UnsatisfiedLinkError` | JNI symbol resolution | [debug-jni-symbols](../debug-jni-symbols/SKILL.md) |
| Promise hangs, no tokens in logcat | JNI → Kotlin callback (`emitToken`) | Inspect `bitnet_jni.cpp::TokenCallback`; check `env->CallVoidMethod` |
| Tokens arrive but JS listener never fires | NativeEventEmitter / TurboModule event wiring | Confirm `DeviceEventManagerModule.RCTDeviceEventEmitter` is reachable; check `eventEmitter` in `src/index.tsx` |
| Tokens arrive with wrong `requestId` | Stale subscription not torn down | Check the `removeListener` path in `Engine.generate`'s finally block |
| Garbled UTF-8 | `NewStringUTF` regressed | Search `bitnet_jni.cpp` for `NewStringUTF` calls — none should remain on outbound paths |
| Cancellation doesn't take effect | Atomic flag not checked, or generate thread blocked in batch decode | Inspect `BitnetEngine::generate` decode loop for the cancel-check; also verify `BitnetEngine::cancel` flips it from any thread |

## Companion skills

- [add-native-method](../add-native-method/SKILL.md) — if extending the generate signature.
- [debug-jni-symbols](../debug-jni-symbols/SKILL.md) — for symbol-resolution failures.
- [push-model](../push-model/SKILL.md) — to seed the model file once.
