# Known issues

> **Status: stub.** This page exists to satisfy cross-links from [architecture.md](./architecture.md) and [sequence-streaming.md](./sequence-streaming.md). Entries will be added as issues surface or are confirmed; the GitHub issue tracker is the source of truth for anything not listed here.

## Active

### `@@@@@@` divergence

**Symptom.** Under certain prompts the model emits long runs of the literal `@` character instead of the expected continuation.

**Where it is.** Compute-level, not bridge-level — the same prompt produces the same divergence when the engine is exercised standalone (without the React Native layer in the path). That means: not a JNI marshalling bug, not a `BitnetToken` event-emission bug, not a JS-side decoding bug. The bytes coming out of `llama_token_to_piece` are already `@`s by the time the JNI callback fires.

**Likely root cause.** A combination of the BitNet 1.58-bit quantization kernels, the specific GGUF metadata, and sampling parameters at low temperature. Not yet pinned to a single commit upstream.

**Workaround.** Slightly raise `temperature` and `top_p`; ensure the prompt doesn't end mid-token. The divergence is much rarer at `temperature >= 0.7`.

**Tracking.** No reproducer-quality bug filed yet.

### iOS inference is stub-only

The inference engine methods on iOS (`loadModel`, `generate`, `applyChatTemplate`, `getModelInfo`) reject with `E_NOT_IMPLEMENTED`. Only model lifecycle (download / cache / list / delete) is wired on iOS today. The platform-agnostic [bitnet_engine.{h,cpp}](../android/src/main/cpp/) is designed to be reused unchanged when the port lands.

**Tracking.** Owned by the [`port-ios` skill](../.claude/skills/port-ios/SKILL.md) and the [`ios-port-engineer` agent](../.claude/agents/ios-port-engineer.md).

### arm64-v8a only on Android

No `armeabi-v7a` or `x86_64` builds. Emulators on Apple Silicon work; emulators on x86 Linux hosts do not. See [ADR-001](./adr/001-arm64-only.md) for the rationale.

## Resolved (kept for historical context)

*None yet — this section will be populated as issues close.*

## Related

- [architecture.md](./architecture.md)
- [sequence-streaming.md](./sequence-streaming.md)
- [sequence-model-lifecycle.md](./sequence-model-lifecycle.md)
