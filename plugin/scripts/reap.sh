#!/bin/sh
# Delete local branches whose upstream is gone, and their worktrees.
#
# Dry-run by default; --apply mutates. Every precondition is recomputed inside
# this invocation, because a branch list from an earlier call is already false:
# one observed run listed 28 gone branches and two calls later 27 had been
# reaped by a concurrent session.
#
# Deliberately NOT `/clean_gone`: its `[gone]` detection actually works —
# with an upstream configured, `git branch -v` does print `[gone]` and its
# grep matches (verified, git 2.50.1). It is disqualified because it then
# runs `git worktree remove --force` and `git branch -D` with no merged
# check at all: nothing there stops it deleting a branch whose commits exist
# nowhere else.
set -eu

# Byte semantics for the `awk`, `grep`, `tr` and `paste` below — this script
# runs no `sed`, and the four it does run do not all see the same data. `awk`
# parses branch names out of `git branch -vv`, worktree paths out of
# `git worktree list --porcelain`, and the ignored-file names
# `git status --ignored` prints; `paste -sd, -` joins those ignored names. `tr`
# sees none of that: it processes `$cherry`, `git cherry`'s output, whose commit
# subjects git constrains to no encoding at all, which makes it arguably the
# likeliest carrier of the four. `grep` reads `$cherry` at the two
# merged-commit checks AND `$wt_list` at the two registry re-reads, so it is
# the one tool here that sees both a commit subject and a raw worktree path.
# The sentence this replaces said `grep` saw only `$cherry`, and had been false
# for as long as those registry reads have existed. Under a UTF-8 locale BSD
# `tr` exits 1 on a byte that is not valid UTF-8, `paste` truncates its whole
# output at it and still exits 0, and `grep` does one of TWO things: it drops
# the offending line at rc 0/1, or it gives up on the scan and exits 2. Only
# the first half was ever written down here, which is why the second once read
# as a clean no-match at all four call sites — the reason `grep_probe` below
# takes grep's own status apart from grep's verdict.
#
# `awk` is NOT immune, and a fixture in this script's own test suite measured
# the earlier claim here false: it is byte-identical only when every rule matches
# at an ANCHOR before the bad byte, never needing to convert it. A rule that
# must SCAN PAST the byte to decide — here, the `/^branch /` match against a
# worktree's raw, unquoted registry path, one SIBLING entry away from the
# branch actually under sweep — dies instead: measured, BWK awk (macOS) aborts
# at rc 2 (`towc: multibyte conversion failure`), and this script runs under
# `set -eu`, so that death TERMINATES the whole sweep rather than merely
# mis-scoring one record. gawk and mawk (Linux CI) tolerate the same byte and
# answer rc 0, which is why this is a macOS-only ceiling, not a portable fix.
# Such a byte reaches us from a fetched tree even where the local filesystem
# refuses to hold the name. Leaving this ambient in no-undo-audit.sh was
# measured to cost a truncated list reported as a clean, confident answer.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on. "Nothing" is an
# inventory, not a hope: the suite's locale-pin prose test enforces it, because
# this sentence shipped false in no-undo-audit.sh and a `sort` added below
# would otherwise leave every test in this suite green.
export LC_ALL=C

# Below the locale pin, not above it with `set -eu`: `unset` touches no
# byte-sensitive tool, but the locale-pin prose test treats ANY line here that
# is not a comment, a blank, or `set -[eux]+` as work the pin must sit above,
# and refuses on principle rather than on this line's own behaviour. Same
# placement, same reason, as release-ticket.sh's copy.
#
# This is the script the class costs the most, and both halves are measured on
# it.
#
# GIT_DIR: nothing in the sweeps carries a `-C`. An ambient one therefore does
# not merely misreport — it MOVES THE DELETIONS. Measured, `--apply` run from
# clone A with `GIT_DIR` naming clone B's `.git`: B's worktree was removed and
# B's branch deleted, at rc 0, with a receipt naming them, while A's own
# [gone] branch and its dirty worktree were never looked at. A destructive
# command aimed at a repository the operator did not name.
#
# GIT_WORK_TREE: it outranks `-C`, so the dirty probe `git -C "$wt" status
# --porcelain` stops answering about `$wt`. Measured, on the fleet's own
# layout (`.worktrees/` gitignored, so the parent really is clean): a worktree
# holding uncommitted work is reported reapable — `would remove worktree`,
# `would reap` — where the unpoisoned run keeps it with reason `dirty
# worktree`. `git worktree remove` without `--force` still refuses on the real
# dirt downstream, so this stops short of data loss; what it costs is the
# `kept` reason an operator acts on, and a dry run that promises a removal the
# apply cannot perform.
unset GIT_DIR GIT_WORK_TREE

NAME=reap
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# The escaping helpers. json.sh's header holds the sourcing contract and the
# measurements behind it. This script defines no exit 1 at all, so a
# bare 1 out of it is a code its caller has no reading for. Placed here, above
# the fetch, so a missing library refuses before anything is deleted rather than
# partway through.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to reap without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

# The bounded, prompt-suppressed git transport. The fetch
# below is unattended: with no bound it can prompt for a credential or a host
# key, or stall on a transport that connects and then goes quiet, and either
# holds a fleet slot until something outside kills it. net.sh's header holds the
# reasoning and the measurements. Sourced below json.sh so a lone copy of this
# script still blames json.sh, the name its missing-library test pins.
net_lib="$(dirname "$0")/net.sh"
[ -r "$net_lib" ] || die "cannot read $net_lib — refusing to reap without the bounded git transport"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=net.sh
. "$net_lib" || die "$net_lib failed to load"

# The worktree readers. worktree.sh's header holds the sourcing
# contract and the measurements behind it, and json.sh's holds the `[ -r ]`
# reasoning all three guards share. Sourced below json.sh so a lone copy of this
# script still blames json.sh, the name its missing-library test pins, and above
# the fetch so a missing library refuses before anything is deleted.
wt_lib="$(dirname "$0")/worktree.sh"
[ -r "$wt_lib" ] || die "cannot read $wt_lib — refusing to reap without the worktree readers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=worktree.sh
. "$wt_lib" || die "$wt_lib failed to load"

# Count first, then value. The count guard used to be the only one, and the
# `--apply` test demoted anything else to "not --apply", so a single argument
# passed whatever it said. Measured on the pre-fix script over identical
# fixtures, `reap.sh --aply` and a bare `reap.sh` both exited 0 with
# byte-identical stdout and stderr — same payload, same banner, same per-branch
# lines — so nothing in the run said the flag had not been understood.
# Both refusals sit above the fetch, so a rejected invocation reads nothing and
# deletes nothing.
apply=false
[ $# -gt 1 ] && die "usage: reap.sh [--apply]"
if [ $# -eq 1 ]; then
  [ "$1" = "--apply" ] || die "unrecognised argument '$1' — usage: reap.sh [--apply]"
  apply=true
fi

base=${BASE_REF:-origin/main}

# Only a remote-tracking ref is accepted — the accept-list release-ticket.sh:229
# carries, and the one this script had none of. Both sweeps below ask a single
# question, has this work landed upstream, and only a ref the `fetch --prune`
# above maintains can answer it. Without the list a `BASE_REF=refs/heads/…` was
# taken at face value in both directions: a local `main` never fast-forwarded
# reads every merged branch as unmerged (strand everything), and
# `refs/heads/<a branch this run is about to sweep>` reads that branch's own
# commits as already upstream — `git cherry` empty, the delete authorized,
# and nothing at the delete refuses it: the compare-and-swap there refuses
# only a ref that moved, and the holder check only a branch a worktree holds.
#
# It is also what makes the qualification below sound rather than a guess.
# Qualifying was once recorded as unavailable here precisely because BASE_REF
# might name a tag, a sha or a local branch, leaving no prefix that is always
# correct; restricting the input first removes that objection instead of
# working around it. Placed with the argument guards above the fetch, so a
# rejected invocation reads nothing and deletes nothing.
case "$base" in
  origin/*|refs/remotes/*) ;;
  *) die "BASE_REF must be a remote-tracking ref, got '$base'";;
esac

# release-ticket.sh's SECOND guard — `*/"$branch") die` — is deliberately not
# ported, and the reason is structural rather than a judgement about severity.
# There the claim's own branch is a single known name, and `origin/$branch`
# passes the accept-list above while making every measurement vacuous, because
# a stale remote-tracking ref left by a pushed-then-deleted branch resolves
# with no branch on the remote to hold the commits. This sweep has no one
# branch to name, and the `fetch --prune` above is what closes the same route:
# it drops exactly those stale refs, so a `BASE_REF=origin/<branch>` that still
# resolves afterwards names a ref the remote still has — the commits it reads
# as upstream really are on the remote, and a branch that is ahead of it still
# prints `+`. Nothing is lost in either case, which is not true of the tag
# spelling handled next.

# And then stop MEASURING against a shorthand. `origin/main` is one, and git
# resolves a shorthand through its own disambiguation order (gitrevisions:
# refs/<name>, refs/tags/<name>, refs/heads/<name>, refs/remotes/<name>, …), in
# which refs/remotes/origin/main comes LAST — so a local tag literally named
# `origin/main` outranks the remote-tracking ref, and every measurement against
# $base then answers about the TAG. Measured on this script (git 2.50.1, Apple
# Git-155): an unmerged [gone] branch holding a commit that existed nowhere
# else, plus `git tag origin/main <that branch's own tip>`, printed
# `REAPED feature/solo` at exit 0 with an empty kept[] — the sole copy of the
# commit destroyed by a probe that was asked about the tag.
#
# Nothing already here could see it. The hijack is spelled as the legitimate
# DEFAULT, so no accept-list catches it; and `git rev-parse --verify "$base"`
# exits 0 whichever ref it picked — git's own
# `warning: refname 'origin/main' is ambiguous.` reaches stderr, where this
# script reads nothing and an unattended run has no one to read it. The fix
# pattern is the one proven in release-ticket.sh:264.
#
# refs/remotes/ leaves nothing to disambiguate, and the accept-list above
# already establishes $base is spelled for that namespace. $base itself is
# unchanged and stays in every operator-facing line: `origin/main does not
# resolve` is what a caller can act on, not the qualified spelling. A BASE_REF
# whose only resolution IS a tag now refuses at the guard below instead of
# measuring against it, which is the fail-closed half of the same edit.
case "$base" in
  refs/remotes/*) base_rev=$base;;
  *) base_rev="refs/remotes/$base";;
esac
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

# The worktree this run is standing in, read once and before anything is
# deleted. `--apply` removes worktrees, and the fleet's own `.worktrees/` home
# is exactly where a member stands when it runs this — so the worktree the
# script is running FROM was itself eligible for removal, and removing it
# deletes this process's cwd. Everything after that dies with
# `fatal: Unable to read current working directory`: measured (git 2.50.1,
# Apple Git-155) as `REMOVED worktree …` followed by a failed
# `git worktree prune` at exit 2, from a run whose every removal SUCCEEDED, and
# measured again on the branch sweep as a `git branch -D` that failed for that
# same reason on a branch whose worktree had just been removed. The two sweeps
# below refuse this one path and report it as a `kept` finding, which is the
# remedy an operator can act on — it is one `cd` away. Chdir-ing somewhere
# durable at the foot of the file would cover the prune only, and the prune is
# the LAST call that needs a cwd, not the only one.
#
# `--show-toplevel`, never `pwd`: this script may be invoked from a
# subdirectory, and that answers the worktree ROOT — the directory
# `git worktree list --porcelain` names. It does not always SPELL it the same:
# the listing echoes the path recorded at `worktree add` time, which a parent
# turned symlink since leaves non-canonical, and which `core.precomposeunicode`
# prints precomposed for a worktree whose on-disk name is NFD while git's own
# answer is the NFD bytes (measured, git 2.50.1, Apple Git-155). So
# `holds_cwd` below matches on the directory, not only the string.
#
# `2>/dev/null` and never `2>&1`, for the reason the in-progress guard below
# records at its own `rev-parse`: this capture is used as a PATH, not as
# message text, and a `~/.gitconfig` with a key outside any section makes every
# git command print `error: key does not contain a section: …` AT EXIT 0
# — folded in, that line would arrive glued in front of the path and match no
# worktree ever again.
#
# Empty is a legitimate answer, not a failure worth dying on: `--show-toplevel`
# exits 128 with one of two known messages where cwd is in no working tree (a
# bare repo root, or inside `.git`) — "not a git repository" or "this
# operation must be run in a work tree" (measured, git 2.50.1, Apple
# Git-155) — and neither is a path either sweep can remove: the branch sweep
# binds `$wt` only from a `branch` line a bare root never prints, and the
# enumeration below skips a bare entry outright.
#
# Any OTHER failure of this probe is NOT that answer and must not be folded
# into it. Doing so silently disables both cwd-delete guards below — every
# removal proceeds as though this run were standing in no worktree at all,
# reproducing the very cwd deletion those guards exist to stop. Fail closed
# instead: die, naming the probe that broke, so an operator chasing a
# downstream failure (a prune refusal, a branch delete dying on
# "Unable to read current working directory") lands on the real cause here
# rather than the symptom.
#
# The success path keeps `2>/dev/null`, never `2>&1`: folding stderr in would
# glue the stray-gitconfig warning onto the path on a plain SUCCESS too.
# Stderr is only re-captured, on a second call, once the first has already
# failed — the classification never touches the value the guards compare
# against. `self_wt_rc=…` (not `|| self_wt=`) keeps the check off `set -e`.
self_wt_rc=0
self_wt=$(git rev-parse --show-toplevel 2>/dev/null) || self_wt_rc=$?
if [ "$self_wt_rc" -ne 0 ]; then
  self_wt_err=$(git rev-parse --show-toplevel 2>&1 >/dev/null) || true
  case "$self_wt_err" in
  *"not a git repository"* | *"this operation must be run in a work tree"*)
    self_wt=
    ;;
  *)
    die "cannot tell whether this run is standing in a worktree slated for removal — 'git rev-parse --show-toplevel' failed with an unrecognised error (${self_wt_err:-exit $self_wt_rc}) instead of one of the two known 'not in a worktree' messages; refusing to reap with the cwd-delete guard unverified"
    ;;
  esac
fi

# True when removing worktree `$1` would delete this run's cwd: `$self_wt` is
# `$1` or lies anywhere beneath it (a nested worktree). Asked of the
# DIRECTORY, not the string: `-ef` (same device and inode) of `$self_wt` and of
# each of its parents in turn. The byte-boundary prefix match this replaces
# missed the same directory spelled two ways — the symlinked parent and the NFD
# name the header above records share no prefix with git's own answer — and
# `--apply` deleted the cwd it was standing in (measured). An empty `$self_wt`
# (no worktree) names no directory, so it matches
# nothing; the walk ends when no `/` is left to strip.
#
# `elif` on `$?`, same refusing direction `wt_linkage_why` states for its own
# `-ef`: every shell this file targets (dash, bash, ksh — all three tested)
# implements it, so a `[` that cannot evaluate it (rc 2) is
# unreached today, not impossible — and unlike `wt_linkage_why`, nothing
# downstream of THIS guard re-checks the directory it protects. Reading that
# rc as a plain "not this one" would silently disable both cwd-delete guards
# exactly the way an unrecognised `self_wt` failure would (the probe's note
# above), just one layer further in.
holds_cwd() {
  hc_d=$self_wt
  while :; do
    # shellcheck disable=SC3013,SC2319 # -ef is a ksh-derived extension bash/dash/BSD sh share, base in POSIX.1-2024; the else's $? is deliberately the `[ -ef ]` test's own rc, read before anything else runs, to fail closed (return 0) on rc>=2 same as wt_linkage_why below
    if [ "$hc_d" -ef "$1" ]; then hc_rc=0; else hc_rc=$?; fi
    if [ "$hc_rc" -eq 0 ] || [ "$hc_rc" -ge 2 ]; then return 0; fi
    case "$hc_d" in
      */*) hc_d=${hc_d%/*} ;;
      *) return 1 ;;
    esac
  done
}

echo "\$ git fetch --prune origin" >&2
fetch_budget=$(net_fetch_budget)
fetch_rc=0
net_git "" "$fetch_budget" fetch --prune --quiet origin || fetch_rc=$?
if [ "$fetch_rc" -ne 0 ]; then
  # A killed fetch and a refused one are different facts and get different
  # words. Without the split, a transport that stalled reads as a refusal,
  # naming a cause this script never observed.
  if net_stalled "$fetch_rc"; then
    die "git fetch did not finish within ${fetch_budget}s and was killed — refusing to reap on stale refs"
  fi
  die "fetch failed — refusing to reap on stale refs"
fi
# `$base_rev`, never `$base`: the qualified spelling is the one every
# measurement below uses, so it is the one whose existence has to be
# established — and asking about it is also what turns a BASE_REF that only
# resolves as a TAG into a refusal here rather than a merge probe answered by
# the wrong commit. The message names `$base`, the spelling the caller
# passed and the only one it can act on.
git rev-parse --verify "$base_rev" >/dev/null || die "$base does not resolve"
[ "$apply" = true ] || echo "$NAME: DRY RUN — nothing will be deleted. Pass --apply to act." >&2

reaped=""
kept=""
warnings=""
# Every worktree this run removed, by path, whether a branch accounted for it or
# not. One meaning, so the key needs no qualifier: the sweep below reaps
# worktrees no `reaped` branch names, and a payload that recorded only those
# would leave a reader guessing whether the branch sweep's removals were absent
# because none happened or because nothing reports them.
removed=""
# `jstr`'s output wrapped in the quotes JSON needs, or the literal `null` where
# it could not render. `die` is the wrong answer at both call sites below: by
# the time either accumulator is written this script may already have deleted
# branches, and the payload printed at the end is the caller's only record of
# that — the same reason the printf runs ahead of the prune. Exiting here
# would destroy the record of work that already happened. So an unrenderable
# field becomes `null` and the run still reports what it did, the ruling
# inflight.sh's `add_evidence` records for the same shape.
#
# jfield always exits 0, which is what makes it safe inside the `$( )` below:
# a substitution that failed would contribute an empty string and splice
# `{"branch":,…}` — malformed JSON — with nothing to notice it.
#
# Five interpolations converge on this function: the branch name, `dirty
# worktree $wt`, `ignored files present in $wt: $ignored`, `cherry probe
# failed …: $cherry` (arbitrary git stderr) — the first four via `keep`, at
# eleven call sites — and the `reaped` accumulator, which calls `jfield`
# directly and never routes through `keep` at all. The branch name is the
# demonstrated trigger — `git branch 'has"quote'` is a legal refname — and raw
# it emitted a payload no parser accepts at exit 0, while the branch was
# correctly kept. The stderr lines stay raw: they are prose for an
# operator, not JSON.
#
# A sixth joined the five above later: grep's own stderr, `$gq_err`,
# surfaced through `gp_why "$gq_err"` in `keep`'s message at the two cherry
# checks and the two registry re-reads —
# arbitrary text on the same footing as `$cherry`, routed through the same
# jfield/jstr escaping the paragraph above already covers. Left out of the
# "eleven call sites" figure above, which still counts only the original
# five; four more now carry grep's stderr specifically.
jfield() {
  if jf=$(jstr "$1"); then
    printf '"%s"' "$jf"
  else
    echo "$NAME: could not escape a payload field — reported as null" >&2
    printf null
  fi
}

# An empty `$1` is the worktree sweep at the foot of this script, which has no
# branch to name: the field becomes JSON `null` rather than `""`, the value
# `jfield` already emits for a field it could not render, so no consumer meets a
# type here it did not already have to handle. Every reason that sweep produces
# ABOUT a worktree names its path, which is why the stderr label can fall back
# to a placeholder without losing which worktree was kept — the two it produces
# before the enumeration succeeds ("cannot enumerate worktrees", "could not read
# the worktrees git listed") name none because none was established.
keep() {
  if [ -n "$1" ]; then kb=$(jfield "$1"); else kb=null; fi
  kept="${kept}{\"branch\":$kb,\"reason\":$(jfield "$2")},"
  printf '    KEEP %s — %s\n' "${1:-(no branch)}" "$2" >&2
}

# Runs `git "$@"`, and unlike a bare `$(git … 2>/dev/null)` this keeps git's
# stderr instead of discarding it — into $gp_err, never mixed into $gp_out,
# with git's own exit status returned by this function. This file's worktree
# status probes used to throw stderr away, so a `fatal:` at rc 128 named no
# cause and a `warning:` at rc 0 (measured — a permission-denied ignored
# directory) reached nobody. The wrong fix is
# `2>&1`: each of these probes is followed by a `[ -n "$gp_out" ]` dirty test,
# which reads the captured text as content, so folding a warning in would make a
# clean worktree with ANY git warning on it read as dirty forever.
#
# No temp file (this file creates none): git's stderr goes to fd3, which the
# group below dupes from fd1 before git runs, so it lands live in the SAME
# pipe `gp_raw=$( … )` reads — no separate pipe or file needed for it. Command
# substitution runs in its own subshell (POSIX), so a plain variable set
# inside — git's stdout, git's own $? — cannot escape it; only the TEXT
# written there survives. `gp_sep` marks where one piece ends and the next
# begins, so `gp_raw` can be split apart with plain parameter expansion once
# it is back in the real, top-level shell.
#
# THE SEPARATOR IS SAFE BECAUSE OF WHAT GIT DOES, NOT BECAUSE OF WHAT 0x02
# IS, and it is safe only for the commands this helper is currently pointed
# at, by two DIFFERENT rules for two DIFFERENT groups. Three call sites below
# read `status --porcelain` (`-uall`, or `-unormal --ignored`) and are safe
# because git quotes PATHS; a fourth, added after this comment was first
# written, reads `for-each-ref --format='%(refname)
# %(upstream:track)'` and is safe for an unrelated reason — a REFNAME,
# unlike a path, can never contain the byte at all. Nothing in the body
# checks either invariant.
#
# The path-reading three: both halves of git's answer put a control byte in
# a path beyond reach of the split, by two DIFFERENT rules — measured on git
# 2.50.1 (Apple Git-155), against a file named `weird<0x02>file` and a
# chmod-000 directory `dir<0x02>name`:
#
#   $gp_out: git C-quotes the path — `?? "weird\002file"`, a literal
#   backslash-002 inside quotes, never the raw byte. This does NOT hang on
#   `core.quotePath`, which only demotes bytes >= 0x80 out of "unusual";
#   "git quotes unusual bytes" is therefore the wrong claim to rest on,
#   since that exact escape hatch was measured for the HIGH-BIT class (see
#   derive-testcmd.sh). Zero raw 0x02 out of `--porcelain -uall` and out of
#   `--porcelain --ignored`, under core.quotePath true AND false.
#
#   $gp_err: git writes an unprintable byte in a path as `?` in its own
#   diagnostics — `warning: could not open directory 'dir?name/'`. Zero raw
#   0x02 there either.
#
# The ref-reading fourth: no PATH-quoting rule is doing the work, because no
# quoting is needed — git refuses to CREATE the ref at all. Measured, git
# 2.50.1 (Apple Git-155): `git branch "$(printf 'a\002b')"` fails outright —
# `fatal: 'a?b' is not a valid branch name` — and so does `git update-ref
# refs/heads/"$(printf 'a\002b')" HEAD` — `refusing to update ref with bad
# name`. `%(refname)` and `%(upstream:track)` can only ever answer with
# bytes that already survived `check-ref-format` on the way in, so a raw
# 0x02 can never reach either field to begin with. A fifth call site joins
# this ref group: `rev-parse --verify refs/heads/<b>`, where
# `<b>` is a name the `for-each-ref` call site produced. Its stdout is an
# object id in hex, and what it can put on stderr is git's own fixed prose
# around that same validated refname.
#
# SO DO NOT POINT `git_probe` AT A COMMAND WHOSE OUTPUT CARRIES NEITHER
# GUARANTEE. It takes `git "$@"`, so the invariant is the CALLER's to keep
# and nothing here catches a caller who drops it: a raw separator truncates
# $gp_out at that byte and concatenates the rest of the real output onto
# $gp_rc, which then reaches `return` as a non-numeric string (measured
# against a stub git). It is one flag away from the path
# group, not hypothetical — same git, same fixture: `status --porcelain
# -uall -z` carries the raw 0x02 straight through, `-z` being the
# machine-readable form that drops the quoting, and so does any command
# emitting CONTENT rather than paths or refnames (`log --format=%s`, `show
# <rev>:<path>`, both measured). The ref group has no equivalent flag —
# `for-each-ref` cannot be asked to emit an unvalidated refname — so this
# warning is really aimed at the path group and at any THIRD kind of call
# site a future caller might add.
#
# Left unguarded anyway, deliberately: every call site is shaped
# `if ! git_probe …; then keep …`, so a garbled $gp_rc can never come back 0
# and so can never turn a KEEP into a REAP. For a script whose only costly
# failure is deleting something it should have kept, that is the direction
# that matters, and it already fails closed. A numeric guard on $gp_rc was
# the competing remedy and was rejected: it buys loudness this failure mode
# does not need.
#
# `if gp_o=$(...); then gp_rc=0; else gp_rc=$?; fi`, never a bare
# `gp_o=$(...); gp_rc=$?`: under `set -e` a bare failing assignment aborts the
# subshell before `gp_rc=$?` or the printf below ever run, and `gp_raw` comes
# back empty — silently, at the one moment this function exists to not be
# silent (measured on this exact shape).
gp_sep=$(printf '\002')
git_probe() {
  gp_raw=$(
    {
      if gp_o=$(git "$@" 2>&3); then gp_rc=0; else gp_rc=$?; fi
      printf '%s' "$gp_sep$gp_o$gp_sep$gp_rc"
    } 3>&1
  )
  gp_err=${gp_raw%%"$gp_sep"*}
  gp_raw=${gp_raw#*"$gp_sep"}
  gp_out=${gp_raw%%"$gp_sep"*}
  gp_rc=${gp_raw#*"$gp_sep"}
  return "$gp_rc"
}

# True when git's stderr says the directory walk was CUT SHORT — entries are
# missing from $gp_out — as opposed to git merely having said something.
# "Anything on stderr" is the wrong test in both directions, measured here on
# git 2.50.1 (Apple Git-155):
#
#   too broad — a global gitconfig with a key outside any section makes EVERY
#   git command print `error: key does not contain a section: …` at rc 0 (the
#   same fault the rev-parse probe near the end of this file is redirected
#   for), and an unreadable core.attributesFile prints `warning: unable to
#   access '…': Permission denied`. Both leave the listing COMPLETE, so a
#   non-empty-stderr gate strands every worktree it guards for as long as the
#   operator's config stays broken, blaming the worktree for the fault.
#
#   too narrow — gating only the `--ignored` probe misses the plain scan: an
#   unreadable UNTRACKED directory makes `git status --porcelain` warn at rc 0
#   and answer EMPTY, which the dirty check below then reads as clean.
#
# `warning: could not open directory '<path>': <err>` is the message git emits
# for exactly that, and only that: measured at rc 0 with entries missing on an
# unreadable untracked directory, an unreadable ignored directory, and an
# unreadable directory holding a tracked file. So both probe kinds gate on it,
# and neither gates on anything else.
gp_cut_short() {
  case "$gp_err" in
    *"could not open directory"*) return 0 ;;
  esac
  return 1
}

# `: <what the probe said>`, or nothing at all when it said nothing. Two
# reasons not to interpolate $gp_err directly. It keeps its trailing newline —
# it is read straight out of the pipe, unlike $gp_out, which command
# substitution strips — so a bare `tr '\n' ' '` leaves a trailing space inside
# the JSON reason. And a git that dies without writing to stderr (measured: a
# signal-killed git exits 137 with stderr empty) would otherwise leave a
# dangling `": "` naming no cause, on the one path this whole change exists to
# make name one.
#
# `$gp_err` is the default, not the only input: `grep_probe` below captures its
# own scanner's stderr into `$gq_err`, and both need these same two guards.
# Taken as an argument rather than by duplicating the stripper, so a fix to
# either guard cannot land in one copy and miss the other. Every git-side call
# site passes nothing and still reads `$gp_err`.
gp_why() {
  gp_w=$(printf '%s' "${1-$gp_err}" | tr '\n' ' ')
  while :; do
    case "$gp_w" in
      *' ') gp_w=${gp_w% } ;;
      *) break ;;
    esac
  done
  if [ -n "$gp_w" ]; then printf ': %s' "$gp_w"; fi
}

# True when `$1`'s `.git` answers for `$1` itself; otherwise false, with the
# reason in `$lk_why`. Both sweeps call it once their `-f "$wt/.git"` test has
# established the linkage EXISTS, and before any git command run through `$wt`
# is believed — the dirty check first among them.
#
# Existing is not answering. Two shapes keep `.git` a well-formed regular file
# and move git's WORKING TREE elsewhere: a `.git` naming a foreign git dir not
# called `.git` whose `core.worktree` is another directory, and `core.worktree`
# set in the worktree's own `config.worktree` under `extensions.worktreeConfig`,
# `.git` untouched. `git -C "$wt" status` then reads THAT tree, so a clean one
# there reads clean over the work sitting in `$wt` — the dry run promised a
# removal `--apply` could not perform, `git worktree remove`'s own back-pointer
# and untracked-file checks being all that kept the work (measured on both
# shapes, both sweeps, git 2.50.1). `--show-toplevel` names the tree git
# actually answers for, so it is compared against `$1`.
#
# Compared as a DIRECTORY (`-ef`, same device and inode), never as a string:
# `$1` is the path `worktree list --porcelain` echoes and `--show-toplevel` is
# git's own resolved spelling, and the two legitimately differ for one and the
# same directory. A parent that was a plain directory at `worktree add` time
# and is a symlink now leaves the listed path non-canonical while git's answer
# is resolved (measured). And a worktree whose name is Unicode
# NFD-composed (`cafe` + U+0301) is listed PRECOMPOSED by the
# `core.precomposeunicode` git writes into every new repo on macOS, while
# `--show-toplevel` answers the on-disk NFD bytes — visually identical,
# byte-different, one directory (measured, git 2.50.1, Apple Git-155).
# `cd && pwd -P` canonicalises only the first: it echoes the spelling it was
# given, so a byte compare against it kept every healthy NFD worktree forever.
# `-ef` answers "same directory" for both and for any other spelling the
# filesystem aliases, and still refuses every redirect — each names a
# different directory. POSIX.1-2017's own `test` page does not define `-ef`
# at all, XSI or otherwise — it is a ksh-derived extension bash, dash, and
# BSD sh already share; POSIX.1-2024 (Austin Group bug 375) is what actually
# adds it, as a base utility primary. A `[` that cannot evaluate it fails,
# which is the refusing direction, as is a `--show-toplevel` naming a path
# that does not exist.
#
# `&& echo x` inside the substitution, then `%?x`: `$(...)` strips EVERY
# trailing newline, so a `core.worktree` naming a sibling directory called
# `<wt>` plus a newline byte — git accepts one as an ordinary path character —
# would otherwise name `$1` itself and pass the redirect (measured; the shape
# no-undo-audit.sh closed the same way). The sentinel leaves `$(...)`
# only git's own terminating newline to strip.
#
# What this does NOT cover, the boundary release-ticket.sh's copy of this
# compare also states: shapes that swap which git DIR answers while the
# working tree stays `$1` — a `.git` naming a sibling worktree's admin dir,
# or a foreign git dir whose `core.worktree` points back at `$1`.
# `--show-toplevel` answers `$1` for both. The dirty check reads `$1`'s real
# files against the borrowed index, and `git worktree remove` refuses a
# `.git` that does not point back at its admin dir, so neither is removed.
#
# A git that cannot answer at all is a refusal, never a pass: the reason is
# fetched with a second call only on that path, the way the cwd guard at the
# top of this file fetches its own, so the answer the compare reads never
# carries stderr.
wt_linkage_why() {
  if ! lk_top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null && echo x); then
    lk_why="has a .git linkage git cannot resolve$(gp_why "$(git -C "$1" rev-parse --show-toplevel 2>&1 >/dev/null)")"
    return 1
  fi
  lk_top=${lk_top%?x}
  # `if`, never `[ ! … ] || return 0`: a `[` that errors (rc 2) must refuse.
  # shellcheck disable=SC3013 # -ef is a ksh-derived extension bash/dash/BSD sh share, base in POSIX.1-2024; this file targets dash too and -ef is verified there
  if [ "$lk_top" -ef "$1" ]; then return 0; fi
  lk_why="has a .git linkage that answers for $lk_top, not for it — its dirty check would read that tree"
  return 1
}

# Runs `grep -q` over CAPTURED text and hands back grep's own status separately
# from the verdict grep was asked for.
#
# `grep -q` has THREE outcomes and a bare `if … | grep -q …; then` has room for
# two: rc 0 a line matched, rc 1 no line matched, rc 2+ grep could not finish
# scanning. Under `-q` both POSIX and GNU reserve 0 for a match even when an
# error also occurred, so an rc 2 means specifically "no match AND the scan
# broke". Tested two ways, that 2 lands in the NO-MATCH arm — a scanner that
# could not look reads exactly like a measurement that looked and found
# nothing. At the two merged-commit checks below, the no-match arm is what
# authorizes the branch delete and `git worktree remove`, so this swallow spends
# commits rather than merely miswording a reason: a tool's own failure
# reported as a clean verdict about the thing it was scanning.
#
# The shape, so no call site reaches the third outcome by accident: this
# returns 0 whenever grep delivered a verdict at all — `$gq_rc` then holds 0
# for matched and 1 for not — and non-zero when it did not. A call site reads
# `if ! grep_probe …` for "could not look" and `[ "$gq_rc" -eq 0 ]` for
# "matched", so the two questions stay as separate in the source as they are in
# grep. What it deliberately does NOT do is decide which way an unanswerable
# scan should fall: each call site rules on that for itself, because the cost
# differs — the cherry checks must keep, the registry re-reads have nothing
# left to protect and only a reason to get right.
#
# Unlike `git_probe` above, this needs no fd3 dup and no `$gp_sep` splice:
# `git_probe` smuggles TWO values (git's stdout `$gp_o` and its rc `$gp_rc`)
# out through one command substitution's single text channel, so it has to
# encode both into that text and split them back apart. `grep -q` never has a
# stdout worth keeping — `-q` promises silence there, enforced below by
# `>/dev/null` — so this function only ever has ONE value to carry out of the
# subshell as text, grep's stderr, and the command substitution's own return
# value already IS that text: `gq_err=$(...)` needs no separator to unpack.
#
# grep's own rc rides out a second, cheaper channel that `git_probe` cannot
# use: making the `grep -q` pipeline the LAST command run inside the command
# substitution means the substitution's own exit status — what `$?` reads
# immediately after the assignment — already IS grep's rc, with nothing
# encoded and nothing to decode. `git_probe` cannot do this because it still
# needs `$gp_o` out as text too, and a command substitution's exit status and
# its captured text both come from the SAME last command, so the moment
# something runs after grep to print a value, that later command's own exit
# status overwrites grep's. Grep's stderr is kept for the reason `git_probe`
# above keeps git's — a probe that dies naming no cause reaches an operator as
# a bare refusal — but keeping it costs nothing here: it IS the command
# substitution's text, not a second thing smuggled alongside the rc.
#
# `if gq_err=$(...); then gq_rc=0; else gq_rc=$?; fi`, never a bare
# `gq_err=$(...); gq_rc=$?`: under `set -e` a bare failing assignment would
# abort the function before `gq_rc=$?` ever ran, the same measured reason
# `git_probe` above takes the same shape. A command
# substitution used as an `if`'s condition is exempt from `set -e` by POSIX
# definition, so `gq_rc=$?` always runs whether grep matched, didn't match, or
# broke.
#
# `2>&1 >/dev/null` inside the substitution, in that exact order: `2>&1`
# first points fd 2 at fd 1's CURRENT target, which at that moment is the
# pipe the command substitution reads back into `$gq_err` — only THEN does
# `>/dev/null` retarget fd 1 alone, leaving fd 2 still pointed at the capture
# pipe. Reversed, `>/dev/null 2>&1` would duplicate an fd 2 that already
# points at `/dev/null`, and grep's stderr would vanish along with its
# promised-silent stdout, leaving `gp_why "$gq_err"` nothing to report.
#
# `-e "$gq_pat"`, never a bare `$gq_pat`: `grep --` is not portable, and a
# pattern read as a flag is the shape that makes a guard match nothing and
# report it as a clean no-match — this function's own defect, one layer down.
#
# Extra flags come AFTER the pattern (`grep_probe "$hay" "$pat" -xF`) so the
# pattern keeps a fixed, non-optional slot no flag list can shift it out of —
# a flag inserted ahead of a positional argument was measured to displace it.
grep_probe() {
  gq_hay=$1
  gq_pat=$2
  shift 2
  if gq_err=$(printf '%s\n' "$gq_hay" | grep -q "$@" -e "$gq_pat" 2>&1 >/dev/null); then
    gq_rc=0
  else
    gq_rc=$?
  fi
  [ "$gq_rc" -le 1 ]
}

# Sets `$state` to name what a re-read of the worktree registry found after a
# `git worktree remove` refusal — shared by the branch sweep and the
# branchless/detached-worktree sweep below, which otherwise carried this
# four-way chain, `$wt_list`/`$gq_rc`/`$gq_err` and all, as two byte-identical
# copies. One copy so a fix to the chain cannot land in one sweep and miss
# the other, same reasoning as `gp_why` taking its guards as an argument
# above. The two call sites still earn their own test fixtures: both
# pin that both sweeps actually CALL this, which one shared body cannot do by
# itself.
wt_reg_state() {
  if ! wt_listing; then
    state="cannot tell whether the registration survived"
  elif ! grep_probe "$wt_list" "worktree $1" -xF; then
    state="cannot tell whether the registration survived — the registry scan itself failed$(gp_why "$gq_err")"
  elif [ "$gq_rc" -eq 0 ]; then
    state="registration intact"
  else
    state="registration cleared"
  fi
}

# The registry cross-check. The branch lookup below matches a
# `branch refs/heads/<b>` line, and an empty match lets the branch through to
# the delete. Measured, git 2.50.1 (Apple Git-155): eight real admin-directory
# faults leave `git worktree list --porcelain -z` at rc 0 — so the `wt_listing`
# failure guard below never fires — while the held entry either loses its
# `branch` line or leaves the listing entirely: `HEAD` garbage, empty, missing
# or chmod 000; `gitdir` missing or chmod 000; the admin directory chmod 000;
# `.git/worktrees` replaced by a file. `$wt` came back empty and `git branch -D`
# — the delete then — deleted a branch a live worktree holds in all eight, its
# own "used by worktree" refusal fooled by the same admin state. The delete is
# now `git update-ref -d`, which consults no worktree at all, and the holder
# check ahead of it (`wt_holding`) reads that same listing: measured against
# the same eight, it answers "not held" for seven and "cannot tell" only for
# `HEAD` missing, the one fault that leaves a `detached` line behind. No
# backstop exists past this point, so the listing has to be checked against
# the registry before its silence is read as "no worktree".
#
# `wt_registry_why` sets `reg_why` and returns 1 when the listing cannot be
# trusted. Two checks, because the fault families differ in what they leave:
#
#   (a) COUNT. The `gitdir`/admin-dir/registry-file faults DROP the entry, so
#   fewer linked worktrees are listed than are registered under
#   `<git-common-dir>/worktrees/`. `count_registry` and `count_linked` mirror
#   inflight.sh's pair of the same names (inflight.sh `count_registry`,
#   `count_linked`, the recount at `[ "$linked" -eq "$registered" ] || {
#   count_registry && count_linked; }` and the two direction-named refusals
#   after it) — the stray-`mkdir` skip, the count-what-`ls`-cannot-read rule,
#   the `[ -r ] && [ -x ]` unreadable-registry arm and the `-ge 1` floor all
#   carry that copy's measurements. One tightening: `-d` joins
#   the unreadable arm, because a registry replaced by a mode-755 FILE passes
#   `-r` and `-x`, globs to nothing, counts 0 against git's 0, and agrees.
#
#   (b) NULL HEAD. The `HEAD` faults keep the entry, so the counts AGREE and
#   (a) sees nothing: git lists it with the null object id and no `branch`
#   line. A LINKED entry in that state is a worktree that held something git
#   can no longer name. An unborn branch carries a null id too, but WITH its
#   `branch` line, so it is not this; the main checkout (first record, and
#   the only one that can be `bare`) is excluded, and a missing `HEAD` line
#   reads as null, the same rule the branchless sweep's null-object-id arm
#   applies. That arm stays as it is: it reports the worktree, while this one
#   protects the branches. No `/^bare$/` rule here, deliberately: a test
#   fixture selects that sweep's awk by it, and a second carrier would shim
#   this one too.
#
# Either finding keeps the branch under lookup, whichever it is: a dropped or
# nameless entry says nothing about WHICH branch it held, so a healthy branch
# with no worktree is exactly as unclearable as the tampered one. The check
# runs on the listing each branch's own lookup reads — re-read per branch, as
# the comment at the `wt_listing` failure guard below records — so a standing
# fault keeps every [gone] branch in the pass, and a transient one keeps only
# the branches whose listing it touched (a transient-fault fixture pins that
# granularity for the listing failure; this guard follows it rather than
# latching).
#
# Recount before refusing, exactly as inflight.sh does it: the
# registry scan and git's listing are two reads at two instants, and a
# sibling's `worktree add`/`remove` landing between them makes the counts
# disagree with nothing wrong. Same order as that copy, first pair and recount
# alike: `count_registry` FIRST, git's listing SECOND — the loop takes the
# first registry count just ahead of the `wt_listing` failure guard, whose read
# is the first listing, so no extra listing is read per branch. A mutation
# landing between the first count and the listing is already reflected in the
# listing, so the recount's registry scan agrees with it; the recount re-takes
# BOTH, in the same order, and re-reads the listing through `wt_listing`, so
# `$wt_list` — which the lookup then scans — is the very listing the recount
# validated.
# inflight.sh's copy recounts once (its `[ "$linked" -eq "$registered" ] ||
# { count_registry && count_linked; }`); release-ticket.sh's bounds the same
# loop at two passes for a third-mutation window. This copy takes
# inflight.sh's single recount: a false refusal here costs one pass's wait,
# never a deletion, and a genuinely dropped entry is a standing state that
# survives every recount.
wtroot=
count_registry() {
  registered=0
  if [ -z "$wtroot" ]; then
    wt_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
      { reg_why="could not resolve the git common directory to read the worktree registry"; return 1; }
    wtroot="$wt_common/worktrees"
  fi
  [ -e "$wtroot" ] || return 0
  [ -d "$wtroot" ] && [ -r "$wtroot" ] && [ -x "$wtroot" ] ||
    { reg_why="worktree registry $wtroot could not be read"; return 1; }
  for entry in "$wtroot"/*; do
    [ -d "$entry" ] || continue
    if contents=$(ls -A "$entry" 2>/dev/null) && [ -z "$contents" ]; then continue; fi
    registered=$((registered + 1))
  done
  return 0
}

# Counts `$wt_list` as it stands; the caller decides whether to re-read it.
count_linked() {
  listed=$(printf '%s\n' "$wt_list" | awk '/^worktree /{c++} END{print c+0}') ||
    { reg_why="could not count the worktrees git listed"; return 1; }
  [ "$listed" -ge 1 ] ||
    { reg_why="git listed no worktrees at all — not even the main checkout"; return 1; }
  linked=$((listed - 1))
}

# Reads the first `count_registry` the loop took ahead of the listing: an
# unreadable registry there has already set `reg_why`.
wt_registry_why() {
  [ -z "$reg_why" ] || return 1
  count_linked || return 1
  if [ "$linked" -ne "$registered" ]; then
    count_registry || return 1
    wt_listing ||
      { reg_why="the recount could not re-read the worktree listing: $(printf '%s' "$wt_err" | tr '\n' ' ')"; return 1; }
    count_linked || return 1
  fi
  if [ "$linked" -lt "$registered" ]; then
    reg_why="git listed $linked linked worktrees for $registered registry entries in $wtroot — the listing dropped an entry, and a dropped entry names no branch"
    return 1
  elif [ "$linked" -gt "$registered" ]; then
    reg_why="git listed $linked linked worktrees but only $registered registry entries were counted in $wtroot — the registry read missed entries git can see"
    return 1
  fi
  if ! nameless=$(printf '%s\n' "$wt_list" | awk '
      function flush() { if (n > 1 && !br && h !~ /[^0]/ && hit == "") hit = w }
      /^worktree /{ flush(); n++; w = substr($0, 10); h = ""; br = 0; next }
      /^HEAD /{ h = substr($0, 6) }
      /^branch /{ br = 1 }
      END{ flush(); print hit }'); then
    reg_why="could not scan the worktree listing for a linked worktree with a null HEAD"
    return 1
  fi
  if [ -n "$nameless" ]; then
    reg_why="git listed a linked worktree with a null HEAD and no branch line ($nameless) — the entry no longer says which branch it holds"
    return 1
  fi
  return 0
}

# %(upstream:track) emits exactly [gone] as its own field — nothing to
# pattern-match, and no -v/-vv trap.
#
# %(refname) and a strip, never %(refname:short): the short form is
# ambiguity-aware, and where a TAG shares a branch's name it stops shortening
# and emits `heads/<name>` instead (measured, git 2.50.1 Apple Git-155). That
# string names no branch — `git branch -D`, the delete then, answered "branch
# not found" — and it
# does not build the `refs/heads/$b` key the worktree lookup below matches on
# either, so $wt comes back empty and the main-checkout, .git-linkage, dirty and
# ignored-files guards all stand down for precisely the branch whose name got
# away from them. %(refname) is always refs/heads/<name>, so the strip yields
# the bare name for every branch, ambiguous or not.
#
# The $2=="[gone]" field test is deliberately untouched, and it still selects
# the same branches: a space is not legal in a branch name (measured — git
# refuses `has space` as invalid), so the name is always the whole of $1, and a
# branch with no upstream leaves $2 empty rather than matching. The tracking
# forms that DO carry a space, `[ahead 1]` and its siblings, split so that $2
# holds `[ahead` — not `[gone]` either way.
# A command substitution inside a `for ... in` word list discards its own
# exit status entirely, in every shell measured here (bash, dash, macOS
# /bin/sh): `for x in $(false); do …; done` completes at the loop's own end,
# runs zero iterations, and never reaches `set -e` — regardless of how the
# pipeline failed. This script has `set -eu` but no `pipefail`, so a plain
# `git … | awk …` pipeline reports only its LAST stage's status: a
# `git for-each-ref` that dies still leaves awk scanning empty input, and
# awk finishes that scan at rc 0 — the identical exit this loop sees on a
# genuinely branchless repo. awk is not immune either, and this file's
# header already documents an awk that cannot finish a scan (the multibyte
# trigger). Either failure, unguarded, reads as a clean sweep
# that never looked: no branches matched because none was ever seen,
# indistinguishable from none being reapable.
#
# Split into git_probe's own two-capture shape — already this file's answer
# to the identical git-then-awk pipeline the ignored-files scan below runs
# (`git_probe`, then a separate `awk` over `$gp_out`) — so each stage's
# status is read on its own rather than folded into the pipeline's last
# exit code. Captured into a variable and guarded, rather than looped over
# directly, so the failure gets a voice. `keep ""`, not `die`: mirrors the
# branchless sweep's own enumeration guard below (`if ! wt_listing`), for
# the same reason — dying here would also abort the second sweep and the
# final `worktree prune`, neither of which this enumeration failing has
# anything to do with, over a failure that only defers reaping to a later pass.
if ! git_probe for-each-ref --format='%(refname) %(upstream:track)' refs/heads; then
  keep "" "could not enumerate [gone] branches — none reaped, and none reported reapable either$(gp_why)"
  gone_branches=""
else
  # git_probe captures git's stderr into $gp_err instead of leaving it on the
  # real fd — the whole reason it exists — and every OTHER call site in this
  # file reads $gp_err back out through a targeted check (gp_cut_short,
  # gp_why) before falling through. This call site's success path does
  # neither: an rc-0 `for-each-ref` that still WARNS used to reach the
  # operator's stderr directly, back when this was a plain
  # `git … | awk …` pipeline with git's stderr inherited, and now reaches no
  # one unless forwarded here explicitly.
  [ -z "$gp_err" ] || printf '%s' "$gp_err" >&2
  if ! gone_branches=$(printf '%s\n' "$gp_out" | awk '$2=="[gone]"{sub(/^refs\/heads\//,"",$1); print $1}'); then
    keep "" "could not enumerate [gone] branches — none reaped, and none reported reapable either"
    gone_branches=""
  fi
fi
for b in $gone_branches; do

  # The tip is read ONCE, here, and everything after it measures that frozen
  # SHA rather than the live ref: the cherry below runs against `$tip`, and
  # the delete at the foot of this loop is `git update-ref -d refs/heads/$b
  # $tip`, which refuses unless the ref STILL equals `$tip` at that instant.
  # The cherry once read `refs/heads/$b` and the delete was
  # `git branch -D "$b"`, a separate call that deletes whatever the ref holds
  # when it runs — so a commit landing between the two was force-deleted at
  # rc 0: the check-then-delete gap release-ticket.sh's own delete closes the
  # same way. A tip that cannot be read is a keep, never a delete.
  #
  # `git_probe`, never `2>&1` into the capture: `$tip` is used as a SHA, and a
  # stray `~/.gitconfig` warning git prints at rc 0 would arrive glued
  # onto it. git's own words still reach the reason, through `gp_why`.
  if ! git_probe rev-parse --verify "refs/heads/$b"; then
    keep "$b" "cannot read the branch tip — not deleted$(gp_why)"
    continue
  fi
  tip=$gp_out

  # git cherry against origin/main, not a local main: a local main never
  # fast-forwarded reads every merged branch as unmerged. Any + line is a commit
  # that exists nowhere else.
  #
  # Captured, not piped: `cmd | grep -q` takes grep's exit status, never cmd's,
  # so a `git cherry` that dies (exit 128 — one unreadable loose object is
  # enough) prints nothing, grep sees empty input and exits 1 — the identical
  # verdict a genuinely clean cherry produces, so "merged" is indistinguishable
  # from "the probe could not answer". An unmerged branch is never the ambiguous
  # one: its `+` line makes grep exit 0 and always keeps. Of the checks that
  # must pass before the delete, this is the only one that asks whether `$tip`
  # is merged — the worktree checks below and the `worktree remove` refusal
  # can each keep the branch, but none of them looks at its commits, and the
  # compare-and-swap refuses a ref that moved off `$tip`, never a `$tip` that
  # is unmerged — so an unanswerable probe must KEEP, the same fail-closed
  # shape the worktree `status` check below already uses.
  # `refs/heads/$b`, never a bare `$b`, where the tip is read above. Restoring
  # the bare name makes a branch that shares its name with a tag ambiguous AS A
  # REV again, and git resolves an ambiguous one by preferring refs/tags/ over
  # refs/heads/ (measured, git 2.50.1 Apple Git-155). This probe would then
  # answer about the TAG's commit while the delete below removes the BRANCH —
  # and a tag sitting on a merged commit reports clean for a branch whose
  # commits exist nowhere else. No other check before the delete asks whether
  # those commits are merged, so that reads straight through to destroying
  # them: measured on a fixture, the enumeration fix alone turned a branch
  # this script currently KEEPS into `REAPED`, at exit 0, with an empty
  # kept[]. Qualifying changes nothing for an ordinary branch — both spellings
  # name the same commit — and it is the same key the worktree lookup below
  # already builds.
  #
  # `$base_rev` is the other side of the same rule, and it was once missing:
  # `$base` reached this `git cherry` exactly as BASE_REF spelled it, so a
  # local tag named `origin/main` outranked refs/remotes/origin/main and the
  # probe answered about the TAG while `git branch -D`, the delete then,
  # deleted the BRANCH — measured, an unmerged [gone] branch whose commit
  # existed nowhere else REAPED at exit 0 with an empty kept[]. The
  # qualification is built at the top of the file, where its own comment
  # records why the accept-list beside it is what makes prefixing sound. Being
  # the only merge check bounds what ELSE could catch an unmerged branch, not
  # whether this check itself can be wrong — which is why BOTH revs it
  # consumes are qualified.
  if ! cherry=$(git cherry "$base_rev" "$tip" 2>&1); then
    keep "$b" "cherry probe failed — cannot tell if merged: $(printf '%s' "$cherry" | tr '\n' ' ')"
    continue
  fi
  # A `+` only at line start is a commit. $cherry holds stderr too — 2>&1 above,
  # so the failure reason can carry git's own words — and an unanchored match
  # reads a `+` anywhere in a diagnostic as a commit line, keeping a branch that
  # is merged. This pipe is safe where the one it replaces was not: it consumes
  # a variable, never git, and the `git cherry` probe already took git's status.
  # Anchored like release-ticket.sh's.
  #
  # What "grep's is the only status left to take" missed, and what this shape
  # exists for: taking it is not the same as READING it. grep answers three
  # ways, and the `if` once had two arms — an rc 2 scan that never
  # examined `$cherry` fell into the merged arm, and no check between here and
  # the delete below asks whether the branch is merged. So the deletion went
  # ahead on a merge status no tool had established. `grep_probe` splits the two
  # questions; the answers are ruled on here, in the order that makes the
  # unanswerable case fail CLOSED like every other could-not-check in this
  # file: scan first, verdict second.
  if ! grep_probe "$cherry" '^+'; then
    keep "$b" "cherry scan failed — cannot tell if merged$(gp_why "$gq_err")"
    continue
  elif [ "$gq_rc" -eq 0 ]; then
    keep "$b" "unmerged commits"
    continue
  fi

  # The registry is counted BEFORE the listing below is read — inflight.sh's
  # order, which `wt_registry_why`'s recount comment explains. A registry that
  # cannot be read sets `reg_why` here and is refused after the `wt_listing`
  # failure guard, so a listing failure still reports as one.
  reg_why=
  count_registry || :

  # The path is the whole rest of the line, never awk's $2: `worktree list
  # --porcelain` prints it raw, so a checkout living under a directory with a
  # space in it — ordinary on macOS — was otherwise truncated at the first
  # one, and every check below then ran against a wrong, nonexistent path.
  #
  # A listing that cannot be read fails CLOSED, like every other could-not-check
  # in this file: `$wt` would be empty, every guard under `[ -n "$wt" ]` below
  # skipped, and `git branch -D`, the delete then, needed no answer from the
  # registry to delete a branch with no worktree — so a merged [gone] branch was
  # force-deleted while the sweep could not see the registry at all. The holder
  # check at the delete re-reads the listing and keeps on a failed read too, but
  # it answers one question — does a worktree hold this branch — and every guard
  # under `[ -n "$wt" ]` asks others, so this lookup still fails closed on its
  # own. Keeping it strands every [gone] branch in this pass on one repo-level
  # failure, since the listing is re-read per branch (header: every
  # precondition is recomputed); reap runs after every merge pass, so each waits
  # one pass with the cause named.
  #
  # A genuine awk failure is a DIFFERENT fault from the listing failing, and is
  # guarded separately: it fires only when `wt_listing` itself succeeded — a
  # real, non-empty `$wt_list` — and awk could not finish scanning it (the
  # multibyte trigger this file's header documents). Left bare, that failure
  # aborted the whole script on awk's own diagnostic, with no `reap:`-prefixed
  # line for a caller to grep stderr for — the same shape release-ticket.sh's
  # own copy of this lookup was fixed for. `keep`, not `die`:
  # nothing has mutated $b yet, and dying here would also discard whatever
  # earlier iterations of this loop already reaped — the same reason the
  # branchless sweep below keeps rather than dies on its own copy of this pipe,
  # and the same reason the listing failure above keeps.
  if ! wt_listing; then
    keep "$b" "worktree lookup failed — cannot tell whether $b has a worktree; kept until a pass that can read the registry: $(printf '%s' "$wt_err" | tr '\n' ' ')"
    continue
  fi
  # A listing that READ is not yet a listing that can be trusted: see
  # `wt_registry_why` above. After the `wt_listing` failure guard, before the
  # lookup, so the lookup scans the listing this check validated (a recount
  # re-reads it).
  if ! wt_registry_why; then
    keep "$b" "worktree registry inconsistent — $reg_why; every [gone] branch is kept until a pass that reads a consistent registry"
    continue
  fi
  if ! wt=$(printf '%s\n' "$wt_list" |
            awk -v b="refs/heads/$b" '/^worktree /{w=substr($0,10)} /^branch /&&$2==b{print w}'); then
    keep "$b" "could not scan the worktree listing for $b — treating it as unresolved rather than guessing it has none"
    continue
  fi

  # A newline in that path used to end the porcelain record before
  # `substr($0,10)` could read past it, so `$wt` was a prefix of the real path —
  # a directory not on disk, which `[ -e ]` below then reported absent and the
  # removal was authorised against. The match itself was never affected: it is
  # made on the `branch` line, so only the path this sweep REPORTS and acts on
  # was wrong. `wt_listing` now delivers the whole path with the newline
  # substituted, and a substituted path is one no `git -C` or `worktree remove`
  # here can name — so it is refused rather than acted on.
  #
  # `nl_path ""` is false, so a branch with no worktree falls through to the
  # `[ -n "$wt" ]` below exactly as before.
  if nl_path "$wt"; then
    keep "$b" "worktree $wt holds a newline in its path — nothing here can stat it, so whether it holds work is unknown"
    continue
  fi

  if [ -n "$wt" ]; then
    # Three states, never the two `|| echo dirty` used to collapse it to:
    # present (readable decides, in the body below), established absent
    # (nothing to protect — reap.sh's OWN branches never rename their worktree
    # away from `[gone]`, so a directory that is really not there holds no
    # work, and it falls through to the removal), or cannot tell (keep — an
    # unanswerable probe authorizes nothing, the same fail-closed direction the
    # cherry check above already takes).
    #
    # `-e` is this `if`'s own condition, so existence is settled before any
    # git command runs through $wt: a genuinely deleted directory never
    # reaches a status call that would fail on it and read as dirty forever.
    if [ -e "$wt" ]; then
      # Establish the .git linkage exists before trusting anything git says
      # through it. Delete a worktree's .git file outright and `git -C` does
      # not fail: it walks UP to the enclosing repo and answers about THAT at
      # rc 0 — which the status call below would otherwise believe is this
      # worktree's own clean status. `-f`, not `-e`: an empty `.git`
      # directory and a dangling `.git` symlink leak the identical rc-0
      # answer. `-x "$wt"` stands aside for the git call below when $wt
      # itself cannot be searched, rather than guessing "no linkage" about a
      # worktree that was never actually looked at. This `$wt` is never the
      # main checkout — it was found by matching a `[gone]` branch above, and
      # `git worktree add` always writes `.git` as a regular file — so unlike
      # worktree-audit.sh this does not also need to accept a `.git`
      # directory. This `-f` test establishes only that the linkage EXISTS,
      # the same gate release-ticket.sh and worktree-audit.sh carry;
      # that it answers for `$wt` is established by the same-directory
      # `--show-toplevel` compare right after it (`wt_linkage_why`).
      # The main checkout reaches here, and must be answered before the
      # linkage guard below sees it. `git worktree list --porcelain` emits a
      # `branch refs/heads/...` line for the main worktree too, so a `[gone]`
      # branch that is the main checkout's own current branch binds `$wt` to
      # it — measured; the enumeration above does not exclude it. There `.git`
      # is a DIRECTORY (a real one always holds `HEAD` directly; an empty
      # stand-in or dangling symlink does not, which is what keeps this from
      # matching the broken-linkage shapes), not the regular file
      # `git worktree add` writes, so the `-f` guard below would call it "no
      # .git linkage" — measurably false, git answers about that repo
      # correctly through it. A reap is impossible here either way
      # (`git worktree remove` refuses a main worktree, and the holder check
      # before the delete refuses a branch its `branch` line names), so keep
      # and say which, in the dry run and under --apply alike — the plain `-f`
      # guard printed a false cause,
      # and dropping it entirely leaves the dry run promising a reap that can
      # never happen.
      if [ -d "$wt/.git" ] && [ -f "$wt/.git/HEAD" ]; then
        keep "$b" "worktree $wt is the main checkout — cannot remove it or delete the branch checked out in it"
        continue
      fi
      if [ -x "$wt" ] && [ ! -f "$wt/.git" ]; then
        keep "$b" "worktree $wt has no .git linkage — git would answer for the enclosing repo, not this one"
        continue
      fi
      # Gated on `-f` rather than on "not kept above": an unsearchable `$wt`
      # fails `-f` too, and is left to the status probe below, which keeps it
      # with git's own "Permission denied" instead of a cause invented here.
      if [ -f "$wt/.git" ] && ! wt_linkage_why "$wt"; then
        keep "$b" "worktree $wt $lk_why"
        continue
      fi
      # `-uall`, never a bare `--porcelain`: the untracked mode is CONFIG, and
      # `git status` honours `status.showUntrackedFiles`. Set to `no`, the scan
      # exits 0 with EMPTY output over a worktree holding untracked work — so
      # the rc check on this line passes, `gp_cut_short` below has no stderr to
      # gate on, `[ -n "$gp_out" ]` reads clean, and the reap removes the
      # worktree and takes the work with it, at exit 0, silently. Measured with
      # a control, git 2.50.1 (Apple Git-155), on an untracked file plus an
      # untracked subdirectory:
      #
      #   config `no`     `--porcelain` -> rc 0, 0 bytes
      #                   `--porcelain -uall` -> rc 0, `?? sub/deep.txt` …
      #   config unset    `--porcelain` -> rc 0, `?? sub/` …
      #                   `--porcelain -uall` -> rc 0, `?? sub/deep.txt` …
      #
      # This is the one shape the fail-closed `if ! …` idiom structurally
      # cannot see, because the status IS 0 — the rc-0 sibling of the
      # `git cherry` swallow this file's branch sweep already documents, where
      # rc was non-zero and taking the status was the whole fix. Nor can
      # `git_probe`'s stderr capture reach it: the config yields rc 0, empty
      # stdout AND empty stderr, so there is nothing for `gp_cut_short` to
      # match. Pinning the mode on the command line is the only fix: a probe
      # whose EMPTY answer licenses an action pins an explicit mode; a probe
      # that only reports after a gate has already refused need not (see
      # below). `git worktree remove`'s own refusal is no backstop, being the
      # same machinery the same config silences (measured at the --apply call
      # below).
      #
      # The one bare `--porcelain` left in a SCRIPT is deliberate:
      # instruments.sh prints one to stderr to say WHAT changed, after a digest
      # over `git ls-files` has already refused. That digest covers TRACKED
      # files only, so no untracked file can trigger it and the silenced mode
      # cannot hide the thing being reported. A report, not a gate. (Prose
      # instructions to an agent are a separate inventory — see SKILL.md,
      # pinned alongside the scripts.)
      #
      # `-uall` here, not `-unormal`: both override the config, but this probe
      # IS the dirty gate itself (unlike the `--ignored` reason-string probe
      # below, whose keep/reap verdict does not depend on per-file detail),
      # and `-uall` is the form measured against this site.
      if ! git_probe -C "$wt" status --porcelain -uall; then
        keep "$b" "worktree $wt could not be read$(gp_why)"
        continue
      fi
      # Before the dirty check, never after it: a walk git could not finish
      # answers EMPTY, so `[ -n "$gp_out" ]` below reads it as clean and the
      # run goes on to delete a worktree it never finished reading. An earlier
      # version of this comment argued a plain scan cannot reach that warning
      # because it skips ignored paths without opening them; the scan does open
      # UNTRACKED directories, and measurably warns at rc 0 on an unreadable
      # one. $gp_out still stays clean of whatever reached stderr — that is
      # what git_probe is for — so a warning is never read as dirty content
      # either.
      if gp_cut_short; then
        keep "$b" "worktree $wt status warned, listing may be incomplete$(gp_why)"
        continue
      fi
      if [ -n "$gp_out" ]; then
        keep "$b" "dirty worktree $wt"
        continue
      fi

      # `git worktree remove` refuses on modified and untracked files, but NOT
      # on ignored ones — it deletes those silently. In a NON-fleet worktree a
      # precious ignored file (.env, scratch) must not vanish, so check
      # --ignored and keep. A fleet worktree is different: claim-ticket.sh
      # creates it under .worktrees/ fresh from origin/main. Merged
      # (cherry-clean above) + tracked-clean (--porcelain above), its ONLY
      # ignored files are machine-generated (agent-test, node_modules, build
      # output) — nothing precious. Since every fleet worktree carries them,
      # keeping on ignored files would strand them all and defeat reap. Run
      # the ignored-keep for non-fleet trees only, keyed on the .worktrees/
      # home (robust to an older tree that predates the agent-test marker).
      case "$wt" in
        */.worktrees/*) : ;;
        *)
          # An explicit mode for the reason the plain scan above states, and
          # it is NOT redundant with it: this probe is the same machinery, so
          # the same `status.showUntrackedFiles = no` silences the backstop
          # that exists to catch what the primary gate misses, and the
          # apparent defence in depth is only apparent. Measured on the same
          # fixture: under that config `--porcelain --ignored` answers 0
          # bytes at rc 0 — the `!!` lines are suppressed too, so a precious
          # ignored file reads as absent — while `--porcelain -unormal
          # --ignored` lists both `??` and `!!` entries.
          #
          # `-unormal`, not `-uall`, here: this probe only builds the
          # human-readable "keep" reason string below, and the keep/reap
          # verdict is unaffected either way — `-uall` would additionally
          # expand every file INSIDE an ignored directory (e.g. `node_modules`)
          # into its own `!!` line instead of the one line `-unormal` gives
          # the directory, detail nobody downstream reads. Measured: 5000
          # ignored files under one directory cost 129KB/6.8s under `-uall`
          # versus 293B/0.19s under `-unormal`; at 10000 files, 259KB/27.8s,
          # roughly quadratic. `-unormal` defeats the config equally well at
          # none of that cost.
          if ! git_probe -C "$wt" status --porcelain -unormal --ignored; then
            keep "$b" "worktree $wt unreadable (git status --ignored failed)$(gp_why)"
            continue
          fi
          # `--ignored` asks git to OPEN every ignored path to list what is
          # inside it (measured: a `chmod 000` ignored directory made this
          # exact probe warn and exit 0). A precious
          # ignored file under a path git could not open would never reach
          # $ignored, and `git worktree remove` deletes ignored files
          # silently — so a cut-short walk fails closed rather than report what
          # git managed to see as the whole answer.
          if gp_cut_short; then
            keep "$b" "worktree $wt status --ignored warned, listing may be incomplete$(gp_why)"
            continue
          fi
          # `paste`, not `awk`, used to be this substitution's last stage, so
          # the substitution reported PASTE's status only — an awk that could
          # not finish scanning `$gp_out` (the multibyte trigger) failed
          # silently AND invisibly: unlike the bare assignments above, nothing
          # here even reads as "empty means none", because the captured
          # pipeline still succeeds — paste has nothing of its own to fail on
          # an empty or partial input. Restructured into two captures so each
          # fallible stage's own status survives, the rule json.sh states for
          # `jstr`'s `sed | tr` ("EVERY FALLIBLE STAGE'S STATUS IS READ") and
          # the shape release-ticket.sh's own worktree lookups already take.
          # `keep`, not `die`, for the reason the worktree lookup above gives:
          # this is per-branch and nothing has mutated $b yet.
          if ! ignored_lines=$(printf '%s\n' "$gp_out" | awk '/^!! /{sub(/^!! /,""); print}'); then
            keep "$b" "worktree $wt ignored-files scan failed — treating it as unresolved rather than guessing it has none"
            continue
          fi
          if [ -n "$ignored_lines" ]; then
            if ! ignored=$(printf '%s\n' "$ignored_lines" | paste -sd, -); then
              keep "$b" "worktree $wt ignored-files list could not be joined"
              continue
            fi
            keep "$b" "ignored files present in $wt: $ignored"
            continue
          fi
          ;;
      esac
    elif ! gone "$wt"; then
      keep "$b" "cannot tell whether worktree $wt exists"
      continue
    fi

    # Refused before the removal below, and in the dry run as well as under
    # `--apply`, for the reason the main-checkout guard above records: a
    # `would remove worktree` line the next `--apply` refuses is a promise this
    # script cannot keep. Unlike git's own refusals this one IS
    # predictable — the cwd is known before anything is deleted.
    #
    # Below the probes rather than above them, so every reason already true of
    # this worktree keeps its precedence: dirty, unreadable and unmerged all
    # name something about the worktree itself, while this one names only where
    # the script happens to stand. It sits here, last, because this is the
    # guard the removal is refused by.
    #
    # `continue`, so the branch is kept with its worktree — the pairing the
    # main-checkout reason already states, and the holder check before the
    # delete would refuse a branch checked out in a surviving worktree anyway.
    #
    # Ancestor match, not exact equality: a worktree nested inside `$wt`
    # (a real, documented shape — SKILL.md names a member committing from a
    # nested worktree) has `$wt` as an ancestor on disk, so removing `$wt`
    # removes the nested one's files too — taking any uncommitted work in it
    # along, the same cwd deletion this guard exists for, one path further
    # out — even though `$wt` itself never equals `$self_wt` in that shape.
    # `holds_cwd` carries the match and why it is on the directory, not only
    # the string.
    if holds_cwd "$wt"; then
      keep "$b" "worktree $wt holds the working directory this run was started in — removing it would delete the cwd every git call after it needs; rerun from outside it"
      continue
    fi

    # Reached with $wt either present-readable-clean or established absent —
    # `git worktree remove` accepts a prunable-because-absent entry at rc 0
    # and clears the stale registration outright (verified, git 2.50.1, same
    # as release-ticket.sh measures for its own delete), so no separate branch
    # is needed for the absent case.
    if [ "$apply" = true ]; then
      # No --force, ever. It refuses on modified and untracked files — but
      # that refusal reads the same `status` machinery the probe above does, so
      # it is a DEFAULT-config guarantee, not an absolute. Measured here, git
      # 2.50.1 (Apple Git-155), with a control: with `status.showUntrackedFiles
      # = no` set, removing a worktree holding an untracked file exits 0 and
      # takes the file with it; the identical fixture without that config exits
      # 128 refusing. That is why the probes above pin `-uall` and why
      # this line may not be read as a second opinion: the config that silences
      # them silences this too, so the gate above is the ONLY thing standing
      # here. The ignored-file gap it never covers under any config is handled
      # by the check above.
      #
      # A non-zero exit does NOT mean the removal had no effect. Measured here,
      # git 2.50.1 (Apple Git-155): a locked worktree exits 128 with the
      # registration INTACT, while a symlink standing in for the directory
      # exits 255 with the registration CLEARED. Reading "refused" off the exit
      # code reports the second as though nothing had happened.
      #
      # Re-read the REGISTRY, never the filesystem, and claim only what that
      # read answers. The registration and the directory are INDEPENDENT facts,
      # in both directions — measured: a peer session that finishes the same
      # removal between this lookup and this remove clears the registration
      # with nothing left on disk (the concurrency this script's own header
      # documents), and `chmod 555 .git/worktrees/<id>` deletes the whole
      # directory while the entry stays listed. So a cleared registration is no
      # evidence of an orphan, an intact one is no evidence that nothing was
      # removed, and naming a filesystem state nobody probed would be the very
      # defect this re-read exists to fix — a reason naming something other
      # than what was measured. reap.sh and release-ticket.sh once answered an
      # unreadable worktree in opposite directions; that is closed, and a third
      # filesystem probe here would reopen exactly that ground. `gone()` above
      # is deliberately not reused: it
      # answers a harder question (established absence vs an unsearchable
      # prefix) that a registry read does not have, and cannot fail the way a
      # stat can.
      #
      # Captured, not piped: `git … | grep -q` takes grep's status, never
      # git's — the same swallow fixed for `git cherry` above, which the probe
      # that reports it must not reintroduce. A registry read that itself fails
      # says so, rather than being misread as "cleared".
      #
      # `grep_probe`, not a bare `grep -q`, for the half of that the capture
      # alone never covered: grep's rc 2 also read as "cleared" here, so a
      # scanner that could not examine the listing reported the alarming state
      # as a measurement. Nothing on disk turns on it — both arms keep and
      # continue — which is exactly why it is a REASON bug and not a deletion
      # bug, and why the unanswerable arm here joins the existing
      # unread-listing arm rather than inventing a third verdict.
      #
      # Still keep, still continue, and nothing on disk is touched either way:
      # one refusal must not strand the remaining branches of an unattended
      # sweep, and a directory whose contents nobody has inspected is not this
      # script's to delete.
      if ! err=$(git worktree remove "$wt" 2>&1); then
        wt_reg_state "$wt"
        keep "$b" "worktree remove refused ($state): $(printf '%s' "$err" | tr '\n' ' ')"
        continue
      fi
    else
      printf '    would remove worktree %s\n' "$wt" >&2
    fi
    removed="${removed}$(jfield "$wt"),"
  fi

  if [ "$apply" = true ]; then
    # What the compare-and-swap below does not give back: `git update-ref` is
    # ref-only plumbing and, unlike `git branch -D` (this sweep's former
    # delete), consults no worktree at all. `-D`'s own delete-time refusal on a
    # branch a worktree holds is replaced by worktree.sh's `wt_holding`, over
    # the listing re-read here rather than the one the `$wt` lookup above
    # read: the `worktree remove` above has changed it since, and a
    # `git worktree add` for this branch can land after that lookup. Held by
    # either route `-D` refused on — a `branch` line, or a detached worktree
    # stopped mid `rebase -i` or mid `git bisect` on this branch, which the
    # `$wt` lookup never binds because the listing prints no `branch` line for
    # it. Measured, git 2.50.1: `-D` refuses both, `update-ref -d` deletes
    # both, and the sibling's `rebase --continue` then fails on `cannot lock
    # ref`. A worktree the reader cannot resolve is a keep,
    # never "not held".
    #
    # Under --apply only, like the delete it guards: in the dry run the
    # worktree the `$wt` lookup found is still registered, and would read as a
    # holder of the very branch it pairs with. The dry run therefore cannot
    # predict THIS branch's own refusal — but not "exactly as it could not
    # predict `-D`'s": `-D`'s blind spot here was only ever this
    # branch's own paired worktree. A registry read that fails closed for an
    # UNRELATED worktree elsewhere in the listing (reaping.md) keeps every
    # `[gone]` branch in the pass, a repo-wide case `-D` had no equivalent of
    # — it needed no registry answer at all and failed OPEN on one it could
    # not read. The dry run — printing `would reap` unconditionally
    # here — cannot predict any of those keeps either.
    #
    # A window remains between this re-read and the delete. A commit landing
    # in it moves the ref off `$tip`, and the compare-and-swap refuses. A
    # `git worktree add` of this branch landing in it moves nothing, so the
    # delete goes through under it — and `wt_recheck_delete`, right after the
    # delete, finds that worktree and restores the branch rather than leaving
    # it broken and unreported.
    if ! wt_listing; then
      keep "$b" "cannot re-read the worktree list to check $b before the delete — not deleted: $(printf '%s' "$wt_err" | tr '\n' ' ')"
      continue
    fi
    if wt_holding "refs/heads/$b"; then held_rc=0; else held_rc=$?; fi
    case $held_rc in
      0)
        keep "$b" "$b $wt_holder_how in worktree $wt_holder — not deleted"
        continue
        ;;
      1) ;;
      *)
        keep "$b" "cannot tell whether $b is held by worktree $wt_holder — not deleted"
        continue
        ;;
    esac

    # The compare-and-swap: `update-ref -d <ref> <tip>` deletes only while the
    # ref still equals the `$tip` the cherry check measured, so a commit
    # landing since is refused with git's `cannot lock ref … is at <new> but
    # expected <tip>`, branch and commit intact. Never plain `git branch -d`:
    # upstream is gone, so it compares against a possibly-behind local HEAD
    # and refuses everything here.
    #
    # `--no-deref`: measured, git 2.50.1, `update-ref -d` on a branch that is
    # a symbolic ref deletes the branch it POINTS AT and leaves the symref
    # dangling. `-D` deleted the symref itself, and so does this.
    #
    # `2>&1` into the capture, and update-ref prints nothing on stdout: a bare
    # "branch delete failed" names the step, never the fault, and git's own
    # diagnosis is the only thing that tells an operator which remedy applies.
    if ! err=$(git update-ref --no-deref -d "refs/heads/$b" "$tip" 2>&1); then
      keep "$b" "branch delete failed: $(printf '%s' "$err" | tr '\n' ' ')"
      continue
    fi
    # The add that raced the delete, caught after it: a worktree that checked
    # this branch out while the delete ran. Ahead of the config removal below,
    # so a restored branch keeps its upstream and is selected again next pass.
    if wt_recheck_delete "refs/heads/$b" "$tip"; then race_rc=0; else race_rc=$?; fi
    case $race_rc in
      0) ;;
      2)
        keep "$b" "$b $wt_restore_why, and restoring it at $tip failed — $wt_restore_out: $(printf '%s' "$wt_err" | tr '\n' ' ')"
        continue
        ;;
      *)
        keep "$b" "$b $wt_restore_why — branch restored, not deleted"
        continue
        ;;
    esac
    # The `[branch "<b>"]` config section, which `-D` removed with the ref and
    # ref-only `update-ref` leaves behind. Measured, git 2.50.1: a later
    # `git branch --no-track <b>` inherits the stale upstream and reads
    # `[gone]` at once, so the next pass would select it. The branch is
    # already deleted, so a failure here is never a keep — but it is not
    # stderr-only either: an unattended caller reading only stdout JSON must
    # still learn the stale upstream was left, so it lands in `warnings` too.
    if ! err=$(git config --remove-section "branch.$b" 2>&1); then
      errflat=$(printf '%s' "$err" | tr '\n' ' ')
      printf '    note: %s deleted, but its branch config section was left: %s\n' "$b" "$errflat" >&2
      warnings="${warnings}{\"branch\":$(jfield "$b"),\"note\":$(jfield "branch config section was left: $errflat")},"
    fi
    echo "    REAPED $b" >&2
  else
    echo "    would reap $b" >&2
  fi
  reaped="${reaped}$(jfield "$b"),"
done

# Second sweep: the worktrees the branch sweep above cannot see AT ALL.
#
# That sweep locates a worktree by the `branch refs/heads/<name>` line
# `git worktree list --porcelain` prints for it, so a worktree carrying no such
# line was never refused — it was never considered, which is why the
# no-silent-caps rule did not fire either: no `would remove worktree` line, no
# `kept` entry, and the directory left on disk while its branch was reaped
# (measured live during a merge pass). A stale worktree still answers
# `git worktree list` and inflight.sh reads one as a live claim, so an
# already-merged ticket then reads as taken and the candidate queue shrinks
# with nothing reporting it.
#
# What leaves a fleet worktree detached is NOT recorded here, deliberately. An
# earlier draft of this comment blamed the merge bot's server-side rebase and
# that mechanism is measured false: in a later pass the bot reported
# `path=rebase` for three PRs, and a `reap.sh` dry run immediately after
# printed `would remove worktree` for all three — a line only an ATTACHED
# worktree reaches. run-merge-bot.md says the same for that step: the API
# rebased the remote, not your checkout, which is left attached and merely
# stale. The shape is observed; the route to it is not established, and
# release-ticket.sh names a different one (an interrupted rebase) it did
# measure. This sweep decides on the state git reports, never on how it got
# there, so nothing below depends on the answer.
#
# Deliberately a second sweep rather than a shared helper over the guard chain
# above. The two differ in more than their subject: there is no branch to name
# in a reason, none to delete afterwards, the merged probe takes a bare object
# id instead of a refname, and the in-progress guard below has no business on a
# `[gone]` branch, where a stale sequencer file would strand a worktree whose PR
# has already merged. Same call reap.sh and release-ticket.sh already make for
# their two copies of `gone()`, for the opposite reason: there the callers
# differ in nothing else.
if ! wt_listing; then
  keep "" "cannot enumerate worktrees — a branchless one would go unreported: $(printf '%s' "$wt_err" | tr '\n' ' ')"
# `h" "p`, an object id and a path: the id is fixed-width hex with no space in
# it, so the shell splits the pair on the first space and the path keeps the
# rest — the whole rest, since `substr($0,10)` is what reads it, never awk's
# `$2`, or a checkout under a directory with a space in its name reads as a
# different path. A record git printed no `HEAD` line for leaves the id empty,
# which the null-object-id arm below already answers for.
#
# `bare` sets the same exclusion flag a `branch` line does. A bare repo used as
# a worktree root prints `worktree <path>` then `bare` and NOTHING else — no
# HEAD, no branch (measured, git 2.50.1 Apple Git-155) — so without this it
# arrived below with an empty id and was reported with the null-object-id arm's
# diagnosis, "has an unresolvable HEAD", which is false: git can say exactly
# what it holds, a bare repo holds no working tree at all. It is never a
# `[gone]`-branch worktree and there is nothing there to remove.
#
# Status taken, not swallowed: this pipeline's last command is the awk, so an
# awk that could not run leaves `$detached` empty and every branchless worktree
# goes unmentioned — the very silence this sweep exists to end, committed
# inside it. The branch sweep above takes both statuses too — the listing's
# and its awk's — and keeps the branch on either.
#
# Pinned at the same arm the paragraph above admits to: a test in the suite
# shims a failing `awk` onto PATH, selected by this program's own `/^bare$/`
# rule, over a repo holding one detached worktree, and requires the decline
# below with an EMPTY removal list. Swallow this status and that fixture's
# sweep goes silently empty — measured, the test reds on `kept.length` 0.
elif ! detached=$(printf '%s\n' "$wt_list" |
       awk '/^worktree /{if (p != "" && !skip) print h" "p; p=substr($0,10); h=""; skip=0; next}
            /^HEAD /{h=$2}
            /^branch /{skip=1}
            /^bare$/{skip=1}
            END{if (p != "" && !skip) print h" "p}'); then
  keep "" "could not read the worktrees git listed — a branchless one would go unreported"
else
  # Read off this listing before the loop below, which re-reads it into the
  # same `$wt_list` whenever a removal refuses: the worktrees checked out on a
  # branch that no longer exists, for the backstop after that loop. A
  # `branch` line with the null object id as its `HEAD` is that shape, and
  # the backstop then asks git whether the ref really is gone. Status taken,
  # for the reason given for `$detached` above.
  if ! broken=$(printf '%s\n' "$wt_list" |
         awk '/^worktree /{if (p != "" && b != "" && h ~ /^0+$/) print b" "h" "p; p=substr($0,10); h=""; b=""; next}
              /^HEAD /{h=$2}
              /^branch /{b=substr($0,8)}
              END{if (p != "" && b != "" && h ~ /^0+$/) print b" "h" "p}'); then
    keep "" "could not read the worktrees git listed — one checked out on a deleted branch would go unreported"
    broken=
  fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    head=${entry%% *}
    wt=${entry#* }

    # Before any probe stats `$wt`, and before the main-checkout test below,
    # which would answer `-d "$wt/.git"` about a path that is not the one git
    # listed. A newline in the path used to split the porcelain record AND the
    # `read -r` line above, so this sweep saw a prefix and, being the sweep that
    # deletes branchless worktrees, could authorise a removal against it.
    # `wt_listing` keeps the record and the line whole; the substituted byte is
    # what no command here can name, so the entry is kept and reported.
    if nl_path "$wt"; then
      keep "" "worktree $wt holds a newline in its path — nothing here can stat it, so whether its work has landed is unknown"
      continue
    fi

    # The main checkout, answered before the ownership bound below so it keeps
    # the reason that is true of it rather than the one true of every stranger.
    # It reaches this sweep whenever it is itself detached, it is never under
    # `.worktrees/`, and this test needs nothing the probes below establish —
    # both operands are false for a path that does not exist. Still ahead of the
    # linkage test for the reason the branch sweep records: that test would
    # otherwise call the main checkout's `.git` DIRECTORY a broken linkage.
    if [ -d "$wt/.git" ] && [ -f "$wt/.git/HEAD" ]; then
      keep "" "worktree $wt is the main checkout — cannot remove it"
      continue
    fi

    # The ownership bound, and the first thing asked of anything else. The branch sweep above
    # authorises a delete on evidence the PR merged — `%(upstream:track)` reads
    # exactly `[gone]`, the remote branch deleted. This sweep has no such
    # evidence to read: branchless, clean and patch-equivalent to `$base` also
    # describes a human's `git worktree add --detach` scratch checkout that was
    # never a fleet ticket, and without this bound `--apply` deleted it
    # (measured: the same fixture survives the branch-only script and is
    # DELETED by the branchless one). `*/.worktrees/*` is the fleet's own
    # worktree home — the set this sweep exists for — and the same key
    # claim-ticket.sh builds its paths under.
    #
    # A `keep`, never a silent `continue`: a directory this script looked at
    # and walked past with nothing said is the exact defect this sweep exists
    # to end, and the reason has to survive being read by someone who expected
    # a removal.
    #
    # It is also why this sweep carries no `--ignored` probe, unlike the branch
    # sweep: that probe exists to protect a .env or a scratch note in a worktree
    # OUTSIDE this home, and no such worktree reaches past this bound.
    case "$wt" in
      */.worktrees/*) : ;;
      *)
        keep "" "worktree $wt is not a fleet worktree — outside .worktrees/, so nothing here says its work has landed"
        continue
        ;;
    esac

    # An absent `branch` line is not by itself a detached checkout: git also
    # emits none for a worktree whose HEAD it could not resolve, which it
    # reports as the null object id — a `chmod 000` or garbage admin `HEAD`
    # file, a dangling symlink or a directory standing in for one. Those are
    # the four routes measured against release-ticket.sh's own lookup, and
    # they empty this key exactly as a detached HEAD does. Nothing about such a
    # worktree can be decided — there is no commit to probe for merged-ness —
    # so it is reported and left, the same fail-closed direction the cherry
    # checks take. The conjunction release-ticket.sh's `unresolved_head` makes
    # in one place is made here in two: the enumeration above already
    # established this record carries no `branch` line, which is what keeps an
    # unborn branch — a legitimate null id that DOES carry one — out of this
    # arm entirely.
    case "$head" in
      *[!0]*) : ;;
      *)
        keep "" "worktree $wt has an unresolvable HEAD — git cannot say what it holds"
        continue
        ;;
    esac

    # `git cherry`, never `git merge-base --is-ancestor`: the branch was rebased
    # before it merged, so its tip is patch-equivalent to what landed rather
    # than an ancestor of it, and ancestry answers no for work that is fully
    # upstream. Captured, never piped into `grep -q`, for the reason the branch
    # sweep above records: the pipeline would take grep's status and a probe
    # that died would read identically to a clean one. `$head` is a full object
    # id, so no refname can shadow it the way a tag was measured shadowing a
    # bare branch name — but the BASE side is a shorthand until it is
    # qualified, and this sweep removes DIRECTORIES, so the tag shadowing the
    # top of the file records costs the files themselves here and not only a
    # branch ref: measured, a local tag named
    # `origin/main` at a detached worktree's own tip made this probe read clean
    # and `--apply` deleted the worktree holding the only copy of that commit.
    # `$base_rev` is built at the top of the file; the branch sweep's copy of
    # this probe carries the same qualification for the same reason.
    if ! cherry=$(git cherry "$base_rev" "$head" 2>&1); then
      keep "" "cherry probe failed — cannot tell if worktree $wt is merged: $(printf '%s' "$cherry" | tr '\n' ' ')"
      continue
    fi
    # Three-way, for the reason the branch sweep's copy of this check records
    # in full: grep's rc 2 is not its rc 1, and the no-match arm here reaches
    # `git worktree remove`, so the swallow cost DIRECTORIES in this sweep and
    # not only a branch ref.
    if ! grep_probe "$cherry" '^+'; then
      keep "" "cherry scan failed — cannot tell if worktree $wt is merged$(gp_why "$gq_err")"
      continue
    elif [ "$gq_rc" -eq 0 ]; then
      keep "" "worktree $wt holds commits that exist nowhere else"
      continue
    fi

    if [ -e "$wt" ]; then
      # The remaining guards the branch sweep above documents, in the same order
      # and for the same measured reasons — the main checkout already answered
      # for above, the linkage established — present, then answering
      # for `$wt` itself — before anything git says through `$wt` is
      # trusted, and existence settled by this `if` so a deleted directory
      # never reaches a status call that would read as dirty forever.
      if [ -x "$wt" ] && [ ! -f "$wt/.git" ]; then
        keep "" "worktree $wt has no .git linkage — git would answer for the enclosing repo, not this one"
        continue
      fi
      if [ -f "$wt/.git" ] && ! wt_linkage_why "$wt"; then
        keep "" "worktree $wt $lk_why"
        continue
      fi
      # `-uall`: see the branch sweep's copy of this probe above for the
      # full explanation. This sweep removes DIRECTORIES, so it is the arm
      # where the misread a bare `--porcelain` produces costs the files
      # themselves.
      if ! git_probe -C "$wt" status --porcelain -uall; then
        keep "" "worktree $wt could not be read$(gp_why)"
        continue
      fi
      # Same gate, same order, and the same reason as the branch sweep's copy
      # of this probe: a cut-short walk answers empty, so it has to be caught
      # before the dirty check below rather than after it.
      if gp_cut_short; then
        keep "" "worktree $wt status warned, listing may be incomplete$(gp_why)"
        continue
      fi
      if [ -n "$gp_out" ]; then
        keep "" "dirty worktree $wt"
        continue
      fi

      # A guard the branch sweep needs no copy of, and the one thing on this
      # path git is no backstop for: `git worktree remove` WITHOUT `--force`
      # removes a worktree holding an interrupted rebase or a bisect at exit 0,
      # sequencer state and all, with `git status --porcelain` empty. Both
      # operations also DETACH, which is precisely how they arrive in this
      # sweep and nowhere else: release-ticket.sh's prose already names the
      # interrupted rebase as the way a fleet worktree wanders off its branch.
      # worktree.sh's `wt_op_state` holds the marker list, the measurements
      # and why its admin-dir read is `2>/dev/null` rather than `2>&1`; a
      # worktree it cannot read is kept, never removed.
      if ! wt_op_state "$wt"; then
        keep "" "worktree $wt could not be read"
        continue
      fi
      if [ -n "$wt_op" ]; then
        keep "" "worktree $wt has a git operation in progress ($wt_op) — removing it discards state no commit holds"
        continue
      fi

      # No `--ignored` probe here, unlike the branch sweep: the ownership bound
      # at the head of this loop already refused every worktree outside
      # `.worktrees/`, and inside it the branch sweep exempts the probe anyway —
      # a fleet worktree's ignored files are machine-generated, and keeping on
      # them would strand every one of them.
    elif ! gone "$wt"; then
      keep "" "cannot tell whether worktree $wt exists"
      continue
    fi

    # The branch sweep's copy of this guard carries the reasoning; the only
    # difference here is that there is no branch to keep with the directory.
    # After the ownership bound above, deliberately: a worktree this sweep would
    # never remove needs no word about where the script is standing, and the
    # bound's own reason is the one true of it.
    #
    # Ancestor match, not exact equality — same reasoning as the branch
    # sweep's copy of this guard: a worktree nested inside `$wt` is removed
    # along with it even though `$wt` never equals `$self_wt` in that shape.
    if holds_cwd "$wt"; then
      keep "" "worktree $wt holds the working directory this run was started in — removing it would delete the cwd every git call after it needs; rerun from outside it"
      continue
    fi

    if [ "$apply" = true ]; then
      # No `--force`, and the same registry re-read the branch sweep documents:
      # a non-zero exit is no proof the removal had no effect, so the reason
      # names what the REGISTRY answered and claims nothing about what is left
      # on disk.
      if ! err=$(git worktree remove "$wt" 2>&1); then
        wt_reg_state "$wt"
        # `$wt` interpolated, unlike the branch sweep's byte-identical twin: there
        # `keep "$b"` names the subject, here the branch field is `null` and
        # git's own message for a locked worktree carries no path, so two
        # refusals in one run were byte-identical and an operator could not tell
        # which worktree was kept (measured, two locked worktrees).
        keep "" "worktree $wt remove refused ($state): $(printf '%s' "$err" | tr '\n' ' ')"
        continue
      fi
      # A line of its own, unlike the branch sweep's silent success: there is no
      # `REAPED <branch>` here to stand in for it, and a removal nothing prints
      # is the silence this ticket exists to end.
      printf '    REMOVED worktree %s\n' "$wt" >&2
    else
      printf '    would remove worktree %s\n' "$wt" >&2
    fi
    removed="${removed}$(jfield "$wt"),"
  done <<EOF
$detached
EOF

  # Backstop for a branch deleted under a worktree that checked it out: the
  # delete raced a `git worktree add` that `wt_recheck_delete` could not see,
  # or something outside this script deleted the ref. git lists such a
  # worktree with its `branch` line forever, so the sweep above never sees it,
  # and its `HEAD` does not resolve. Reported, never acted on: a worktree made
  # with `git worktree add --orphan` looks the same, and only fleet worktrees,
  # under `.worktrees/`, are reported — a fleet claim always branches from
  # `origin/main`, so one of those on a ref that does not exist was broken.
  # The likely tip is read from the worktree's own `HEAD` reflog, which
  # survives the delete, and named as unverified: nothing here can prove it
  # was the branch's tip.
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    ref=${entry%% *}
    entry=${entry#* }
    null=${entry%% *}
    wt=${entry#* }
    case "$wt" in
      */.worktrees/*) ;;
      *) continue ;;
    esac
    git rev-parse -q --verify "$ref" >/dev/null && continue
    likely=
    if ! nl_path "$wt" && admin=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null); then
      likely=$(awk '$2 !~ /^0+$/ {t = $2} END {print t}' "$admin/logs/HEAD" 2>/dev/null) || likely=
    fi
    if [ -n "$likely" ]; then
      keep "" "worktree $wt is checked out on $ref, which no longer exists — its HEAD reflog last named $likely (unverified); if that was the tip, restore it with: git update-ref $ref $likely $null"
    else
      keep "" "worktree $wt is checked out on $ref, which no longer exists — no tip could be read from its HEAD reflog; restore it with: git update-ref $ref <tip> $null"
    fi
  done <<EOF
$broken
EOF
fi

# Payload first, prune after: `git worktree prune` used to be the last
# command of the guard below — an AND-OR list then — so under `set -eu` ITS
# OWN failure, not just a false `[ apply = true ]`, reached -e and aborted the
# script before this printf ever ran, after the branches above were already
# deleted. The caller lost the only record of what happened. Printing first
# means that record survives regardless of what the prune does.
printf '{"applied":%s,"reaped":[%s],"worktreesRemoved":[%s],"kept":[%s],"warnings":[%s]}\n' \
  "$apply" "${reaped%,}" "${removed%,}" "${kept%,}" "${warnings%,}"

# An `if`, not `[ ... ] && { ... }`: with the printf moved above it this guard
# is the script's LAST command, and an AND-OR list whose test is false has
# status 1 — which would become the script's own exit status and regress the
# default dry run from 0 to a bare, verdictless 1, the very failure this fix
# exists to remove. An `if` with no `else` exits 0 when its condition is false.
# The prune's own failure reaches `die`, never -e, so it refuses loudly on 2
# like every other failure this script can name.
#
# Captured, and quoted into the refusal the way `cherry probe failed` and
# `worktree remove refused` above already are: bare, this printed a step name
# and dropped git's stdout and stderr on the floor, so the operator read
# `git worktree prune failed` and nothing about what git said (the class the
# other sites here were already fixed for). Folded to one line by the same
# `tr '\n' ' '` every reason here uses, so one failure stays one line. A
# non-zero exit from this command now means the housekeeping genuinely failed:
# the run standing in a worktree it was about to remove is refused above,
# before any removal, rather than diagnosed here afterwards.
if [ "$apply" = true ]; then
  if ! prune_err=$(git worktree prune 2>&1); then
    die "git worktree prune failed: $(printf '%s' "$prune_err" | tr '\n' ' ')"
  fi
fi
