#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After src/index.tsx or src/models.ts is edited,
# remind about JSDoc, the docs/api/ reference, README API table, and error-code conventions.
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *src/index.tsx|*src/models.ts) ;;
  *) exit 0 ;;
esac

cat >&2 <<'EOF'
[facade reminder] Public SDK surface (src/index.tsx or src/models.ts) was edited.

Audit before merge:
  - JSDoc on every new/changed public export (@param, @returns, @throws, @example).
  - Error codes use E_* convention and attach .code via Error & { code: string }.
  - AbortSignal: pre-check signal.aborted, register + remove listener in finally.
  - BitnetToken subscriptions filter by BOTH handle AND requestId.
  - Dispose check: this.handle === null → throw makeEngineDisposedError().
  - Update docs/api/ — every public-surface change needs a matching doc edit.
    See .claude/skills/update-api-reference/SKILL.md.

Hand off:
  - @sdk-api-reviewer            — breaking-change + JSDoc audit.
  - @streaming-lifecycle-reviewer — if you touched generate / stream / chat.
  - @doc-sync-auditor             — to sync docs/api/, README, and error-code list.
EOF

exit 0
