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
# A branch never pushed, a stale remote-tracking ref, or a caller who already
# passed a name prefixed "origin/" all make this not resolve. Left unchecked,
# merge-tree below fails silently and "no conflicting files" is printed for a
# question that was never actually answered.
git -C "$wt" rev-parse --verify --quiet "origin/$branch" >/dev/null \
  || die "origin/$branch does not resolve — fetch it, or it was never pushed"

# 1. Uncommitted work. This may exist nowhere else on disk. `|| true` here would
#    turn a failed `status` into empty output and print "clean" over a dirty
#    tree — and since the stash count stopped gating, nothing else would catch
#    it. Unanswerable is exit 2, never exit 0. Same rule as worktree-audit.sh.
echo "\$ git -C $wt status --porcelain" >&2
porcelain=$(git -C "$wt" status --porcelain) \
  || die "git status failed in $wt — cannot tell a clean worktree from a dirty one"
if [ -n "$porcelain" ]; then
  clean=false
  echo "$porcelain" | sed 's/^/    /' >&2
else
  clean=true
  echo "    clean" >&2
fi

# Repo-global across worktrees, and a rebase never consumes a pre-existing entry
# — `--autostash` stores its own on top, never takes yours. So the count says
# nothing about whether THIS rebase loses THIS branch's work. Reported, never
# gated: gating refused every run in a repo holding any entry, and a check that
# always fires is one nobody reads. Read the list when it is nonzero — an entry
# labelled `on <this branch>` may be a dead member's only copy.
#
# It cannot cover the hazard it looks like it covers, either. A member running
# `git stash` to clear a dirty worktree leaves `porcelain` empty, so `clean` is
# already true — and `-u` takes the untracked files too, so no case is left that
# this still refuses. Entries carry `WIP on <branch>`, so an old entry on
# ANOTHER branch is separable; a stale one on THIS branch is not, and telling it
# from the member's fresh entry needs a count the caller captured before the
# member ran. This script runs once, before the rebase, so it has no baseline.
#
# Never pop, drop or apply an entry this process did not create.
stash=$(git -C "$wt" stash list 2>/dev/null | wc -l | tr -d ' ')
echo "    stash entries (repo-global, not gated): $stash" >&2

# 2. Which files would conflict. merge-tree exits 0 clean, 1 conflicts found,
#    >=1 other on real failure (bad refs, corrupt tree, etc — treat >=2 as an
#    error; exit 1 is the only "ran fine, found conflicts" outcome). Losing
#    that distinction is how a branch that never resolved gets reported safe.
echo "\$ git merge-tree --write-tree --name-only $base origin/$branch" >&2
if merge_tree_out=$(git -C "$wt" merge-tree --write-tree --name-only "$base" "origin/$branch"); then
  mt_rc=0
else
  mt_rc=$?
fi
case "$mt_rc" in
  0|1) : ;;
  *) die "git merge-tree failed (exit $mt_rc) against origin/$branch — cannot determine conflicts" ;;
esac

# --name-only output is: tree OID, then (if conflicted) the conflicted-file
# list, then a BLANK LINE, then prose ("Auto-merging ...", "CONFLICT ...").
# Only the section before that first blank line is filenames — the old
# `tail -n +2` grabbed the prose section too and word-split it into the
# `git log -- $conflicts` pathspec below.
conflicts=$(printf '%s\n' "$merge_tree_out" | awk 'NR==1{next} /^$/{exit} {print}')
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

if [ "$clean" = true ]; then
  rc=0
else
  rc=1
  echo "$NAME: REFUSED — commit the worktree before rebasing. Never \`git clean\`," >&2
  echo "  \`git checkout .\`, \`git reset --hard\` or \`git stash\` to make a rebase start." >&2
fi

printf '{"worktree":"%s","branch":"%s","clean":%s,"stash":%s,"conflicts":[%s],"atRisk":[%s]}\n' \
  "$wt" "$branch" "$clean" "$stash" "$conflicts_json" "$at_risk_json"
exit "$rc"
