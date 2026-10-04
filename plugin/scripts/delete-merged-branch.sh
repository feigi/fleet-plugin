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
# KEPT while another open PR uses the branch (#2295). Deleting a branch closes
# every open PR headed by it, and may close rather than retarget every open PR
# based on it — GitHub retargets stacked PRs when IT deletes a merged head, and
# nobody has observed whether a push-delete triggers the same. So just before
# the push the script asks for both, and deletes nothing when either answers.
# The merged PR is not open, so it never matches. A fork PR whose own branch
# shares the name does not count as headed by it: that branch lives in the fork.
# The lookups run only when there is a delete to guard — a branch already gone
# has none, and is exit 0 whatever they would say.
#
# THE LABEL HALF. The same step also drops `in-progress` from every issue the
# merged PR closes, by running its sibling `drop-merged-label.sh <pr> --apply`
# through `sh`, resolved beside this file. It runs right after the MERGED gate,
# before any branch-half validation, so every later exit already carries its
# outcome; a PR that is not MERGED is refused (exit 2) with no `issue edit`. A
# missing or unreadable sibling is exit 2 at startup, nothing touched. Its JSON
# line and stderr go to this script's stderr; stdout carries only these failure
# tokens, one per line, printed before the branch half's output:
#   label-drop-failed-#<issue>  one per issue whose removal failed
#   label-read-failed-#<pr>     the outcome could not be determined: the sibling
#                               exited 2, exited 1 naming no issue, or ended any
#                               other way (stderr names the raw exit code) —
#                               never read as "nothing to drop"
# A label failure never stops the branch delete from running.
#
# Exit 0: the branch is gone from origin (deleted here, already gone, or a fork
#         PR's branch, which lives in another repository and is not ours to
#         delete — `"skipped":"cross-repository"`).
# Exit 1: the branch is STILL on origin — the lease refused (the tip moved after
#         the merge) or the push failed. REPORT IT as
#         `branch-delete-failed-#<pr>`, never swallow it.
# Exit 2: could not even tell what to delete — bad usage, the PR is not merged,
#         a `gh`/`ls-remote` call failed, the head names the base branch, or an
#         open-PR lookup failed, answered with something that is not a list
#         of PR numbers, or could not be checked for that (nothing is deleted;
#         the lookup is named on stderr).
# Exit 3: KEPT on purpose — another open PR uses the branch as its head or its
#         base. Nothing was pushed. Stdout is one `branch-kept-#<pr>` line per
#         such PR (that PR's number, not the merged one's) instead of the JSON
#         payload; stderr says which role each plays. A deliberate keep, not a
#         failure: report the lines, never retry.
# Exit 4: the branch half succeeded (what would be exit 0) but the label half
#         printed at least one token. When the branch half exits 1, 2 or 3 that
#         code wins and the tokens are still printed. Report every token line
#         on any non-zero exit; never retry.
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

# The label half is a sibling script, resolved from this file's own location —
# not PATH, not the caller's cwd. Checked with the helper libraries, before
# anything is touched: a partial install must never delete branches while
# silently skipping the label.
label_script="$(dirname "$0")/drop-merged-label.sh"
[ -r "$label_script" ] || die "cannot read $label_script — refusing to delete a branch without the label drop that belongs to it"

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

# The label half runs HERE — right after the MERGED gate and before any
# branch-half validation — so every later exit (deleted, already gone, skipped,
# kept, delete failed, a read that dies) already carries its outcome. A PR that
# is not MERGED never reaches it. Its JSON line and stderr stay on stderr:
# stdout carries only the tokens below and the branch half's own output, and a
# label failure never stops the branch delete from running.
label_failed=false
label_token() { printf '%s\n' "$1"; label_failed=true; }

echo "\$ sh $label_script $pr --apply" >&2
label_rc=0
label_out=$(sh "$label_script" "$pr" --apply) || label_rc=$?
[ -z "$label_out" ] || printf '%s\n' "$label_out" >&2
case "$label_rc" in
  0) echo "$NAME: in-progress dropped from every issue PR #$pr closes (or none carried it)" >&2 ;;
  1)
    # The label script's own exit 1 is "one or more removals failed"; its
    # `failed` array names them. Exit 1 with no number to extract is not an
    # answer about any issue, so it reads as undetermined, never as clear.
    if ! failed_issues=$(printf '%s\n' "$label_out" | sed -n 's/.*"failed":\[\([0-9][0-9,]*\)\].*/\1/p'); then
      failed_issues=""
    fi
    if [ -z "$failed_issues" ]; then
      echo "$NAME: $label_script exited 1 but named no failed issue — the label outcome is unknown" >&2
      label_token "label-read-failed-#$pr"
    else
      for n in $(printf '%s\n' "$failed_issues" | tr ',' ' '); do
        label_token "label-drop-failed-#$n"
      done
    fi
    ;;
  *)
    echo "$NAME: $label_script exited $label_rc — the label outcome could not be determined" >&2
    label_token "label-read-failed-#$pr"
    ;;
esac

# Exit 4: the branch half succeeded but a label token was printed. The branch
# half's own 1, 2 and 3 win; this only lifts a would-be 0.
if [ "$label_failed" = true ]; then
  trap 'exit_rc=$?; trap - EXIT; if [ "$exit_rc" -eq 0 ]; then exit 4; fi; exit "$exit_rc"' EXIT
fi
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

# Dies unless $2 is empty or one PR number per line: a `gh` that exits 0 has
# not answered if what it printed cannot be read as that. grep's exit 1 is the
# only "valid list" answer; anything past it (2 and up) means grep itself
# failed, and reading that as valid would let the delete through unchecked.
pr_numbers() {
  pn_rc=0
  printf '%s\n' "$2" | grep -Eqv '^([1-9][0-9]*)?$' || pn_rc=$?
  case "$pn_rc" in
    0) die "the open-PR lookup \`gh pr list --$1 $branch\` answered with something that is not a list of PR numbers: '$2' — not deleting it" ;;
    1) ;;
    *) die "grep exited $pn_rc, so whether the open-PR lookup \`gh pr list --$1 $branch\` answered with a list of PR numbers is unknown — not deleting it" ;;
  esac
}

# Asked here, after the branch is known to be on origin and just before the
# push, so a keep is only ever reported for a branch that is really still
# there. `--limit` sits far past any real count: a truncated list would still
# keep the branch, but would drop a `branch-kept-#` line.
echo "\$ gh pr list --head $branch --state open --json number,isCrossRepository" >&2
if ! headed=$(gh pr list --head "$branch" --state open --limit 1000 --json number,isCrossRepository \
  --jq '.[] | select(.isCrossRepository | not) | .number'); then
  die "the open-PR lookup \`gh pr list --head $branch\` failed — cannot tell whether deleting it would close another PR; not deleting it"
fi
pr_numbers head "$headed"
echo "\$ gh pr list --base $branch --state open --json number" >&2
if ! based=$(gh pr list --base "$branch" --state open --limit 1000 --json number --jq '.[].number'); then
  die "the open-PR lookup \`gh pr list --base $branch\` failed — cannot tell whether deleting it would close another PR; not deleting it"
fi
pr_numbers base "$based"

# Both lists hold only validated PR numbers, so splitting them is safe — and
# command substitution strips trailing newlines, so a list is non-empty only
# when it names a PR.
for n in $headed; do
  printf '%s: open PR #%s uses %s as its head — deleting the branch would close it; keeping the branch\n' "$NAME" "$n" "$branch" >&2
done
for n in $based; do
  printf '%s: open PR #%s uses %s as its base — deleting the branch may close it rather than retarget it; keeping the branch\n' "$NAME" "$n" "$branch" >&2
done
if [ -n "$headed$based" ]; then
  printf '%s\n%s\n' "$headed" "$based" | grep . | sort -nu | sed 's/^/branch-kept-#/'
  exit 3
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
