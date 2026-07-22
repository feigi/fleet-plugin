#!/bin/bash
# Claude Code SessionStart Hook: load agent-brain memories.
# Emits a slim preview (instructions + flags + counts) as additionalContext
# and writes the full markdown index to .agent-brain/index.md at the git worktree
# toplevel (see derive_workspace_dir).
# Agent fetches full bodies on-demand via memory_get(id) when index entries
# overlap the user's topic.
# On any failure, emits the existing fallback additionalContext.

set -uo pipefail

# Source the shared index writer (ab_write_index / ab_stamp_stale). Resolves
# installed-vs-repo layout the same way memory-cache.sh's WRITER lookup does:
# co-located lib/ when installed, hooks/shared/lib/ in-repo. Optional — every
# call site below falls back to pre-lib behavior when the lib didn't load.
_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/index-write.sh"
[ -f "$_LIB" ] || _LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../shared/lib/index-write.sh"
# shellcheck source=/dev/null
[ -f "$_LIB" ] && . "$_LIB"

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

# Resolve the directory to root agent-brain's workspace files (index + cache) at.
# Use the git worktree toplevel rather than the raw cwd so a session launched from
# a subdir (e.g. .agent-brain/cache/) doesn't write a nested .agent-brain/ tree one
# level down. --show-toplevel keeps writes in the *current* worktree (unlike the
# --git-common-dir used above for the worktree-stable workspace_id). Falls back to
# the cwd outside a git repo or if resolution yields a non-directory. Note
# --show-toplevel returns the symlink-resolved path, so the write root can differ
# from the raw cwd even on success.
derive_workspace_dir() {
  local dir="$1" top
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$top" ] && [ -d "$top" ]; then
    printf '%s\n' "$top"
  else
    printf '%s\n' "$dir"
  fi
}

AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"

FALLBACK_MSG="Agent Brain session_start did not succeed — memories were not loaded this session. Call memory_search explicitly when team knowledge or prior context is relevant."

emit_fallback() {
  local reason="$1"
  echo "agent-brain SessionStart: ${reason}" >&2
  # Best-effort: if we already know the workspace dir and the lib is loaded,
  # stamp the prior index stale so its action queue is not presented as current.
  if [ -n "${WORKSPACE_DIR:-}" ] && command -v ab_stamp_stale >/dev/null 2>&1; then
    ab_stamp_stale "${WORKSPACE_DIR}/.agent-brain/index.md" "$reason" || true
  fi
  local ctx="${FALLBACK_MSG} (reason: ${reason})"
  if ! jq -cn --arg ctx "$ctx" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}' 2>/dev/null; then
    # jq itself failed — emit a hand-built envelope so the harness still gets valid JSON.
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
      "agent-brain SessionStart failed; jq unavailable"
  fi
  exit 0
}

if ! command -v jq >/dev/null 2>&1; then
  emit_fallback "jq not installed"
fi

INPUT=$(cat) || emit_fallback "could not read hook stdin"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""') \
  || emit_fallback "could not parse hook input as JSON"
CLIENT_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // .sessionId // ""')

USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')
WORKSPACE_ID=$(derive_workspace_id "$CWD")

if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_fallback "missing or invalid cwd"
fi

# Root index + cache writes at the worktree toplevel, not the raw cwd (see helper).
WORKSPACE_DIR=$(derive_workspace_dir "$CWD")

HEALTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${AGENT_BRAIN_URL}/health" || echo "000")
if [ "$HEALTH_CODE" != "200" ]; then
  emit_fallback "server unreachable (${AGENT_BRAIN_URL}/health → HTTP ${HEALTH_CODE})"
fi

RESPONSE_BODY=$(mktemp -t agent-brain-resp.XXXXXX) || emit_fallback "could not create temp file for response"
trap 'rm -f "$RESPONSE_BODY"' EXIT
REQUEST_BODY=$(jq -cn \
  --arg w "$WORKSPACE_ID" \
  --arg u "$USER_ID" \
  --arg s "$CLIENT_SESSION_ID" \
  '{workspace_id: $w, user_id: $u, limit: 10}
   + (if $s != "" then {session_id: $s} else {} end)')
HTTP_CODE=$(curl -s -o "$RESPONSE_BODY" -w '%{http_code}' \
  -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d "$REQUEST_BODY" \
  || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  BODY_SNIPPET=$(head -c 200 "$RESPONSE_BODY" 2>/dev/null | tr '\n' ' ')
  emit_fallback "memory_session_start POST failed (HTTP ${HTTP_CODE}): ${BODY_SNIPPET}"
fi

if [ ! -s "$RESPONSE_BODY" ]; then
  emit_fallback "memory_session_start returned empty body (HTTP 200)"
fi

# Discriminate: parse error vs missing field vs present-but-empty (zero memories).
if ! jq -e . "$RESPONSE_BODY" >/dev/null 2>&1; then
  BODY_SNIPPET=$(head -c 200 "$RESPONSE_BODY" | tr '\n' ' ')
  emit_fallback "response body is not valid JSON: ${BODY_SNIPPET}"
fi
if ! jq -e 'has("preview")' "$RESPONSE_BODY" >/dev/null 2>&1; then
  emit_fallback "response missing preview field"
fi

PREVIEW=$(jq -r '.preview // ""' "$RESPONSE_BODY")

# Validate the full-index field is present.
if ! jq -e 'has("full")' "$RESPONSE_BODY" >/dev/null 2>&1; then
  emit_fallback "response missing full field"
fi
FULL=$(jq -r '.full // ""' "$RESPONSE_BODY")

# Absolutize the clickable cache paths the server renders. The server can't know
# the client path, so it emits a relative `.agent-brain/cache/<id>.md`; that only
# resolves when the open cwd == project root, and a terminal/editor that wraps it
# as an OSC 8 hyperlink makes macOS throw a "-50" paramErr popup on a relative,
# scheme-less target. Root it at $WORKSPACE_DIR here (the same base used for
# INDEX_DIR below), where the client path is known. Only the backticked row suffix
# is touched; the `^- <id> [` prefix the cache pre-warm regex parses below is
# unaffected. The escape covers the chars special in sed *replacement* text
# (delimiter |, back-ref &, escape \) — it does NOT defend against a newline or
# control char in $WORKSPACE_DIR, which would make sed abort. So guard the result:
# only adopt the rewrite when sed succeeds and yields non-empty output, else keep
# the un-absolutized index (degraded relative links beat overwriting it with sed's
# empty error output and silently blanking the index).
WS_SED=$(printf '%s' "$WORKSPACE_DIR" | sed -e 's/[&|\\]/\\&/g')
if ABS_FULL=$(printf '%s' "$FULL" | sed -e "s|\`.agent-brain/cache/|\`${WS_SED}/.agent-brain/cache/|g") \
  && { [ -n "$ABS_FULL" ] || [ -z "$FULL" ]; }; then
  # sed succeeded (exit 0 under pipefail) and did not blank a non-empty index
  # (an empty result is only legitimate when $FULL was already empty: 0 memories).
  FULL="$ABS_FULL"
else
  echo "agent-brain SessionStart: cache-path absolutization failed; keeping relative links" >&2
fi

# Write the full index to a workspace-local file. Atomic write via tmp + mv.
INDEX_DIR="${WORKSPACE_DIR}/.agent-brain"
INDEX_FILE="${INDEX_DIR}/index.md"
if ! mkdir -p "$INDEX_DIR" 2>/dev/null; then
  emit_fallback "could not create $INDEX_DIR"
fi
if command -v ab_write_index >/dev/null 2>&1; then
  ab_write_index "$INDEX_FILE" "$FULL" || emit_fallback "could not write index file"
else
  # Fallback if the lib failed to load: preserve the original atomic write.
  printf '%s' "$FULL" > "${INDEX_FILE}.tmp" 2>/dev/null || emit_fallback "could not write index file"
  mv -f "${INDEX_FILE}.tmp" "$INDEX_FILE" 2>/dev/null || emit_fallback "could not finalize index file"
fi

# Pre-warm the clickable memory cache for indexed memories (best-effort).
WRITER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cache-write.sh"
[ -f "$WRITER" ] || WRITER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../shared/lib/cache-write.sh"
if [ -f "$WRITER" ]; then
  CACHE_IDS=$(grep -oE '^- [A-Za-z0-9_-]+ \[' "$INDEX_FILE" 2>/dev/null \
    | sed -E 's/^- ([A-Za-z0-9_-]+) \[$/\1/' | head -n 100)
  if [ -n "$CACHE_IDS" ]; then
    IDS_JSON=$(printf '%s\n' "$CACHE_IDS" | jq -R . | jq -sc .)
    GET_BODY=$(jq -nc --argjson ids "$IDS_JSON" --arg u "$USER_ID" '{ids: $ids, user_id: $u}')
    GET_RESP=$(curl -s --max-time 5 -X POST "${AGENT_BRAIN_URL}/api/tools/memory_get" \
      -H 'Content-Type: application/json' -d "$GET_BODY" 2>/dev/null) || GET_RESP=""
    if [ -n "$GET_RESP" ]; then
      ITEMS=$(printf '%s' "$GET_RESP" | jq -c \
        '[ (.data // [])[] | {id, source_path, content, title, type, scope, version, updated_at} ]' \
        2>/dev/null) || ITEMS=""
      if [ -n "$ITEMS" ]; then
        printf '%s' "$ITEMS" | bash "$WRITER" "$INDEX_DIR/cache" || true
      fi
    fi
  fi
fi

# Self-install .gitignore entry — best effort, non-fatal on failure.
GITIGNORE="${WORKSPACE_DIR}/.gitignore"
if [ -e "${WORKSPACE_DIR}/.git" ] || [ -f "$GITIGNORE" ]; then
  if ! grep -qxF '.agent-brain/' "$GITIGNORE" 2>/dev/null; then
    if ! printf '\n# agent-brain (auto-generated index)\n.agent-brain/\n' >> "$GITIGNORE" 2>/dev/null; then
      echo "agent-brain SessionStart: could not append to .gitignore" >&2
    fi
  fi
fi

# Stash agent-brain session_id for the stop hook to read.
if [ -n "$CLIENT_SESSION_ID" ]; then
  AB_SESSION_ID=$(jq -r '.meta.session_id // ""' "$RESPONSE_BODY")
  if [ -n "$AB_SESSION_ID" ]; then
    if ! echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${CLIENT_SESSION_ID}" 2>/dev/null; then
      echo "agent-brain SessionStart: could not stash session id to /tmp" >&2
    fi
  fi
fi

if ! CTX_ESCAPED=$(printf "%s" "$PREVIEW" | jq -Rs '.' 2>/dev/null); then
  emit_fallback "could not JSON-encode preview"
fi

cat <<EOF
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ${CTX_ESCAPED}}}
EOF
