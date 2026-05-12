#!/bin/bash
# Claude Code SessionStart Hook: load agent-brain memories.
# Emits a slim preview (instructions + flags + counts) as additionalContext
# and writes the full markdown index to .agent-brain/index.md in the workspace.
# Agent fetches full bodies on-demand via memory_get(id) when index entries
# overlap the user's topic.
# On any failure, emits the existing fallback additionalContext.

set -uo pipefail

AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"

FALLBACK_MSG="Agent Brain session_start did not succeed — memories were not loaded this session. Call memory_search explicitly when team knowledge or prior context is relevant."

emit_fallback() {
  local reason="$1"
  echo "agent-brain SessionStart: ${reason}" >&2
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
WORKSPACE_ID=$(basename "$CWD")

if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_fallback "missing or invalid cwd"
fi

HEALTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${AGENT_BRAIN_URL}/health" || echo "000")
if [ "$HEALTH_CODE" != "200" ]; then
  emit_fallback "server unreachable (${AGENT_BRAIN_URL}/health → HTTP ${HEALTH_CODE})"
fi

RESPONSE_BODY=$(mktemp -t agent-brain-resp.XXXXXX) || emit_fallback "could not create temp file for response"
trap 'rm -f "$RESPONSE_BODY"' EXIT
HTTP_CODE=$(curl -s -o "$RESPONSE_BODY" -w '%{http_code}' \
  -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}" \
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

# Write the full index to a workspace-local file. Atomic write via tmp + mv.
INDEX_DIR="${CWD}/.agent-brain"
INDEX_FILE="${INDEX_DIR}/index.md"
if ! mkdir -p "$INDEX_DIR" 2>/dev/null; then
  emit_fallback "could not create $INDEX_DIR"
fi
if ! printf '%s' "$FULL" > "${INDEX_FILE}.tmp" 2>/dev/null; then
  emit_fallback "could not write index file"
fi
if ! mv -f "${INDEX_FILE}.tmp" "$INDEX_FILE" 2>/dev/null; then
  emit_fallback "could not finalize index file"
fi

# Self-install .gitignore entry — best effort, non-fatal on failure.
GITIGNORE="${CWD}/.gitignore"
if [ -d "${CWD}/.git" ] || [ -f "$GITIGNORE" ]; then
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
