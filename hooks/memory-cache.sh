#!/bin/bash
# PostToolUse hook: cache agent-brain memories touched by memory_get / memory_create
# as clickable files under <workspace>/.agent-brain/cache/<id>.md. Best-effort, exits 0.
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0

# Root cache writes at the git worktree toplevel, not the raw cwd, so a session
# launched from a subdir (e.g. .agent-brain/cache/) doesn't write a nested
# .agent-brain/ tree one level down. Falls back to the cwd outside a git repo or if
# resolution yields a non-directory. Note --show-toplevel returns the symlink-
# resolved path, so the write root can differ from the raw cwd even on success.
derive_workspace_dir() {
  local dir="$1" top
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$top" ] && [ -d "$top" ]; then
    printf '%s\n' "$top"
  else
    printf '%s\n' "$dir"
  fi
}

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRITER="$HOOK_DIR/lib/cache-write.sh"
# Installed layout co-locates lib/; in-repo the writer lives in hooks/shared/lib/.
[ -f "$WRITER" ] || WRITER="$HOOK_DIR/../shared/lib/cache-write.sh"
[ -f "$WRITER" ] || exit 0

INPUT=$(cat) || exit 0
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null) || exit 0
[ -z "$CWD" ] && exit 0
[ -d "$CWD" ] || exit 0
WORKSPACE_DIR=$(derive_workspace_dir "$CWD")
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0

case "$TOOL" in
  *memory_get)
    # The MCP result is wrapped as { content: [{ type:"text", text:<json> }] }.
    RESP_TEXT=$(printf '%s' "$INPUT" | jq -r \
      '.tool_response as $r | ($r.content[0].text // ($r | tostring))' 2>/dev/null) || exit 0
    ITEMS=$(printf '%s' "$RESP_TEXT" | jq -c \
      '[ (.data // [])[] | {id, source_path, content, title, type, scope, version, updated_at} ]' \
      2>/dev/null) || exit 0
    ;;
  *memory_create)
    ITEMS=$(printf '%s' "$INPUT" | jq -c '
      ((.tool_response.content[0].text // (.tool_response | tostring)) | try fromjson catch null) as $res
      | if $res == null then []
        else
          (.tool_input // {}) as $in
          | if (($res.id // "") == "") or (($in.content // "") == "") then []
            else [ { id: $res.id,
                     content: $in.content,
                     title: ($res.title // $in.title // ""),
                     type: ($in.type // ""),
                     scope: ($res.scope // $in.scope // "") } ]
            end
        end' 2>/dev/null) || exit 0
    ;;
  *) exit 0 ;;
esac

[ -z "$ITEMS" ] && exit 0
printf '%s' "$ITEMS" | jq -e 'length > 0' >/dev/null 2>&1 || exit 0
printf '%s' "$ITEMS" | bash "$WRITER" "$WORKSPACE_DIR/.agent-brain/cache"
exit 0
