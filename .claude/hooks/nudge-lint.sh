#!/usr/bin/env bash
# Stop hook. If JS/TS/TSX files changed and `yarn lint` wasn't run, nudge.
set -euo pipefail

payload=$(cat)
transcript=$(echo "$payload" | jq -r '.transcript_path // empty')

# Did JS/TS files change?
js_changed=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(js|jsx|ts|tsx)$' | head -1 || true)
if [[ -z "$js_changed" ]]; then
  js_changed=$(git status --porcelain 2>/dev/null | awk '{print $2}' | grep -E '\.(js|jsx|ts|tsx)$' | head -1 || true)
fi
[[ -z "$js_changed" ]] && exit 0

if [[ -n "$transcript" ]] && [[ -f "$transcript" ]]; then
  if grep -q 'yarn lint\|eslint' "$transcript" 2>/dev/null; then
    exit 0
  fi
fi

cat <<EOF
{"systemMessage": "JS/TS files changed in this session but \`yarn lint\` wasn't run. Consider running it before finishing."}
EOF

exit 0
