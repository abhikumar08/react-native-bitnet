#!/usr/bin/env bash
# Stop hook. If native or streaming-relevant files changed and no device run is
# evident, suggest running the verify-streaming skill.
set -euo pipefail

payload=$(cat)
transcript=$(echo "$payload" | jq -r '.transcript_path // empty')

# Did streaming-relevant files change?
streaming_changed=$(
  git diff --name-only HEAD 2>/dev/null | \
    grep -E '(src/index\.tsx|android/src/main/java/com/bitnet/BitnetModule\.kt|android/src/main/cpp/bitnet_(jni|engine)\.(cpp|h)|ios/Bitnet\.mm)' | \
    head -1 || true
)
if [[ -z "$streaming_changed" ]]; then
  streaming_changed=$(
    git status --porcelain 2>/dev/null | awk '{print $2}' | \
      grep -E '(src/index\.tsx|android/src/main/java/com/bitnet/BitnetModule\.kt|android/src/main/cpp/bitnet_(jni|engine)\.(cpp|h)|ios/Bitnet\.mm)' | \
      head -1 || true
  )
fi
[[ -z "$streaming_changed" ]] && exit 0

# Evidence of device run: adb logcat OR yarn example android OR react-native run-android
if [[ -n "$transcript" ]] && [[ -f "$transcript" ]]; then
  if grep -qE 'adb logcat|yarn example android|run-android|run-ios|yarn example ios' "$transcript" 2>/dev/null; then
    exit 0
  fi
fi

cat <<EOF
{"systemMessage": "Native / streaming code changed but no device run is evident in this session. Consider running .claude/skills/verify-streaming/SKILL.md (boot example app, run the 6 checks) before finishing."}
EOF

exit 0
