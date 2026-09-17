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
# WHAT IS IN THE SET: every tracked file under the plugin's own component
# directories — `plugin/commands/ plugin/scripts/ plugin/skills/
# plugin/agents/ plugin/workflows/` — contents read from the AUDITED
# repository: the working directory's checkout, or the tree named by
# `--repo` (see below). Not a written list of instrument names — the
# ticket named six and the class is larger (the supply scan, the liveness
# probe, the shared `arg.mjs`/`json.sh`/`net.sh` libraries that a single edit
# mutates every node instrument through, and the runbooks, which the
# controller also reads from this same writable tree and which phase 0
# already knows can be stale). A list rots on the next commit that adds a
# script; a directory does not.
#
# NOT THE WHOLE REPO, deliberately: since #1336 the plugin's payload is
# nested under `plugin/`, and the repo root also carries `docs/`, `.github/`
# and `.out-of-scope/`. `docs/metrics/` is APPENDED BY THE CONTROLLER
# MID-RUN, so a whole-repo set would fire the gate on the run's own
# bookkeeping every single time — a guard the controller learns to ignore,
# which is the failure the paragraph below names.
#
# TRACKED, deliberately: an untracked file appearing under those dirs — a
# `.DS_Store`, an editor swap file, a member's scratch output — changes no
# reading the controller takes, and refusing on it would fire the guard on
# ordinary runs. A guard the controller learns to ignore is worse than none.
#
# CONTENT, not `git status`: status answers off the stat cache, so a content
# change that lands on the same size and mtime does not reach it, and a bare
# `touch` does. This hashes bytes, so it accepts a touch and refuses a rewrite.
#
# MODES ARE NOT IN THE DIGEST, and that one is a GAP rather than a trade: a
# mode-only change to a tracked instrument is ACCEPTED. Measured — `chmod +x`
# on a tracked `100644` instrument leaves `git status` printing ` M` for it,
# and `git update-index --chmod=+x` moves the index entry to `100755` with the
# blob untouched; both exit 0 here. A mode change that costs the hash its READ
# is caught instead: `chmod 000` on a tracked instrument refuses at exit 2
# through `could not hash every tracked file`. So the exposure is the bits that
# still permit reading, the exec bit above all — and that bit is not how a
# fleet probe runs: fleet-run hands `.sh` to `sh` and `.mjs` to `node`, so a
# stripped `+x` is invisible through the Resolver, while invoking one by path
# instead is EACCES at exec (126), loud rather than a wrong verdict. Folding
# modes in — digesting `git ls-files -s` alongside the contents, or a per-file
# `[ -x "$f" ]` — is a behaviour change to the gate on a channel with no
# silently wrong reading to its name, and whether a mode-only edit is worth
# refusing on is a decision rather than a fix, so #1059 names the gap and
# leaves the behaviour alone. Evidence that decision can lean on: no fleet
# script chmods a tracked instrument at all — the only chmod calls outside
# this repo's test code are claim-ticket.sh's on the worktree's untracked
# `agent-test` runner, fleet-bootstrap's on `~/.fleet/bin/fleet-run` outside
# the repo, and slow-transport.mjs's on a stub it has just written into a
# fixture. instruments.test.mjs pins the accepted pair, so closing the gap
# later goes red there rather than leaving this paragraph stale.
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

# Directly below `set -eu`, not below a locale pin: this script has none and is
# deliberately off locale-pin-prose.test.mjs's PINNED list. The five siblings
# that DO carry a pin put this line under it instead, because that file's
# PROLOGUE regex admits only comments, blanks and `set -[eux]+` above the pin.
# Here the only constraint left is the real one: above the first git call.
#
# GIT_WORK_TREE is #1337's defect reached through the environment. The
# contract that ticket established is that the audited tree is the WORKING
# DIRECTORY's checkout — and `git rev-parse --show-toplevel` answers with the
# ambient work tree instead the moment one is set, `--repo` or not. Measured
# (#1020): standing in a checkout whose instruments have been TAMPERED, with
# `GIT_WORK_TREE` naming a clean twin that carries its own pinned baseline,
# this script exits 0 and prints the twin's digest. The gate passes. That is
# the same wrong-tree write `--repo ""` produced before #1350 refused it, one
# door further out, and a gate that certifies a tree nobody looked at is
# worse than no gate.
#
# GIT_DIR is unset alongside it and is measured INERT here: `ls-files` names
# paths and the digest is taken over the FILES ON DISK under `$root`, so
# pointing the object database elsewhere changes nothing — measured against a
# clean twin holding the exact pre-tamper content, the tampered digest came
# back unchanged and the gate still refused. It stays on the line because the
# pair is one hazard with one remedy, and because "inert today" is a
# measurement of the current call set: a digest taken from `git show` or
# `cat-file` rather than from disk would reintroduce the half nothing here
# can see. ambient-git-vars-prose.test.mjs pins the line itself, which is
# what keeps that half from being quietly dropped.
unset GIT_DIR GIT_WORK_TREE

NAME=instruments
# `printf '%s'`, never `echo` (#484): `echo` expands backslash escapes in its
# operand, and the messages below carry paths that git will happily hand us with
# a backslash in them.
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

pin=false
repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pin) pin=true; shift ;;
    --repo)
      [ $# -ge 2 ] || die "usage: instruments.sh [--pin] [--repo <path>]"
      repo=$2
      # An empty value falls through the `[ -n "$repo" ]` branch below and
      # silently re-derives from cwd — measured (#1350 review): `--repo ""`
      # pinned the CALLER's cwd repo instead of refusing, exactly the
      # wrong-tree-write class this ticket exists to close. Refuse here,
      # before that check ever runs.
      [ -n "$repo" ] || die "--repo requires a non-empty path"
      shift 2
      ;;
    *) die "usage: instruments.sh [--pin] [--repo <path>]" ;;
  esac
done

# The repository under audit is the WORKING DIRECTORY's checkout, never the
# checkout this script happens to ship from. Under the install-only dev loop
# (ADR 0003) this file runs out of a plugin cache — on a real install,
# `~/.claude/plugins/cache/fleet-plugin/fleet-ctl/<version>/scripts/
# instruments.sh` — and the OLD own-location contract (`git -C "$(dirname
# "$0")" …`) resolved the audited tree to whatever git checkout happens to
# CONTAIN that cache path. Measured (#1337): on a real box that is the
# operator's unrelated personal dotfiles checkout, and `--pin` run that way
# writes `.fleet/instruments.sha` into it. `--repo <path>` is the explicit
# override for the one legitimate case that needs a tree other than cwd's:
# auditing a named worktree from elsewhere. Resolution happens before
# anything is read or written, so a cwd outside any checkout refuses here,
# not partway through.
if [ -n "$repo" ]; then
  root=$(git -C "$repo" rev-parse --show-toplevel) \
    || die "$repo is not inside a git checkout — cannot identify the instrument set"
else
  root=$(git rev-parse --show-toplevel) \
    || die "the working directory is not inside a git checkout — cannot identify the instrument set (pass --repo <path> to audit a tree other than cwd's)"
fi

set='plugin/commands plugin/scripts plugin/skills plugin/agents plugin/workflows'

files=$(mktemp) || die "cannot create a temp file"
# INT/HUP/TERM as well as EXIT: a controller that kills a stalled gate check
# should not leave the temp file behind on a shared machine.
trap 'rm -f "$files"' EXIT
trap 'rm -f "$files"; exit 2' INT HUP TERM

# shellcheck disable=SC2086 # $set is a deliberate list of pathspecs, not one path
git -C "$root" ls-files -z -- $set > "$files" \
  || die "git ls-files failed under $root for: $set"
# An empty listing is the shape a wrong root produces — a symlinked skills dir
# resolving to a different repository, most plausibly. Certifying it would hand
# back "unchanged" for a set that was never read.
[ -s "$files" ] || die "no tracked file under $root for: $set — refusing to certify an empty instrument set"

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
[ -n "$digest" ] || die "empty digest for $root ($set)"

base="$root/.fleet/instruments.sha"

if [ "$pin" = true ]; then
  mkdir -p "$root/.fleet" || die "cannot create $root/.fleet"
  printf '%s\n' "$digest" > "$base" || die "cannot write $base"
  printf '%s\n' "$digest"
  printf '%s: pinned %s over %s\n' "$NAME" "$digest" "$root ($set)" >&2
  exit 0
fi

# No baseline is not "nothing has changed" — it is a run that never pinned, and
# the check has nothing to compare against. Refusing is the whole contract.
#
# EXISTS-but-unreadable is a different state than ABSENT, and it needs a
# different message: `--pin` never compares against the existing baseline, it
# just overwrites it with whatever the tree looks like now. Labeling this case
# "no baseline" and prescribing `--pin` would walk a controller from "the check
# could not look" to "certified clean" in one step, discarding evidence it
# never read — the exact anti-pattern run-team/SKILL.md forbids. (#1058)
basedir="$(dirname "$base")"

# A directory that exists but cannot be searched (missing +x) hides
# everything under it from stat(2) — `[ -e "$base" ]` below reads FALSE for
# every file underneath, so without this check the run falls through to the
# "no baseline" message one level up: the exact mislabel this refusal exists
# to prevent, just moved from the file to its containing directory. (#1058)
[ -d "$basedir" ] && [ ! -x "$basedir" ] \
  && die "$basedir exists but is unreadable — fix its permissions; do NOT --pin over it, --pin overwrites rather than compares"

# `-L` catches a dangling symlink: the link entry is present but its target
# is gone, so `-e` (which dereferences) reads FALSE and the run would
# otherwise fall through to the same "no baseline" message for a baseline
# that is very much present, just broken. (#1058)
{ [ -e "$base" ] || [ -L "$base" ]; } && [ ! -r "$base" ] \
  && die "$base exists but is unreadable — fix its permissions; do NOT --pin over it, --pin overwrites rather than compares"
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
# shellcheck disable=SC2086 # $set is a deliberate list of pathspecs, not one path
git -C "$root" status --porcelain -- $set >&2 || true
exit 1
