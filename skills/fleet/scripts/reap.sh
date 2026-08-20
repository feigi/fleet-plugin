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

apply=false
[ "${1:-}" = "--apply" ] && apply=true
[ $# -gt 1 ] && die "usage: reap.sh [--apply]"

base=${BASE_REF:-origin/main}
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

echo "\$ git fetch --prune origin" >&2
git fetch --prune --quiet origin || die "fetch failed — refusing to reap on stale refs"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"
[ "$apply" = true ] || echo "$NAME: DRY RUN — nothing will be deleted. Pass --apply to act." >&2

reaped=""
kept=""
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

keep() { kept="${kept}{\"branch\":$(jfield "$1"),\"reason\":$(jfield "$2")}," ; echo "    KEEP $1 — $2" >&2; }

# %(upstream:track) emits exactly [gone] as its own field — nothing to
# pattern-match, and no -v/-vv trap.
for b in $(git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads |
           awk '$2=="[gone]"{print $1}'); do

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
  if ! cherry=$(git cherry "$base" "$b" 2>&1); then
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
    # present (readable decides), established absent (nothing to protect —
    # reap.sh's OWN branches never rename their worktree away from `[gone]`,
    # so a directory that is really not there holds no work), or cannot tell
    # (keep — an unanswerable probe authorizes nothing, the same fail-closed
    # direction the cherry check above already takes). `-e`/`gone` first,
    # before any git command runs through $wt, so a genuinely deleted
    # directory never reaches a status call that would fail on it and read as
    # dirty forever (#83).
    if [ -e "$wt" ]; then
      wt_present=true
    elif gone "$wt"; then
      wt_present=false
    else
      keep "$b" "cannot tell whether worktree $wt exists"
      continue
    fi

    if [ "$wt_present" = true ]; then
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
      # Gated on $wt_present: an established-absent directory has no ignored
      # files to strand, and running this against it would read the same
      # rc-nonzero "unreadable" it was already ruled out from being.
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
      echo "    would remove worktree $wt" >&2
    fi
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

# Payload first, prune after (#265): `git worktree prune` used to be the last
# command of the guard below — an AND-OR list then — so under `set -eu` ITS
# OWN failure, not just a false `[ apply = true ]`, reached -e and aborted the
# script before this printf ever ran, after the branches above were already
# deleted. The caller lost the only record of what happened. Printing first
# means that record survives regardless of what the prune does.
printf '{"applied":%s,"reaped":[%s],"kept":[%s]}\n' \
  "$apply" "${reaped%,}" "${kept%,}"

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
