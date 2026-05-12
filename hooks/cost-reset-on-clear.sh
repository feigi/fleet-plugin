#!/usr/bin/env bash
# Claude Code SessionStart hook (matcher: clear).
# Drops a flag file so the statusline rebases its cost baseline to the
# current total on next render, making session cost display reset to $0.00
# after /clear.

set -u

INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // ""' 2>/dev/null)

if [ -n "$SID" ]; then
  : > "/tmp/claude-clear-pending-${SID}" 2>/dev/null || true
fi

exit 0
