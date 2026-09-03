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
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it. Exit 1 out of THIS script means "the sha is not
# reachable", the one distinction it exists to make, so a missing library would
# report a member's PR as sitting somewhere it does not — which is why `[ -r ]`
# has to fire before the `.` can kill the shell.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to answer without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

# The bounded, prompt-suppressed git transport (#92, #346, #347). The fetch
# below is unattended: with no bound it can prompt for a credential or a host
# key, or stall on a transport that connects and then goes quiet, and either
# holds a fleet slot until something outside kills it. net.sh's header holds the
# reasoning and the measurements. Sourced below json.sh so a lone copy of this
# script still blames json.sh, the name its missing-library test pins.
net_lib="$(dirname "$0")/net.sh"
[ -r "$net_lib" ] || die "cannot read $net_lib — refusing to answer without the bounded git transport"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=net.sh
. "$net_lib" || die "$net_lib failed to load"

[ $# -eq 2 ] || die "usage: verify-sha.sh <branch> <sha>"
branch=$1
sha=$2

# Nothing below silences git. Each of these is silent on its healthy path, so
# the only stderr it can add is the diagnosis of a failure, and swallowing that
# leaves the die message asserting a cause the script cannot know. A bad remote
# URL and a removed remote are both "cannot fetch"; only git can say which.
#
# `printf`, not `echo`, on THIS line alone (#484): `$branch` is still raw argv
# here — `[ $# -eq 2 ]` is the only guard it has passed — so a `\c` in it
# truncated the trace AND swallowed its newline, welding git's own `fatal:`
# onto the tail of a line that had already lied about the command being run.
# The three `$branch` echoes below are a different case and stay: each runs
# only after git ACCEPTED the ref, and `git check-ref-format --branch` refuses
# a backslash, so no value reaching them can carry one. Acceptance is what
# makes a refname safe, never the proposal.
printf '$ git fetch --quiet origin %s\n' "$branch" >&2
# 300s, and the number is chosen against the FALSE FAILURE, not against the
# stall: this fetch moves objects rather than refs, so a cold or large one can
# legitimately run for minutes, and a bound that turns a working slow link into
# exit 2 is worse than the hang it replaces — exit 2 is a verdict the controller
# acts on. Well above any healthy incremental fetch, and still a bound.
# `FLEET_NET_TIMEOUT` is the shorten-only override the fleet's fetches share;
# the rule is net_budget's, in net.sh.
fetch_budget=$(net_budget 300 "${FLEET_NET_TIMEOUT:-}")
fetch_rc=0
net_git "" "$fetch_budget" fetch --quiet origin "$branch" || fetch_rc=$?
if [ "$fetch_rc" -ne 0 ]; then
  # A killed fetch and a refused one are different facts and get different
  # words. Without the split, a transport that stalled reads as "cannot fetch",
  # which names a cause this script never observed.
  if net_stalled "$fetch_rc"; then
    die "git fetch origin/$branch did not finish within ${fetch_budget}s and was killed"
  fi
  die "cannot fetch origin/$branch"
fi

# --verify (#1146): without it, an unresolvable "origin/$branch" falls back to
# treating the argument as a PATH — if a file or dir of that name sits in the
# cwd, rev-parse prints it and exits 0, and this guard's `|| die` never fires.
# Measured: a real ref still wins over a same-named path either way, so
# --verify costs the healthy case nothing; it only closes the fallback.
tip=$(git rev-parse --verify "origin/$branch") \
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

# Two of the three string fields are reachable. git accepts a `"` in a ref
# (`git check-ref-format --branch 'evil"branch'` exits 0), so pushing a branch
# is one vector, and raw it emitted an unparseable payload at exit 0 — the worst
# shape, since the caller gets no signal at all. `$sha` is the other, and not by
# a later edit: `git cat-file -e "${sha}^{commit}"` resolves any rev expression,
# a REF NAME included, so `verify-sha.sh main 'evil"tag'` reaches here with a
# quote in it. Measured — unwrapped it emits `"sha":"evil"tag"`, which
# JSON.parse rejects, at exit 0. `$tip` is `git rev-parse`, 40 hex characters
# and nothing else, and is wrapped anyway: it costs nothing and survives a later
# edit moving where it comes from.
# Assigned before the printf, never inline in its argument list — a `$()`
# there sits outside this `|| die`, contributes an empty argument on failure,
# and printf still exits 0 with a malformed payload.
branch_j=$(jstr "$branch") && sha_j=$(jstr "$sha") && tip_j=$(jstr "$tip") \
  || die "could not escape the payload fields for origin/$branch"
printf '{"branch":"%s","sha":"%s","reachable":%s,"tip":"%s"}\n' \
  "$branch_j" "$sha_j" "$reachable" "$tip_j"
exit "$rc"
