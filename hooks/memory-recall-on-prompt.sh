#!/bin/bash
# UserPromptSubmit hook: auto-runs memory_search on substantive prompts.
# Injects top matches as additionalContext so the model has prior decisions,
# gotchas, and conventions in scope before it generates a response.
#
# Thin wrapper over hooks/shared/lib/recall-lib.sh (shared with the Copilot
# userPromptSubmitted hook). This script owns Claude-specific input parsing
# (.prompt from stdin, $CLAUDE_PROJECT_DIR for the workspace) and the Claude
# UserPromptSubmit output envelope; the gate + recall core are shared.
#
# Silent on every failure path — never blocks the prompt.

set -uo pipefail

# Need jq to parse stdin and build the response. Installer preflight
# (scripts/installer/preflight.ts) checks jq at install time; if it's
# missing here at runtime, exit silently before draining stdin.
command -v jq >/dev/null 2>&1 || exit 0

# Source the shared recall lib. Installed layout co-locates it under
# <hooksDir>/lib/; repo layout keeps it at hooks/shared/lib/.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${HOOK_DIR}/lib/recall-lib.sh"
[ -f "$LIB" ] || LIB="${HOOK_DIR}/../shared/lib/recall-lib.sh"
# shellcheck disable=SC1090
# Don't swallow the source failure silently: a missing/corrupt lib (or a syntax error
# in it) would otherwise kill recall permanently with no signal, indistinguishable from
# "server down". Drop stderr suppression so a real error surfaces in hook debug logs;
# still exit 0 so the prompt is never blocked.
if ! source "$LIB"; then
  echo "agent-brain recall: failed to source recall lib at $LIB; recall disabled this session" >&2
  exit 0
fi

INPUT=$(cat)

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null) || exit 0
[[ -z "$PROMPT" ]] && exit 0

# Reset the per-turn ledger BEFORE the is_substantive_prompt gate below. The
# reset is turn-boundary bookkeeping, not part of the recall decision — a
# slash command (/review, /commit) or a short prompt still starts a new
# turn, and must not leave the previous turn's injected-id exclusions in
# place for THIS turn's mid-turn recall (PreToolUse/PostToolUse) to inherit.
# Gating the reset on is_substantive_prompt was the bug: it let a
# non-substantive prompt skip the reset entirely, so mid-turn recall later
# in that turn excluded everything injected in the PREVIOUS turn.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // ""' 2>/dev/null)
LEDGER=$(ledger_path "$SESSION_ID")
ledger_reset "$LEDGER" || true

is_substantive_prompt "$PROMPT" || exit 0

USER_ID=$(whoami 2>/dev/null | tr '[:upper:]' '[:lower:]') || exit 0
WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
WORKSPACE_ID=$(derive_workspace_id "$WORKSPACE_DIR") || exit 0

PORT="${AGENT_BRAIN_PORT:-19898}"

CTX=$(run_recall "$PROMPT" "$USER_ID" "$WORKSPACE_ID" "$WORKSPACE_DIR" "$PORT") || exit 0
[[ -z "$CTX" ]] && exit 0

# Record what was injected so mid-turn recall in this same turn won't repeat it.
ledger_append "$LEDGER" "$(printf '%s' "$CTX" | awk 'NR>1 {print $1}')" || true

OUT=$(jq -nc \
  --arg ctx "$CTX" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
  2>/dev/null) || exit 0

printf '%s' "$OUT"
