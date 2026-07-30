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
# no-rebase path (pre == post) — leg 1 is dropped, because legs 1 and 2 cannot
# both hold here: a commit is its own ancestor, so leg 2 (post IS an ancestor)
# makes leg 1 (pre is NOT an ancestor) fail by definition, and nothing can ever
# prove. Note leg 1 alone is perfectly satisfiable when pre == post — it holds
# whenever the merge has not landed. It is the *conjunction* that is impossible.
#
# Two gates carry the weight instead, and both are required on BOTH paths:
#
#   headWasCurrent — the merge's first parent IS an ancestor of the merged head,
#                    which is what behind_by=0 means for a merge built on main.
#   merge ∈ base   — <merge> is reachable from $base, so that first parent really
#                    is a main tip and not something the caller made up.
#
# Both read structure off the merge object rather than off a ref, so the fetch
# below cannot establish them the way it can establish legs 1 and 2.
#
# Leg 1 is not a substitute for headWasCurrent: it proves the pre-rebase version
# did not land, not that the merged head was current, and it only bites a caller
# who reports `pre` honestly. headWasCurrent is derived from history alone, which
# is why it is required even on the rebase path — see run-merge-bot.md, "you are
# the only place currency is proven". Both paths also require exactly two parents,
# so an octopus merge cannot drag an unreviewed third parent along behind a second
# parent that looks right.
set -eu

NAME=prove-merge
die() { echo "$NAME: $1" >&2; exit 2; }
# Exit 1 is the answer "no"; anything else is git failing to answer, and a proof
# must never read a failure as a leg it likes.
is_ancestor() {
  if git merge-base --is-ancestor "$1" "$2"; then echo true; else
    [ $? -eq 1 ] || die "git merge-base --is-ancestor $1 $2 failed — cannot prove anything"
    echo false
  fi
}

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

# Everything below reads structure off $merge, so an object the caller made up
# would otherwise prove whatever it was built to prove.
echo "\$ git merge-base --is-ancestor $merge $base" >&2
[ "$(is_ancestor "$merge" "$base")" = true ] || die "$merge is not reachable from $base — that merge did not land"

pre_full=$(git rev-parse "$pre")
post_full=$(git rev-parse "$post")

echo "\$ git merge-base --is-ancestor $pre $base" >&2
pre_anc=$(is_ancestor "$pre_full" "$base")
echo "    pre  is-ancestor = $pre_anc" >&2

echo "\$ git merge-base --is-ancestor $post $base  # expect SUCCESS" >&2
post_anc=$(is_ancestor "$post_full" "$base")
echo "    post is-ancestor = $post_anc (want true)" >&2

# Trailing -- so a <merge> that also names a file is a revision, not an ambiguity.
# Captured first: the status of a substitution inside `set --` is discarded, and
# an empty result would trip `shift` and exit 1 — indistinguishable from a disproof.
parent_line=$(git rev-list --parents -n 1 "$merge" --) || die "cannot read the parents of $merge"
# Word-splitting is the point: "<merge> <parent>..." -> positional params.
# shellcheck disable=SC2086
set -- $parent_line
shift
parents=$#
[ "$parents" -ge 2 ] || die "$merge has no second parent — not a merge commit"
first=$1
second=$2
echo "    ${merge}^1 = $first  (${parents} parents)" >&2
echo "    ${merge}^2 = $second" >&2
echo "    claimed head = $post_full" >&2

echo "\$ git merge-base --is-ancestor $first $post_full" >&2
head_current=$(is_ancestor "$first" "$post_full")

if [ "$pre_full" = "$post_full" ]; then
  proof_path=no-rebase
  teeth=true
  echo "    no rebase (pre == post) — leg 1 dropped, headWasCurrent carries it" >&2
else
  proof_path=rebase
  if [ "$pre_anc" = false ]; then teeth=true; else teeth=false; fi
  echo "    rebase (pre != post) — pre is-ancestor = $pre_anc, so leg 1 = $teeth (wants false)" >&2
fi
echo "    headWasCurrent = $head_current (want true, both paths)" >&2

if [ "$teeth" = true ] && [ "$head_current" = true ] && [ "$post_anc" = true ] &&
   [ "$second" = "$post_full" ] && [ "$parents" -eq 2 ]; then
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
