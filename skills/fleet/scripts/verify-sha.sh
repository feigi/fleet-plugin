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

# Nothing below silences git. Each of these is silent on its healthy path, so
# the only stderr it can add is the diagnosis of a failure, and swallowing that
# leaves the die message asserting a cause the script cannot know. A bad remote
# URL and a removed remote are both "cannot fetch"; only git can say which.
echo "\$ git fetch --quiet origin $branch" >&2
git fetch --quiet origin "$branch" \
  || die "cannot fetch origin/$branch"

tip=$(git rev-parse "origin/$branch") \
  || die "origin/$branch does not resolve after fetch"
echo "    origin/$branch tip = $tip" >&2

# Fail closed on an unknown object: "not reachable" and "never heard of it" are
# different answers, and only one of them is a finding about the branch. The
# message stops at what the guard observed: cat-file -e also fails on an object
# that is present but is not a commit, and on an object store it cannot read.
git cat-file -e "${sha}^{commit}" \
  || die "cannot resolve $sha to a commit in this repository"

# Exit 1 is the answer "no"; anything else is git failing to answer, and the one
# distinction this script exists to make must never be read off a failure. Keep
# the status read first in the branch — anything above it overwrites $?. git is
# silent on a plain "no", so the rule above costs this branch nothing: a real
# negative still reaches the controller with no git noise attached.
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
