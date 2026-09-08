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
# and `grep` see none of that — both process `$cherry`, `git cherry`'s output,
# whose commit subjects git constrains to no encoding at all, which makes it
# arguably the likeliest carrier of the four. Under a UTF-8 locale BSD `tr`
# exits 1 on a byte that is not valid UTF-8, `grep` silently drops the line
# holding it, and `paste` truncates its whole output at it and still exits 0.
#
# `awk` is NOT immune, and reap.test.mjs's own #614 fixture measured the
# earlier claim here false: it is byte-identical only when every rule matches
# at an ANCHOR before the bad byte, never needing to convert it. A rule that
# must SCAN PAST the byte to decide — here, the `/^branch /` match against a
# worktree's raw, unquoted registry path, one SIBLING entry away from the
# branch actually under sweep — dies instead: measured, BWK awk (macOS) aborts
# at rc 2 (`towc: multibyte conversion failure`), and this script runs under
# `set -eu`, so that death TERMINATES the whole sweep rather than merely
# mis-scoring one record. gawk and mawk (Linux CI) tolerate the same byte and
# answer rc 0, which is why this is a macOS-only ceiling, not a portable fix —
# #790. Such a byte reaches us from a fetched tree even where the local
# filesystem refuses to hold the name. #582 measured the cost of leaving this
# ambient in no-undo-audit.sh: a truncated list reported as a clean, confident
# answer.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on. "Nothing" is an
# inventory, not a hope: locale-pin-prose.test.mjs enforces it (#612), because
# this sentence shipped false in no-undo-audit.sh and a `sort` added below
# would otherwise leave every test in this suite green.
export LC_ALL=C

NAME=reap
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it. This script defines no exit 1 at all (#265), so a
# bare 1 out of it is a code its caller has no reading for. Placed here, above
# the fetch, so a missing library refuses before anything is deleted rather than
# partway through.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to reap without the JSON escaping helpers"
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
[ -r "$net_lib" ] || die "cannot read $net_lib — refusing to reap without the bounded git transport"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=net.sh
. "$net_lib" || die "$net_lib failed to load"

# The worktree readers (#551, #725). worktree.sh's header holds the sourcing
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
# lines — so nothing in the run said the flag had not been understood (#250).
# Both refusals sit above the fetch, so a rejected invocation reads nothing and
# deletes nothing.
apply=false
[ $# -gt 1 ] && die "usage: reap.sh [--apply]"
if [ $# -eq 1 ]; then
  [ "$1" = "--apply" ] || die "unrecognised argument '$1' — usage: reap.sh [--apply]"
  apply=true
fi

base=${BASE_REF:-origin/main}
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

echo "\$ git fetch --prune origin" >&2
# 300s, and the number is chosen against the FALSE FAILURE, not against the
# stall: this fetch moves objects rather than refs, so a cold or large one can
# legitimately run for minutes, and a bound that turns a working slow link into
# exit 2 is worse than the hang it replaces — exit 2 is a verdict the controller
# acts on. Well above any healthy incremental fetch, and still a bound.
# `FLEET_NET_TIMEOUT` is the shorten-only override the fleet's fetches share;
# the rule is net_budget's, in net.sh.
fetch_budget=$(net_budget 300 "${FLEET_NET_TIMEOUT:-}")
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
git rev-parse --verify "$base" >/dev/null || die "$base does not resolve"
[ "$apply" = true ] || echo "$NAME: DRY RUN — nothing will be deleted. Pass --apply to act." >&2

reaped=""
kept=""
# Every worktree this run removed, by path, whether a branch accounted for it or
# not. One meaning, so the key needs no qualifier: the sweep below reaps
# worktrees no `reaped` branch names, and a payload that recorded only those
# would leave a reader guessing whether the branch sweep's removals were absent
# because none happened or because nothing reports them (#381).
removed=""
# `jstr`'s output wrapped in the quotes JSON needs, or the literal `null` where
# it could not render. `die` is the wrong answer at both call sites below: by
# the time either accumulator is written this script may already have deleted
# branches, and the payload printed at the end is the caller's only record of
# that — the same reason #265 moved the printf ahead of the prune. Exiting here
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
# correctly kept (#119). The stderr lines stay raw: they are prose for an
# operator, not JSON.
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
# with git's own exit status returned by this function. #625: this file's
# worktree status probes used to throw stderr away, so a `fatal:` at rc 128 named
# no cause and a `warning:` at rc 0 (measured, PR #726 review — a
# permission-denied ignored directory) reached nobody. The wrong fix is
# `2>&1`: the very next line after one of these probes tests whether the
# captured text is non-empty to decide dirty, so folding a warning in would
# make a clean worktree with ANY git warning on it read as dirty forever.
#
# No temp file (this file creates none): git's stderr goes to fd3, which the
# group below dupes from fd1 before git runs, so it lands live in the SAME
# pipe `gp_raw=$( … )` reads — no separate pipe or file needed for it. Command
# substitution runs in its own subshell (POSIX), so a plain variable set
# inside — git's stdout, git's own $? — cannot escape it; only the TEXT
# written there survives. `gp_sep` (a byte no porcelain line or ordinary
# warning contains) marks where one piece ends and the next begins, so
# `gp_raw` can be split apart with plain parameter expansion once it is back
# in the real, top-level shell.
#
# `if gp_o=$(...); then gp_rc=0; else gp_rc=$?; fi`, never a bare
# `gp_o=$(...); gp_rc=$?`: under `set -e` a bare failing assignment aborts the
# subshell before `gp_rc=$?` or the printf below ever run, and `gp_raw` comes
# back empty — silently, at the one moment this function exists to not be
# silent (measured on this exact shape, PR #1068 review).
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

# `: <what git said>`, or nothing at all when git said nothing. Two reasons not
# to interpolate $gp_err directly. It keeps its trailing newline — it is read
# straight out of the pipe, unlike $gp_out, which command substitution strips —
# so a bare `tr '\n' ' '` leaves a trailing space inside the JSON reason. And a
# git that dies without writing to stderr (measured: a signal-killed git exits
# 137 with stderr empty) would otherwise leave a dangling `": "` naming no
# cause, on the one path this whole change exists to make name one.
gp_why() {
  gp_w=$(printf '%s' "$gp_err" | tr '\n' ' ')
  while :; do
    case "$gp_w" in
      *' ') gp_w=${gp_w% } ;;
      *) break ;;
    esac
  done
  if [ -n "$gp_w" ]; then printf ': %s' "$gp_w"; fi
}

# %(upstream:track) emits exactly [gone] as its own field — nothing to
# pattern-match, and no -v/-vv trap.
#
# %(refname) and a strip, never %(refname:short): the short form is
# ambiguity-aware, and where a TAG shares a branch's name it stops shortening
# and emits `heads/<name>` instead (measured, git 2.50.1 Apple Git-155). That
# string names no branch — `git branch -D` answers "branch not found" — and it
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
# holds `[ahead` — not `[gone]` either way. #634
for b in $(git for-each-ref --format='%(refname) %(upstream:track)' refs/heads |
           awk '$2=="[gone]"{sub(/^refs\/heads\//,"",$1); print $1}'); do

  # git cherry against origin/main, not a local main: a local main never
  # fast-forwarded reads every merged branch as unmerged. Any + line is a commit
  # that exists nowhere else.
  #
  # Captured, not piped: `cmd | grep -q` takes grep's exit status, never cmd's,
  # so a `git cherry` that dies (exit 128 — one unreadable loose object is
  # enough) prints nothing, grep sees empty input and exits 1 — the identical
  # verdict a genuinely clean cherry produces, so "merged" is indistinguishable
  # from "the probe could not answer". An unmerged branch is never the ambiguous
  # one: its `+` line makes grep exit 0 and always keeps. -D is authorized by
  # this check and by nothing else, so an unanswerable probe must KEEP, the
  # same fail-closed shape the worktree `status` check below already uses.
  # `refs/heads/$b`, never a bare `$b`. Restoring the bare name above makes a
  # branch that shares its name with a tag ambiguous AS A REV again, and git
  # resolves an ambiguous one by preferring refs/tags/ over refs/heads/
  # (measured, git 2.50.1 Apple Git-155). This probe would then answer about the
  # TAG's commit while `git branch -D` below deletes the BRANCH — and a tag
  # sitting on a merged commit reports clean for a branch whose commits exist
  # nowhere else. -D is authorized by this check and by nothing else, so that
  # reads straight through to destroying them: measured on a fixture, the
  # enumeration fix alone turned a branch this script currently KEEPS into
  # `REAPED`, at exit 0, with an empty kept[]. Qualifying changes nothing for an
  # ordinary branch — both spellings name the same commit — and it is the same
  # key the worktree lookup below already builds. The BRANCH side is the only
  # side qualified here, and qualifying it does not make the check unfoolable:
  # `$base` reaches this same `git cherry` exactly as BASE_REF spells it, so a
  # local tag carrying that spelling outranks the remote-tracking ref and the
  # probe answers about the TAG — measured, an unmerged [gone] branch REAPED at
  # exit 0 with an empty kept[]; open as #924. "By nothing else" bounds what
  # ELSE authorizes -D, not whether this check itself can be wrong. #634
  if ! cherry=$(git cherry "$base" "refs/heads/$b" 2>&1); then
    keep "$b" "cherry probe failed — cannot tell if merged: $(printf '%s' "$cherry" | tr '\n' ' ')"
    continue
  fi
  # A `+` only at line start is a commit. $cherry holds stderr too — 2>&1 above,
  # so the failure reason can carry git's own words — and an unanchored match
  # reads a `+` anywhere in a diagnostic as a commit line, keeping a branch that
  # is merged. This pipe is safe where the one it replaces was not: it consumes
  # a variable, never git, and git's status was already taken on the line above,
  # so grep's is the only status left to take. Anchored like release-ticket.sh's.
  if printf '%s\n' "$cherry" | grep -q '^+'; then
    keep "$b" "unmerged commits"
    continue
  fi

  # The path is the whole rest of the line, never awk's $2: `worktree list
  # --porcelain` prints it raw, so a checkout living under a directory with a
  # space in it — ordinary on macOS — was otherwise truncated at the first
  # one, and every check below then ran against a wrong, nonexistent path.
  #
  # This pipeline DOES take awk's status rather than git's, the swallow #264
  # fixed for `git cherry` above — left deliberately. Making it fail closed is
  # a control-flow change, not a message one: measured, a dying
  # `git worktree list` leaves $wt empty, and a merged [gone] branch with no
  # worktree is then reaped by `git branch -D`, which needs no answer from the
  # registry. Keeping it instead strands every [gone] branch in the sweep, and
  # #391's ruling was to report the state, not to change what gets reaped. The
  # half that IS a message change is already made: a branch that does have a
  # worktree still reaches `git branch -D` and still refuses, and that refusal
  # now carries git's own `used by worktree at …` instead of a bare label. #622
  #
  # `|| :` keeps that swallow exactly where it was after the read moved into
  # `wt_listing`: a listing that could not be produced leaves `$wt_list` empty,
  # the awk matches nothing, `$wt` is empty, and the branch is reaped as before.
  # Without it the helper's status would reach `set -e` and end the sweep, which
  # is the control-flow change the paragraph above declines to make.
  wt_listing || :
  wt=$(printf '%s\n' "$wt_list" |
       awk -v b="refs/heads/$b" '/^worktree /{w=substr($0,10)} /^branch /&&$2==b{print w}')

  # A newline in that path used to end the porcelain record before
  # `substr($0,10)` could read past it, so `$wt` was a prefix of the real path —
  # a directory not on disk, which `[ -e ]` below then reported absent and the
  # removal was authorised against. The match itself was never affected: it is
  # made on the `branch` line, so only the path this sweep REPORTS and acts on
  # was wrong. `wt_listing` now delivers the whole path with the newline
  # substituted, and a substituted path is one no `git -C` or `worktree remove`
  # here can name — so it is refused rather than acted on. #551
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
    # reaches a status call that would fail on it and read as dirty forever
    # (#83).
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
      # directory. Reference shape: release-ticket.sh's own linkage guard,
      # same reason worktree-audit.sh gives its copy (#128).
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
      # (`git worktree remove` refuses a main worktree, `git branch -D`
      # refuses a checked-out branch), so keep and say which, in the dry run
      # and under --apply alike — the plain `-f` guard printed a false cause,
      # and dropping it entirely leaves the dry run promising a reap that can
      # never happen (#82).
      if [ -d "$wt/.git" ] && [ -f "$wt/.git/HEAD" ]; then
        keep "$b" "worktree $wt is the main checkout — cannot remove it or delete the branch checked out in it"
        continue
      fi
      if [ -x "$wt" ] && [ ! -f "$wt/.git" ]; then
        keep "$b" "worktree $wt has no .git linkage — git would answer for the enclosing repo, not this one"
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
      # cannot see, because the status IS 0 — #730, the rc-0 sibling of the
      # `git cherry` swallow (#264) this file's branch sweep already documents, where
      # rc was non-zero and taking the status was the whole fix. Nor can #625's
      # stderr work reach it: the config yields rc 0, empty stdout AND empty
      # stderr, so there is nothing for `gp_cut_short` to match. Pinning the
      # mode on the command line is the only fix: a probe whose EMPTY answer
      # licenses an action pins an explicit mode; a probe that only reports
      # after a gate has already refused need not (see below). `git worktree
      # remove`'s own refusal is no backstop, being the same machinery the
      # same config silences (measured at the --apply call below).
      #
      # The one bare `--porcelain` left in a SCRIPT is deliberate:
      # instruments.sh prints one to stderr to say WHAT changed, after a digest
      # over `git ls-files` has already refused. That digest covers TRACKED
      # files only, so no untracked file can trigger it and the silenced mode
      # cannot hide the thing being reported. A report, not a gate. (Prose
      # instructions to an agent are a separate inventory — see SKILL.md and
      # docs/specs/2026-07-22-run-team-agent-fleet-design.md, pinned
      # alongside the scripts.)
      #
      # `-uall` here, not `-unormal`: both override the config, but this probe
      # IS the dirty gate itself (unlike the `--ignored` reason-string probe
      # below, whose keep/reap verdict does not depend on per-file detail),
      # and `-uall` is the form #730 measured against this site.
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
          # --ignored` lists both `??` and `!!` entries. #730.
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
          # inside it (measured, PR #726 review: a `chmod 000` ignored
          # directory made this exact probe warn and exit 0). A precious
          # ignored file under a path git could not open would never reach
          # $ignored, and `git worktree remove` deletes ignored files
          # silently — so a cut-short walk fails closed rather than report what
          # git managed to see as the whole answer.
          if gp_cut_short; then
            keep "$b" "worktree $wt status --ignored warned, listing may be incomplete$(gp_why)"
            continue
          fi
          ignored=$(printf '%s\n' "$gp_out" | awk '/^!! /{sub(/^!! /,""); print}' | paste -sd, -)
          if [ -n "$ignored" ]; then
            keep "$b" "ignored files present in $wt: $ignored"
            continue
          fi
          ;;
      esac
    elif ! gone "$wt"; then
      keep "$b" "cannot tell whether worktree $wt exists"
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
      # 128 refusing. That is why the probes above pin `-uall` (#730) and why
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
      # removed, and naming a filesystem state nobody probed would be this
      # ticket's own defect — a reason naming something other than what was
      # measured — committed inside its fix. #83, reap.sh and
      # release-ticket.sh answering an unreadable worktree in opposite
      # directions, is closed; a third filesystem probe here would reopen
      # exactly that ground. `gone()` above is deliberately not reused: it
      # answers a harder question (established absence vs an unsearchable
      # prefix) that a registry read does not have, and cannot fail the way a
      # stat can.
      #
      # Captured, not piped: `git … | grep -q` takes grep's status, never
      # git's — the same swallow fixed for `git cherry` above, which the probe
      # that reports it must not reintroduce. A registry read that itself fails
      # says so, rather than being misread as "cleared".
      #
      # Still keep, still continue, and nothing on disk is touched either way:
      # one refusal must not strand the remaining branches of an unattended
      # sweep, and a directory whose contents nobody has inspected is not this
      # script's to delete.
      if ! err=$(git worktree remove "$wt" 2>&1); then
        if ! wt_listing; then
          state="cannot tell whether the registration survived"
        elif printf '%s\n' "$wt_list" | grep -qxF "worktree $wt"; then
          state="registration intact"
        else
          state="registration cleared"
        fi
        keep "$b" "worktree remove refused ($state): $(printf '%s' "$err" | tr '\n' ' ')"
        continue
      fi
    else
      printf '    would remove worktree %s\n' "$wt" >&2
    fi
    removed="${removed}$(jfield "$wt"),"
  fi

  if [ "$apply" = true ]; then
    # -D is authorized by the cherry check above and by nothing else. -d would
    # refuse everything here: upstream is gone, so it compares against a
    # possibly-behind local HEAD.
    #
    # `2>&1 >/dev/null`, in that order: redirections apply left to right, so
    # stderr is bound to the capture and stdout is then dropped — git's
    # diagnosis is kept and its confirmation line discarded. A bare "branch
    # delete failed" names the step, never the fault; git names it outright
    # (`error: cannot delete branch 'x' used by worktree at '…'`), and that
    # message is the only thing that tells an operator which remedy applies.
    if ! err=$(git branch -D "$b" 2>&1 >/dev/null); then
      keep "$b" "branch delete failed: $(printf '%s' "$err" | tr '\n' ' ')"
      continue
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
# (#381, measured live during a merge wave). A stale worktree still answers
# `git worktree list` and inflight.sh reads one as a live claim, so an
# already-merged ticket then reads as taken and the candidate queue shrinks
# with nothing reporting it.
#
# What leaves a fleet worktree detached is NOT recorded here, deliberately. An
# earlier draft of this comment blamed the merge bot's server-side rebase (#149)
# and that mechanism is measured false: in a later wave the bot reported
# `path=rebase` for #969, #970 and #972, and a `reap.sh` dry run immediately
# after printed `would remove worktree` for all three — a line only an ATTACHED
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
# goes unmentioned — this ticket's own defect, committed inside its fix. The
# swallow the branch sweep above leaves deliberately is a different trade: there
# an empty answer still reaps the branch, here it silently reaps nothing.
elif ! detached=$(printf '%s\n' "$wt_list" |
       awk '/^worktree /{if (p != "" && !skip) print h" "p; p=substr($0,10); h=""; skip=0; next}
            /^HEAD /{h=$2}
            /^branch /{skip=1}
            /^bare$/{skip=1}
            END{if (p != "" && !skip) print h" "p}'); then
  keep "" "could not read the worktrees git listed — a branchless one would go unreported"
else
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
    # what no command here can name, so the entry is kept and reported. #551
    if nl_path "$wt"; then
      keep "" "worktree $wt holds a newline in its path — nothing here can stat it, so whether its work has landed is unknown"
      continue
    fi

    # The main checkout, answered before the ownership bound below so it keeps
    # the reason that is true of it rather than the one true of every stranger.
    # It reaches this sweep whenever it is itself detached, it is never under
    # `.worktrees/`, and this test needs nothing the probes below establish —
    # both operands are false for a path that does not exist. Still ahead of the
    # linkage test for the reason the branch sweep records (#82): that test would
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
    # (measured, PR #985 review: the same fixture survives the branch-only
    # script and is DELETED by the branchless one). `*/.worktrees/*` is the
    # fleet's own worktree home — the set #381 describes — and the same key
    # claim-ticket.sh builds its paths under.
    #
    # A `keep`, never a silent `continue`: a directory this script looked at and
    # walked past with nothing said is the exact defect #381 exists to end, and
    # the reason has to survive being read by someone who expected a removal.
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
    # the four routes #179 measured against release-ticket.sh's own lookup, and
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
    # id, so no refname can shadow it the way #634 measured for a bare branch
    # name.
    if ! cherry=$(git cherry "$base" "$head" 2>&1); then
      keep "" "cherry probe failed — cannot tell if worktree $wt is merged: $(printf '%s' "$cherry" | tr '\n' ' ')"
      continue
    fi
    if printf '%s\n' "$cherry" | grep -q '^+'; then
      keep "" "worktree $wt holds commits that exist nowhere else"
      continue
    fi

    if [ -e "$wt" ]; then
      # The remaining guards the branch sweep above documents, in the same order
      # and for the same measured reasons — the main checkout already answered
      # for above, the linkage established before anything git says through
      # `$wt` is trusted (#128), and existence settled by this `if` so a deleted
      # directory never reaches a status call that would read as dirty forever
      # (#83).
      if [ -x "$wt" ] && [ ! -f "$wt/.git" ]; then
        keep "" "worktree $wt has no .git linkage — git would answer for the enclosing repo, not this one"
        continue
      fi
      # `-uall`: #730, see the branch sweep's copy of this probe above for the
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
      # path git is no backstop for. Measured here, git 2.50.1 (Apple Git-155):
      # `git worktree remove` WITHOUT `--force` removes a worktree holding an
      # interrupted rebase, and one holding a bisect, at exit 0 — both leave
      # `git status --porcelain` empty, so every check above passes and the
      # sequencer state, the todo list and the original head go with the
      # directory. Both operations also DETACH, which is precisely how they
      # arrive in this sweep and nowhere else: release-ticket.sh's prose already
      # names the interrupted rebase as the way a fleet worktree wanders off its
      # branch. The remaining sequencer states leave staged or unmerged paths
      # behind, so the dirty check above already answers for them; they are
      # listed anyway because a state git records is cheaper to test than to
      # argue about.
      # `2>/dev/null`, NOT the `2>&1` the reasons above fold in, because this
      # capture is used as a PATH and theirs are used as message text. Measured
      # (PR #985 review): a `~/.gitconfig` with a key outside any section makes
      # every git command print `error: key does not contain a section: …` to
      # stderr AT EXIT 0, so `2>&1` returns that line glued in front of the git
      # dir, `[ -e "$gitdir/$op" ]` then matches nothing, and this very guard
      # waves through a worktree holding an interrupted rebase — removed, state
      # and all. The same change on the status probe reads every clean worktree
      # as dirty forever.
      if ! gitdir=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null); then
        keep "" "worktree $wt could not be read"
        continue
      fi
      busy=
      for op in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
        if [ -e "$gitdir/$op" ]; then busy=$op; fi
      done
      if [ -n "$busy" ]; then
        keep "" "worktree $wt has a git operation in progress ($busy) — removing it discards state no commit holds"
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

    if [ "$apply" = true ]; then
      # No `--force`, and the same registry re-read the branch sweep documents:
      # a non-zero exit is no proof the removal had no effect, so the reason
      # names what the REGISTRY answered and claims nothing about what is left
      # on disk.
      if ! err=$(git worktree remove "$wt" 2>&1); then
        if ! wt_listing; then
          state="cannot tell whether the registration survived"
        elif printf '%s\n' "$wt_list" | grep -qxF "worktree $wt"; then
          state="registration intact"
        else
          state="registration cleared"
        fi
        # `$wt` interpolated, unlike the branch sweep's byte-identical twin: there
        # `keep "$b"` names the subject, here the branch field is `null` and
        # git's own message for a locked worktree carries no path, so two
        # refusals in one run were byte-identical and an operator could not tell
        # which worktree was kept (measured, PR #985 review, two locked
        # worktrees).
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
fi

# Payload first, prune after (#265): `git worktree prune` used to be the last
# command of the guard below — an AND-OR list then — so under `set -eu` ITS
# OWN failure, not just a false `[ apply = true ]`, reached -e and aborted the
# script before this printf ever ran, after the branches above were already
# deleted. The caller lost the only record of what happened. Printing first
# means that record survives regardless of what the prune does.
printf '{"applied":%s,"reaped":[%s],"worktreesRemoved":[%s],"kept":[%s]}\n' \
  "$apply" "${reaped%,}" "${removed%,}" "${kept%,}"

# An `if`, not `[ ... ] && { ... }`: with the printf moved above it this guard
# is the script's LAST command, and an AND-OR list whose test is false has
# status 1 — which would become the script's own exit status and regress the
# default dry run from 0 to a bare, verdictless 1, the very failure this fix
# exists to remove. An `if` with no `else` exits 0 when its condition is false.
# The prune's own failure reaches `die`, never -e, so it refuses loudly on 2
# like every other failure this script can name.
if [ "$apply" = true ]; then
  git worktree prune || die "git worktree prune failed"
fi
