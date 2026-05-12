#!/bin/bash
# UserPromptSubmit hook: auto-runs memory_search on substantive prompts.
# Injects top matches as additionalContext so the model has prior decisions,
# gotchas, and conventions in scope before it generates a response.
#
# Silent on every failure path — never blocks the prompt.

set -uo pipefail

# Need jq to parse stdin and build the response. Installer preflight
# (scripts/installer/preflight.ts) checks jq at install time; if it's
# missing here at runtime, exit silently before draining stdin.
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null) || exit 0
[[ -z "$PROMPT" ]] && exit 0

# Skip rules:
TRIMMED=$(printf '%s' "$PROMPT" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' 2>/dev/null) || exit 0
[[ ${#TRIMMED} -le 20 ]] && exit 0                # too short
[[ "$TRIMMED" =~ ^[^[:space:]]+$ ]] && exit 0     # single token (no whitespace)
[[ "$TRIMMED" =~ ^/ ]] && exit 0                  # slash command

USER_ID=$(whoami 2>/dev/null | tr '[:upper:]' '[:lower:]') || exit 0
WORKSPACE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
WORKSPACE_ID=$(basename "$WORKSPACE_DIR" 2>/dev/null | tr '[:upper:]' '[:lower:]') || exit 0

PORT="${AGENT_BRAIN_PORT:-19898}"

# limit/min_similarity tuned in spec
# (docs/superpowers/specs/2026-05-07-memory-recall-on-prompt-design.md).
BODY=$(jq -nc \
  --arg q "$PROMPT" \
  --arg u "$USER_ID" \
  --arg w "$WORKSPACE_ID" \
  '{query: $q, user_id: $u, workspace_id: $w, scope: ["workspace","user","project"], limit: 5, min_similarity: 0.5}' \
  2>/dev/null) || exit 0

RESP=$(curl -fsS --max-time 3 \
  -H 'content-type: application/json' \
  -d "$BODY" \
  "http://127.0.0.1:${PORT}/api/tools/memory_search" 2>/dev/null) || exit 0

LINES=$(printf '%s' "$RESP" | jq -r '
  .data
  | if . == null or length == 0 then empty
    else
      map(
        "\(.id) [\(.scope)] \(.type)"
        + ( if (.tags // [] | length) > 0
            then " {" + ((.tags // []) | join(",")) + "}"
            else "" end )
        + " — \(.title): "
        + ( (.content // "") | split("\n")[0] | .[0:80] )
      )
      | join("\n")
    end
' 2>/dev/null) || exit 0

[[ -z "$LINES" ]] && exit 0

COUNT=$(printf '%s' "$RESP" | jq -r '.data | length' 2>/dev/null) || exit 0

OUT=$(jq -nc \
  --arg ctx "Auto-recall: ${COUNT} potentially relevant memories. Fetch any with memory_get(id) before responding.
${LINES}" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
  2>/dev/null) || exit 0

printf '%s' "$OUT"
