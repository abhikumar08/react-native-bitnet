# Architecture

`react-native-bitnet` exposes BitNet (a 1.58-bit quantized LLM running on llama.cpp) as a React Native module. The codebase has two parallel concerns — **inference** (load a model and stream tokens) and **model lifecycle** (download, cache, resume, delete) — both descending from the same TurboModule spec at the top through three runtime environments: JavaScript, the JVM, and native C++.

![SDK architecture stack](./diagrams/architecture.svg)

## The stack

**`example/`.** The example app — a chat UI that exercises the public API the way a real consumer would. It owns the message list, the typing indicator, the cancel button, and the model-load lifecycle. It imports both `Engine` (for inference) and `Models` (for the download UI). It depends on nothing in the SDK except the public TypeScript surface.

**`Engine` / `Bitnet`** (`src/index.tsx`). The public TypeScript API. `Engine.load()` is a static factory that returns a handle-wrapped instance; instance methods are `generate`, `stream`, `chat.completions.create`, `cancel`, `applyChatTemplate`, `modelInfo`, and `dispose`. This is the only file a consumer needs to read to use the SDK. Streaming is exposed three ways: an `onToken` callback on `generate()` (push), an async iterable returned by `stream()` (pull), and the OpenAI-shaped `chat.completions.create({ stream: true })` facade that wraps `stream()` and emits OpenAI-compatible chunks. All three are surfaces over the same underlying `BitnetToken` event stream.

**`NativeBitnet`** (`src/NativeBitnet.ts`). The TurboModule spec. Declarative — no logic. React Native's codegen reads this file at build time and generates the C++ glue that marshals each method's arguments across the JS-to-JVM boundary. Every parameter type is constrained to what codegen supports: `string`, `number`, `boolean`, arrays of those, or a JSON-stringified object for anything richer (chat messages). Promise return types only — no synchronous calls.

**Boundary: JS / JVM.** Method calls become serialized parameter packets dispatched onto the React Native module thread. Token events flow the other way as `WritableMap`s through `DeviceEventEmitter`.

**`BitnetModule.kt`** (`android/src/main/java/com/bitnet/BitnetModule.kt`). The Kotlin native module. Declares external native methods, marshals their arguments to JNI-compatible types, runs `generate` on a background `Thread{}.start()` so the JS thread isn't blocked, and provides the `emitToken` callback the JNI layer calls back into for each generated token. Loads `libbitnet_rn.so` via `System.loadLibrary` in its companion object.

**Boundary: JNI.** The hard interop boundary — Java Native Interface calls into C++. Symbol naming follows JNI conventions (`Java_com_bitnet_BitnetModule_nativeGenerate`). Symbol visibility is forced to `default` in the CMake config because NDK r30's Clang strips JNIEXPORT symbols from the dynamic table by default — see `native-build.md`.

**`bitnet_jni.cpp`** (`android/src/main/cpp/bitnet_jni.cpp`). The JNI bridge. Six C functions implementing the native methods declared in Kotlin. Holds an `EngineRegistry` — a mutex-protected map from integer handles to `unique_ptr<BitnetEngine>` — so JS can address multiple loaded models with simple numeric handles instead of opaque pointers. Translates `jstring` ↔ `std::string`, parses the chat-message JSON, and invokes the engine. The token callback is constructed here and passed down into the engine; when it fires, this layer calls back up into Kotlin's `emitToken`.

**`BitnetEngine`** (`android/src/main/cpp/bitnet_engine.cpp`, `.h`). The actual inference engine. Holds the `llama_model` and `llama_context`. Owns the decode loop: tokenize prompt → loop `llama_decode` → sample → detokenize piece → invoke callback → repeat until EOS. Platform-agnostic — no JNI, no Kotlin, no React Native. The exact same class compiles and runs on macOS for testing.

**Boundary: SDK / vendor.** Below this line is code the SDK doesn't own.

**`libllama.so` + `libggml.so`.** The vendored prebuilts — BitNet's pinned fork of llama.cpp, cross-compiled for `arm64-v8a` and dropped into `android/src/main/jniLibs/arm64-v8a/`. The SDK doesn't build these as part of its consumer-facing Gradle build (that would force every consumer to set up the NDK, run Python codegen, and wait 15 minutes per build). Reproduction steps are documented in [`native-build.md`](./native-build.md).

## Model lifecycle

The right-hand column of the diagram is a separate stack that shares the TurboModule spec at the top but otherwise runs parallel to the inference stack. Most consumers never call this surface directly — `Engine.load({ modelRef })` does it implicitly — but it's exposed as a first-class namespace for download UIs, eviction tooling, and background refresh.

**`Models`** (`src/models.ts`). The public TypeScript API: `download`, `list`, `resumeAll`, `delete`, `cacheSize`, `cacheDir`, `isCached`, and `resolve`. `resolve(ref)` is the canonicalization step that turns a `modelRef` (a URL, an `hf://owner/repo/file.gguf` string, or a structured object) into the stable `{ url, cacheKey }` pair every other method keys off.

**`ModelDownloader.kt`** (`android/src/main/java/com/bitnet/ModelDownloader.kt`). The Kotlin download orchestrator. It deduplicates concurrent calls on the same `cacheKey` so a download triggered twice in flight only opens one connection. It resumes interrupted downloads from `.part` files using HTTP `Range` + `If-Range` headers — the latter pins the resume to a specific ETag so a re-uploaded file on the origin causes a clean restart from byte 0 instead of corrupting the local copy. It SHA-256-verifies the result against the caller's expected checksum (rejecting with `E_CHECKSUM_MISMATCH` on mismatch) and commits via atomic `.part`→file rename followed by a `meta.json` write. Progress is published as `BitnetDownloadProgress` events that the TS layer fans out as `opts.onProgress(...)` callbacks.

**`BitnetDownloadService`** (`android/src/main/java/com/bitnet/BitnetDownloadService.kt`). An Android foreground service that the downloader starts before opening any connection and stops after the atomic commit. Its only purpose is keeping the process alive across user backgrounding (multi-GB GGUF downloads regularly take longer than the OS will let a background app live). Requires `POST_NOTIFICATIONS` on Android 13+ since a foreground service must surface an ongoing notification.

**Filesystem layer.** `context.filesDir/bitnet-models/{cacheKey}/` holds the trio `model.gguf`, `model.gguf.part`, and `meta.json` for each cached model. `ModelCache.kt` is the read/write helper; `meta.json` carries the ETag, content-length, SHA-256, and a `complete:true` flag that `Engine.load` uses to short-circuit the download stage.

**Bridge to inference.** The two columns meet exactly once: `Engine.load({ modelRef })` calls `Models.download(...)` internally, then passes the resulting `localPath` into the native `loadModel(path)`. Past that handoff, the inference stack is unaware of where the file came from.

## Colour coding

The diagram uses four colour groups:

- **Gray** — code the SDK does not own. The example app (consumers will replace it), the vendored prebuilts (BitNet's llama.cpp fork), and the Android filesystem.
- **Teal** — SDK code running in a managed runtime. JavaScript on top, Kotlin underneath. Includes both the inference (`Engine`, `BitnetModule.kt`) and lifecycle (`Models`, `ModelDownloader.kt`) layers.
- **Coral** — SDK code running natively. The JNI bridge and the engine itself.
- **Amber** — platform services the SDK starts but does not own. Currently just `BitnetDownloadService`, the Android foreground service that keeps downloads alive across backgrounding.

The three dashed lines are runtime boundaries. They're the places where a stack trace will switch from one toolchain's symbols to another's, where a crash dump will hand off to a different debugger, and where a type system will start over with a new vocabulary.

## What the diagram does not show

This is the static structure — what code lives where. It does not show what happens when a single prompt flows through the stack, what gets called synchronously vs. asynchronously, where threading boundaries are, or how tokens make it back from the C++ engine to a `setState` call. For that, see [`sequence-streaming.md`](./sequence-streaming.md).

## Related documents

- [`native-build.md`](./native-build.md) — how the vendored `.so` files were produced.
- [`sequence-streaming.md`](./sequence-streaming.md) — what happens during a single chat turn, end to end.
- [`sequence-model-lifecycle.md`](./sequence-model-lifecycle.md) — what happens when a model is downloaded, resumed, verified, and cached.
- [`adr/001-arm64-only.md`](./adr/001-arm64-only.md) — why no armeabi-v7a, why DOTPROD is the minimum.
- [`adr/002-engine-design.md`](./adr/002-engine-design.md) — handle-based registry, ownership, lifecycle.
- [`adr/003-streaming-api.md`](./adr/003-streaming-api.md) — TurboModule + JNI vs. C++ TurboModule with JSI; promise-down, events-up.
- [`known-issues.md`](./known-issues.md) — the `@@@@@@` divergence and other open items.
