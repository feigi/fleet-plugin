#!/bin/sh
# Drop `in-progress` from every issue a merged PR closes. claim-ticket.sh adds
# the label, release-ticket.sh drops it on a bail (CONTEXT.md's Release: "a
# claim that never became" a PR). This is neither Release nor Reap
# (CONTEXT.md's Reap is branches and worktrees, not the label) — a third,
# merge-triggered step in the claim lifecycle CONTEXT.md does not yet name.
# #170.
#
# Single writer, per the #170 ruling: the merge is the only moment the ticket
# number and the fact of completion are known together, so only a PROVEN merge
# triggers this — never reap (branches, not tickets), never a repo automation
# (no attribution). Call this from run-merge-bot.md's step 4, after
# prove-merge.sh, never before: `closingIssuesReferences` reflects `Closes #N`
# syntax regardless of merge state, and the claim has not ended until the
# merge lands.
#
# Dry-run by default; --apply mutates the tracker. Exit 0 done (or dry run),
# 1 one or more removals failed — REPORT THIS, never swallow it: a merged
# ticket that keeps the label is a future invisible ticket, 2 could not even
# tell what this PR closes.
set -eu

NAME=drop-merged-label
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

[ $# -ge 1 ] && [ $# -le 2 ] || die "usage: drop-merged-label.sh <pr> [--apply]"
pr=$1
case "$pr" in ''|*[!0-9]*|0?*) die "pr must be a number, got '$pr'";; esac
case "${2:-}" in
  ''|--apply) ;;
  *) die "unknown argument '$2' — the only option is --apply";;
esac
apply=false
[ "${2:-}" = "--apply" ] && apply=true

# MERGED, not just "closed" — a PR closed without merging must never reach the
# loop below. Reading state before closingIssuesReferences means this refusal
# fires before either call that follows can hand the caller anything to act on.
echo "\$ gh pr view $pr --json state --jq .state" >&2
if ! state=$(gh pr view "$pr" --json state --jq .state); then
  die "gh pr view $pr failed — cannot tell whether it merged"
fi
[ "$state" = "MERGED" ] || die "PR #$pr is not merged (state=$state) — refusing to touch its issues"

echo "\$ gh pr view $pr --json closingIssuesReferences --jq '.closingIssuesReferences[].number'" >&2
if ! issues=$(gh pr view "$pr" --json closingIssuesReferences --jq '.closingIssuesReferences[].number'); then
  die "gh pr view $pr failed — cannot read which issues it closes"
fi

if [ -z "$issues" ]; then
  echo "$NAME: PR #$pr closes no issues — nothing to drop" >&2
  printf '{"pr":%s,"merged":true,"issues":[],"applied":%s,"failed":[]}\n' "$pr" "$apply"
  exit 0
fi

results=""
failed=""
for n in $issues; do
  echo "\$ gh issue view $n --json labels --jq '.labels[].name'" >&2
  if ! labels=$(gh issue view "$n" --json labels --jq '.labels[].name'); then
    echo "    #$n: could not read labels — gh issue view failed" >&2
    failed="${failed}${n},"
    results="${results}{\"issue\":$n,\"hadLabel\":null,\"removed\":false},"
    continue
  fi

  # grep's OWN scan failing (rc 2+) must not read as "no in-progress label":
  # the same defect PR #1519 fixed in reap.sh's grep_probe (#1543). A bare
  # `if … grep -qx …; then had=true; else had=false; fi` has room for only two
  # of grep's three `-q` outcomes — rc 0 matched, rc 1 none did, rc 2+ the
  # scan itself broke — so a scan that could not look would read here exactly
  # like a measurement that looked and found the label already gone, and the
  # loop below would skip the removal a merged ticket still needs.
  if printf '%s\n' "$labels" | grep -qx in-progress; then gp_rc=0; else gp_rc=$?; fi
  case $gp_rc in
    0) had=true ;;
    1) had=false ;;
    *)
      echo "    #$n: could not scan its labels for in-progress (grep exited $gp_rc)" >&2
      failed="${failed}${n},"
      results="${results}{\"issue\":$n,\"hadLabel\":null,\"removed\":false},"
      continue
      ;;
  esac
  if [ "$had" = false ]; then
    echo "    #$n: no in-progress label — already clear" >&2
    results="${results}{\"issue\":$n,\"hadLabel\":false,\"removed\":false},"
    continue
  fi

  if [ "$apply" = false ]; then
    echo "    would: gh issue edit $n --remove-label in-progress" >&2
    results="${results}{\"issue\":$n,\"hadLabel\":true,\"removed\":false},"
    continue
  fi

  echo "\$ gh issue edit $n --remove-label in-progress" >&2
  if gh issue edit "$n" --remove-label in-progress >/dev/null; then
    echo "    #$n: dropped in-progress" >&2
    results="${results}{\"issue\":$n,\"hadLabel\":true,\"removed\":true},"
  else
    echo "    #$n: FAILED to drop in-progress — invisible on reopen until retried" >&2
    failed="${failed}${n},"
    results="${results}{\"issue\":$n,\"hadLabel\":true,\"removed\":false},"
  fi
done

printf '{"pr":%s,"merged":true,"issues":[%s],"applied":%s,"failed":[%s]}\n' \
  "$pr" "${results%,}" "$apply" "${failed%,}"

[ -z "$failed" ] || exit 1
exit 0
