#!/usr/bin/env bash
# Request a rerun of ONE pull request's `rebase-check` job, walking every
# candidate run it is given until one accepts.
#
# Usage: rerun-rebase-check.sh <pr> <sha> <behind_by> <run-id>...
# Env:   GH_REPO (and whatever gh needs — GH_TOKEN, GH_HOST)
#
# Exit status classifies the PR for the caller, which is what keeps the
# counters honest (#159): this script runs once per PR and exits once, so the
# caller's `rejected` tally cannot count the same PR twice no matter how many
# candidates were tried. The previous shape — a resolution loop that `break`ed
# on the first run holding a rebase-check job, then POSTed once outside it —
# had no way to try the next candidate at all, so moving the POST inside the
# loop without moving the accounting out would have traded a missed fallback
# for a `rejected: 3` on a single PR.
#
#   0  rerun accepted (a 2xx)
#   3  a rebase-check job was found, and every candidate rejected the rerun
#   4  no rebase-check job in any candidate run
#   6  no rebase-check job resolved, and at least one candidate's jobs listing
#      failed — an API failure rather than an absent job (#160)
#   1  fatal — the token cannot rerun anything here, so no PR can be refreshed
#
# 6 rather than 5: the caller's `case` has a `*` arm that fails the step on any
# status it does not name, and the suite reaches it with jq's own 5 (an
# unparseable jobs payload aborts this script under `set -e`). Routing 5 here
# would leave that pin with no unrouted status to fire on.
#
# Why this is a script and not more inline YAML: nothing in this repo executes
# a workflow, so logic living in `run: |` is reachable only by assertions over
# its source text — and a text assertion that survives deleting the behaviour
# it names checks nothing (measured in #161's review). Extracted, the loop runs
# under a stub `gh` in scripts/rerun-rebase-check.test.mjs.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "::error::rerun-rebase-check.sh: usage: rerun-rebase-check.sh <pr> <sha> <behind_by> <run-id>..."
  exit 1
fi
# Named rather than left to `set -u`, whose `unbound variable` names the line
# and not the contract the caller broke.
: "${GH_REPO:?rerun-rebase-check.sh: GH_REPO must be set}"

PR=$1
SHA=$2
BEHIND_BY=$3
shift 3

# Distinguishes "every candidate refused" (3) from "there was nothing to
# refuse" (4) from "nobody could look" (6). A run whose jobs could not be
# listed leaves FOUND_JOB unset and bumps JOBS_ERRS instead: reporting it as a
# run that LACKED the job points a debugger at ci.yml's job name for what was
# an API error, and lands the PR in the caller's `no-job` tally, which neither
# its `FAILED == TOTAL` guard nor its `FAILED > 0` warning reads (#160).
#
# A candidate that WAS listed still classifies the PR however many of its
# siblings errored: an accepted rerun is still 0, an exhausted walk still 3.
# The error only decides the case where nothing was resolved at all.
FOUND_JOB=""
JOBS_ERRS=0

for RUN in "$@"; do
  if ! JOBS_JSON=$(gh api "repos/$GH_REPO/actions/runs/$RUN/jobs?filter=latest&per_page=100" </dev/null); then
    echo "::error::#$PR: failed to list jobs for run $RUN — see gh error above."
    JOBS_ERRS=$((JOBS_ERRS + 1))
    continue
  fi
  # `first(...)` inside jq rather than `| head -1`: it short-circuits on the
  # first match instead of building the whole list. Note gh is NOT in this
  # pipeline — its output was captured into $JOBS_JSON on the line above — so
  # the SIGPIPE-the-fetch hazard this guards against in other code does not
  # apply here.
  JOB=$(printf '%s' "$JOBS_JSON" \
    | jq -r 'first(.jobs[] | select(.name == "rebase-check") | .id) // empty')
  if [ -z "$JOB" ]; then
    continue
  fi
  FOUND_JOB=1

  # The rerun endpoint rejects a job whose parent RUN is still in progress —
  # not merely a queued job. `check` runs in parallel with `rebase-check` and
  # is capped at 10 minutes, so rebase-check can sit completed inside a run
  # that stays in progress for that long. Reruns also fail once a run ages out
  # of the retention window. Neither is fatal and neither is final: the caller
  # hands over the older runs from the same `per_page=5` page precisely so a
  # rejection here can fall back to a run that has already finished, which is
  # the whole of #159. So every non-fatal rejection continues the loop.
  #
  # 401/403 is a different animal: it means this workflow's token cannot rerun
  # anything here, so it is fatal rather than per-PR — otherwise a global
  # config defect reads as N benign timing races. It exits on the FIRST
  # candidate rather than retrying: retrying a token failure four more times
  # per PR is a secondary-rate-limit generator, not a fallback.
  if RERUN_ERR=$(gh api --method POST "repos/$GH_REPO/actions/jobs/$JOB/rerun" </dev/null 2>&1); then
    # A 2xx means accepted for scheduling, not completed: the rerun re-enters
    # ci.yml's concurrency group and a later push to the PR branch can cancel it.
    echo "#$PR ($SHA): behind by $BEHIND_BY — requested rerun of rebase-check (job $JOB)."
    exit 0
  elif printf '%s' "$RERUN_ERR" | grep -qiE 'in progress|queued'; then
    # Checked BEFORE the 401/403 branch: GitHub refuses a rerun whose parent
    # run is still going, and returns 403 for it. That is the routine per-PR
    # skip described above, not a token problem — and reading it as one would
    # exit 1 with a wrong diagnosis and abandon every remaining PR in the loop.
    echo "#$PR ($SHA): rerun of job $JOB rejected — parent run still in progress or queued: $RERUN_ERR"
  elif printf '%s' "$RERUN_ERR" | grep -qE 'HTTP (401|403)'; then
    echo "::error::#$PR: rerun POST denied — $RERUN_ERR"
    echo "::error::GITHUB_TOKEN lacks 'actions: write' here, or a secondary rate limit is active. No PR can be refreshed until this is fixed."
    exit 1
  else
    echo "#$PR ($SHA): rerun of job $JOB rejected — $RERUN_ERR"
  fi
done

if [ -z "$FOUND_JOB" ]; then
  # Errors first: "no rebase-check job in ANY candidate run" is a claim about
  # every candidate, and a candidate whose jobs listing failed is one this walk
  # never got to look at. One such candidate is enough to disqualify the claim.
  if [ "$JOBS_ERRS" -gt 0 ]; then
    echo "::error::#$PR ($SHA): no rebase-check job found, and $JOBS_ERRS candidate run(s) could not be listed — an API failure, not a missing job."
    exit 6
  fi
  echo "#$PR ($SHA): behind by $BEHIND_BY but no rebase-check job in any candidate run — skipping."
  exit 4
fi
echo "#$PR ($SHA): behind by $BEHIND_BY but every candidate run rejected the rerun — skipping."
exit 3
