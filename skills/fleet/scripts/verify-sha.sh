#!/bin/sh
# Is <sha> reachable on origin/<branch>?
#
# A member can create a nested worktree and commit there, leaving the SHA it
# reports on a stray branch while its report reads entirely normally. Enqueueing
# that PR for review wastes a reviewer on work that is not where it claims.
#
# Exit 0 reachable, 1 not reachable, 2 the question could not be answered.
set -eu

NAME=verify-sha
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -eq 2 ] || die "usage: verify-sha.sh <branch> <sha>"
branch=$1
sha=$2

echo "\$ git fetch --quiet origin $branch" >&2
git fetch --quiet origin "$branch" 2>/dev/null \
  || die "cannot fetch origin/$branch — branch missing, or no network"

tip=$(git rev-parse "origin/$branch" 2>/dev/null) \
  || die "origin/$branch does not resolve after fetch"
echo "    origin/$branch tip = $tip" >&2

# Fail closed on an unknown object: "not reachable" and "never heard of it" are
# different answers, and only one of them is a finding about the branch.
git cat-file -e "${sha}^{commit}" 2>/dev/null \
  || die "$sha is not a commit object in this repository"

# Exit 1 is the answer "no"; anything else is git failing to answer, and the one
# distinction this script exists to make must never be read off a failure. Keep
# the status read first in the branch — anything above it overwrites $?. git is
# silent on a plain "no", so no 2>/dev/null here: the only stderr it can add is
# the cause of a failure the operator needs.
if git merge-base --is-ancestor "$sha" "origin/$branch"; then
  reachable=true
  rc=0
  echo "    $sha IS reachable on origin/$branch" >&2
else
  [ $? -eq 1 ] || die "git merge-base --is-ancestor failed — cannot tell reachable from unanswerable"
  reachable=false
  rc=1
  echo "    $sha is NOT reachable on origin/$branch" >&2
fi

printf '{"branch":"%s","sha":"%s","reachable":%s,"tip":"%s"}\n' \
  "$branch" "$sha" "$reachable" "$tip"
exit "$rc"
