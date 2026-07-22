#!/bin/bash
# Shared index.md writer for agent-brain session-start and refresh hooks.
# Sourced, not executed. Best-effort: callers stay responsible for exit codes.

# Echo the ISO-8601 timestamp from a rendered index's header comment, or empty.
# Header shape: `<!-- agent-brain index — generated <ISO> for workspace ... -->`
ab_index_stamp() {
  printf '%s' "$1" | sed -n '1s/.*generated \([0-9TZ:.-]*\).*/\1/p'
}

# Create a per-writer temp file in the same directory as the target, so `mv`
# stays an atomic same-filesystem rename. Overlapping writers (e.g. the
# housekeeper refreshing in the background while the main thread also
# writes) each get their own temp — never a shared "${file}.tmp" — so two
# concurrent writes can't interleave into one file before either `mv`.
ab_mktemp_for() {
  mktemp "$1.tmp.XXXXXX" 2>/dev/null || printf '%s.tmp.%s' "$1" "$$"
}

# Monotonic, atomic write. Skips when the on-disk index carries a stamp strictly
# newer than the payload's — narrows (does not eliminate) the window in which an
# overlapping refresh clobbers: a slow earlier response can still overwrite a
# fast later one, because the stamp is read and the temp renamed in separate,
# non-atomic steps (read-stamp-then-mv is a TOCTOU race — a writer that reads the
# on-disk stamp, then is paused past another writer's `mv`, still clobbers). The
# guard only shrinks that window. ISO-8601 UTC strings are lexicographically
# ordered, so string comparison is correct.
# Args: <index_file> <full_content>. Returns 0 on write or intentional skip.
ab_write_index() {
  local file="$1" content="$2" new_stamp disk_stamp tmp
  new_stamp=$(ab_index_stamp "$content")
  if [ -f "$file" ] && [ -n "$new_stamp" ]; then
    disk_stamp=$(ab_index_stamp "$(cat "$file" 2>/dev/null)")
    if [ -n "$disk_stamp" ] && [ "$disk_stamp" \> "$new_stamp" ]; then
      return 0   # on-disk index is newer; skip
    fi
  elif [ -z "$new_stamp" ] && [ -n "$content" ]; then
    # Header drift: a non-empty payload with no parseable stamp can't be
    # compared, so the monotonic guard is skipped and this write proceeds
    # unconditionally — which may clobber a fresher on-disk index. Leave a
    # breadcrumb rather than dropping the anomaly silently.
    printf 'agent-brain write-index: no parseable stamp in payload; writing %s without monotonic guard\n' "$file" >&2
  fi
  tmp=$(ab_mktemp_for "$file")
  # Clean the temp on every return path (incl. an early `return 1` below, and a
  # signal that fires the RETURN trap) so a failure between printf and mv never
  # orphans it.
  trap 'rm -f "$tmp"' RETURN
  printf '%s' "$content" > "$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$file" 2>/dev/null || return 1
  return 0
}

# Replace-or-insert a stale-warning header, preserving the memory rows below.
# No-op when the file is absent (nothing stale to warn about; a session with no
# prior index needs no header). Idempotent: an existing stale block is replaced,
# never stacked. Args: <index_file> <reason>.
ab_stamp_stale() {
  local file="$1" reason="$2" now raw body tmp
  [ -f "$file" ] || return 0
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Capture the current content once, so the corruption check and the body
  # extraction see the same bytes.
  raw=$(cat "$file" 2>/dev/null)
  # Strip any prior stale block (the `> STALE:` blockquote lines) and the
  # generated-at comment, keeping everything from the first `#` heading on.
  # Also collapse the now-orphaned leading blank lines so repeated fallback
  # stamps don't accumulate blank lines before the preserved body; rows
  # themselves stay verbatim.
  body=$(printf '%s' "$raw" | sed '/^> STALE:/d; /^> (reason:/d; /^> Action queue NOT refreshed/d; /^> flags or relationships/d; /^<!-- agent-brain index/d' | sed '/./,$!d')
  # Data-loss guard: if the source carried real memory rows (a `#`-heading
  # line) but the extracted body came out empty, the read/strip failed —
  # aborting is far better than overwriting a populated index with a
  # header-only stub. A genuinely header-only/stale file (no `#` rows)
  # legitimately yields an empty body and must still re-stamp successfully, so
  # the `#`-heading presence is what distinguishes "rows we failed to read"
  # from "no rows to lose".
  if [ -z "$body" ] && printf '%s\n' "$raw" | grep -q '^#'; then
    printf 'agent-brain stamp-stale: refusing to overwrite %s — rows present but extracted body empty\n' "$file" >&2
    return 1
  fi
  tmp=$(ab_mktemp_for "$file")
  # Clean the temp on every return path (see ab_write_index).
  trap 'rm -f "$tmp"' RETURN
  {
    printf '<!-- agent-brain index — STALE %s -->\n\n' "$now"
    printf '> STALE: session_start failed %s\n' "$now"
    printf '> (reason: %s)\n' "$reason"
    printf '> Action queue NOT refreshed — do not act on\n'
    printf '> flags or relationships from this file.\n\n'
    printf '%s' "$body"
  } > "$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$file" 2>/dev/null || return 1
  return 0
}
