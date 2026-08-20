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
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it. Exit 1 out of THIS script means "the proof is a
# no", which the merge bot reads as a reason to refuse a merge, so a missing
# library must not be able to say it — which is why `[ -r ]` has to fire before
# the `.` can kill the shell.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to answer without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"
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
# Nothing below silences git: --quiet and 2>/dev/null discarded the only line
# that separates the causes, and both guards are silent when they succeed.
# --verify stays — without it a $base that names a FILE resolves and exits 0.
git rev-parse --verify "$base" >/dev/null || die "$base does not resolve"

for obj in "$pre" "$post" "$merge"; do
  # Stops at what the guard observed: cat-file -e also fails on an object that
  # is present but is not a commit, and on an object store it cannot read.
  git cat-file -e "${obj}^{commit}" || die "cannot resolve $obj to a commit in this repository"
done

# Everything below reads structure off $merge, so an object the caller made up
# would otherwise prove whatever it was built to prove.
echo "\$ git merge-base --is-ancestor $merge $base" >&2
# Assigned first, not tested inline: `die` inside `$(...)` exits the subshell,
# and `[ ]` discards that status, so `set -e` never fires and a probe that could
# not answer falls through to the disproof below — a verdict never established.
# An assignment is a simple command, so its status is the substitution's (#267).
merge_anc=$(is_ancestor "$merge" "$base")
[ "$merge_anc" = true ] || die "$merge is not reachable from $base — that merge did not land"

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

# None of the three string fields is reachable today — `$second` and `$first`
# come from `git rev-parse`, 40 hex characters and nothing else, and
# `$proof_path` is this script's own `rebase`/`no-rebase` literal. They go
# through `jstr` for uniformity against a later edit that changes where a field
# comes from, the same reason inflight.sh wraps `$pr`, and it costs nothing
# (#119). Assigned before the printf, never inline in its argument list — a
# `$()` there sits outside this `|| die`, contributes an empty argument on
# failure, and printf still exits 0 with a malformed payload.
second_j=$(jstr "$second") && first_j=$(jstr "$first") && path_j=$(jstr "$proof_path") \
  || die "could not escape the proof fields for $merge"
printf '{"preIsAncestor":%s,"postIsAncestor":%s,"secondParent":"%s","firstParent":"%s","parentCount":%s,"proofPath":"%s","headWasCurrent":%s,"proved":%s}\n' \
  "$pre_anc" "$post_anc" "$second_j" "$first_j" "$parents" "$path_j" "$head_current" "$proved"
exit "$rc"
