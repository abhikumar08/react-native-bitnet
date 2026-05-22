#!/usr/bin/env bash
# PreToolUse hook for Bash. Blocks npm / pnpm commands — this repo is Yarn 4 only.
set -euo pipefail

payload=$(cat)
cmd=$(echo "$payload" | jq -r '.tool_input.command // empty')

if echo "$cmd" | grep -qE '^[[:space:]]*(npm|pnpm)([[:space:]]|$)'; then
  echo "Blocked: this repo is Yarn 4 only (packageManager: yarn@4.11.0)." >&2
  echo "Use 'yarn …' instead. See .nvmrc and package.json." >&2
  echo "Attempted: $cmd" >&2
  exit 2
fi

exit 0
