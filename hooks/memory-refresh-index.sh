#!/bin/bash
# PostToolUse hook: regenerate .agent-brain/index.md after a tool mutated the
# flag/relationship action queue. Best-effort; always exits 0 so it can never
# fail the user's tool call. Reuses the shared writer's monotonic guard so
# overlapping refreshes (housekeeper runs in the background) don't clobber.
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

derive_workspace_dir() {
  local dir="$1" top
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$top" ] && [ -d "$top" ]; then printf '%s\n' "$top"; else printf '%s\n' "$dir"; fi
}
derive_workspace_id() {
  local dir="$1" common repo
  common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)
  if [ -n "$common" ]; then
    case "$common" in /*) ;; *) common="$dir/$common" ;; esac
    repo=$(cd "$(dirname "$common")" 2>/dev/null && pwd)
    [ -n "$repo" ] && { basename "$repo" | tr '[:upper:]' '[:lower:]'; return; }
  fi
  basename "$dir" | tr '[:upper:]' '[:lower:]'
}

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LIB="$HOOK_DIR/lib/index-write.sh"
[ -f "$_LIB" ] || _LIB="$HOOK_DIR/../shared/lib/index-write.sh"
[ -f "$_LIB" ] || { printf 'agent-brain refresh: index-write lib not found at %s\n' "$_LIB" >&2; exit 0; }
# shellcheck source=/dev/null
. "$_LIB"

AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"
INPUT=$(cat) || exit 0
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null) || exit 0
[ -n "$CWD" ] && [ -d "$CWD" ] || exit 0

# In-script guard: only refresh when the tool that just ran is one of the
# seven flag/relationship-queue mutators. Kept on every harness (not just the
# ones lacking a PostToolUse matcher) — harmless where a matcher already
# filters, and load-bearing where it doesn't (e.g. copilot's hooks.json has no
# matcher field).
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL" in
  *memory_resolve_flag|*memory_verify|*memory_archive|*relationship_accept|*relationship_reject|*flag_reopen|*relationship_repropose) ;;
  *) exit 0 ;;
esac

WORKSPACE_DIR=$(derive_workspace_dir "$CWD")
WORKSPACE_ID=$(derive_workspace_id "$CWD")
USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')

REQ=$(jq -cn --arg w "$WORKSPACE_ID" --arg u "$USER_ID" '{workspace_id:$w, user_id:$u}')
# Capture the HTTP status alongside the body: a bare `curl -s` returns exit 0
# for a 4xx/5xx and hands back the error body, so without the status a
# persistent server error would silently no-op and leave a stale queue on disk
# with no breadcrumb. A transient network failure (curl non-zero exit / empty
# body) still skips silently — only a reachable-but-erroring server is logged.
RESP_FILE=$(mktemp 2>/dev/null) || exit 0
trap 'rm -f "$RESP_FILE"' EXIT
HTTP_CODE=$(curl -s -o "$RESP_FILE" -w '%{http_code}' --max-time 5 -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_refresh" \
  -H 'Content-Type: application/json' -d "$REQ" 2>/dev/null) || exit 0
RESP=$(cat "$RESP_FILE" 2>/dev/null)
[ -n "$RESP" ] || exit 0

# Persistent server error: a non-2xx status or a body carrying `.error` means
# the server rejected the refresh — leave one breadcrumb, then exit 0 (this hook
# is best-effort and must never fail the user's tool call).
case "$HTTP_CODE" in
  2[0-9][0-9]) ;;
  *) printf 'agent-brain refresh: HTTP %s\n' "$HTTP_CODE" >&2; exit 0 ;;
esac
if printf '%s' "$RESP" | jq -e '.error' >/dev/null 2>&1; then
  printf 'agent-brain refresh: server returned error for HTTP %s\n' "$HTTP_CODE" >&2
  exit 0
fi

FULL=$(printf '%s' "$RESP" | jq -r '.full // ""' 2>/dev/null) || exit 0
[ -n "$FULL" ] || exit 0

# Absolutize cache paths, matching the session-start hook (same guard).
WS_SED=$(printf '%s' "$WORKSPACE_DIR" | sed -e 's/[&|\\]/\\&/g')
if ABS_FULL=$(printf '%s' "$FULL" | sed -e "s|\`.agent-brain/cache/|\`${WS_SED}/.agent-brain/cache/|g") \
  && [ -n "$ABS_FULL" ]; then
  FULL="$ABS_FULL"
fi

INDEX_DIR="${WORKSPACE_DIR}/.agent-brain"
mkdir -p "$INDEX_DIR" 2>/dev/null || exit 0
ab_write_index "${INDEX_DIR}/index.md" "$FULL" || true
exit 0
