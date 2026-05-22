#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After android/build.gradle is edited, verify
# abiFilters "arm64-v8a" is present in both ndk { } and externalNativeBuild { cmake { } }
# blocks. Per ADR-001, this repo ships arm64-only prebuilts.
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *android/build.gradle) ;;
  *) exit 0 ;;
esac

[[ -f "$file" ]] || exit 0

# Count occurrences of abiFilters "arm64-v8a" — expect 2 (ndk block + cmake block).
count=$(grep -cE 'abiFilters[[:space:]]*"arm64-v8a"' "$file" || true)

if (( count < 2 )); then
  {
    echo "ABI lock violation: arm64-v8a abiFilters not present in both required blocks."
    echo "Found $count occurrences (expected 2)."
    echo
    echo "Per ADR-001, this repo ships arm64-only prebuilts. abiFilters must be set in"
    echo "BOTH the ndk { } block AND the externalNativeBuild { cmake { } } block."
    echo
    echo "Current matches:"
    grep -nE 'abiFilters' "$file" || echo "  (none)"
  } >&2
  exit 2
fi

exit 0
