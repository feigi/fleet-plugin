#!/bin/bash
# Claude Code PreToolUse hook: auto-fill user_id and workspace_id for
# mcp__agent-brain__* tool calls. Prevents the agent from guessing wrong
# values (e.g. wrong-case user_id). Configure with matcher "mcp__agent-brain__.*".

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
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')
WORKSPACE_ID=$(derive_workspace_id "$CWD")

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
# Accept camelCase .sessionId too, matching memory-session-start.sh, so the
# search path and session-start path always bucket recall by the same id.
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // .sessionId // ""')

# session_id is a recall-dedup bucket — inject it only for the two tools that
# bucket recall by it. Other agent-brain tools must not receive it.
INJECT_SESSION=""
case "$TOOL_NAME" in
  mcp__agent-brain__memory_search|mcp__agent-brain__memory_session_start)
    [ -n "$SESSION_ID" ] && INJECT_SESSION="$SESSION_ID" ;;
esac

TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
MODIFIED=$(echo "$TOOL_INPUT" | jq -c \
  --arg u "$USER_ID" \
  --arg w "$WORKSPACE_ID" \
  --arg s "$INJECT_SESSION" \
  'if (.user_id // "") == "" then .user_id = $u else . end
   | if (.workspace_id // "") == "" then .workspace_id = $w else . end
   | if ($s != "" and (.session_id // "") == "") then .session_id = $s else . end')

if [ "$MODIFIED" = "$TOOL_INPUT" ]; then
  exit 0
fi

jq -cn --argjson input "$MODIFIED" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: $input}}'

exit 0
