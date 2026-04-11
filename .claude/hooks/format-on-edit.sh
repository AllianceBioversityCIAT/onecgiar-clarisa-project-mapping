#!/usr/bin/env bash
# PostToolUse hook: auto-format TS/SCSS/HTML/JSON files with Prettier after Edit/Write.
# Reads hook JSON payload from stdin and runs prettier from the correct workspace.
# Never fails the tool call — if prettier isn't available or errors, exit 0.
set -u

input=$(cat 2>/dev/null || true)
[ -z "$input" ] && exit 0

# Extract file_path without requiring jq (fallback grep)
file_path=""
if command -v jq >/dev/null 2>&1; then
  file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
else
  file_path=$(printf '%s' "$input" | grep -o '"file_path":[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path":[[:space:]]*"\([^"]*\)".*/\1/')
fi

[ -z "$file_path" ] && exit 0
[ ! -f "$file_path" ] && exit 0

case "$file_path" in
  *.ts|*.tsx|*.js|*.mjs|*.cjs|*.html|*.scss|*.css|*.json)
    # Pick the correct workspace (api/ or web/) so prettier picks up the local config
    workspace=""
    case "$file_path" in
      */api/*)  workspace="$(dirname "$(dirname "$0")")/../api" ;;
      */web/*)  workspace="$(dirname "$(dirname "$0")")/../web" ;;
    esac

    if [ -n "$workspace" ] && [ -d "$workspace" ]; then
      (cd "$workspace" && npx --no-install prettier --write "$file_path" >/dev/null 2>&1) || true
    fi
    ;;
esac

exit 0
