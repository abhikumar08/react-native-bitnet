---
name: run-example-android
description: Launch the example app on an Android device/emulator with Metro running, model on device, and filtered logcat showing token streaming and RN errors. Project-specific complement to the built-in /run skill. Use when "run the example", "boot the app", or "see the app working" is the goal.
---

# Running the example app end-to-end

The built-in `/run` skill knows React Native patterns; this one adds the project-specific bits: arm64-only ABI, the GGUF model path, the New Architecture flags to check, and the right logcat filter.

## Prerequisites — one-time

- Yarn 4 (`packageManager: yarn@4.11.0`), Node `v24.13.0` (see [.nvmrc](../../../.nvmrc)).
- Android SDK + an **arm64** target. On Apple Silicon, `aosp_arm64-userdebug` is fastest; on x86 hosts, use a physical device or a `google_apis_arm64-v8a` image (slow under emulation).
- `adb` on PATH.

## Boot sequence

Run from the repo root.

```sh
# Terminal 1 — Metro
yarn example start

# Terminal 2 — build + install + launch
yarn example android
```

`yarn example android` invokes `react-native run-android` under [example/](../../../example/) which:
1. Builds the library's native code (CMake → libbitnet_rn.so) via the consumer's gradle plugin.
2. Builds the example APK (arm64 only — see `abiFilters` in [android/build.gradle](../../../android/build.gradle)).
3. Installs to the first device returned by `adb devices`.
4. Launches `bitnet.example/.MainActivity`.

Specify a device when multiple are attached:

```sh
yarn example android --deviceId <serial-from-adb-devices>
```

## Confirm New Architecture is active

In Metro's logs, look for:

```
"fabric":true,"concurrentRoot":true
```

If those aren't there, the TurboModule path isn't being exercised. Check [example/android/gradle.properties](../../../example/android/gradle.properties) — `newArchEnabled=true` must be set.

## Seed a model (first run only)

The app's in-app downloader works, but for offline iteration push a GGUF directly. Full instructions in [push-model](../push-model/SKILL.md). Short version:

```sh
adb shell run-as bitnet.example mkdir -p files/bitnet-models
adb exec-out run-as bitnet.example sh -c "cat > files/bitnet-models/ggml-model-i2_s.gguf" \
  < ~/Downloads/ggml-model-i2_s.gguf
adb shell am force-stop bitnet.example
adb shell monkey -p bitnet.example -c android.intent.category.LAUNCHER 1
```

Filename should match what the curated picker in [example/src/App.tsx](../../../example/src/App.tsx) expects (e.g. `ggml-model-i2_s.gguf` for the bundled BitNet 2B-4T).

## Filtered logcat for iterating

```sh
# Terminal 3 — log tail
adb logcat -c       # clear ring buffer first
adb logcat -v color -s ReactNativeJS:V BitnetModule:V llama:V ggml:V AndroidRuntime:E
```

Filter tags explained:

| Tag | What it shows |
|---|---|
| `ReactNativeJS:V` | `console.log` from JS, including streamed token logs in [example/src/App.tsx](../../../example/src/App.tsx) |
| `BitnetModule:V` | Kotlin module logs — model load, dispose, error paths |
| `llama:V`, `ggml:V` | Underlying llama.cpp / ggml diagnostics (KV cache size, BLAS ops, etc.) |
| `AndroidRuntime:E` | Java/Kotlin uncaught exceptions including `UnsatisfiedLinkError` |

For just streamed tokens (the most common debug case):

```sh
adb logcat -s ReactNativeJS:V | grep -i "token\|generate"
```

## Quick reset between runs

When the app misbehaves and you want a clean state without a full reinstall:

```sh
adb shell am force-stop bitnet.example
adb shell pm clear bitnet.example       # WIPES app data including downloaded models
adb shell monkey -p bitnet.example -c android.intent.category.LAUNCHER 1
```

Use `force-stop` to just kill; `pm clear` to also wipe `{filesDir}/bitnet-models/` and start from zero.

## Hermes vs JSC

This repo is on Hermes (the RN default). Some Web APIs the SDK might rely on (e.g. `DOMException`) aren't available — see comment in [src/index.tsx:42](../../../src/index.tsx#L42). If something works on simulator/web but not the device, suspect Hermes-incompatible code.

## When it doesn't boot

| Symptom | Try |
|---|---|
| Build fails at CMake step | `yarn clean` first, then retry. If still failing, [debug-jni-symbols](../debug-jni-symbols/SKILL.md) covers symbol-table issues; [build-native-prebuilts](../build-native-prebuilts/SKILL.md) for prebuilt mismatch. |
| App launches, white screen, Metro disconnected | Shake gesture → "Settings" → set debug host to your host's LAN IP, or run `adb reverse tcp:8081 tcp:8081`. |
| App crashes on first model load | `adb logcat -s AndroidRuntime:E` — common: missing model file (wrong filename), arm64 mismatch, or `UnsatisfiedLinkError`. |
| Generation never streams | Run [verify-streaming](../verify-streaming/SKILL.md) — it walks the layers. |

## Companion skills

- [verify-streaming](../verify-streaming/SKILL.md) — smoke test once the app is up.
- [push-model](../push-model/SKILL.md) — seeding a GGUF without using the in-app downloader.
- [debug-jni-symbols](../debug-jni-symbols/SKILL.md) — for symbol-resolution failures at launch.
