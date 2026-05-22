---
name: build-native-prebuilts
description: Rebuild libllama.so / libggml.so / libcommon.a for android/src/main/jniLibs/arm64-v8a/ from upstream llama.cpp / bitnet.cpp sources. Use when bumping the upstream SHA, adding a CPU feature, or chasing a llama.cpp-side bug. Codifies the NDK toolchain, flags, and the visibility / ABI footguns ADR-001 calls out.
---

# Rebuilding the bundled llama.cpp prebuilts

The library does not build llama.cpp from source at consumer-app build time. We ship three artifacts under [android/src/main/jniLibs/arm64-v8a/](../../../android/src/main/jniLibs/arm64-v8a/):

- `libllama.so` (SHARED, dynamically linked)
- `libggml.so` (SHARED, dynamically linked)
- `libcommon.a` (STATIC, linked into `libbitnet_rn.so`)

The matching headers are checked into [android/src/main/cpp/include/{llama,common,ggml}/](../../../android/src/main/cpp/include/). **Bump these in lockstep** — header/library skew is the most common reason for a subtle UB after upgrading.

## When to rebuild

- Bumping the upstream `llama.cpp` / `bitnet.cpp` SHA.
- Enabling a CPU/quant feature not in the current build (e.g. extra dotprod paths).
- Reproducing a llama.cpp-side bug with debug symbols.
- Switching NDK versions (ABI must match — same C++ runtime).

**Do not rebuild casually.** The shipped binaries are the only thing keeping consumer builds fast.

## Prerequisites

- Android NDK r26 or newer (matches the Gradle plugin in this repo — `com.android.tools.build:gradle:8.7.2`, which expects NDK r26+).
- CMake 3.22+.
- Upstream source: `bitnet.cpp` (which vendors a llama.cpp fork). Clone separately, **not into this repo**.

```sh
git clone --recursive https://github.com/microsoft/BitNet bitnet.cpp
cd bitnet.cpp
git submodule update --init --recursive
```

Record the SHA you build against — it goes in the commit message that updates the prebuilts.

## Build commands (arm64 only)

ABI is locked to `arm64-v8a`. See [android/build.gradle](../../../android/build.gradle) — `abiFilters "arm64-v8a"` is intentional per ADR-001 (binary size, BitNet kernels are arm64-tuned).

```sh
# from inside the bitnet.cpp clone
mkdir -p build-android && cd build-android
cmake .. \
  -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DANDROID_STL=c++_shared \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DGGML_OPENMP=OFF
cmake --build . -j --target llama ggml common
```

Notes:
- `ANDROID_PLATFORM=android-24` matches `minSdkVersion 24` in [android/build.gradle](../../../android/build.gradle). Going higher excludes devices; going lower fails on `__aarch64_*` builtins.
- `ANDROID_STL=c++_shared` must match what `bitnet_rn`'s CMakeLists declares (`-DANDROID_STL=c++_shared`). Mismatched STLs link but crash on the first `std::string` cross-library destructor.
- `GGML_OPENMP=OFF` — bionic doesn't ship libgomp, and BitNet kernels parallelize internally.
- `BUILD_SHARED_LIBS=ON` makes `libllama.so` and `libggml.so` shared; `libcommon` typically still builds as static (it's a thin utility).
- **Do not** add `-fvisibility=hidden`. The host module needs to dlsym into ggml/llama symbols.

## Verify before copying in

```sh
# 1. ABI must be arm64
file build-android/src/libllama.so
# expected: ELF 64-bit LSB shared object, ARM aarch64, ...

# 2. No host x86 contamination
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-readelf -h build-android/src/libllama.so | grep Machine
# expected: Machine: AArch64

# 3. C++ runtime is the shared one
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-readelf -d build-android/src/libllama.so | grep NEEDED
# expected to include libc++_shared.so (NOT libc++_static)

# 4. Required llama symbols are exported
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-nm -D build-android/src/libllama.so | grep -c "llama_model_load\|llama_decode\|llama_token_to_piece"
# expected: ≥ 3
```

## Copy artifacts in

```sh
# from the repo root
cp /path/to/bitnet.cpp/build-android/src/libllama.so       android/src/main/jniLibs/arm64-v8a/
cp /path/to/bitnet.cpp/build-android/src/libggml.so        android/src/main/jniLibs/arm64-v8a/
cp /path/to/bitnet.cpp/build-android/common/libcommon.a    android/src/main/jniLibs/arm64-v8a/
```

(Exact paths in `build-android/` vary by upstream version — they may live under `bin/`, `src/llama/`, etc. `find build-android -name "libllama.so"` is the safest locator.)

## Update headers in lockstep

```sh
# headers travel with the binaries
cp -R /path/to/bitnet.cpp/include/llama.h     android/src/main/cpp/include/llama/
cp -R /path/to/bitnet.cpp/ggml/include/*.h    android/src/main/cpp/include/ggml/
cp -R /path/to/bitnet.cpp/common/*.h          android/src/main/cpp/include/common/
```

If `llama.h` added new APIs you want to use, also update [bitnet_engine.cpp](../../../android/src/main/cpp/bitnet_engine.cpp) and possibly the JNI surface — see [add-native-method](../add-native-method/SKILL.md).

## Sanity-check consumer build

```sh
yarn clean
yarn prepare
yarn example android
```

Then run [verify-streaming](../verify-streaming/SKILL.md) to confirm inference still works end-to-end. A symbol error here means a header/binary mismatch — start over.

## Commit message convention

```
chore(prebuilts): bump llama.cpp to <short-sha>

Source: microsoft/BitNet @ <full-sha>
NDK: r<N>
Build flags: <any non-default flags>
Verified: yarn example android, verify-streaming smoke
```

## Known footguns

- **Headers/binaries drift.** A copy that updates `.so` but leaves the header at an older API silently miscompiles. Always update both.
- **Static `libcommon` vs shared.** [CMakeLists.txt](../../../android/CMakeLists.txt) imports `libcommon` as `STATIC IMPORTED`. If upstream switches it to shared (`.so`), the import declaration needs updating too.
- **Symbol visibility on the library side.** If `libllama.so` was built with `-fvisibility=hidden` upstream (some forks), llama symbols aren't dlopen-able. Patch upstream's `CMakeLists.txt` to remove that flag if encountered.
- **STL mismatch.** Building llama.cpp with `c++_static` and linking against a `c++_shared` consumer (which `bitnet_rn` uses) "works" until the first std::string crosses the boundary, then crashes in a destructor with no useful stack.

## Companion skill

- [debug-jni-symbols](../debug-jni-symbols/SKILL.md) — diagnostic when a fresh prebuilt won't resolve at runtime.
