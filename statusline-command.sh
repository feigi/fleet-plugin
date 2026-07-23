#!/usr/bin/env bash
# Claude Code statusLine command
# Sections: worktree/session name + branch | model(ctx)@effort | ctx% | 5h usage | cost | PR/GitHub link

set -uo pipefail

INPUT=$(cat)

# ---------------------------------------------------------------------------
# 1. Worktree / session name + git branch
# ---------------------------------------------------------------------------
SESSION_NAME=$(printf '%s' "$INPUT" | jq -r '.session_name // empty' 2>/dev/null)
WORKTREE_NAME=$(printf '%s' "$INPUT" | jq -r '.worktree.name // empty' 2>/dev/null)
WORKTREE_BRANCH=$(printf '%s' "$INPUT" | jq -r '.worktree.branch // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)

# Prefer worktree name, then session name, then basename of cwd
if [ -n "$WORKTREE_NAME" ]; then
  DISPLAY_NAME="$WORKTREE_NAME"
elif [ -n "$SESSION_NAME" ]; then
  DISPLAY_NAME="$SESSION_NAME"
elif [ -n "$CWD" ]; then
  DISPLAY_NAME=$(basename "$CWD")
else
  DISPLAY_NAME="claude"
fi

# Git branch: use worktree branch first, then detect from cwd
GIT_BRANCH=""
if [ -n "$WORKTREE_BRANCH" ]; then
  GIT_BRANCH="$WORKTREE_BRANCH"
elif [ -n "$CWD" ] && [ -d "$CWD" ]; then
  GIT_BRANCH=$(git -C "$CWD" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null || true)
fi

if [ -n "$GIT_BRANCH" ]; then
  SECTION1=$(printf '\033[38;5;250m%s\033[0m \033[38;5;240m[%s]\033[0m' "$DISPLAY_NAME" "$GIT_BRANCH")
else
  SECTION1=$(printf '\033[38;5;250m%s\033[0m' "$DISPLAY_NAME")
fi

# ---------------------------------------------------------------------------
# 2. Model + context window size + effort
# ---------------------------------------------------------------------------
MODEL_DISPLAY=$(printf '%s' "$INPUT" | jq -r '.model.display_name // .model.id // "Claude"' 2>/dev/null)
CTX_SIZE=$(printf '%s' "$INPUT" | jq -r '.context_window.context_window_size // 0' 2>/dev/null)
EFFORT=$(printf '%s' "$INPUT" | jq -r '.effort.level // empty' 2>/dev/null)

# Shorten model display name: strip "Claude" prefix and any trailing
# parenthetical (e.g. " (1M context)") — CTX_LABEL is re-appended below.
MODEL_SHORT=$(printf '%s' "$MODEL_DISPLAY" \
  | sed -E 's/^Claude //; s/^claude-//; s/ *\([^)]*\)$//')

# Format context window size
if [ "$CTX_SIZE" -ge 1000000 ] 2>/dev/null; then
  CTX_LABEL="$(echo "$CTX_SIZE" | awk '{printf "%dM", $1/1000000}')"
elif [ "$CTX_SIZE" -ge 1000 ] 2>/dev/null; then
  CTX_LABEL="$(echo "$CTX_SIZE" | awk '{printf "%dk", $1/1000}')"
else
  CTX_LABEL=""
fi

if [ -n "$CTX_LABEL" ]; then
  MODEL_PART="${MODEL_SHORT} (${CTX_LABEL})"
else
  MODEL_PART="$MODEL_SHORT"
fi

if [ -n "$EFFORT" ]; then
  SECTION2="${MODEL_PART}@${EFFORT}"
else
  SECTION2="$MODEL_PART"
fi

# ---------------------------------------------------------------------------
# 3. Context window usage percentage (colored)
# ---------------------------------------------------------------------------
USED_PCT=$(printf '%s' "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)

if [ -n "$USED_PCT" ]; then
  USED_INT=$(printf '%.0f' "$USED_PCT" 2>/dev/null || echo "0")
  # Color: green < 50%, yellow 50-79%, red >= 80%
  if [ "$USED_INT" -ge 80 ]; then
    PCT_COLOR='\033[0;31m'
  elif [ "$USED_INT" -ge 50 ]; then
    PCT_COLOR='\033[0;33m'
  else
    PCT_COLOR='\033[0;32m'
  fi
  SECTION3=$(printf '\033[38;5;250mctx:\033[0m '"${PCT_COLOR}"'%d%%\033[0m' "$USED_INT")
else
  SECTION3=""
fi

# ---------------------------------------------------------------------------
# 4. 5-hour rate limit usage + time to reset (colored)
# ---------------------------------------------------------------------------
FIVE_PCT=$(printf '%s' "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
FIVE_RESET=$(printf '%s' "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)

SECTION4=""
if [ -n "$FIVE_PCT" ]; then
  FIVE_INT=$(printf '%.0f' "$FIVE_PCT" 2>/dev/null || echo "0")
  RESET_LABEL=""
  if [ -n "$FIVE_RESET" ]; then
    NOW=$(date +%s)
    DIFF=$(( FIVE_RESET - NOW ))
    if [ "$DIFF" -gt 0 ]; then
      HH=$(( DIFF / 3600 ))
      MM=$(( (DIFF % 3600) / 60 ))
      RESET_LABEL=$(printf '\033[38;5;240m (rst T-%02d:%02d)\033[0m' "$HH" "$MM")
    fi
  fi

  if [ "$FIVE_INT" -ge 80 ]; then
    PCT5_COLOR='\033[0;31m'
  elif [ "$FIVE_INT" -ge 50 ]; then
    PCT5_COLOR='\033[0;33m'
  else
    PCT5_COLOR='\033[0;32m'
  fi
  SECTION4=$(printf '\033[38;5;250m5h:\033[0m '"${PCT5_COLOR}"'%d%%\033[0m%s' "$FIVE_INT" "$RESET_LABEL")
fi

# ---------------------------------------------------------------------------
# 5. Cost: absolute total + last-turn delta
# ---------------------------------------------------------------------------
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
COST_FILE="/tmp/claude-cost-${SESSION_ID}"
BASELINE_FILE="/tmp/claude-cost-baseline-${SESSION_ID}"
CLEAR_PENDING="/tmp/claude-clear-pending-${SESSION_ID}"

# Extract cost from transcript (sum of all costUSD fields)
TOTAL_COST=""
if [ -n "$SESSION_ID" ]; then
  TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    TOTAL_COST=$(jq -s '[.[].costUSD // 0] | add // 0' "$TRANSCRIPT" 2>/dev/null || true)
  fi
fi

SECTION5=""
if [ -n "$TOTAL_COST" ] && [ "$TOTAL_COST" != "0" ] && [ "$TOTAL_COST" != "null" ]; then
  # Handle /clear baseline reset
  BASELINE=0
  if [ -f "$CLEAR_PENDING" ]; then
    printf '%s' "$TOTAL_COST" > "$BASELINE_FILE"
    rm -f "$CLEAR_PENDING"
  fi
  if [ -f "$BASELINE_FILE" ]; then
    BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null || echo "0")
  fi

  # Session display cost = total - baseline
  DISPLAY_COST=$(awk "BEGIN {printf \"%.2f\", $TOTAL_COST - $BASELINE}" 2>/dev/null || echo "0.00")

  # Last-turn delta
  PREV_COST=0
  if [ -f "$COST_FILE" ]; then
    PREV_COST=$(cat "$COST_FILE" 2>/dev/null || echo "0")
  fi
  DELTA=$(awk "BEGIN {d = $TOTAL_COST - $PREV_COST; printf \"%.2f\", (d < 0) ? 0 : d}" 2>/dev/null || echo "0.00")
  printf '%s' "$TOTAL_COST" > "$COST_FILE"

  if [ "$DELTA" != "0.00" ]; then
    SECTION5=$(printf '\$%.2f (+\$%s)' "$DISPLAY_COST" "$DELTA")
  else
    SECTION5=$(printf '\$%.2f' "$DISPLAY_COST")
  fi
fi

# ---------------------------------------------------------------------------
# 6. GitHub repo link
# ---------------------------------------------------------------------------
SECTION6=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  REMOTE_URL=$(git -C "$CWD" --no-optional-locks remote get-url origin 2>/dev/null || true)
  if [ -n "$REMOTE_URL" ]; then
    HTTPS_URL=$(printf '%s' "$REMOTE_URL" \
      | sed 's|git@\([^:]*\):\(.*\)\.git$|https://\1/\2|' \
      | sed 's|git@\([^:]*\):\(.*\)$|https://\1/\2|' \
      | sed 's|\.git$||')
    SECTION6=$(printf '\033]8;;%s\033\\GitHub\033]8;;\033\\' "$HTTPS_URL")
  fi
fi

# ---------------------------------------------------------------------------
# Assemble sections, separated by " | "
# ---------------------------------------------------------------------------
LINE1_PARTS=()
[ -n "$SECTION1" ] && LINE1_PARTS+=("$SECTION1")
[ -n "$SECTION2" ] && LINE1_PARTS+=("$SECTION2")

LINE2_PARTS=()
[ -n "$SECTION3" ] && LINE2_PARTS+=("$SECTION3")
[ -n "$SECTION4" ] && LINE2_PARTS+=("$SECTION4")
[ -n "$SECTION5" ] && LINE2_PARTS+=("$SECTION5")
[ -n "$SECTION6" ] && LINE2_PARTS+=("$SECTION6")

join_parts() {
  local out=""
  for p in "$@"; do
    [ -z "$out" ] && out="$p" || out="${out} | ${p}"
  done
  printf '%s' "$out"
}

LINE1=$(join_parts "${LINE1_PARTS[@]+"${LINE1_PARTS[@]}"}")
LINE2=$(join_parts "${LINE2_PARTS[@]+"${LINE2_PARTS[@]}"}")

if [ -n "$LINE1" ] && [ -n "$LINE2" ]; then
  printf '%b\n%b\n' "$LINE1" "$LINE2"
elif [ -n "$LINE1" ]; then
  printf '%b\n' "$LINE1"
else
  printf '%b\n' "$LINE2"
fi
