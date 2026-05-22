# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A React Native TurboModule wrapping `bitnet.cpp` / `llama.cpp` for on-device inference of BitNet GGUF models. Scaffolded with `create-react-native-library` (turbo-module, kotlin-objc). The Android implementation is the real one; on iOS the model lifecycle (download / cache / list / delete) is wired but the inference engine methods (`loadModel`, `generate`, `applyChatTemplate`, `getModelInfo`) still reject with `E_NOT_IMPLEMENTED` — see `ios/Bitnet.mm`.

## Repository layout

Yarn workspaces monorepo. The library is the root package; `example/` is a workspace containing a host app used to exercise the library.

- `src/` — TS public API. `src/NativeBitnet.ts` is the codegen spec (`TurboModuleRegistry.getEnforcing<Spec>('Bitnet')`); `src/index.tsx` wraps it with the `Engine` class and JS `NativeEventEmitter` for streaming tokens.
- `android/` — Kotlin TurboModule + JNI + native C++ engine.
  - `src/main/java/com/bitnet/BitnetModule.kt` — extends generated `NativeBitnetSpec`, owns `System.loadLibrary("bitnet_rn")`, dispatches `generate()` to a background thread, emits `BitnetToken` events via `DeviceEventManagerModule.RCTDeviceEventEmitter`.
  - `src/main/cpp/bitnet_engine.{h,cpp}` — platform-agnostic C++17 engine (pimpl, no JNI/JSI types) wrapping `llama.cpp`. Designed to be reused for the future iOS port unchanged.
  - `src/main/cpp/bitnet_jni.cpp` — thin JNI glue; engine handles are `jlong` keys into an `EngineRegistry` map (NOT raw `reinterpret_cast` pointers — the map guards against use-after-dispose).
  - `src/main/cpp/include/{llama,common,ggml}` — vendored headers.
  - `src/main/jniLibs/arm64-v8a/` — prebuilt `libllama.so`, `libggml.so`, `libcommon.a`. **arm64 only** (see `abiFilters "arm64-v8a"` in `android/build.gradle` — ADR-001 referenced in comments).
  - `CMakeLists.txt` — `bitnet_rn` shared lib links the three prebuilts. `CXX_VISIBILITY_PRESET default` is intentional: NDK's default-hidden visibility strips `JNIEXPORT` symbols from the dynamic table, breaking `dlsym()` resolution.
- `ios/` — `Bitnet.mm` has the model-lifecycle methods wired (delegating to `BitnetDownloader`/`BitnetCache`), but the inference engine methods are still `E_NOT_IMPLEMENTED` stubs. The C++ engine in `android/src/main/cpp/bitnet_engine.{h,cpp}` is intentionally platform-agnostic and can be reused unchanged when the iOS port lands.
- `example/` — RN host app. `example/src/App.tsx` loads a model from `/data/data/bitnet.example/files/model.gguf` and logs streaming tokens to an on-screen ScrollView (also `console.log`'d to logcat).

## Commands

Always work from the repo root with Yarn 4 (`packageManager: yarn@4.11.0`). Don't use npm. Node version per `.nvmrc`: `v24.13.0`.

```sh
yarn                      # install workspace deps
yarn typecheck            # tsc
yarn lint                 # eslint **/*.{js,ts,tsx}
yarn lint --fix
yarn prepare              # bob build — emits lib/module + lib/typescript
yarn clean                # nukes lib + android/ios build dirs
```

Example app:

```sh
yarn example start        # Metro
yarn example android      # run on device/emulator
yarn example ios          # currently stub-only
```

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `yarn prepare`, and `turbo run build:{android,ios}` from the root. Turbo task inputs are scoped — see `turbo.json`.

To confirm the New Architecture is active, look for `"fabric":true,"concurrentRoot":true` in Metro logs at startup.

## Architecture notes that span files

**Codegen flow.** `package.json::codegenConfig` (`name: BitnetSpec`, `javaPackageName: com.bitnet`) drives generation of `NativeBitnetSpec` (Kotlin) and `BitnetSpec` (iOS) from `src/NativeBitnet.ts`. `BitnetModule.kt` extends the generated Kotlin class; don't add JS-facing methods without first updating the TS Spec.

**Handle lifecycle.** Engine handles cross three layers as opaque numbers:
- TS: `number` returned by `loadModel` and stored on `Engine.handle`.
- Kotlin: `Double` at the spec boundary (TurboModule numeric type), converted to `Long` before JNI.
- C++: `jlong` key in `EngineRegistry` (the singleton in `bitnet_jni.cpp`), NOT a reinterpret-cast pointer. Dispose removes the entry from the registry, which destroys the `unique_ptr<BitnetEngine>`.

**Token streaming.** `BitnetEngine::generate()` takes a `TokenCallback` (`std::function<CallbackResult(const std::string&)>`). The JNI layer calls back into Kotlin's `emitToken(handle, token)`, which fires a `BitnetToken` JS event via `DeviceEventManagerModule.RCTDeviceEventEmitter`. The JS `Engine.generate()` filters events by `event.handle === this.handle` so multiple concurrent engines don't cross-talk. On iOS, `NativeEventEmitter` requires the module to implement `supportedEvents`/`addListener`/`removeListeners` (currently not done — flagged in the comment at `src/index.tsx:7`).

**Threading.** `generate()` runs on a `Thread` spawned by `BitnetModule.kt` so it doesn't block the JS thread. The C++ engine itself is single-threaded per instance: `generate()` is not safe to call concurrently on one `BitnetEngine`; `cancel()` is safe from any thread (atomic flag checked in the decode loop).

**Symbol visibility on Android.** If you add a new JNI entry point and it can't be found at runtime, double-check it's marked `JNIEXPORT` (or `extern "C"` with default visibility). The CMake config forces default visibility but `-fvisibility=hidden` slipping into compile flags would silently break things.

**iOS port status.** When porting iOS: reuse `bitnet_engine.{h,cpp}` from the Android tree (no changes needed by design). The Obj-C++ bridge in `ios/Bitnet.mm` should mirror what `BitnetModule.kt` does and wire `supportedEvents` for `NativeEventEmitter`.

## Conventions

- Prettier config lives in `package.json::prettier` (single quotes, 2-space, trailing comma `es5`).
- The library uses `react-native-builder-bob` (`module` ESM + `typescript` targets) — never hand-edit `lib/`.
- Don't add `npm install`/`npm run` instructions; this repo is Yarn-only.
- ADRs are referenced in code comments (e.g. "see ADR-001" in `android/build.gradle`) but the documents themselves aren't checked in here.
- Detailed API reference is the canonical doc surface at `docs/api/` (one file per resource: `engine.md`, `chat-completions.md`, `models.md`, `types.md`, `errors.md`, `events.md`, `streaming.md`). Update it alongside any `src/index.tsx` or `src/models.ts` change — follow `.claude/skills/update-api-reference/SKILL.md` and hand off to `@doc-sync-auditor` for the cross-check.
