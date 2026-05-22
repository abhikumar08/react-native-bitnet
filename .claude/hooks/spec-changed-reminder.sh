#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After src/NativeBitnet.ts is edited, remind about
# the codegen fan-out: yarn prepare, Kotlin override, iOS stub, JS facade.
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *src/NativeBitnet.ts) ;;
  *) exit 0 ;;
esac

# Advisory. Print to stderr so it surfaces but doesn't block.
cat >&2 <<'EOF'
[fan-out reminder] src/NativeBitnet.ts (the codegen Spec) was edited.

Required follow-ups:
  1. yarn prepare                                          # regenerate Kotlin/iOS bases
  2. android/src/main/java/com/bitnet/BitnetModule.kt      # update override
  3. android/src/main/cpp/bitnet_jni.cpp                   # JNI bridge (if native work)
  4. ios/Bitnet.mm                                         # at least an E_NOT_IMPLEMENTED stub
  5. src/index.tsx                                         # expose via Engine class

Hand off to @codegen-fanout-checker for verification, or follow the
.claude/skills/add-native-method/SKILL.md workflow end-to-end.
EOF

exit 0
