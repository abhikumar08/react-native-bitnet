#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After BitnetModule.kt is edited, remind about
# iOS parity (a matching impl or stub in ios/Bitnet.mm).
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *android/src/main/java/com/bitnet/BitnetModule.kt) ;;
  *) exit 0 ;;
esac

cat >&2 <<'EOF'
[parity reminder] android/src/main/java/com/bitnet/BitnetModule.kt was edited.

Mirror the change in ios/Bitnet.mm:
  - If the iOS engine is wired for this method, update the real implementation.
  - Otherwise, ensure the stub still rejects with E_NOT_IMPLEMENTED and matches the
    new spec signature.

Symmetry rules that must hold on both platforms:
  - Same E_* error codes, same conditions.
  - Same dispose / busy / abort handling per @error-symmetry-auditor.
  - BitnetToken event payload: { handle, requestId, token } on both sides.

Hand off: @ios-port-engineer for real impl, @error-symmetry-auditor for an audit
once both sides are updated.
EOF

exit 0
