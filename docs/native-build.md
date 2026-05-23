# Native build — `libllama.so` / `libggml.so` / `libcommon.a`

> **Status: stub.** This page exists to satisfy cross-links from [architecture.md](./architecture.md). The full how-to with NDK toolchain flags, ABI footguns, and the symbol-visibility workaround lives in the [`build-native-prebuilts` skill](../.claude/skills/build-native-prebuilts/SKILL.md) — read that if you actually need to rebuild.

## What's shipped

Three prebuilt artifacts in [android/src/main/jniLibs/arm64-v8a/](../android/src/main/jniLibs/arm64-v8a/), cross-compiled from BitNet's pinned llama.cpp fork:

| File | Linkage | Role |
|---|---|---|
| `libllama.so` | shared | the llama.cpp engine |
| `libggml.so`  | shared | the GGML tensor library |
| `libcommon.a` | static | helper layer, statically linked into `libbitnet_rn.so` |

Matching headers live in [android/src/main/cpp/include/{llama,common,ggml}/](../android/src/main/cpp/include/). They must be bumped in lockstep with the `.so`/`.a` files — header/library skew is the most common cause of subtle UB after an upgrade.

## Why not build from source at consumer-app build time

Every consumer would need: the NDK, CMake 3.22+, the BitNet/llama.cpp clone with submodules, and ~15 minutes per build. The prebuilts trade reproducibility-on-every-build for fast consumer iteration. See [ADR-001](./adr/001-arm64-only.md) for the related ABI decision.

## When you do need to rebuild

- Bumping the upstream `bitnet.cpp` / `llama.cpp` SHA.
- Enabling a CPU/quant feature not in the current build (e.g. extra dotprod paths).
- Reproducing a llama.cpp-side bug with debug symbols.
- Switching NDK major versions.

Full steps: [`.claude/skills/build-native-prebuilts/SKILL.md`](../.claude/skills/build-native-prebuilts/SKILL.md).

## Symbol-visibility gotcha (load-bearing)

NDK Clang defaults to `-fvisibility=hidden`, which strips `JNIEXPORT` symbols from the dynamic symbol table even though they survive in the text section. The JVM resolves JNI calls via `dlsym()`, which only reads the dynamic table — so default-hidden visibility causes `UnsatisfiedLinkError` at runtime even though the build succeeded.

[android/CMakeLists.txt:34-43](../android/CMakeLists.txt) forces default visibility for `libbitnet_rn`:

```cmake
set_target_properties(bitnet_rn PROPERTIES
    CXX_VISIBILITY_PRESET default
    C_VISIBILITY_PRESET default
    VISIBILITY_INLINES_HIDDEN OFF
)
target_compile_options(bitnet_rn PRIVATE -fvisibility=default)
```

Diagnosing this class of bug: [`.claude/skills/debug-jni-symbols/SKILL.md`](../.claude/skills/debug-jni-symbols/SKILL.md).

## Related

- [ADR-001](./adr/001-arm64-only.md) — why arm64-v8a only.
- [architecture.md](./architecture.md) — where these prebuilts sit in the stack.
