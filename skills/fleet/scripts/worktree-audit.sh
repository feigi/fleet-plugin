#!/bin/sh
# Per worktree: how many commits ahead of the base, and what is uncommitted.
#
# Run before dispatching a replacement for a killed member. The distinction that
# matters is committed-and-pushed vs committed-only vs uncommitted-in-the-worktree:
# only the last exists nowhere else, and a replacement told the wrong one will
# either redo finished work or destroy unfinished work.
#
# Read-only. Never exits non-zero for a dirty or absent worktree — that is the
# finding, not an error.
set -eu

NAME=worktree-audit
die() { echo "$NAME: $1" >&2; exit 2; }

base=${BASE_REF:-origin/main}
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

echo "\$ git worktree list --porcelain" >&2

first=1
printf '['
git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{print w"\t"$2} /^detached$/{print w"\tDETACHED"}' |
while IFS="$(printf '\t')" read -r wt br; do
  short=${br#refs/heads/}
  if [ -d "$wt" ]; then
    ahead=$(git -C "$wt" rev-list --count "$base"..HEAD 2>/dev/null || echo 0)
    dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    files=$(git -C "$wt" status --porcelain 2>/dev/null | awk '{print "\""$2"\""}' | paste -sd, -)
  else
    ahead=0; dirty=0; files=""
    echo "    MISSING on disk: $wt" >&2
  fi
  echo "    $wt  branch=$short  ahead=$ahead  dirty=$dirty" >&2
  [ "$first" = 1 ] || printf ','
  first=0
  printf '{"worktree":"%s","branch":"%s","ahead":%s,"dirty":%s,"dirtyFiles":[%s]}' \
    "$wt" "$short" "$ahead" "$dirty" "$files"
done
printf ']\n'
