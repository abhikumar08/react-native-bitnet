---
name: port-ios
description: Port the inference engine to iOS. Wires the platform-agnostic bitnet_engine.{h,cpp} into ios/Bitnet.mm, mirrors BitnetModule.kt's handle registry / threading / busy-guard / dispose semantics, and adds the NativeEventEmitter contract. Use when starting or extending the iOS engine port.
---

# Porting the Bitnet engine to iOS

The Android implementation was deliberately structured so the iOS port is a wiring exercise, not a reimplementation. The C++ engine ([bitnet_engine.{h,cpp}](../../../android/src/main/cpp/bitnet_engine.h)) has zero JNI types and is reused unchanged. Everything iOS-specific lives in [ios/Bitnet.mm](../../../ios/Bitnet.mm).

This SKILL covers what to wire, in what order, and which Android invariants to mirror exactly.

## Current state

[ios/Bitnet.mm](../../../ios/Bitnet.mm) already has:
- `RCTEventEmitter` boilerplate: `supportedEvents` (`BitnetToken`, `BitnetDownloadProgress`), `startObserving`/`stopObserving`, `_hasListeners`.
- Model lifecycle: `startDownload`, `cancelDownload`, `listModels`, `deleteModel`, `getCacheSize`, `getCacheDir`, `isModelCached` — wired to `BitnetDownloader` / `BitnetCache`.
- Engine methods stubbed with `reject(@"E_NOT_IMPLEMENTED", ...)`.

What's missing: the engine itself, the handle registry, threading, busy-guard, dispose semantics, token emission. All of those have an Android reference implementation to copy.

## Architecture decisions to preserve

Read the Android side first as the spec:
- [BitnetModule.kt](../../../android/src/main/java/com/bitnet/BitnetModule.kt) — the contract every method must match.
- [bitnet_jni.cpp](../../../android/src/main/cpp/bitnet_jni.cpp) — the engine registry pattern and TokenCallback.
- [bitnet_engine.h](../../../android/src/main/cpp/bitnet_engine.h) — the engine API, unchanged.

These invariants are load-bearing — iOS must match them or the JS facade in [src/index.tsx](../../../src/index.tsx) will misbehave:

1. **Handle is an opaque `double` at the spec boundary.** JS sees `number`, Obj-C sees `double`, internally it's a key into a registry — **never** a reinterpret_cast'd pointer.
2. **Engine lookups must guard against use-after-dispose.** The registry returns null if the handle was disposed; methods reject with `E_ENGINE_DISPOSED` (commit `dff70eb`).
3. **`generate()` is single-flight per engine.** Overlapping calls reject with `E_ENGINE_BUSY`. The atomic check uses an NSMutableSet/NSLock or `dispatch_semaphore_t` — the Android side uses `ConcurrentHashMap.putIfAbsent`.
4. **Generation runs on a background queue.** Don't block the calling thread. Token emission can happen on that queue; `RCTEventEmitter::sendEventWithName` is thread-safe.
5. **Token events carry `{handle, requestId, token}`.** The JS facade filters by both. Missing `requestId` will look like cross-talk between cancelled and new generations.
6. **`cancelGeneration` is safe from any thread.** It just flips an atomic flag the decode loop checks.
7. **String returns over JNI use `NewString` (UTF-16) on Android because of "modified UTF-8" issues — see `fb77b0a`.** On iOS this is a non-issue: `NSString` is natively UTF-16, and bridging to `NSString` is lossless. Just don't go through a `char *` round-trip for arbitrary UTF-8.

## Step-by-step

### 1. Stand up the engine inside the iOS target

The C++ engine builds for arm64 on macOS/iOS unchanged. Add the files to the Xcode target. Two ways:

- **Cocoapods (preferred for this repo, see [react-native-bitnet.podspec](../../../react-native-bitnet.podspec)):** add `bitnet_engine.cpp` and the include dirs as `source_files` / `header_search_paths`. The `.podspec` already pulls from `ios/` — extend it to also pull from `android/src/main/cpp/bitnet_engine.*` so the engine code is genuinely shared, not duplicated.
- Or symlink `ios/cpp/bitnet_engine.{h,cpp}` → `../android/src/main/cpp/bitnet_engine.{h,cpp}` (gross, but unambiguous).

You'll also need llama.cpp/ggml as iOS static or framework binaries. The Android prebuilts are arm64-v8a ELFs and can't be reused — see [build-native-prebuilts](../build-native-prebuilts/SKILL.md) for the analogous iOS build using the same upstream SHA.

### 2. EngineRegistry — Objective-C++ version

In `ios/EngineRegistry.h`/`.mm` (new files):

```objc++
#pragma once
#import <memory>
#import <unordered_map>
#import <mutex>
#import "bitnet_engine.h"

class EngineRegistry {
public:
  static EngineRegistry &instance();
  int64_t insert(std::unique_ptr<BitnetEngine> engine);
  BitnetEngine *get(int64_t handle);   // returns nullptr if disposed
  void remove(int64_t handle);
private:
  std::mutex _m;
  std::unordered_map<int64_t, std::unique_ptr<BitnetEngine>> _map;
  int64_t _next = 1;
};
```

Mirror `bitnet_jni.cpp`'s `EngineRegistry` exactly — same monotonic counter, same map-keyed-by-int64.

### 3. Wire `loadModel`

```objc++
- (void)loadModel:(NSString *)modelPath
             nCtx:(double)nCtx
         nThreads:(double)nThreads
           nBatch:(double)nBatch
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_engineQueue, ^{
    try {
      auto engine = std::make_unique<BitnetEngine>();
      BitnetLoadParams params{
        .modelPath = std::string(modelPath.UTF8String),
        .nCtx = (int)nCtx,
        .nThreads = (int)nThreads,
        .nBatch = (int)nBatch,
      };
      if (!engine->load(params)) {
        reject(@"E_LOAD_FAILED", @"Engine load returned false", nil);
        return;
      }
      int64_t handle = EngineRegistry::instance().insert(std::move(engine));
      resolve(@((double)handle));
    } catch (const std::exception &e) {
      reject(@"E_LOAD_FAILED", [NSString stringWithUTF8String:e.what()], nil);
    }
  });
}
```

(Match the exact parameter names/types codegen produced — read the generated `BitnetSpec.h` for the canonical Obj-C signature.)

### 4. Wire `generate` with streaming + busy-guard + threading

```objc++
- (void)generate:(double)handle
       requestId:(double)requestId
          prompt:(NSString *)prompt
       /* ... all the sampler args ... */
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  int64_t key = (int64_t)handle;

  // Busy-guard — match Android's putIfAbsent.
  @synchronized (_busyHandles) {
    if ([_busyHandles containsObject:@(key)]) {
      reject(@"E_ENGINE_BUSY", @"Another generate() in progress…", nil);
      return;
    }
    [_busyHandles addObject:@(key)];
  }

  dispatch_async(_engineQueue, ^{
    BitnetEngine *engine = EngineRegistry::instance().get(key);
    if (!engine) {
      @synchronized (self->_busyHandles) { [self->_busyHandles removeObject:@(key)]; }
      reject(@"E_ENGINE_DISPOSED", @"Engine has been disposed.", nil);
      return;
    }

    // TokenCallback: convert std::string → NSString → emit
    auto cb = [self, handle, requestId](const std::string &tok) -> CallbackResult {
      if (self->_hasListeners) {
        [self sendEventWithName:@"BitnetToken" body:@{
          @"handle": @(handle),
          @"requestId": @(requestId),
          @"token": [NSString stringWithUTF8String:tok.c_str()],
        }];
      }
      return CallbackResult::Continue;
    };

    BitnetGenerateParams params{ /* ... fill from args ... */ };
    auto result = engine->generate(params, cb);

    @synchronized (self->_busyHandles) { [self->_busyHandles removeObject:@(key)]; }

    resolve(@{
      @"text": [NSString stringWithUTF8String:result.text.c_str()],
      @"finishReason": @(finishReasonString(result.finishReason)),
      @"usage": @{ /* ... */ },
      @"wallTimeMs": @(result.wallTimeMs),
    });
  });
}
```

**Don't drop the busy-set entry on the `reject` path** without also handling it on the dispose-race path — bugs here cause permanent E_ENGINE_BUSY until app restart.

### 5. Wire `cancelGeneration` / `disposeEngine`

```objc++
- (void)cancelGeneration:(double)handle {
  BitnetEngine *engine = EngineRegistry::instance().get((int64_t)handle);
  if (engine) engine->cancel();   // atomic; safe from any thread
}

- (void)disposeEngine:(double)handle {
  EngineRegistry::instance().remove((int64_t)handle);
  // ConcurrentMap erase + unique_ptr destruction. Generate-in-flight will
  // see cancel signaled via the registry returning null on next lookup —
  // but generate already holds a raw BitnetEngine* for its duration.
  // To be safe, also call engine->cancel() before remove if a generation is in flight.
}
```

The Android side has a subtle race: if `disposeEngine` runs while `generate` is mid-loop, the `unique_ptr` could free the engine under the running thread. Android mitigates by checking `busyHandles` on dispose. **Match that behavior on iOS** — if `_busyHandles` contains the key, defer the actual erase until generate finishes, or signal cancel and wait.

### 6. Wire `applyChatTemplate` / `getModelInfo`

Synchronous on a background queue, resolve with the engine's return value. No streaming, no busy-guard needed (these are read-only against the model — they don't touch the KV cache).

### 7. Test

Run the example app on an iOS device (`yarn example ios`). Then run [verify-streaming](../verify-streaming/SKILL.md) — same six checks apply, just on iOS now. Pay particular attention to:
- The UTF-8 round-trip test (different bridging than Android, may surface different bugs).
- The dispose-during-generate race (iOS-specific; the Android map's lifetime semantics may not transfer cleanly).
- Cancellation latency (iOS GCD queue scheduling can differ from Android's plain `Thread`).

## What CAN be deleted from `ios/Bitnet.mm`

Once each method is wired, remove its `E_NOT_IMPLEMENTED` stub. **Do not** leave both the stub and the implementation — codegen will complain about duplicate declarations.

## When adding a new spec method during the port

Use [add-native-method](../add-native-method/SKILL.md). The iOS-stub step in that flow becomes a real iOS implementation now.

## Related skills

- [add-native-method](../add-native-method/SKILL.md) — the cross-platform method-adding workflow.
- [verify-streaming](../verify-streaming/SKILL.md) — smoke tests that apply once iOS is wired.
- [build-native-prebuilts](../build-native-prebuilts/SKILL.md) — analogous iOS build of llama.cpp / ggml.
