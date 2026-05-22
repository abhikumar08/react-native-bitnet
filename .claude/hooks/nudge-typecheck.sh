#!/usr/bin/env bash
# Stop hook. If TS/TSX files changed since session start and `yarn typecheck` wasn't
# run, print a one-line nudge.
set -euo pipefail

payload=$(cat)
transcript=$(echo "$payload" | jq -r '.transcript_path // empty')

# Did TS/TSX files change in the working tree?
ts_changed=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.tsx?$' | head -1 || true)
if [[ -z "$ts_changed" ]]; then
  # also check unstaged
  ts_changed=$(git status --porcelain 2>/dev/null | awk '{print $2}' | grep -E '\.tsx?$' | head -1 || true)
fi
[[ -z "$ts_changed" ]] && exit 0

# Was `yarn typecheck` run this session? Scan transcript for the command.
if [[ -n "$transcript" ]] && [[ -f "$transcript" ]]; then
  if grep -q 'yarn typecheck\|yarn tsc\|tsc --noEmit' "$transcript" 2>/dev/null; then
    exit 0
  fi
fi

# Output JSON to inject additional context into the stopped state
cat <<EOF
{"systemMessage": "TS/TSX files changed in this session but \`yarn typecheck\` wasn't run. Consider running it before finishing."}
EOF

exit 0
