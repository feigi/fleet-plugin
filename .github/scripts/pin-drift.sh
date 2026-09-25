#!/usr/bin/env bash
# Report a stalled node pin from this tree's own history (#1755).
#
# Usage: .github/scripts/pin-drift.sh
#   exit 0  the pin moved within the drift bound
#   exit 1  the pin has not moved for longer than the bound — the stall
#   exit 2  the question could not be answered from this checkout
#
# ADR 0010 hands `.nvmrc` to a hosted bot and ends on the gap this closes: if
# the app is uninstalled, suspended, or its hosted schedule silently breaks,
# the pin stops moving and nothing says so — `dependencyDashboard: false`
# removed the one passive heartbeat there was. The measured cost of that
# silence is 43 days across 8 releases.
#
# So the judgement is read off `git log`, never off the integration. Asking
# the bot, its dashboard or the app whether it is healthy goes quiet at exactly
# the moment it matters: an uninstalled app answers nothing. The history of
# `.nvmrc` on this branch is the one witness that still speaks when the bot is
# gone, and it is also the thing we actually care about — the pin moving,
# whoever or whatever moves it.
#
# `--first-parent` dates the move by when it LANDED on the branch (the merge
# commit), not by when the bot authored it on its own branch: a bump PR that
# sat red for a week has not moved the pin for that week.
#
# The bound. Renovate is scheduled for the 1st of each month (renovate.json),
# so on a healthy repo the pin lands roughly monthly and the longest healthy
# gap is one 1st-to-1st interval — up to 31 days. 35 days is that plus a few
# days' slack for a bump PR that goes red and is fixed, or a hosted run that
# lands late. It is short of the 43-day precedent with room for the workflow's
# weekly cadence: a stall that starts right after a run is still caught by day
# 35 + 7 = 42. A month where node ships nothing on the pinned line trips it
# too — correctly: the pin did not move, and a human glancing at that is the
# whole ask.
#
# Every way of failing to READ the history is exit 2, never exit 0. A shallow
# clone is the dangerous one: its boundary commit shows every file as added,
# so `git log -- .nvmrc` would date the pin to the checkout itself and report
# a perfectly fresh pin for any stall at all.
set -euo pipefail

MAX_DAYS=35
PIN=.nvmrc

cannot() {
  echo "::error title=Pin drift unanswerable::pin-drift.sh: $1"
  exit 2
}

# `set -e` does not abort on `VAR=$(cmd)` when cmd fails — split substitution
# from assignment and check the exit code explicitly.
root=""
if ! root=$(git rev-parse --show-toplevel); then
  cannot "not inside a git work tree"
fi

shallow=""
if ! shallow=$(git -C "$root" rev-parse --is-shallow-repository); then
  cannot "git rev-parse --is-shallow-repository failed"
fi
if [ "$shallow" != "false" ]; then
  cannot "shallow clone — the history of $PIN is truncated, so its last move cannot be dated (check out with fetch-depth: 0)"
fi

if ! git -C "$root" cat-file -e "HEAD:$PIN" 2>/dev/null; then
  cannot "$PIN is not tracked at HEAD"
fi

last=""
if ! last=$(git -C "$root" log --first-parent -1 --format='%H %ct' HEAD -- "$PIN"); then
  cannot "git log of $PIN failed"
fi
if [ -z "$last" ]; then
  cannot "no commit on HEAD's first-parent history touches $PIN"
fi

sha=${last%% *}
moved=${last#* }
now=$(date +%s)
age=$(( now - moved ))
age_days=$(( age / 86400 ))
pin=$(head -n1 "$root/$PIN")
short=$(git -C "$root" rev-parse --short "$sha")
moved_iso=$(git -C "$root" log -1 --format=%cI "$sha")

if [ "$age" -gt $(( MAX_DAYS * 86400 )) ]; then
  verdict="stalled"
  msg="$PIN has held $pin for $age_days days (last moved in $short, $moved_iso) — longer than the $MAX_DAYS-day drift bound. The bot that moves it (ADR 0010) has likely stopped: check the Renovate app is installed and not suspended, and whether a bump PR is sitting red or was closed."
  echo "::error file=$PIN,title=Node pin stalled::$msg"
else
  verdict="moving"
  msg="$PIN holds $pin, last moved $age_days days ago in $short ($moved_iso) — within the $MAX_DAYS-day drift bound."
  echo "$msg"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Node pin: %s\n\n%s\n' "$verdict" "$msg" >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$verdict" = "stalled" ]; then
  exit 1
fi
