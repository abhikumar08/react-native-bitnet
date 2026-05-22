#!/usr/bin/env bash
# Stop hook. If src/index.tsx or src/models.ts changed this session AND no file
# under docs/api/ was edited, surface a reminder to update the API reference.
set -euo pipefail

payload=$(cat)

changed=$(git status --porcelain 2>/dev/null | awk '{print $2}')
[[ -z "$changed" ]] && exit 0

sdk_changed=false
docs_changed=false

while IFS= read -r f; do
  case "$f" in
    *src/index.tsx|*src/models.ts) sdk_changed=true ;;
    *docs/api/*) docs_changed=true ;;
  esac
done <<< "$changed"

if [[ "$sdk_changed" == true ]] && [[ "$docs_changed" != true ]]; then
  cat <<'EOF'
{"systemMessage": "Public SDK surface changed (src/index.tsx or src/models.ts) but no docs/api/ files were edited. Update the API reference per .claude/skills/update-api-reference/SKILL.md, or hand off to @doc-sync-auditor."}
EOF
fi

exit 0
