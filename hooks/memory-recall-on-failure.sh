#!/bin/bash
# PostToolUse hook: mid-turn recall on tool failure.
#
# Failure triage needs the error text, which exists ONLY in the tool output —
# at PreToolUse time a command like `gh run view --log-failed` says the agent is
# about to look, not that anything failed, and that string is a near
# content-free search query. See
# docs/superpowers/specs/2026-07-20-mid-turn-recall-design.md.
#
# Thin wrapper over hooks/shared/lib/recall-lib.sh. Owns Claude input parsing
# and the PostToolUse envelope ONLY — all detection lives in the lib, enforced
# by tests/integration/hooks/shim-purity.test.ts.
#
# Silent on every failure path — never blocks the tool.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${HOOK_DIR}/lib/recall-lib.sh"
[ -f "$LIB" ] || LIB="${HOOK_DIR}/../shared/lib/recall-lib.sh"
# shellcheck disable=SC1090
if ! source "$LIB"; then
  echo "agent-brain recall: failed to source recall lib at $LIB; mid-turn recall disabled" >&2
  exit 0
fi

INPUT=$(cat)

RESP=$(printf '%s' "$INPUT" | jq -r '.tool_response // ""' 2>/dev/null) || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0

is_tool_failure "$RESP" "$CMD" "$TOOL_NAME" || exit 0
QUERY=$(extract_failure_query "$RESP") || exit 0
[[ -z "$QUERY" ]] && exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // ""' 2>/dev/null)
USER_ID=$(whoami 2>/dev/null | tr '[:upper:]' '[:lower:]') || exit 0
WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
WORKSPACE_ID=$(derive_workspace_id "$WORKSPACE_DIR") || exit 0
PORT="${AGENT_BRAIN_PORT:-19898}"

LEDGER=$(ledger_path "$SESSION_ID")
EXCLUDE=$(ledger_read "$LEDGER")

CTX=$(run_recall "$QUERY" "$USER_ID" "$WORKSPACE_ID" "$WORKSPACE_DIR" "$PORT" "$EXCLUDE") || exit 0
[[ -z "$CTX" ]] && exit 0

# Ledger write failure must NOT suppress the injection: recall is the feature,
# dedup is the optimization. Degrading to a possible duplicate beats silence.
ledger_append "$LEDGER" "$(printf '%s' "$CTX" | awk 'NR>1 {print $1}')" || true

OUT=$(jq -nc --arg ctx "$CTX" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' \
  2>/dev/null) || exit 0

printf '%s' "$OUT"
