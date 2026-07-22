#!/bin/bash
# Materialize agent-brain memories as clickable files under <cache_dir>.
# Usage:  cache-write.sh <cache_dir>      (JSON array of items on stdin)
# Item:   {id, source_path?, content?, title?, type?, scope?, version?, updated_at?}
# Symlinks <cache_dir>/<id>.md -> source_path when that file exists; otherwise
# writes a frontmatter+content copy. Best-effort: logs to stderr, ALWAYS exits 0.
set -uo pipefail

CACHE_DIR="${1:-}"
[ -z "$CACHE_DIR" ] && { echo "cache-write: no cache dir arg" >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "cache-write: jq missing" >&2; exit 0; }

INPUT=$(cat)
printf '%s' "$INPUT" | jq -e 'type == "array"' >/dev/null 2>&1 \
  || { echo "cache-write: stdin is not a JSON array" >&2; exit 0; }

mkdir -p "$CACHE_DIR" 2>/dev/null || { echo "cache-write: mkdir $CACHE_DIR failed" >&2; exit 0; }
# Self-contained ignore (the parent .agent-brain/ is normally ignored too).
[ -f "$CACHE_DIR/.gitignore" ] || printf '*\n' > "$CACHE_DIR/.gitignore" 2>/dev/null || true

write_one() {
  local id="$1" src="$2" content="$3" title="$4" type="$5" scope="$6" version="$7" updated="$8"
  # Reject empty, path-traversal, backslash, or dot-only ids.
  case "$id" in
    ""|.|..) echo "cache-write: unsafe id '$id' skipped" >&2; return ;;
  esac
  case "$id" in
    */* | *\\*) echo "cache-write: unsafe id '$id' skipped" >&2; return ;;
  esac
  local target="$CACHE_DIR/$id.md"
  if [ -n "$src" ] && [ -e "$src" ]; then
    if ln -sfn "$src" "$target" 2>/dev/null; then return; fi
    echo "cache-write: symlink failed for $id; copying" >&2
  fi
  [ -z "$content" ] && { echo "cache-write: no content/source for $id" >&2; return; }
  local tmp="$target.tmp.$$"
  {
    printf -- '---\n'
    printf 'id: %s\n' "$id"
    [ -n "$title" ]   && printf 'title: %s\n' "$title"
    [ -n "$type" ]    && printf 'type: %s\n' "$type"
    [ -n "$scope" ]   && printf 'scope: %s\n' "$scope"
    [ -n "$version" ] && printf 'version: %s\n' "$version"
    [ -n "$updated" ] && printf 'updated_at: %s\n' "$updated"
    printf -- '---\n\n%s\n' "$content"
  } > "$tmp" 2>/dev/null
  if mv -f "$tmp" "$target" 2>/dev/null; then
    :
  else
    echo "cache-write: write failed for $id" >&2
    rm -f "$tmp" 2>/dev/null || true
  fi
}

while IFS= read -r item; do
  [ -z "$item" ] && continue
  id=$(printf '%s' "$item" | jq -r '.id // ""')
  [ -z "$id" ] && { echo "cache-write: item missing id" >&2; continue; }
  src=$(printf '%s'     "$item" | jq -r '.source_path // ""')
  content=$(printf '%s' "$item" | jq -r '.content // ""')
  title=$(printf '%s'   "$item" | jq -r '.title // ""')
  type=$(printf '%s'    "$item" | jq -r '.type // ""')
  scope=$(printf '%s'   "$item" | jq -r '.scope // ""')
  version=$(printf '%s' "$item" | jq -r '.version // ""')
  updated=$(printf '%s' "$item" | jq -r '.updated_at // ""')
  write_one "$id" "$src" "$content" "$title" "$type" "$scope" "$version" "$updated"
done < <(printf '%s' "$INPUT" | jq -c '.[]')

exit 0
