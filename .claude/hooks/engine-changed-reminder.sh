#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After bitnet_engine.cpp or bitnet_engine.h is edited,
# remind that this code is reused unchanged by the iOS port — confirm iOS build picks
# up the change.
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *android/src/main/cpp/bitnet_engine.cpp|*android/src/main/cpp/bitnet_engine.h) ;;
  *) exit 0 ;;
esac

cat >&2 <<'EOF'
[engine reminder] bitnet_engine.{cpp,h} was edited.

This file is platform-agnostic and reused unchanged by the iOS port. Confirm:
  - No JNI / JSI / Android-specific headers added (would break iOS build).
  - react-native-bitnet.podspec still picks up the file from the shared path.
  - If you added a new method to BitnetEngine, also expose it through:
      android/src/main/cpp/bitnet_jni.cpp   (JNI bridge)
      android/src/main/java/com/bitnet/BitnetModule.kt   (Kotlin external fun)
      src/NativeBitnet.ts   (Spec)
      src/index.tsx   (JS facade)
      ios/Bitnet.mm   (stub or real)

See .claude/skills/port-ios/SKILL.md and .claude/skills/add-native-method/SKILL.md.
EOF

exit 0
