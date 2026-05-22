#!/usr/bin/env bash
# PreToolUse hook for Bash. Verifies git committer is abhikumar08 before any 'git commit'.
# Aligns with the [Commit identity] memory in this repo.
set -euo pipefail

payload=$(cat)
cmd=$(echo "$payload" | jq -r '.tool_input.command // empty')

if ! echo "$cmd" | grep -qE '(^|[[:space:]&|;])git[[:space:]]+commit(\b|[[:space:]])'; then
  exit 0
fi

# A 'git commit' is about to run. Check effective identity.
email=$(git config user.email 2>/dev/null || true)
name=$(git config user.name 2>/dev/null || true)

if [[ "$email" != "akabhikumar08@gmail.com" ]] || [[ "$name" != "abhikumar08" ]]; then
  echo "Blocked: git committer identity is not abhikumar08 / akabhikumar08@gmail.com." >&2
  echo "Current: $name <$email>" >&2
  echo "Set with:" >&2
  echo "  git config user.name abhikumar08" >&2
  echo "  git config user.email akabhikumar08@gmail.com" >&2
  exit 2
fi

exit 0
