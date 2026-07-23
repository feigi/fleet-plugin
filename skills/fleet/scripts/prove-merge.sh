#!/bin/sh
# Prove which head actually landed in a rebase-then-merge.
#
# Three legs, and all three must hold:
#   1. the pre-rebase head is NOT an ancestor of main  (the old version did not land)
#   2. the rebased head IS an ancestor of main         (the new version did)
#   3. the merge commit's second parent IS the rebased head
#
# Leg 1 is the one with teeth. Without it "proved" is satisfiable by doing
# nothing at all, because an unrebased head that merged cleanly is also an
# ancestor of main.
set -eu

NAME=prove-merge
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -eq 3 ] || die "usage: prove-merge.sh <pre-rebase-head> <rebased-head> <merge-commit>"
pre=$1
post=$2
merge=$3
base=${BASE_REF:-origin/main}

echo "\$ git fetch --quiet origin" >&2
git fetch --quiet origin || die "fetch failed — refusing to prove a merge on stale refs"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

for obj in "$pre" "$post" "$merge"; do
  git cat-file -e "${obj}^{commit}" 2>/dev/null || die "$obj is not a commit in this repository"
done

echo "\$ git merge-base --is-ancestor $pre $base   # expect FAILURE" >&2
if git merge-base --is-ancestor "$pre" "$base" 2>/dev/null; then
  pre_anc=true
else
  pre_anc=false
fi
echo "    pre  is-ancestor = $pre_anc (want false)" >&2

echo "\$ git merge-base --is-ancestor $post $base  # expect SUCCESS" >&2
if git merge-base --is-ancestor "$post" "$base" 2>/dev/null; then
  post_anc=true
else
  post_anc=false
fi
echo "    post is-ancestor = $post_anc (want true)" >&2

second=$(git rev-parse "${merge}^2" 2>/dev/null) || die "$merge has no second parent — not a merge commit"
post_full=$(git rev-parse "$post")
echo "    ${merge}^2 = $second" >&2
echo "    rebased head = $post_full" >&2

if [ "$pre_anc" = false ] && [ "$post_anc" = true ] && [ "$second" = "$post_full" ]; then
  proved=true
  rc=0
else
  proved=false
  rc=1
fi
echo "$NAME: proved=$proved" >&2

printf '{"preIsAncestor":%s,"postIsAncestor":%s,"secondParent":"%s","proved":%s}\n' \
  "$pre_anc" "$post_anc" "$second" "$proved"
exit "$rc"
