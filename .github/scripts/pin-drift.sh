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
# silence is 43 days, with five 26.x releases landing inside them.
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
# The bound. Renovate's window is all day on the first three days of each
# month, UTC (renovate.json), so on a healthy repo the pin lands roughly
# monthly. The longest healthy gap runs from a bump PR opened as one window
# opens on the 1st to the next one opened as its window closes at the end of
# the 3rd — up to 34 days across a 31-day month, and a hosted run that comes
# late inside the window is already inside that figure — plus however long
# that last PR's checks take to go green, since the merge waits on them, not
# on the window. 35 days leaves about a day for those checks; a bump PR that
# goes red and stays red longer than that trips it in such a month, like any
# other pin that sat still past the bound. It is short of the 43-day
# precedent with room for the workflow's weekly cadence: a stall that starts
# right after a run is still caught by day 35 + 7 = 42 — which is also why
# the slack cannot simply grow: at 36 the worst case is caught on day 43, no
# longer short of it. A month where node ships nothing on the pinned line
# trips it too — correctly: the pin did not move, and a human glancing at
# that is the whole ask.
#
# Every way of failing to READ the history is exit 2, never exit 0 or a bare
# abort. A shallow clone is the dangerous one: its boundary commit shows every
# file as added, so `git log -- .nvmrc` would date the pin to the checkout
# itself and report a perfectly fresh pin for any stall at all.
set -euo pipefail

MAX_DAYS=35
PIN=.nvmrc

cannot() {
  echo "::error title=Pin drift unanswerable::pin-drift.sh: $1"
  exit 2
}

# Every `VAR=$(cmd)` below already aborts under `set -e` on its own if cmd
# fails — that part needs no help. The explicit `if ! VAR=$(cmd); then`
# exists so the abort routes through `cannot` and names what was
# unanswerable, instead of leaving a bare, unlabelled `set -e` exit for
# whoever reads the run.
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

# Capture stderr instead of discarding it: a genuinely untracked $PIN and a
# corrupt/unresolvable HEAD both fail this check, and the message should say
# which one actually happened rather than guessing "not tracked" for both.
tracked_err=""
if ! tracked_err=$(git -C "$root" cat-file -e "HEAD:$PIN" 2>&1); then
  cannot "$PIN is not resolvable at HEAD: $tracked_err"
fi

last=""
if ! last=$(git -C "$root" log --first-parent -1 --format='%h %ct %cI' HEAD -- "$PIN"); then
  cannot "git log of $PIN failed"
fi
if [ -z "$last" ]; then
  cannot "no commit on HEAD's first-parent history touches $PIN"
fi

short=""
moved=""
moved_iso=""
read -r short moved moved_iso <<<"$last"
now=$(date +%s)
age=$(( now - moved ))
age_days=$(( age / 86400 ))
# Read the pin from HEAD, not the working tree: the checks above establish
# what HEAD holds, and a script whose whole point is to judge from git
# history should not switch to the disk for the one value it prints. It also
# means a failed/partial checkout that leaves $PIN off disk gets diagnosed
# here instead of surfacing a raw `head` error with no annotation.
if ! pin=$(git -C "$root" show "HEAD:$PIN" | head -n1); then
  cannot "could not read $PIN at HEAD"
fi

if [ "$age" -gt $(( MAX_DAYS * 86400 )) ]; then
  verdict="stalled"
  msg="$PIN has held $pin for over $age_days days (last moved in $short, $moved_iso) — longer than the $MAX_DAYS-day drift bound. The bot that moves it (ADR 0010) has likely stopped: check the Renovate app is installed and not suspended, and whether a bump PR is sitting red or was closed."
  echo "::error file=$PIN,title=Node pin stalled::$msg"
else
  verdict="moving"
  msg="$PIN holds $pin, last moved $age_days days ago in $short ($moved_iso) — within the $MAX_DAYS-day drift bound."
  echo "$msg"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Node pin: %s\n\n%s\n' "$verdict" "$msg" >>"$GITHUB_STEP_SUMMARY" || echo "::warning::pin-drift.sh: could not write step summary" >&2
fi

if [ "$verdict" = "stalled" ]; then
  exit 1
fi
