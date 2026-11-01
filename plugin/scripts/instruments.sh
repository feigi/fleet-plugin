#!/bin/sh
# Did the controller's instrument set change under it?
#
# The controller reads the world through scripts and runbooks it loads from
# the Install root — the realpath of
# `~/.omp/plugins/node_modules/@feigi/fleet-ctl`, the tree fleet-run executes
# and omp loads the runbooks from — and every member can write to that tree.
# member-write-guard.mjs refuses a `write`/`edit`/`ast_edit` inside the Install
# root, whatever the install kind, but a `bash` or `eval` write lands there
# anyway and nothing refuses it. Worktree isolation
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
# finding about this script. Both stop the gate. Only a digest mismatch is
# exit 1; every refusal to look, a changed Install root among them, is exit 2.
#
# WHAT IS IN THE SET: the plugin's own component directories — `commands/
# scripts/ skills/ agents/ workflows/` — of the Install root, the tree the
# fleet executes, never the checkout this script happens to run in, and never
# the workspace's own. Every regular file and every symlink under those five
# directories of the realpath is hashed, dotfiles included: nothing in an
# installed package is untracked and anything in it executes.
#
# THE KINDS are named the way fleet-provenance names them, and told apart the
# same way: the entry's own link-ness, then where the link resolves.
#
#   npm-install          a real directory.
#   marketplace-install  a link into `.omp/plugins/cache/`.
#   linked-checkout      any other link — `omp plugin link`. REFUSED, at pin
#                        and at check, exit 2 and nothing on stdout: a fleet
#                        run executes an installed package, and a linked
#                        checkout is a working tree that every checkout,
#                        merge and edit in it moves under the run. The link
#                        remains the dev loop for interactive sessions; the
#                        run needs it replaced by the package.
#
# Not a written list of instrument names — the
# ticket named six and the class is larger (the supply scan, the liveness
# probe, the shared `arg.mjs`/`json.sh`/`net.sh` libraries that a single edit
# mutates every node instrument through, and the runbooks, which the
# controller also reads from this same writable tree and which phase 0
# already knows can be stale). A list rots on the next commit that adds a
# script; a directory does not.
#
# NOT THE WHOLE TREE, deliberately. A package's `package.json`, and everything
# else at its top level, stays out: the set is the five directories. The
# state home's `docs/metrics/` is APPENDED BY THE CONTROLLER MID-RUN and is
# not under the Install root at all, so the run's own bookkeeping cannot fire
# the gate — a guard the controller learns to ignore is worse than none.
#
# CONTENT, not a stat cache: this hashes bytes, so it accepts a bare `touch`
# and refuses a rewrite. A symlink is hashed by its target's bytes —
# `shasum` reads through it — so a dangling link, or a link to a directory,
# cannot be hashed and refuses at exit 2.
#
# MODES ARE NOT IN THE DIGEST, and that one is a GAP rather than a trade: a
# mode-only change to an instrument is ACCEPTED. Measured — `chmod +x` on a
# mode-644 file under the set exits 0 here. A mode change that costs the
# hash its READ is caught instead: `chmod 000` on an instrument refuses at
# exit 2 through `could not hash every file` — as root that never fires,
# since root reads a mode-000 file regardless (the suite skips
# this case there for the same reason). So the exposure is the bits that
# still permit reading, the exec bit above all — and that bit is not how a
# fleet probe runs: fleet-run hands `.sh` to `sh` and `.mjs` to `node`, so a
# stripped `+x` is invisible through the Resolver, while invoking one by path
# instead is EACCES at exec (126), loud rather than a wrong verdict. Folding
# modes in is a behaviour change to the gate on a channel with no
# silently wrong reading to its name, and whether a mode-only edit is worth
# refusing on is a decision rather than a fix, so this paragraph names the gap and
# leaves the behaviour alone. The suite pins the accepted case,
# so closing the gap later goes red there rather than leaving this
# paragraph stale.
#
# COST: one `git rev-parse` to locate the state home, one `find` over the set
# and one pass of `shasum` over those files; a pin or a changed check runs
# `awk` once to read the package's version. No network, no `gh`, no
# fetch, no subprocess per file. It is meant to be run
# before every gate decision and it has to be cheap enough that nobody is
# tempted to skip it.
set -eu

# Directly below `set -eu`, not below a locale pin: this script has none and is
# deliberately off the suite's list of locale-pinned scripts. The siblings
# that DO carry a pin put this line under it instead, because the suite admits
# only comments, blanks and `set -[eux]+` above the pin in those scripts.
# Here the only constraint left is the real one: above the first git call.
#
# GIT_WORK_TREE is the wrong-tree defect reached through the environment. The
# contract here is that the state home is the WORKING DIRECTORY's checkout —
# and `git rev-parse --show-toplevel` answers with the ambient work tree
# instead the moment one is set, `--repo` or not. Measured:
# standing in a checkout whose baseline is honest, with
# `GIT_WORK_TREE` naming a twin whose own pinned baseline matches the
# tampered Install root, this script exits 0 and prints the tampered digest.
# The gate passes. That is
# the same wrong-tree write `--repo ""` produced before this script refused it, one
# door further out, and a gate that certifies a tree nobody looked at is
# worse than no gate.
#
# GIT_DIR is unset alongside it and is measured INERT here: the only git call
# is `rev-parse --show-toplevel`, and the digest is taken over the FILES ON
# DISK under the Install root, so pointing the object database elsewhere
# changes nothing. It stays on the line because the
# pair is one hazard with one remedy, and because "inert today" is a
# measurement of the current call set. The suite pins the line itself, which is
# what keeps that half from being quietly dropped.
unset GIT_DIR GIT_WORK_TREE

NAME=instruments
# `printf '%s'`, never `echo`: `echo` expands backslash escapes in its
# operand, and the messages below carry paths that git will happily hand us with
# a backslash in them.
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }
# The value of the baseline's first `<key>=` line, the one match every reader
# of the file takes.
baseline_field() { sed -n "/^$1=/{s/^$1=//;p;q;}" "$base"; }

pin=false
repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pin) pin=true; shift ;;
    --repo)
      [ $# -ge 2 ] || die "usage: instruments.sh [--pin] [--repo <path>]"
      repo=$2
      # An empty value falls through the `[ -n "$repo" ]` branch below and
      # silently re-derives from cwd — measured: `--repo ""`
      # pinned the CALLER's cwd repo instead of refusing, exactly the
      # wrong-tree-write class this script exists to close. Refuse here,
      # before that check ever runs.
      [ -n "$repo" ] || die "--repo requires a non-empty path"
      shift 2
      ;;
    *) die "usage: instruments.sh [--pin] [--repo <path>]" ;;
  esac
done

# Two trees, named apart:
#
# `root` — the STATE HOME — is the WORKING DIRECTORY's checkout, never the
# checkout this script happens to ship from. Under the install-only dev loop
# this file runs out of the Install root — on a real install, under
# `~/.omp/plugins/...` — and the OLD own-location contract (`git -C
# "$(dirname "$0")" …`) resolved it to whatever git checkout happens to
# CONTAIN that path. Measured, pre-cutover: on a real box that
# was the operator's unrelated personal dotfiles checkout, and `--pin` run
# that way writes `.fleet/instruments.sha` into it. `--repo <path>` is the
# explicit override for the one legitimate case that needs a home other than
# cwd's: reading a named checkout's baseline from elsewhere. Resolution
# happens before anything is read or written, so a cwd outside any checkout
# refuses here, not partway through. The state home only locates `.fleet/`:
# the baseline lives there, so every reader that knows only the run's
# workspace finds it without configuration, and nothing in it is hashed.
#
# `target` — the CERTIFIED TREE — is the live Install root, resolved below on
# every pin and every check and never taken from anywhere else.
if [ -n "$repo" ]; then
  root=$(git -C "$repo" rev-parse --show-toplevel) \
    || die "$repo is not inside a git checkout — cannot locate the baseline"
else
  root=$(git rev-parse --show-toplevel) \
    || die "the working directory is not inside a git checkout — cannot locate the baseline (pass --repo <path> to name a checkout other than cwd's)"
fi
base="$root/.fleet/instruments.sha"

# The Install root, resolved inline on every pin and every check: the same
# path fleet-run, fleet-provenance and fleet-bootstrap resolve, the same way —
# the package entry's own link-ness for the kind, its realpath for the tree.
# Mirrored rather than called. The placed `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run` can drift
# from the package, and an environment override or a `node` call would be a
# second way to name a tree the fleet does not execute.
#
# HOME is checked by hand because `set -u` does not answer for it: measured,
# macOS `/bin/sh` exits 1 on an unset HOME under `set -eu`, and exit 1 is the
# one code that means the set changed.
[ -n "${HOME:-}" ] || die "HOME is unset — cannot resolve the Install root"
entry="$HOME/.omp/plugins/node_modules/@feigi/fleet-ctl"
if [ -L "$entry" ]; then
  [ -e "$entry" ] || die "omp plugin \"@feigi/fleet-ctl\" link $entry is dangling"
  live=$(CDPATH='' cd -P "$entry" && pwd -P) \
    || die "cannot resolve omp plugin \"@feigi/fleet-ctl\" at $entry"
  case $live in
    */.omp/plugins/cache/*) kind=marketplace-install ;;
    *) kind=linked-checkout ;;
  esac
else
  [ -e "$entry" ] || die "no omp plugin \"@feigi/fleet-ctl\" at $entry"
  live=$(CDPATH='' cd -P "$entry" && pwd -P) \
    || die "cannot resolve omp plugin \"@feigi/fleet-ctl\" at $entry"
  kind=npm-install
fi

# A linked checkout is refused, at pin and at check, before anything is read
# from or written to the state home and before anything is hashed. A fleet run
# executes an installed package: a link's tree moves under the run with every
# checkout, merge and edit in it, which no digest can tell from tampering. The
# controller never runs `omp plugin`; the message is for the maintainer.
if [ "$kind" = linked-checkout ]; then
  die "Install root $live is a linked checkout (omp plugin link) — a fleet run executes an installed package; omp plugin uninstall @feigi/fleet-ctl, then omp plugin install @feigi/fleet-ctl, and restart."
fi

if [ "$pin" != true ]; then
  # No baseline is not "nothing has changed" — it is a run that never pinned,
  # and the check has nothing to compare against. Refusing is the whole
  # contract.
  #
  # EXISTS-but-unreadable is a different state than ABSENT, and it needs a
  # different message: `--pin` never compares against the existing baseline,
  # it just overwrites it with whatever the tree looks like now. Labeling this
  # case "no baseline" and prescribing `--pin` would walk a controller from
  # "the check could not look" to "certified clean" in one step, discarding
  # evidence it never read — the exact anti-pattern run-team/SKILL.md forbids.
  basedir="$(dirname "$base")"

  # A directory that exists but cannot be searched (missing +x) hides
  # everything under it from stat(2) — `[ -e "$base" ]` below reads FALSE for
  # every file underneath, so without this check the run falls through to the
  # "no baseline" message one level up: the exact mislabel this refusal exists
  # to prevent, just moved from the file to its containing directory.
  [ -d "$basedir" ] && [ ! -x "$basedir" ] \
    && die "$basedir exists but is unreadable — fix its permissions; do NOT --pin over it, --pin overwrites rather than compares"

  # `-L` catches a dangling symlink: the link entry is present but its target
  # is gone, so `-e` (which dereferences) reads FALSE and the run would
  # otherwise fall through to the same "no baseline" message for a baseline
  # that is very much present, just broken.
  { [ -e "$base" ] || [ -L "$base" ]; } && [ ! -r "$base" ] \
    && die "$base exists but is unreadable — fix its permissions; do NOT --pin over it, --pin overwrites rather than compares"
  [ -r "$base" ] || die "no baseline at $base — run instruments.sh --pin once at run start"
  want=$(sed -n '1p' "$base") || die "cannot read $base"
  [ -n "$want" ] || die "$base is empty — re-pin, do not guess"
fi

# The five component directories, as the digest lists them.
dirs='commands scripts skills agents workflows'
target=$live

# The top-level "version" of the package's `package.json`, or nothing. It is
# evidence for a refusal to name, never part of a verdict, so a file that is
# missing, unparseable or carries no string version reads as unknown rather
# than refusing. A brace-depth scan rather than a line match: a nested
# "version" key (an `engines` entry, say) must not answer for the package.
pkg_version() {
  v=$(awk '
    { s = s $0 "\n" }
    END {
      n = length(s); depth = 0; i = 1
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\"") {
          k = ""; i++
          while (i <= n && (c = substr(s, i, 1)) != "\"") {
            if (c == "\\") { k = k c substr(s, i + 1, 1); i += 2 } else { k = k c; i++ }
          }
          i++
          if (depth == 1 && k == "version") {
            while (substr(s, i, 1) ~ /[ \t\r\n]/) i++
            if (substr(s, i, 1) != ":") continue
            i++
            while (substr(s, i, 1) ~ /[ \t\r\n]/) i++
            if (substr(s, i, 1) != "\"") exit
            j = i + 1; out = ""
            while (j <= n && (c = substr(s, j, 1)) != "\"") { out = out c; j++ }
            if (j <= n) print out
            exit
          }
          continue
        }
        if (c == "{" || c == "[") depth++
        else if (c == "}" || c == "]") depth--
        i++
      }
    }' "$target/package.json" 2>/dev/null) || v=
  case $v in
    *[!0-9A-Za-z.+-]*) v= ;;
  esac
  printf '%s' "$v"
}

if [ "$pin" != true ]; then
  # The check takes its tree from the live Install root and from nothing else.
  # The baseline's `root=` is evidence of which tree the pin certified, never
  # a path to follow: a check that hashed it would let anyone who can write
  # `.fleet/` keep the honest digest on line 1, point `root=` at a
  # byte-identical clone, and watch the clone certify. Compared instead, a
  # forged `root=` can only make the check refuse. Any difference is a
  # different tree under the same gate: an upgrade or a reinstall that moved
  # the realpath, a switch between a package and a link, a link retargeted, or
  # a baseline from before the root was recorded. Equal roots imply equal
  # kinds, so the root alone answers for a kind change too. Exit 2, before
  # anything is hashed: the question "did this tree change?" has no answer
  # against a digest made over another one.
  rec=$(baseline_field root) || die "cannot read $base"
  [ "$rec" = "$target" ] \
    || die "Install root now resolves to $target ($kind), pinned ${rec:-<none recorded>} — the installed plugin changed under this run; the maintainer adopts it (re-pin) or restores the pinned install"
fi

# Hash the certified tree.
files=$(mktemp) || die "cannot create a temp file"
# INT/HUP/TERM as well as EXIT: a controller that kills a stalled gate check
# should not leave the temp file behind on a shared machine.
trap 'rm -f "$files"' EXIT
trap 'rm -f "$files"; exit 2' INT HUP TERM

# Absent directories are skipped, but a name that is present in any form
# — a file, a dangling link — is listed, so it reaches `shasum` and refuses
# there rather than vanishing from the set. With none present there is
# nothing to certify, and `find` given no path would list `.` instead.
present=
for d in $dirs; do
  if [ -e "$target/$d" ] || [ -L "$target/$d" ]; then
    present="$present $d"
  fi
done
[ -n "$present" ] || die "no file under $target for: $dirs — refusing to certify an empty instrument set"
# Paths relative to the realpath, NUL-separated, in byte order: `find`
# lists in directory order, which is the filesystem's to choose, so the
# sort is what makes the digest a function of the tree alone. Two steps
# with a status check each, for the reason the hashing below spells out.
# shellcheck disable=SC2086 # $present is a list of fixed directory names
(cd "$target" && find $present \( -type f -o -type l \) -print0) > "$files" \
  || die "could not list every file under $target for: $dirs"
LC_ALL=C sort -z -o "$files" "$files" \
  || die "could not sort the instrument set under $target"
[ -s "$files" ] || die "no file under $target for: $dirs — refusing to certify an empty instrument set"

# Two steps, each with its own status check, because a pipeline reports only its
# LAST command: with `xargs … | shasum` as one pipeline, a `shasum` that cannot
# run at all leaves the second one hashing empty input and exiting 0, and the
# empty-input digest then compares unequal and reads as CHANGED. That is exit 1
# — a verdict about the tree — off a failure to look. reap.sh shipped this exact
# bug against `git cherry` and it deleted branches.
#
# `xargs` exits 123 when `shasum` failed on any file — a dangling link, or a
# link to a directory, or a file that cannot be read — as exit 2 naming it,
# not as a digest quietly missing a line. Both
# refuse; only one of them is honest about why.
per_file=$(cd "$target" && xargs -0 shasum -a 256 < "$files") \
  || die "could not hash every file under $target — see the errors above"
digest=$(printf '%s\n' "$per_file" | shasum -a 256 | cut -d' ' -f1) \
  || die "could not digest the instrument set"
[ -n "$digest" ] || die "empty digest for $target"

if [ "$pin" = true ]; then
  mkdir -p "$root/.fleet" || die "cannot create $root/.fleet"
  # Three lines at most, order fixed: the digest first, the certified tree
  # second, and third the package's version. A reader that only
  # knows the old one-line shape — merge-gate.mjs's `readInstruments`, which
  # takes the FIRST stdout line as the digest — keeps working, and a check
  # from this script reads the rest. The root rides in the same write as the
  # digest so a check can tell the Install root moved; the check compares it
  # and never follows it.
  #
  # The version line is not trusted for any verdict: it exists only so a
  # refusal can say what moved. A package with no readable version writes no
  # `version=` line, and the refusal says so.
  val=$(pkg_version)
  {
    printf '%s\n' "$digest"
    printf 'root=%s\n' "$target"
    [ -z "$val" ] || printf 'version=%s\n' "$val"
  } > "$base" || die "cannot write $base"
  printf '%s\n' "$digest"
  printf '%s: pinned %s over %s %s (version %s)\n' "$NAME" "$digest" "$kind" "$target" "${val:-?}" >&2
  exit 0
fi

printf '%s\n' "$digest"
if [ "$digest" = "$want" ]; then
  exit 0
fi

# Cold path only, so it costs the ordinary run nothing. The controller has to
# report WHAT changed, and neither digest says.
printf '%s: instrument set CHANGED under this run — expected %s\n' "$NAME" "$want" >&2
printf '%s: refuse the gate and report. Do NOT re-read the instrument.\n' "$NAME" >&2

# A package has no HEAD and no status to read, and anything in it may have
# changed: the versions are what the maintainer rules on — adopt what is
# installed, or put the pinned version back. Never the controller: a
# reinstall swaps the files every live member is running.
pinv=$(baseline_field version) || pinv=
nowv=$(pkg_version)
printf '%s: %s %s: version %s pinned, %s now\n' "$NAME" "$kind" "$target" "${pinv:-?}" "${nowv:-?}" >&2
printf '%s: the installed package changed or was reinstalled — the maintainer adopts it (re-pin) or restores version %s\n' "$NAME" "${pinv:-?}" >&2
exit 1
