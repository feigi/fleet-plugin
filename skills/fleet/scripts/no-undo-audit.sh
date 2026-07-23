#!/bin/sh
# Is this worktree safe to rebase, and what would a careless resolution eat?
#
# A rebase resolved the wrong way silently reverts work already in main. It looks
# like an ordinary conflict resolution and passes CI, because the branch's own
# tests never covered what it undid.
#
# This REFUSES; it does not repair. Choosing the resolution is judgement and
# stays with the caller. Exit 0 safe, 1 refused, 2 unanswerable.
set -eu

NAME=no-undo-audit
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -eq 2 ] || die "usage: no-undo-audit.sh <worktree> <branch>"
wt=$1
branch=$2
base=${BASE_REF:-origin/main}

[ -d "$wt" ] || die "worktree $wt does not exist"
git -C "$wt" rev-parse --git-dir >/dev/null 2>&1 || die "$wt is not a git worktree"
git -C "$wt" rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

# 1. Uncommitted work. This may exist nowhere else on disk.
echo "\$ git -C $wt status --porcelain" >&2
porcelain=$(git -C "$wt" status --porcelain || true)
if [ -n "$porcelain" ]; then
  clean=false
  echo "$porcelain" | sed 's/^/    /' >&2
else
  clean=true
  echo "    clean" >&2
fi

# The stash stack is repo-global across worktrees. Report it; never pop, drop or
# apply an entry this process did not create.
stash=$(git -C "$wt" stash list 2>/dev/null | wc -l | tr -d ' ')
echo "    stash entries (repo-global): $stash" >&2

# 2. Which files would conflict.
echo "\$ git merge-tree --write-tree --name-only $base origin/$branch" >&2
conflicts=$(git -C "$wt" merge-tree --write-tree --name-only "$base" "origin/$branch" 2>/dev/null | tail -n +2 || true)
if [ -n "$conflicts" ]; then
  echo "$conflicts" | sed 's/^/    conflict: /' >&2
else
  echo "    no conflicting files" >&2
fi
conflicts_json=$(printf '%s' "$conflicts" | awk 'NF{print "\""$0"\""}' | paste -sd, -)

# 3. What main gained in those files since the fork. These are the commits a
#    careless resolution deletes — read them before resolving, not after.
at_risk=""
if [ -n "$conflicts" ]; then
  fork=$(git -C "$wt" merge-base "$base" "origin/$branch" 2>/dev/null || true)
  if [ -n "$fork" ]; then
    echo "\$ git log --oneline $fork..$base -- <conflicting files>" >&2
    # shellcheck disable=SC2086
    at_risk=$(git -C "$wt" log --oneline "$fork".."$base" -- $conflicts 2>/dev/null || true)
    [ -n "$at_risk" ] && echo "$at_risk" | sed 's/^/    at risk: /' >&2
  fi
fi
at_risk_json=$(printf '%s' "$at_risk" | awk 'NF{gsub(/"/,"\\\""); print "\""$0"\""}' | paste -sd, -)

if [ "$clean" = true ] && [ "$stash" -eq 0 ]; then
  rc=0
else
  rc=1
  echo "$NAME: REFUSED — commit or stash-list-clear before rebasing. Never \`git clean\`," >&2
  echo "  \`git checkout .\`, \`git reset --hard\` or \`git stash drop\` to make a rebase start." >&2
fi

printf '{"worktree":"%s","branch":"%s","clean":%s,"stash":%s,"conflicts":[%s],"atRisk":[%s]}\n' \
  "$wt" "$branch" "$clean" "$stash" "$conflicts_json" "$at_risk_json"
exit "$rc"
