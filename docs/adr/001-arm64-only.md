# ADR-001 — Android ABI is `arm64-v8a` only

> **Status:** Accepted. **Date:** 2026-04 (approx — predates ADR file creation).
> **Stub note:** This document records the locked-in decision. The full historical context (which devices were excluded, the AAB size delta) was discussed verbally; this is the canonical record going forward.

## Context

`react-native-bitnet` ships large prebuilt native libraries (`libllama.so` ~12 MB, `libggml.so` ~2 MB) that dominate the final APK / AAB size. Android supports four ABIs (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`); shipping all four would multiply the binary cost by ~4×. The BitNet 1.58-bit quantization kernels are also hand-tuned for ARMv8.2-A's DOTPROD extension, with no equivalent path on 32-bit ARM or x86.

## Decision

The library declares `abiFilters "arm64-v8a"` in [android/build.gradle:49](../../android/build.gradle#L49). No other ABIs are built or shipped. The minimum CPU is ARMv8.2-A with DOTPROD (`__ARM_FEATURE_DOTPROD`).

This is enforced at the Gradle level — a consumer app cannot opt back in to other ABIs without forking the library.

## Consequences

**Accepted.**

- **Excluded devices.** No support for `armeabi-v7a` (32-bit ARM phones, mostly pre-2017 budget devices) or any `x86` / `x86_64` device (Chromebooks, some Android-on-Intel hardware).
- **Emulator implications.** Android Studio's emulator on Apple Silicon hosts uses arm64 and works. On x86 Linux/Windows hosts the emulator is `x86_64` and **does not** work — developers there must use a physical arm64 device.
- **Binary size win.** AAB ABI splits already let consumers ship per-architecture variants; the library decision means the arm64 variant is the only one needed, halving the matrix Android Studio has to build.
- **Performance floor.** DOTPROD-capable devices (most arm64 phones from 2019 onward) hit 5–15 tokens/sec for BitNet 1.58-bit. Pre-DOTPROD arm64 hardware exists but is not in the supported set.

## Alternatives considered

1. **Ship all four ABIs.** Rejected — quadruples the AAB cost for ~2% device coverage gain.
2. **Ship arm64 + armeabi-v7a.** Rejected — no BitNet kernel path on 32-bit ARM; would degrade to a generic FP path that defeats the point of using BitNet.
3. **Runtime CPU detection with fallback.** Rejected as overengineered for the current consumer base; can be revisited if a real consumer asks.

## References

- [android/build.gradle:49,55](../../android/build.gradle) — `abiFilters "arm64-v8a"`.
- [`build-native-prebuilts` skill](../../.claude/skills/build-native-prebuilts/SKILL.md) — build commands assume arm64.
- [native-build.md](../native-build.md) — what's shipped.
