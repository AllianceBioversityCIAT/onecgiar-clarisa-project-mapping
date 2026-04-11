#!/usr/bin/env bash
# PreToolUse hook: block direct edits to .env files (enforces CLAUDE.md rule #7).
# Exit 2 signals "deny" to Claude Code — the tool call is rejected with the stderr message.
set -u

input=$(cat 2>/dev/null || true)
[ -z "$input" ] && exit 0

file_path=""
if command -v jq >/dev/null 2>&1; then
  file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
else
  file_path=$(printf '%s' "$input" | grep -o '"file_path":[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path":[[:space:]]*"\([^"]*\)".*/\1/')
fi

[ -z "$file_path" ] && exit 0

# Match: anything ending in .env, .env.local, .env.production, etc.
# Allow .env.example (that's the template, safe to edit).
case "$file_path" in
  *.env.example) exit 0 ;;
  *.env|*.env.*|*/.env)
    echo "Blocked: direct edits to .env files are not allowed (CLAUDE.md rule #7)." >&2
    echo "Update .env.example instead and ask the user to sync their local .env." >&2
    exit 2
    ;;
esac

exit 0
