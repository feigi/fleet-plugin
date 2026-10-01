#!/bin/sh
# Delete a merged PR's head branch from `origin` (#2196). The merge bot owns
# this step: run-merge-bot.md's step 4 calls it after the merge is confirmed.
# Until #2196 nothing did — the fleet leaned on the repo setting "Automatically
# delete head branches", which nothing here enforced or checked, so a repo with
# it off accumulated every merged branch, and reap.sh (which reaps only a local
# branch whose upstream is `[gone]`) never saw one to reap.
#
# REMOTE ONLY, on purpose — never `gh pr merge --delete-branch`. That flag's
# post-merge LOCAL cleanup dies with `fatal: 'main' is already used by worktree
# at <path>` whenever the head branch is checked out in a git worktree, and every
# fleet-claimed ticket's branch is, by construction
# (`.worktrees/<issue>-<slug>`, docs/requirements.md §3.2). This script runs no
# local branch or worktree command at all: it deletes the ref on `origin`, which
# leaves the local branch `[gone]` with its worktree still on disk — exactly the
# state reap.sh already reaps, worktree first and branch second. So the local
# half stays reap.sh's, with its dirty-worktree and unpushed-work refusals
# intact, and a worktree holding the branch cannot make this step fail.
#
# The delete is LEASED to the head GitHub merged (`--force-with-lease=<ref>:
# <headRefOid>`), so the check and the act are one ref update on the server: a
# push that landed on the branch after the merge makes the delete refuse instead
# of destroying commits `main` never received. A separate "is the tip still the
# merged head" read followed by a plain delete would leave a window between the
# two; the lease closes it at delete time.
#
# Success is READ BACK, never inferred from the push's exit status: after the
# push, `ls-remote` must show the ref absent. A branch already absent before the
# push — the repo still has auto-delete on, or a re-run — is the same success:
# the outcome this step exists for already holds.
#
# Exit 0: the branch is gone from origin (deleted here, already gone, or a fork
#         PR's branch, which lives in another repository and is not ours to
#         delete — `"skipped":"cross-repository"`).
# Exit 1: the branch is STILL on origin — the lease refused (the tip moved after
#         the merge) or the push failed. REPORT IT as
#         `branch-delete-failed-#<pr>`, never swallow it.
# Exit 2: could not even tell what to delete — bad usage, the PR is not merged,
#         a `gh`/`ls-remote` call failed, or the head names the base branch.
set -eu

# Ambient GIT_DIR/GIT_WORK_TREE would point `ls-remote origin` and the push at
# whatever repository they name rather than the one this runs in — the same
# misdirection reap.sh's header records for its own calls.
unset GIT_DIR GIT_WORK_TREE

NAME=delete-merged-branch
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to run without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

net_lib="$(dirname "$0")/net.sh"
[ -r "$net_lib" ] || die "cannot read $net_lib — refusing to run without the bounded git transport"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=net.sh
. "$net_lib" || die "$net_lib failed to load"

[ $# -eq 1 ] || die "usage: delete-merged-branch.sh <pr>"
pr=$1
case "$pr" in ''|*[!0-9]*|0?*) die "pr must be a number, got '$pr'";; esac

# One read, so state, head and fork-ness all describe the same moment. Fields
# are joined on \037 (unit separator), not @tsv's tab: a tab is IFS whitespace,
# so `read` collapses a run of them and an empty field shifts every later field
# left — an empty headRefName read the base branch as the head commit. A
# non-whitespace IFS keeps an empty field in its place. No field can carry the
# separator: git refnames cannot hold a control character (git-check-ref-format).
echo "\$ gh pr view $pr --json state,isCrossRepository,headRefName,headRefOid,baseRefName" >&2
if ! fields=$(gh pr view "$pr" --json state,isCrossRepository,headRefName,headRefOid,baseRefName \
  --jq '[.state, (.isCrossRepository | tostring), .headRefName, .headRefOid, .baseRefName] | map(. // "") | join("\u001f")'); then
  die "gh pr view $pr failed — cannot tell whether it merged or what its head branch is"
fi
us=$(printf '\037')
IFS=$us read -r state cross branch oid base <<EOF
$fields
EOF

# MERGED, not just closed: a PR closed unmerged still holds work nowhere else.
[ "$state" = "MERGED" ] || die "PR #$pr is not merged (state=$state) — refusing to delete its branch"
[ -n "$branch" ] && [ -n "$oid" ] || die "gh pr view $pr returned no head branch or head commit"
case "$oid" in *[!0-9a-f]*) die "gh pr view $pr returned a head commit that is not a hex SHA: '$oid'";; esac
[ "$branch" != "$base" ] || die "PR #$pr's head branch is its base branch '$base' — refusing to delete it"

if ! jbranch=$(jstr "$branch"); then
  die "could not JSON-escape branch name '$branch'"
fi

# A fork PR's head lives in the fork. A same-named branch on OUR origin is a
# different branch that happens to share the name, and the lease alone would be
# the only thing standing between it and this delete.
if [ "$cross" = "true" ]; then
  printf '{"pr":%s,"branch":"%s","deleted":false,"skipped":"cross-repository"}\n' "$pr" "$jbranch"
  exit 0
fi

# 30s, the budget every fleet `ls-remote` gets: it moves refs, no objects. The
# ref-only `push --delete` below moves no objects either, so it shares it.
# `FLEET_NET_TIMEOUT` shortens it, never lengthens — net_budget's rule.
ref_budget=$(net_budget 30 "${FLEET_NET_TIMEOUT:-}")

# Prints the tip of refs/heads/$branch on origin, or nothing when it is absent.
# An exact field match rather than trusting ls-remote's pattern, which matches
# any ref ENDING in the pattern on a `/` boundary.
remote_tip() {
  rt_rc=0
  rt_out=$(net_git "" "$ref_budget" ls-remote --heads origin "refs/heads/$branch") || rt_rc=$?
  if [ "$rt_rc" -ne 0 ]; then
    if net_stalled "$rt_rc"; then
      die "git ls-remote did not finish within ${ref_budget}s and was killed, so whether $branch is on origin is unknown"
    fi
    die "git ls-remote failed, so whether $branch is on origin is unknown"
  fi
  printf '%s\n' "$rt_out" | awk -F '\t' -v ref="refs/heads/$branch" '$2 == ref { print $1 }'
}

echo "\$ git ls-remote --heads origin refs/heads/$branch" >&2
before=$(remote_tip)
if [ -z "$before" ]; then
  printf '{"pr":%s,"branch":"%s","deleted":false,"alreadyGone":true}\n' "$pr" "$jbranch"
  exit 0
fi

echo "\$ git push --force-with-lease=refs/heads/$branch:$oid origin --delete refs/heads/$branch" >&2
push_rc=0
net_git "" "$ref_budget" push --force-with-lease="refs/heads/$branch:$oid" origin --delete "refs/heads/$branch" >&2 || push_rc=$?

echo "\$ git ls-remote --heads origin refs/heads/$branch" >&2
after=$(remote_tip)
if [ -n "$after" ]; then
  # The branch survived. Say which of the three causes this run can tell apart.
  if [ "$after" != "$oid" ]; then
    reason="branch tip $after is not the merged head $oid — a push landed after the merge; not deleting it"
  elif net_stalled "$push_rc"; then
    reason="git push --delete did not finish within ${ref_budget}s and was killed; the branch was still on origin when read back"
  else
    reason="git push --delete exited $push_rc and the branch is still on origin"
  fi
  if ! jreason=$(jstr "$reason"); then jreason="unrenderable reason"; fi
  printf '%s: %s\n' "$NAME" "$reason" >&2
  printf '{"pr":%s,"branch":"%s","deleted":false,"tip":"%s","reason":"%s"}\n' "$pr" "$jbranch" "$after" "$jreason"
  exit 1
fi

# Absent now. If the push itself failed, something else removed the branch
# between the two reads (auto-delete racing this run) — still the outcome
# this step exists for, so it is reported as already gone rather than deleted.
if [ "$push_rc" -ne 0 ]; then
  printf '{"pr":%s,"branch":"%s","deleted":false,"alreadyGone":true}\n' "$pr" "$jbranch"
  exit 0
fi
printf '{"pr":%s,"branch":"%s","deleted":true}\n' "$pr" "$jbranch"
exit 0
