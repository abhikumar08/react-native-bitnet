#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After bitnet_jni.cpp is edited, verify every
# Java_com_bitnet_* function has both `extern "C"` and `JNIEXPORT`. Missing either
# leaves the symbol C++-mangled / hidden — JVM's dlsym can't resolve it.
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *android/src/main/cpp/bitnet_jni.cpp) ;;
  *) exit 0 ;;
esac

[[ -f "$file" ]] || exit 0

# Find Java_com_bitnet_* function defs and check the 3 lines preceding each have
# both JNIEXPORT and extern "C".
violations=()
while IFS=: read -r lineno match; do
  # Look at 5 lines preceding this match for JNIEXPORT and extern "C"
  start=$((lineno > 5 ? lineno - 5 : 1))
  window=$(sed -n "${start},${lineno}p" "$file")
  has_export=$(echo "$window" | grep -c 'JNIEXPORT' || true)
  has_externc=$(echo "$window" | grep -cE 'extern[[:space:]]+"C"' || true)
  if [[ "$has_export" -eq 0 ]] || [[ "$has_externc" -eq 0 ]]; then
    violations+=("$file:$lineno  $match  [JNIEXPORT=$has_export externC=$has_externc]")
  fi
done < <(grep -nE '^\s*\w+\s+Java_com_bitnet_' "$file" || true)

if (( ${#violations[@]} > 0 )); then
  {
    echo "JNI symbol resolution risk: function(s) missing JNIEXPORT or extern \"C\"."
    echo "Both are required — JNIEXPORT alone keeps the C++ name mangled; extern \"C\""
    echo "alone may still be stripped from .dynsym under -fvisibility=hidden."
    echo
    echo "Violations:"
    printf '  %s\n' "${violations[@]}"
    echo
    echo "Fix by ensuring each JNI entrypoint reads:"
    echo "  extern \"C\" JNIEXPORT <jtype> JNICALL Java_com_bitnet_..."
    echo "See .claude/skills/debug-jni-symbols/SKILL.md."
  } >&2
  exit 2
fi

exit 0
