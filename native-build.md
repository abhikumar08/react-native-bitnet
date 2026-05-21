# Building the Android arm64-v8a prebuilts

This document explains how the `libllama.so` and `libggml.so` shipped under `android/src/main/jniLibs/arm64-v8a/` were produced, and how to reproduce them.

These are the only binaries the React Native module links against. Everything else in the SDK is source code that compiles inside the consumer's Android Studio project. Treating BitNet/llama.cpp as a prebuilt binary dependency (rather than a source dependency) was a deliberate scope decision: BitNet's build involves Python codegen, kernel-specific compile flags, and ~15 minutes of compilation. Shipping that as a Gradle dependency would be hostile to anyone integrating the SDK.

## What you'll produce

```
android/src/main/jniLibs/arm64-v8a/
├── libllama.so    ~16 MB    llama.cpp + BitNet kernels
├── libggml.so     ~4.3 MB   ggml tensor compute library
└── libcommon.a    static    helper utilities (init, tokenize, sampling)
```

`libllama.so` and `libggml.so` are SHARED libraries — they get packaged into the APK under `lib/arm64-v8a/` and loaded by the dynamic linker when the app starts. `libcommon.a` is STATIC; it gets linked into our own `libbitnet_rn.so` at build time and doesn't appear in the APK as a separate file.

## Prerequisites

- macOS or Linux host (Windows likely works but untested)
- Android NDK r30 or newer
  - Tested with `30.0.14904198`, installed via Android Studio's SDK Manager
  - Lives at `~/Library/Android/sdk/ndk/30.0.14904198` on macOS
- CMake 3.22 or newer (NDK r30 ships its own; the system CMake works too)
- Git
- ~8 GB free disk space for the BitNet checkout and build artifacts

## Step 1 — Clone BitNet

The BitNet repo vendors a pinned commit of llama.cpp as a submodule. Always clone with `--recursive`.

```bash
git clone --recursive https://github.com/microsoft/BitNet.git
cd BitNet
```

If you forgot the `--recursive`:

```bash
git submodule update --init --recursive
```

Capture the commit hash for the writeup — the SDK is pinned to whatever commit you build against:

```bash
cd 3rdparty/llama.cpp
git rev-parse --short HEAD
git log -1 --format="%h %ci %s"
cd ../..
```

## Step 2 — Point at the NDK

The CMake toolchain file lives inside the NDK and is what makes CMake cross-compile for Android instead of the host:

```bash
export ANDROID_NDK=~/Library/Android/sdk/ndk/30.0.14904198
ls $ANDROID_NDK/build/cmake/android.toolchain.cmake
```

That second line should print the toolchain file path. If it doesn't, your `ANDROID_NDK` is wrong — fix it before continuing.

For convenience across shell sessions, add the export to `~/.zshrc` (or `~/.bashrc`).

## Step 3 — Configure CMake

From the BitNet repo root:

```bash
cmake -B build-android-arm64 \
    -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK/build/cmake/android.toolchain.cmake \
    -DANDROID_ABI=arm64-v8a \
    -DANDROID_PLATFORM=android-30 \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_SERVER=OFF \
    -DLLAMA_CURL=OFF
```

Each flag earns its place — here's what every one is doing:

**`CMAKE_TOOLCHAIN_FILE`** — points CMake at the NDK's cross-compile toolchain. Without this, CMake compiles for your host (macOS arm64 or x86_64), not Android.

**`ANDROID_ABI=arm64-v8a`** — target the 64-bit ARM ABI. The SDK does not ship armeabi-v7a (32-bit ARM); BitNet's kernels are AArch64-only and the install base of v7a-only devices is negligible in 2026. Documented in ADR-001.

**`ANDROID_PLATFORM=android-30`** — minimum API level 30 (Android 11). Modern enough to skip legacy-API workarounds, old enough that we're not narrowing the device pool unnecessarily.

**`CMAKE_BUILD_TYPE=Release`** — `-O3` optimization across the codebase. Don't use `RelWithDebInfo` here; the optimizer at `-O2` thrashed for hours on BitNet's generated kernel files when we tested. `Release` (`-O3`) compiled cleanly within minutes. (Counterintuitive but verified.)

**`GGML_NATIVE=OFF`** — disables the host-CPU autodetection llama.cpp does for desktop builds. We're cross-compiling for an unknown phone CPU; let the kernel feature flags be driven by the architecture, not by `cmake`'s host introspection.

**`GGML_OPENMP=OFF`** — disable OpenMP threading. OpenMP needs `libomp.so` at runtime, which Android doesn't ship. Disabling it means llama.cpp falls back to pthreads (which Android always has) for parallel work. Simpler, one fewer .so to package, identical correctness.

**`LLAMA_BUILD_EXAMPLES/TESTS/SERVER=OFF`** — skip the example apps, the test suite, and the HTTP server. They're significant compile time and we don't ship them. (You can flip `LLAMA_BUILD_EXAMPLES=ON` if you want `llama-cli` as well for on-device sanity testing via `adb`.)

**`LLAMA_CURL=OFF`** — disable the CURL-based HTTP fetcher (used by llama.cpp's server). We don't ship the server; this avoids a libcurl dependency on Android.

### Flags that are deliberately not set

A few configurations we tried during development and rejected, documented here so a future maintainer doesn't repeat the experiment:

**`BITNET_ARM_TL1`** — must stay at its default OFF on ARM. The TL1 kernel variant uses heavily unrolled, hand-tuned code that overwhelms Clang's optimizer at any level above `-O0` on the generated `ggml-bitnet-lut.cpp` file (build wedges, no progress, eventually OOMs the optimizer). The I2_S generic kernel path (the default) compiles cleanly and produces correct output. The TL1 path also requires DOTPROD instructions, which not all phones have.

**`CMAKE_C_FLAGS=-march=armv8-a`** — a baseline-ARMv8 override we tried to support DOTPROD-less phones (like the Samsung M31 / Cortex-A53). Don't add this; it cascades into ggml-quants.c errors because llama.cpp has DOTPROD intrinsics that don't have non-DOTPROD fallbacks compiled-in once you tell it the CPU can do DOTPROD via `check_cxx_compiler_flag`. The right answer for non-DOTPROD CPUs is a separate build variant; for the take-home, we scope to ARMv8.2-a+dotprod.

## Step 4 — Build

```bash
cmake --build build-android-arm64 --target llama -j2
cmake --build build-android-arm64 --target common -j2
```

`-j2` is intentional. The BitNet kernel files allocate a lot of optimizer memory. On a Mac with 16 GB RAM and multiple apps running, `-j8` can OOM the build; `-j2` is the sweet spot for reliability over speed. Expect 8–15 minutes total.

Optional, for on-device testing via `adb shell`:

```bash
cmake --build build-android-arm64 --target llama-cli -j2
```

This builds a standalone arm64 binary you can `adb push` to the device and run from a shell. Useful for confirming the prebuilts work before debugging integration issues from inside React Native. Not packaged into the SDK.

## Step 5 — Copy the artifacts into the SDK

The CMake build drops outputs in a directory structure that mirrors the source layout. Pluck out the four files we need:

```bash
# Adjust this path to wherever react-native-bitnet lives
SDK_JNILIBS=~/path/to/react-native-bitnet/android/src/main/jniLibs/arm64-v8a

mkdir -p "$SDK_JNILIBS"

cp build-android-arm64/3rdparty/llama.cpp/src/libllama.so "$SDK_JNILIBS/"
cp build-android-arm64/3rdparty/llama.cpp/ggml/src/libggml.so "$SDK_JNILIBS/"
cp build-android-arm64/3rdparty/llama.cpp/common/libcommon.a "$SDK_JNILIBS/"
```

Also copy the headers the SDK's C++ code compiles against. These are needed by `bitnet_engine.cpp` (`#include "llama.h"`, `#include "common.h"`, `#include "sampling.h"`):

```bash
SDK_INCLUDE=~/path/to/react-native-bitnet/android/src/main/cpp/include
mkdir -p "$SDK_INCLUDE"/{llama,common,ggml}

cp 3rdparty/llama.cpp/include/*.h           "$SDK_INCLUDE/llama/"
cp 3rdparty/llama.cpp/common/*.h            "$SDK_INCLUDE/common/"
cp 3rdparty/llama.cpp/ggml/include/*.h      "$SDK_INCLUDE/ggml/"
```

The headers are a snapshot from BitNet's pinned llama.cpp commit. Note that commit hash somewhere (the SDK's README is a good home) so a future maintainer can regenerate them deterministically.

## Step 6 — Verify

Sanity-check the binaries are genuinely ARM aarch64 and not accidentally x86 (which can happen if the toolchain file didn't take effect):

```bash
file "$SDK_JNILIBS/libllama.so"
```

Expected:

```
libllama.so: ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV),
dynamically linked, BuildID[sha1]=..., with debug_info, not stripped
```

Two specific things to confirm in that output:
- `ARM aarch64` — not `x86_64`, not `ARM (32-bit)`
- `dynamically linked` — not `statically linked`

Also confirm the .so files' NEEDED dependencies are satisfied:

```bash
$ANDROID_NDK/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-readelf -d \
    "$SDK_JNILIBS/libllama.so" | grep NEEDED
```

Expected NEEDED entries: `libggml.so`, `libc.so`, `libdl.so`, `libm.so`, `libc++_shared.so`. The `libggml.so` line is the important one — it means `libllama.so` will look for `libggml.so` in the same directory at load time, which is what we set up by placing both in `jniLibs/arm64-v8a/`.

## Step 7 — On-device smoke test (optional but recommended)

If you built `llama-cli` in step 4, push it to a connected device or emulator and confirm the engine actually runs:

```bash
adb push build-android-arm64/bin/llama-cli                       /data/local/tmp/
adb push build-android-arm64/3rdparty/llama.cpp/src/libllama.so  /data/local/tmp/
adb push build-android-arm64/3rdparty/llama.cpp/ggml/src/libggml.so /data/local/tmp/
adb push ~/path/to/some-model.gguf                               /data/local/tmp/

adb shell
cd /data/local/tmp
chmod +x llama-cli
LD_LIBRARY_PATH=. ./llama-cli -m some-model.gguf -p "Hello" -n 30 -t 4
```

You should see model-loading log lines followed by generated text. Performance on an emulator is unimpressive (1–2 tok/s); on a real DOTPROD-capable phone, 5–15 tok/s is typical.

## Stripping for production (optional)

The shipped binaries are unstripped. Symbols make on-device crash stack traces actually useful during development, at the cost of ~13 MB of APK size. For production releases, strip:

```bash
STRIP=$ANDROID_NDK/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-strip
"$STRIP" "$SDK_JNILIBS/libllama.so"
"$STRIP" "$SDK_JNILIBS/libggml.so"
```

Stripping typically shaves 60–70% off `libllama.so` size. We don't do this for the take-home submission to keep debug info available.

## Updating to a newer llama.cpp

If BitNet's pinned llama.cpp submodule moves forward (or you bump it manually), expect some rework:

1. The DOTPROD detection logic in `ggml/src/CMakeLists.txt` has been rewritten upstream a few times. The flags we use today may need adjustment.
2. The `common_*` helper function signatures occasionally change. `bitnet_engine.cpp` calls into them and may need small edits.
3. GGUF metadata schema evolves. Models converted with an older llama.cpp may load with `missing pre-tokenizer type` warnings on a newer one.

Strategy: when you bump, rebuild, run the on-device smoke test in step 7, and only then update the SDK's vendored binaries.

## Troubleshooting

**`cmake: command not found` after sourcing the NDK env.** The NDK ships its own CMake. Either add `$ANDROID_NDK/cmake/<version>/bin` to `PATH`, or use the host's system CMake — both work. The toolchain file is what does the cross-compilation magic, not the CMake binary itself.

**Build wedges at "Building CXX object ... ggml-bitnet-lut.cpp.o"** with no output and rising memory.

You probably enabled `BITNET_ARM_TL1=ON`. Turn it off (it's off by default; only on if you explicitly passed `-DBITNET_ARM_TL1=ON`). The TL1 kernels generate too much code for Clang's optimizer to handle at any reasonable level above `-O0`.

**`libomp.so` not found at runtime when running `llama-cli` on device.**

You forgot `-DGGML_OPENMP=OFF`. Either set it and rebuild, or push the NDK's `libomp.so` alongside the other binaries.

**Crash with `SIGILL` early in `llama_backend_init` on real hardware.**

The phone's CPU lacks DOTPROD. The optimized BitNet kernel path was compiled in regardless and crashed when invoked. Real fix: build a separate baseline-ARMv8 variant for these devices (out of scope for this SDK). Workaround for testing: use a DOTPROD-capable device (Pixel 6+, mid-range 2020+ phones, or a recent Android Studio emulator image).

**Headers found but linker can't find `libcommon.a`.**

Confirm the file actually built — `find build-android-arm64 -name "libcommon.a"`. If missing, you didn't run `cmake --build ... --target common`. (Some BitNet revisions build `common` as a transitive target of `llama`, others don't.)
