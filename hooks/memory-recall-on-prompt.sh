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

# Resolve workspace_id = canonical git repo name (stable across worktrees).
# Falls back to the directory basename outside a git repo. Lowercased.
# Empty/nonexistent dir → "unknown-workspace" (never "/" or a plausible wrong
# path; git -C "" would otherwise resolve against the hook process cwd).
derive_workspace_id() {
  local dir="$1" common repo
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    echo "unknown-workspace"
    return
  fi
  common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)
  if [ -n "$common" ]; then
    case "$common" in /*) ;; *) common="$dir/$common" ;; esac   # absolutize relative .git
    repo=$(cd "$(dirname "$common")" 2>/dev/null && pwd)
    if [ -n "$repo" ]; then
      basename "$repo" | tr '[:upper:]' '[:lower:]'
      return
    fi
  fi
  basename "$dir" | tr '[:upper:]' '[:lower:]'
}

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
# The cache paths advertised below (and the cache-write target) are rooted at
# $WORKSPACE_DIR. An empty/relative/nonexistent value would emit a dead link like
# "/.agent-brain/cache/<id>.md" rooted at filesystem root — the exact broken-link
# failure this absolutization exists to prevent. Bail rather than advertise it
# (consistent with derive_workspace_id's "never /" guard and the never-block contract).
# The case glob also catches the empty string (no match on /*).
case "$WORKSPACE_DIR" in
  /*) ;;
  *) echo "memory-recall: WORKSPACE_DIR not absolute; skipping recall to avoid dead cache links" >&2; exit 0 ;;
esac
[ -d "$WORKSPACE_DIR" ] || { echo "memory-recall: WORKSPACE_DIR not a directory; skipping recall to avoid dead cache links" >&2; exit 0; }
WORKSPACE_ID=$(derive_workspace_id "$WORKSPACE_DIR") || exit 0

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

LINES=$(printf '%s' "$RESP" | jq -r \
  --arg cache "$WORKSPACE_DIR/.agent-brain/cache" '
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
        # Bare path (no backticks) is intentional: injected as additionalContext,
        # the terminal linkifies the raw .md path directly — backticks add noise.
        # ABSOLUTE (rooted at the client project dir, $WORKSPACE_DIR) so the click
        # resolves regardless of the terminal cwd: a relative path only works when
        # cwd == project root, and if the terminal wraps it as an OSC 8 hyperlink
        # macOS throws a "-50" paramErr popup on a scheme-less/relative target.
        + " → \($cache)/\(.id).md"
      )
      | join("\n")
    end
' 2>/dev/null) || exit 0

[[ -z "$LINES" ]] && exit 0

# Cache the recalled memories so the linked paths resolve (best-effort).
WRITER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cache-write.sh"
if [ -f "$WRITER" ]; then
  # memory_search results carry no source_path (only memory_get does) → recall always writes a copy; a later memory_get upgrades vault entries to symlinks via the PostToolUse hook. Projection kept identical to session-start for consistency.
  ITEMS=$(printf '%s' "$RESP" | jq -c \
    '[ (.data // [])[] | {id, source_path, content, title, type, scope, version, updated_at} ]' 2>/dev/null) || ITEMS=""
  # The "→ $WORKSPACE_DIR/.agent-brain/cache/<id>.md" suffix is advertised on every recall
  # line above. If the cache write is skipped (projection failed) or fails, those links
  # won't resolve — log a breadcrumb to stderr instead of failing silently. Still
  # non-fatal: a missing convenience cache must never block the prompt.
  if [ -n "$ITEMS" ]; then
    printf '%s' "$ITEMS" | bash "$WRITER" "$WORKSPACE_DIR/.agent-brain/cache" \
      || echo "memory-recall: cache-write failed; advertised cache paths may not resolve" >&2
  else
    echo "memory-recall: could not build cache items; advertised cache paths may not resolve" >&2
  fi
fi

COUNT=$(printf '%s' "$RESP" | jq -r '.data | length' 2>/dev/null) || exit 0

OUT=$(jq -nc \
  --arg ctx "Auto-recall: ${COUNT} potentially relevant memories. Fetch any with memory_get(id) before responding.
${LINES}" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
  2>/dev/null) || exit 0

printf '%s' "$OUT"
