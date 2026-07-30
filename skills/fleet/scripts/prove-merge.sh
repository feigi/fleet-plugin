#!/bin/sh
# Prove which head actually landed in a merge.
#
# Two proof paths, because a PR that is already current never gets rebased.
#
# rebase path (pre != post) — three legs, all required:
#   1. the pre-rebase head is NOT an ancestor of main  (the old version did not land)
#   2. the rebased head IS an ancestor of main         (the new version did)
#   3. the merge commit's second parent IS the rebased head
#
# no-rebase path (pre == post) — leg 1 is unsatisfiable here: a commit is its own
# ancestor, so leg 2 forces leg 1 true and nothing can ever prove. Its teeth move
# to headWasCurrent: the merge's first parent — the main tip the merge was built
# on — IS an ancestor of the merged head, which is what behind_by=0 means.
#
# Leg 1 and headWasCurrent are the legs with teeth. Without one of them "proved"
# is satisfiable by doing nothing at all, because an unrebased head that merged
# cleanly is also an ancestor of main. Both paths also require exactly two
# parents, so an octopus merge cannot drag an unreviewed third parent along
# behind a second parent that looks right.
set -eu

NAME=prove-merge
die() { echo "$NAME: $1" >&2; exit 2; }
is_ancestor() { if git merge-base --is-ancestor "$1" "$2" 2>/dev/null; then echo true; else echo false; fi; }

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

pre_full=$(git rev-parse "$pre")
post_full=$(git rev-parse "$post")

echo "\$ git merge-base --is-ancestor $pre $base" >&2
pre_anc=$(is_ancestor "$pre_full" "$base")
echo "    pre  is-ancestor = $pre_anc" >&2

echo "\$ git merge-base --is-ancestor $post $base  # expect SUCCESS" >&2
post_anc=$(is_ancestor "$post_full" "$base")
echo "    post is-ancestor = $post_anc (want true)" >&2

# Word-splitting is the point: "<merge> <parent>..." -> positional params.
set -- $(git rev-list --parents -n 1 "$merge")
shift
parents=$#
[ "$parents" -ge 2 ] || die "$merge has no second parent — not a merge commit"
first=$1
second=$2
echo "    ${merge}^1 = $first  (${parents} parents)" >&2
echo "    ${merge}^2 = $second" >&2
echo "    verified head = $post_full" >&2

head_current=$(is_ancestor "$first" "$post_full")

if [ "$pre_full" = "$post_full" ]; then
  proof_path=no-rebase
  teeth=$head_current
  echo "    no rebase (pre == post) — leg 1 replaced by headWasCurrent = $head_current (want true)" >&2
else
  proof_path=rebase
  if [ "$pre_anc" = false ]; then teeth=true; else teeth=false; fi
  echo "    rebase (pre != post) — leg 1 holds = $teeth (wants pre is-ancestor false)" >&2
fi

if [ "$teeth" = true ] && [ "$post_anc" = true ] && [ "$second" = "$post_full" ] && [ "$parents" -eq 2 ]; then
  proved=true
  rc=0
else
  proved=false
  rc=1
fi
echo "$NAME: proved=$proved (path=$proof_path)" >&2

printf '{"preIsAncestor":%s,"postIsAncestor":%s,"secondParent":"%s","firstParent":"%s","parentCount":%s,"proofPath":"%s","headWasCurrent":%s,"proved":%s}\n' \
  "$pre_anc" "$post_anc" "$second" "$first" "$parents" "$proof_path" "$head_current" "$proved"
exit "$rc"
