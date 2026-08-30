#!/bin/sh
# Did the controller's instrument set change under it? (#436)
#
# The controller reads the world through scripts and runbooks that live in the
# MAIN checkout, and every member can write to that checkout. Worktree isolation
# and `./agent-test` port derivation protect members from each other; neither
# protects the tree the controller measures from. Measured: a member edited two
# files in the main checkout instead of its worktree while the CI monitor was
# polling one of them and a finisher was using it to decide a label. It caught
# itself. Nothing in the fleet would have.
#
# The failure is silent in the direction that matters. A modified instrument
# still returns a verdict; it may just not be the right one, and there is no
# error, no diff in any PR and nothing in the ledger to say so. So this is a
# DETECTION, not a prevention: pin the set's state at run start, re-check before
# each gate decision, and refuse rather than read a changed instrument. It
# compares the tree as it stands against the pin, so a change still present when
# it runs is caught and one made and reverted between two runs of it is not.
#
# Exit 0 unchanged, 1 changed, 2 the question could not be answered.
#
# THREE codes, but only ONE of them lets a gate proceed. Every other fleet probe
# with this contract (inflight.sh, verify-sha.sh, staleness.mjs) hands exit 2
# back to a caller that then decides; here 1 and 2 both refuse, because a guard
# that fails open on "could not look" protects nothing — the whole point is to
# fail closed. The split survives only so the refusal can say WHICH it was: a
# changed instrument is a finding about the tree, an unanswerable check is a
# finding about this script. Both stop the gate.
#
# WHAT IS IN THE SET: every tracked file under `skills/fleet/`, contents read
# from the worktree of the checkout this script itself lives in. Not a written
# list of instrument names — the ticket named six and the class is larger (the
# supply scan, the liveness probe, the shared `arg.mjs`/`json.sh`/`net.sh`
# libraries that a single edit mutates every node instrument through, and the
# runbooks, which the controller also reads from this same writable tree and
# which phase 0 already knows can be stale). A list rots on the next commit that
# adds a script; a directory does not.
#
# TRACKED, deliberately: an untracked file appearing under `skills/fleet/` — a
# `.DS_Store`, an editor swap file, a member's scratch output — changes no
# reading the controller takes, and refusing on it would fire the guard on
# ordinary runs. A guard the controller learns to ignore is worse than none.
#
# CONTENT, not `git status`: status answers off the stat cache, so a content
# change that lands on the same size and mtime does not reach it, and a bare
# `touch` does. This hashes bytes, so it accepts a touch and refuses a rewrite.
#
# REFS ARE DELIBERATELY NOT IN THE DIGEST, and the reason is not that they do
# not matter. The corroborating evidence on #436 is a stray `fix/42-slug` branch
# left in the main checkout by something running this repo's own fixtures — a
# ref write, which no hash of files can see. But `claim-ticket.sh` creates a
# branch per ticket and `reap.sh` deletes them, in the ref store every worktree
# shares, so a ref digest changes several times per wave as ORDINARY WORK. Per
# gate that is noise, and noise is the one failure this check cannot afford.
# Sweeping for unexpected refs is a drain-cadence question, not a gate one, and
# it is not what #436's acceptance criteria ask for.
#
# COST: one `git ls-files` and one pass of `shasum` over those files. No
# network, no `gh`, no fetch, no subprocess per file. It is meant to be run
# before every gate decision and it has to be cheap enough that nobody is
# tempted to skip it.
set -eu

NAME=instruments
# `printf '%s'`, never `echo` (#484): `echo` expands backslash escapes in its
# operand, and the messages below carry paths that git will happily hand us with
# a backslash in them.
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

pin=false
case "${1:-}" in
  --pin) pin=true ;;
  "") ;;
  *) die "usage: instruments.sh [--pin]" ;;
esac
[ $# -le 1 ] || die "usage: instruments.sh [--pin]"

# The checkout THIS FILE came from, not the caller's working directory. The
# instruments the controller is about to read are this script's siblings, so the
# tree to measure is the one it was invoked out of — and the harness resets cwd
# between calls, so a check keyed on cwd measures whatever tree the last command
# happened to leave behind.
here=$(dirname "$0")
root=$(git -C "$here" rev-parse --show-toplevel) \
  || die "$here is not inside a git checkout — cannot identify the instrument set"

set=skills/fleet

files=$(mktemp) || die "cannot create a temp file"
# INT/HUP/TERM as well as EXIT: a controller that kills a stalled gate check
# should not leave the temp file behind on a shared machine.
trap 'rm -f "$files"' EXIT
trap 'rm -f "$files"; exit 2' INT HUP TERM

git -C "$root" ls-files -z -- "$set" > "$files" \
  || die "git ls-files failed under $root/$set"
# An empty listing is the shape a wrong root produces — a symlinked skills dir
# resolving to a different repository, most plausibly. Certifying it would hand
# back "unchanged" for a set that was never read.
[ -s "$files" ] || die "no tracked file under $root/$set — refusing to certify an empty instrument set"

# Two steps, each with its own status check, because a pipeline reports only its
# LAST command: with `xargs … | shasum` as one pipeline, a `shasum` that cannot
# run at all leaves the second one hashing empty input and exiting 0, and the
# empty-input digest then compares unequal and reads as CHANGED. That is exit 1
# — a verdict about the tree — off a failure to look. reap.sh shipped this exact
# bug against `git cherry` (#264) and it deleted branches.
#
# `xargs` exits 123 when `shasum` failed on any file, which is how a tracked
# file deleted from the worktree arrives: as exit 2 naming it, not as a digest
# quietly missing a line. Both refuse; only one of them is honest about why.
per_file=$(cd "$root" && xargs -0 shasum -a 256 < "$files") \
  || die "could not hash every tracked file under $set — see the errors above"
digest=$(printf '%s\n' "$per_file" | shasum -a 256 | cut -d' ' -f1) \
  || die "could not digest the instrument set"
[ -n "$digest" ] || die "empty digest for $root/$set"

base="$root/.fleet/instruments.sha"

if [ "$pin" = true ]; then
  mkdir -p "$root/.fleet" || die "cannot create $root/.fleet"
  printf '%s\n' "$digest" > "$base" || die "cannot write $base"
  printf '%s\n' "$digest"
  printf '%s: pinned %s over %s\n' "$NAME" "$digest" "$root/$set" >&2
  exit 0
fi

# No baseline is not "nothing has changed" — it is a run that never pinned, and
# the check has nothing to compare against. Refusing is the whole contract.
[ -r "$base" ] || die "no baseline at $base — run instruments.sh --pin once at run start"
want=$(cat "$base") || die "cannot read $base"
[ -n "$want" ] || die "$base is empty — re-pin, do not guess"

printf '%s\n' "$digest"
if [ "$digest" = "$want" ]; then
  exit 0
fi

# Cold path only, so it costs the ordinary run nothing. The controller has to
# report WHAT changed, and neither digest says. `git status` names the
# uncommitted half, which is the shape the near-miss on #436 actually took; a
# checked-out branch that moved shows as nothing here and the HEAD line is what
# names it.
printf '%s: instrument set CHANGED under this run — expected %s\n' "$NAME" "$want" >&2
printf '%s: refuse the gate and report. Do NOT re-read the instrument.\n' "$NAME" >&2
printf '%s: HEAD %s\n' "$NAME" "$(git -C "$root" rev-parse HEAD 2>/dev/null || printf '?')" >&2
git -C "$root" status --porcelain -- "$set" >&2 || true
exit 1
