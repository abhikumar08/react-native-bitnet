#!/usr/bin/env bash
# Stop hook. If src/NativeBitnet.ts changed in this session but BitnetModule.kt and
# ios/Bitnet.mm didn't, warn — the codegen fan-out is likely incomplete.
set -euo pipefail

payload=$(cat)

# Inspect working tree (staged + unstaged + untracked deltas)
changed=$(git status --porcelain 2>/dev/null | awk '{print $2}')
[[ -z "$changed" ]] && exit 0

spec_changed=false
kotlin_changed=false
ios_changed=false

while IFS= read -r f; do
  case "$f" in
    *src/NativeBitnet.ts) spec_changed=true ;;
    *android/src/main/java/com/bitnet/BitnetModule.kt) kotlin_changed=true ;;
    *ios/Bitnet.mm) ios_changed=true ;;
  esac
done <<< "$changed"

if [[ "$spec_changed" == true ]] && { [[ "$kotlin_changed" != true ]] || [[ "$ios_changed" != true ]]; }; then
  missing=""
  [[ "$kotlin_changed" != true ]] && missing="$missing BitnetModule.kt"
  [[ "$ios_changed" != true ]] && missing="$missing ios/Bitnet.mm"
  cat <<EOF
{"systemMessage": "Codegen fan-out likely incomplete: src/NativeBitnet.ts changed but no edits to:${missing}. Hand off to @codegen-fanout-checker or follow .claude/skills/add-native-method/SKILL.md before finishing."}
EOF
fi

exit 0
