#!/bin/sh
# Is ticket <N> already being worked on?
#
# Three probes, all of them, every time: an existing PR, a remote branch, a
# local worktree or branch. Any hit means taken. They are not redundant — a PR
# can exist with its branch deleted, a branch can exist with no PR yet, and a
# worktree can exist before anything is pushed.
#
# Exit 0 free, 1 taken, 2 the question could not be answered.
set -eu

NAME=inflight
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -eq 1 ] || die "usage: inflight.sh <issue-number>"
n=$1
case "$n" in ''|*[!0-9]*) die "issue must be a number, got '$n'";; esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

hits=""
add_hit() { hits="${hits}\"$1\","; echo "    HIT: $1" >&2; }

# Probe 1 — any PR, in any state, referencing this number.
echo "\$ gh pr list --state all --search $n --json number,title,state" >&2
pr=$(gh pr list --state all --search "$n" --json number,title,state --jq \
      '[.[]|"#\(.number) \(.state)"]|join(", ")' 2>/dev/null) \
  || die "gh pr list failed — cannot determine whether #$n is taken"
if [ -n "$pr" ] && [ "$pr" != "" ]; then
  echo "    PRs: $pr" >&2
  add_hit "pr"
else
  echo "    no PR references #$n" >&2
fi

# Probe 2 — a remote branch carrying the number as its own path segment.
echo "\$ git ls-remote --heads origin" >&2
remote=$(git ls-remote --heads origin 2>/dev/null | awk '{print $2}' | sed 's#refs/heads/##' |
         grep -E "(^|[/-])$n([-/]|$)" | paste -sd, - || true)
if [ -n "$remote" ]; then
  echo "    remote branches: $remote" >&2
  add_hit "remote-branch"
else
  echo "    no remote branch for #$n" >&2
fi

# Probe 3 — a local worktree or branch.
local_b=$(git for-each-ref --format='%(refname:short)' refs/heads |
          grep -E "(^|[/-])$n([-/]|$)" | paste -sd, - || true)
wt=$(git worktree list --porcelain | awk '/^worktree /{print $2}' |
     grep -E "(^|[/-])$n([-/]|$)" | paste -sd, - || true)
if [ -n "$local_b" ] || [ -n "$wt" ]; then
  [ -n "$local_b" ] && echo "    local branches: $local_b" >&2
  [ -n "$wt" ] && echo "    worktrees: $wt" >&2
  add_hit "local"
else
  echo "    no local branch or worktree for #$n" >&2
fi

if [ -n "$hits" ]; then
  taken=true
  rc=1
else
  taken=false
  rc=0
fi
echo "$NAME: #$n taken=$taken" >&2

printf '{"issue":%s,"taken":%s,"hits":[%s],"evidence":{"pr":"%s","remote":"%s","localBranch":"%s","worktree":"%s"}}\n' \
  "$n" "$taken" "${hits%,}" "$pr" "$remote" "$local_b" "$wt"
exit "$rc"
