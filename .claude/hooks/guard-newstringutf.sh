#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. After bitnet_jni.cpp is edited, flag any use of
# NewStringUTF on outbound paths — this regresses commit fb77b0a (JNI "modified UTF-8"
# corrupts non-BMP code points like 4-byte emoji).
set -euo pipefail

payload=$(cat)
file=$(echo "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

case "$file" in
  *android/src/main/cpp/bitnet_jni.cpp) ;;
  *) exit 0 ;;
esac

[[ -f "$file" ]] || exit 0

# Outbound = return value path. NewStringUTF on outbound corrupts non-BMP.
# Inbound (GetStringUTFChars) is fine, that's standard.
if grep -nE 'NewStringUTF\s*\(' "$file" >/dev/null 2>&1; then
  {
    echo "fb77b0a regression risk: NewStringUTF found in $file."
    echo "Outbound strings must use env->NewString (UTF-16). JNI's 'modified UTF-8'"
    echo "mangles non-BMP code points (emoji, etc.). Inbound GetStringUTFChars is fine."
    echo
    echo "Occurrences:"
    grep -nE 'NewStringUTF\s*\(' "$file"
  } >&2
  exit 2
fi

exit 0
