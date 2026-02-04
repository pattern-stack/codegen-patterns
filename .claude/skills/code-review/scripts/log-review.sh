#!/bin/bash
# Logs review activity for metrics/audit
# Called as PostToolUse hook

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ -n "$FILE" ]; then
  echo "{\"timestamp\": \"$TIMESTAMP\", \"action\": \"code_review\", \"file\": \"$FILE\"}" >> ~/.claude/review-log.jsonl
fi

exit 0
