---
name: debug-jni-symbols
description: Diagnose "java.lang.UnsatisfiedLinkError — No implementation found for native ..." errors. Walks the symbol-visibility checks specific to this repo (CXX_VISIBILITY_PRESET default, JNIEXPORT/extern "C", ABI filter, name mangling). Use whenever a JNI call fails at runtime even though the build succeeded.
---

# Diagnosing JNI "No implementation found" errors

The build succeeds, the app installs, the first call into native code throws:

```
java.lang.UnsatisfiedLinkError: No implementation found for long
com.bitnet.BitnetModule.nativeLoadModel(...)
```

This is almost always a **symbol resolution** problem, not a missing implementation. The function exists in the `.so`'s text section but isn't in the dynamic symbol table, which is what the JVM's `dlsym` looks at. This SKILL walks the four causes that account for >95% of these errors in this repo.

## Symbol resolution cheatsheet

```
JVM → dlsym(libbitnet_rn.so, "Java_com_bitnet_BitnetModule_nativeFoo")
       │
       └─ reads the .dynsym table
            │
            └─ symbol must be:
                 • marked JNIEXPORT (default visibility)
                 • extern "C" (no C++ name mangling)
                 • name-mangled per JNI rules
                 • present in this ABI's .so
```

## Quick triage — run this first

```sh
# Find the installed .so on the device
adb shell run-as bitnet.example find lib -name "libbitnet_rn.so"
# Expected: lib/arm64/libbitnet_rn.so

# Pull it back so we can inspect
adb exec-out run-as bitnet.example cat lib/arm64/libbitnet_rn.so > /tmp/libbitnet_rn.so

# 1. Is the symbol in the dynamic table?
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-nm -D /tmp/libbitnet_rn.so | grep nativeFoo

# 2. If not, is it in the static (non-dynamic) table?
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-nm /tmp/libbitnet_rn.so | grep nativeFoo
```

- If it appears in (2) but not (1): **visibility problem** → see cause #1.
- If it appears in neither: **not linked, name mangled, or wrong ABI** → see causes #2–#4.

## Cause 1 — visibility stripped (the most common one in this repo)

NDK toolchains default to `-fvisibility=hidden`, which excludes everything from `.dynsym` unless explicitly exported. [CMakeLists.txt](../../../android/CMakeLists.txt) compensates with:

```cmake
set_target_properties(bitnet_rn PROPERTIES
    CXX_VISIBILITY_PRESET default
    C_VISIBILITY_PRESET default
    VISIBILITY_INLINES_HIDDEN OFF
)
target_compile_options(bitnet_rn PRIVATE -fvisibility=default)
```

**If those lines were dropped or overridden, hidden visibility comes back.** Check:

```sh
grep -E "VISIBILITY_PRESET|fvisibility" android/CMakeLists.txt
# all four lines above must be present
```

Also check that no parent gradle/cmake config injects `-fvisibility=hidden` for the whole project — search:

```sh
grep -rn "fvisibility=hidden" android/ example/android/ 2>/dev/null
# should return nothing
```

## Cause 2 — missing JNIEXPORT or extern "C"

```cpp
// WRONG — gets C++ name mangling
JNIEXPORT jlong JNICALL Java_com_bitnet_BitnetModule_nativeFoo(JNIEnv*, jobject);

// RIGHT
extern "C" JNIEXPORT jlong JNICALL Java_com_bitnet_BitnetModule_nativeFoo(JNIEnv*, jobject);
```

`JNIEXPORT` alone is **not enough**. Without `extern "C"`, the C++ compiler mangles the symbol name to something like `_ZN...` and the JVM can't find it.

Check with:

```sh
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-nm -D /tmp/libbitnet_rn.so | grep nativeFoo
# expected: T Java_com_bitnet_BitnetModule_nativeFoo (NOT _ZN...)
```

## Cause 3 — wrong JNI name mangling

JNI symbol names use a specific transform:

| Java identifier piece | JNI symbol piece |
|---|---|
| `.` (package separator) | `_` |
| `_` (literal underscore) | `_1` |
| `;` (in arg signature, overloaded methods) | `_2` |
| `[` (array, overloaded methods) | `_3` |

For a method `nativeFoo_bar` on package `com.bitnet`, the symbol is `Java_com_bitnet_BitnetModule_nativeFoo_1bar`. Easy way to get the right name — use `javah`-equivalent:

```sh
# From inside android/
./gradlew :react-native-bitnet:compileDebugKotlin
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-nm -D build/intermediates/cmake/debug/obj/arm64-v8a/libbitnet_rn.so \
  | grep "Java_com_bitnet"
```

Compare what the `.so` exports vs what `BitnetModule.kt` declares as `private external fun ...`.

## Cause 4 — ABI mismatch

[android/build.gradle](../../../android/build.gradle) locks the build to arm64-v8a:

```gradle
ndk { abiFilters "arm64-v8a" }
externalNativeBuild { cmake { abiFilters "arm64-v8a" } }
```

If running on an x86_64 emulator, `libbitnet_rn.so` simply isn't packaged for that ABI and the load fails with `UnsatisfiedLinkError: dlopen failed`. Confirm the device ABI:

```sh
adb shell getprop ro.product.cpu.abi
# expected: arm64-v8a (or arm64-v8a in the abilist for emulators)
```

Switch to an arm64 emulator (`aosp_arm64-userdebug` on Apple Silicon hosts) or a physical device.

## Cause 5 — library not loaded at all

[BitnetModule.kt](../../../android/src/main/java/com/bitnet/BitnetModule.kt) has:

```kotlin
init {
  System.loadLibrary("bitnet_rn")
}
```

`libbitnet_rn.so` has NEEDED entries for `libllama.so` and `libggml.so`, so they autoload — but if those `.so`s are missing or have unresolved symbols, `loadLibrary("bitnet_rn")` itself throws and you'll see:

```
java.lang.UnsatisfiedLinkError: dlopen failed: cannot locate symbol "..." referenced by "libbitnet_rn.so"
```

Check the dynamic dependencies:

```sh
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-readelf -d /tmp/libbitnet_rn.so | grep NEEDED
# expected: libllama.so, libggml.so, libc++_shared.so, liblog.so, libandroid.so, libc.so, libm.so, libdl.so

# all NEEDED libs should be present in lib/arm64/
adb shell run-as bitnet.example ls lib/arm64/
```

If a NEEDED lib is missing, the prebuilt may not be packaged — confirm it's under [android/src/main/jniLibs/arm64-v8a/](../../../android/src/main/jniLibs/arm64-v8a/) and that the rebuild didn't change which `.so`s exist (see [build-native-prebuilts](../build-native-prebuilts/SKILL.md)).

## End-to-end recipe

```sh
# Clean, rebuild, install, attach
yarn clean
yarn example android

# As soon as the crash happens:
adb logcat | grep -A20 UnsatisfiedLinkError
```

The error message names the exact method that couldn't resolve. Take the symbol name from the error, then run the triage commands at the top of this skill.

## Companion skills

- [build-native-prebuilts](../build-native-prebuilts/SKILL.md) — when the upstream `.so`s themselves are suspect.
- [add-native-method](../add-native-method/SKILL.md) — the codegen → Kotlin → JNI → C++ flow that, if done out of order, lands here.
