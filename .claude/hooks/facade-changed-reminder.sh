#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After src/index.tsx is edited, remind about
# JSDoc, README API table, and error-code conventions.
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *src/index.tsx) ;;
  *) exit 0 ;;
esac

cat >&2 <<'EOF'
[facade reminder] src/index.tsx (the public JS API) was edited.

Audit before merge:
  - JSDoc on every new/changed public export (@param, @returns, @throws, @example).
  - Error codes use E_* convention and attach .code via Error & { code: string }.
  - AbortSignal: pre-check signal.aborted, register + remove listener in finally.
  - BitnetToken subscriptions filter by BOTH handle AND requestId.
  - Dispose check: this.handle === null → throw makeEngineDisposedError().

Hand off:
  - @sdk-api-reviewer  — breaking-change + JSDoc audit.
  - @streaming-lifecycle-reviewer — if you touched generate / stream / chat.
  - @doc-sync-auditor — to sync README API table + error-code list.
EOF

exit 0
