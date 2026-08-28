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
# holding it, and `paste` truncates its whole output at it and still exits 0;
# `awk` is immune, measured byte-identical in both locales. Such a byte reaches
# us from a fetched tree even where the local filesystem refuses to hold the
# name. #582 measured the cost of leaving this ambient in no-undo-audit.sh: a
# truncated list reported as a clean, confident answer.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on.
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

# Is $1 established ABSENT, or merely a path this script cannot stat? A bare
# `[ -e ]` failure is both — an unreadable parent fails it identically to a
# directory that was actually removed — and only the second is nothing to
# protect. Walk up to the nearest ancestor that exists and require THAT to be
# searchable: only then is "not there" a measurement, not a guess. Same shape
# and same reason as release-ticket.sh's own `gone()` (not shared code — the
# callers differ in nothing else); named there, not by line number, per #129.
gone() {
  look=$1
  while [ ! -e "$look" ] && [ "$look" != "${look%/*}" ]; do look=${look%/*}; look=${look:-/}; done
  [ ! -e "$1" ] && [ -x "$look" ]
}

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
git fetch --prune --quiet origin || die "fetch failed — refusing to reap on stale refs"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"
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
  wt=$(git worktree list --porcelain |
       awk -v b="refs/heads/$b" '/^worktree /{w=substr($0,10)} /^branch /&&$2==b{print w}')

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
      if ! status_out=$(git -C "$wt" status --porcelain 2>/dev/null); then
        keep "$b" "worktree $wt could not be read"
        continue
      fi
      if [ -n "$status_out" ]; then
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
          if ! ignored_raw=$(git -C "$wt" status --porcelain --ignored 2>/dev/null); then
            keep "$b" "worktree $wt unreadable (git status --ignored failed)"
            continue
          fi
          ignored=$(printf '%s\n' "$ignored_raw" | awk '/^!! /{sub(/^!! /,""); print}' | paste -sd, -)
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
      # No --force, ever. It refuses on modified and untracked files; the
      # ignored-file gap it does NOT cover is handled by the check above.
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
        if ! reg=$(git worktree list --porcelain 2>&1); then
          state="cannot tell whether the registration survived"
        elif printf '%s\n' "$reg" | grep -qxF "worktree $wt"; then
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
if ! wt_list=$(git worktree list --porcelain 2>&1); then
  keep "" "cannot enumerate worktrees — a branchless one would go unreported: $(printf '%s' "$wt_list" | tr '\n' ' ')"
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
      if ! status_out=$(git -C "$wt" status --porcelain 2>/dev/null); then
        keep "" "worktree $wt could not be read"
        continue
      fi
      if [ -n "$status_out" ]; then
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
        if ! reg=$(git worktree list --porcelain 2>&1); then
          state="cannot tell whether the registration survived"
        elif printf '%s\n' "$reg" | grep -qxF "worktree $wt"; then
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
