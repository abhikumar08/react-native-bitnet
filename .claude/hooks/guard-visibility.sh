#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After android/CMakeLists.txt is edited, verify the
# load-bearing visibility settings are still present. NDK defaults to -fvisibility=hidden,
# which strips JNIEXPORT symbols from the dynamic table.
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *android/CMakeLists.txt) ;;
  *) exit 0 ;;
esac

[[ -f "$file" ]] || exit 0

required=(
  "CXX_VISIBILITY_PRESET default"
  "C_VISIBILITY_PRESET default"
  "VISIBILITY_INLINES_HIDDEN OFF"
  "-fvisibility=default"
)

missing=()
for needle in "${required[@]}"; do
  if ! grep -qF -- "$needle" "$file"; then
    missing+=("$needle")
  fi
done

if (( ${#missing[@]} > 0 )); then
  {
    echo "JNI visibility risk: required CMake settings missing from $file."
    echo "Without these, NDK's default-hidden visibility strips JNIEXPORT symbols"
    echo "from .dynsym and the JVM can't dlsym to them."
    echo
    echo "Missing:"
    printf '  - %s\n' "${missing[@]}"
    echo
    echo "Restore the bitnet_rn target properties + compile options. See the comment"
    echo "block in android/CMakeLists.txt (\"Force default symbol visibility\")."
  } >&2
  exit 2
fi

exit 0
