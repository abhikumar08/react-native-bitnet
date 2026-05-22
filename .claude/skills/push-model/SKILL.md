---
name: push-model
description: Push a local GGUF model file onto a connected Android device/emulator into the example app's private cache so the app can load it without going through the in-app downloader. Use to test inference with a local checkpoint, skip network, or pre-seed the cache before a flight test.
---

# Pushing a GGUF model onto the device

The example app normally downloads models via the SDK (`Models.download(...)` → `{filesDir}/bitnet-models/...`). Pre-seeding the cache lets you skip that step — useful when iterating locally, testing offline, or working with a model that isn't on Hugging Face.

## Where the file needs to land

The cache root is `{context.filesDir}/bitnet-models/` (see [ModelCache.kt:8](../../../android/src/main/java/com/bitnet/ModelCache.kt#L8)). For the example app (applicationId `bitnet.example`) that's:

```
/data/data/bitnet.example/files/bitnet-models/
```

This path is **private** to the app and not writable directly without root. Use `adb shell run-as bitnet.example` (works on debug builds — the apps in this repo are all debug).

## One-time prep

```sh
adb devices                              # confirm a device is attached
adb shell run-as bitnet.example pwd      # confirms the app is installed and run-as works
adb shell run-as bitnet.example mkdir -p files/bitnet-models
```

If `run-as` errors with `Package not debuggable`, the example app was installed from a release build. Reinstall via `yarn example android`.

## The push (use `cat | run-as` — direct `adb push` can't reach the private dir)

```sh
MODEL_PATH=/path/to/local/ggml-model-i2_s.gguf
DEST_NAME=ggml-model-i2_s.gguf

# Stream the file via run-as. adb push -> external location -> run-as cp also works
# but uses double the disk space on the device.
adb exec-out run-as bitnet.example sh -c "cat > files/bitnet-models/$DEST_NAME" < "$MODEL_PATH"

# Verify
adb shell run-as bitnet.example ls -la files/bitnet-models/
adb shell run-as bitnet.example stat -c '%s %n' files/bitnet-models/$DEST_NAME
```

(Multi-GB pushes can take several minutes on USB 2.0. Prefer USB 3 or wifi-adb.)

## Making the SDK aware of the pushed file

The cache index is a JSON manifest, not just a directory listing. The runtime cache discovery scans the directory and reconstructs entries, but if the SDK was already initialized this session, it won't rescan. **Force-stop the app** so its next launch picks up the new file:

```sh
adb shell am force-stop bitnet.example
```

Then launch the example app. The new file shows up in the model picker.

If you want a specific filename → display name mapping that matches the curated list in [example/src/App.tsx](../../../example/src/App.tsx), name it exactly as that list expects (e.g. `ggml-model-i2_s.gguf` for the bundled BitNet 2B-4T).

## Pulling a model back off the device

```sh
adb exec-out run-as bitnet.example cat files/bitnet-models/ggml-model-i2_s.gguf > local-copy.gguf
```

Useful if a teammate downloaded via the in-app flow and you want a copy without re-fetching.

## Wiping the cache

```sh
adb shell run-as bitnet.example sh -c "rm -rf files/bitnet-models/*"
adb shell am force-stop bitnet.example
```

## Working from an emulator vs physical device

Same commands. On x86_64 emulators the prebuilt arm64 libraries can't run — see `abiFilters "arm64-v8a"` in [android/build.gradle](../../../android/build.gradle) and ADR-001. Use an arm64 emulator image (`aosp_arm64-userdebug` on Apple Silicon hosts is fast) or a physical device.

## Quick sanity probe — does the app see it?

```sh
adb logcat -c
adb shell am force-stop bitnet.example
adb shell monkey -p bitnet.example -c android.intent.category.LAUNCHER 1
adb logcat -s ReactNativeJS:V BitnetModule:V | grep -i "model\|cache" | head -20
```

If the file is well-formed but the app rejects it: check the GGUF magic bytes and version (`head -c 8 model.gguf | xxd` should show `47 47 55 46` = "GGUF" followed by a small-endian version). Llama.cpp prints the rejection reason via `__android_log`; tail logcat with `-s llama:V` to catch it.

## Related skills

- [run-example-android](../run-example-android/SKILL.md) — end-to-end run including this push step.
- [verify-streaming](../verify-streaming/SKILL.md) — once the model is on the device, smoke-test the generate path.
