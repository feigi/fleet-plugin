#!/bin/sh
# Did the controller's instrument set change under it?
#
# The controller reads the world through scripts and runbooks that live in the
# MAIN checkout, and every member can write to that checkout — except through a
# `write`/`edit`/`ast_edit` that member-write-guard.mjs refuses; a
# `bash` or `eval` write still lands. Worktree isolation
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
# repository: the tree the baseline names (its recorded root, else the working
# directory's checkout), or for a pin the tree named by `--audit` (see below).
# Not a written list of instrument names — the
# ticket named six and the class is larger (the supply scan, the liveness
# probe, the shared `arg.mjs`/`json.sh`/`net.sh` libraries that a single edit
# mutates every node instrument through, and the runbooks, which the
# controller also reads from this same writable tree and which phase 0
# already knows can be stale). A list rots on the next commit that adds a
# script; a directory does not.
#
# NOT THE WHOLE REPO, deliberately: the plugin's payload is
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
# through `could not hash every tracked file` — as root that never fires,
# since root reads a mode-000 file regardless (the suite skips
# this case there for the same reason). So the exposure is the bits that
# still permit reading, the exec bit above all — and that bit is not how a
# fleet probe runs: fleet-run hands `.sh` to `sh` and `.mjs` to `node`, so a
# stripped `+x` is invisible through the Resolver, while invoking one by path
# instead is EACCES at exec (126), loud rather than a wrong verdict. Folding
# modes in — digesting `git ls-files -s` alongside the contents, or a per-file
# `[ -x "$f" ]` — is a behaviour change to the gate on a channel with no
# silently wrong reading to its name, and whether a mode-only edit is worth
# refusing on is a decision rather than a fix, so this paragraph names the gap and
# leaves the behaviour alone. The suite pins the accepted pair,
# so closing the gap later goes red there rather than leaving this
# paragraph stale.
#
# REFS ARE DELIBERATELY NOT IN THE DIGEST, and the reason is not that they do
# not matter. The corroborating evidence is a stray `fix/42-slug` branch
# left in the main checkout by something running this repo's own fixtures — a
# ref write, which no hash of files can see. But `claim-ticket.sh` creates a
# branch per ticket and `reap.sh` deletes them, in the ref store every worktree
# shares, so a ref digest changes several times per pass as ORDINARY WORK. Per
# gate that is noise, and noise is the one failure this check cannot afford.
# Sweeping for unexpected refs is a drain-cadence question, not a gate one.
#
# COST: two `git ls-files` (the state home's own set, which decides whether a
# recorded root may be followed at all, and the audited tree's set) and one
# pass of `shasum` over those files. No network, no `gh`, no fetch, no
# subprocess per file. It is meant to be run
# before every gate decision and it has to be cheap enough that nobody is
# tempted to skip it.
set -eu

# Directly below `set -eu`, not below a locale pin: this script has none and is
# deliberately off the suite's list of locale-pinned scripts. The five siblings
# that DO carry a pin put this line under it instead, because the suite admits
# only comments, blanks and `set -[eux]+` above the pin in those scripts.
# Here the only constraint left is the real one: above the first git call.
#
# GIT_WORK_TREE is the wrong-tree defect reached through the environment. The
# contract here is that the audited tree is the WORKING
# DIRECTORY's checkout — and `git rev-parse --show-toplevel` answers with the
# ambient work tree instead the moment one is set, `--repo` or not. Measured:
# standing in a checkout whose instruments have been TAMPERED, with
# `GIT_WORK_TREE` naming a clean twin that carries its own pinned baseline,
# this script exits 0 and prints the twin's digest. The gate passes. That is
# the same wrong-tree write `--repo ""` produced before this script refused it, one
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
# can see. The suite pins the line itself, which is
# what keeps that half from being quietly dropped.
unset GIT_DIR GIT_WORK_TREE

NAME=instruments
# `printf '%s'`, never `echo`: `echo` expands backslash escapes in its
# operand, and the messages below carry paths that git will happily hand us with
# a backslash in them.
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

pin=false
repo=""
# The tree `--pin` certifies when it is NOT the state home's own checkout —
# the cross-workspace case: a fleet running in a repo that does not track
# `plugin/…` pins the marketplace/clone checkout that does, and the check
# later follows THAT pointer, recorded beside the digest. Pin-only: a check
# that let its caller repoint the tree would turn the baseline into a
# suggestion.
audit=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pin) pin=true; shift ;;
    --audit)
      [ $# -ge 2 ] || die "usage: instruments.sh [--pin] [--repo <path>] [--audit <path>]"
      audit=$2
      [ -n "$audit" ] || die "--audit requires a non-empty path"
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || die "usage: instruments.sh [--pin] [--repo <path>] [--audit <path>]"
      repo=$2
      # An empty value falls through the `[ -n "$repo" ]` branch below and
      # silently re-derives from cwd — measured: `--repo ""`
      # pinned the CALLER's cwd repo instead of refusing, exactly the
      # wrong-tree-write class this script exists to close. Refuse here,
      # before that check ever runs.
      [ -n "$repo" ] || die "--repo requires a non-empty path"
      shift 2
      ;;
    *) die "usage: instruments.sh [--pin] [--repo <path>] [--audit <path>]" ;;
  esac
done
[ -n "$audit" ] && [ "$pin" != true ] \
  && die "--audit is only accepted with --pin — a check audits the tree its baseline names, never one its caller names"

# Two trees, named apart:
#
# `root` — the STATE HOME — is the WORKING DIRECTORY's checkout, never the
# checkout this script happens to ship from. Under the install-only dev loop
# this file runs out of a plugin cache — on a real install, under
# `~/.omp/plugins/cache/...` — and the OLD own-location contract (`git -C
# "$(dirname "$0")" …`) resolved it to whatever git checkout happens to
# CONTAIN that cache path. Measured, pre-cutover: on a real box that
# was the operator's unrelated personal dotfiles checkout, and `--pin` run
# that way writes `.fleet/instruments.sha` into it. `--repo <path>` is the
# explicit override for the one legitimate case that needs a home other than
# cwd's: auditing a named worktree from elsewhere. Resolution happens before
# anything is read or written, so a cwd outside any checkout refuses here,
# not partway through. The baseline lives here, so every reader that knows
# only the run's workspace finds it without configuration.
#
# `target` — the AUDITED TREE — is the checkout whose `plugin/…` files are
# hashed. `--pin --audit <path>` names it for the cross-workspace case: a
# fleet running in a repo that does not track `plugin/…` has no instrument
# set to certify of its own (that empty set is exactly the refusal below),
# so the pin certifies the plugin checkout that DOES and records its toplevel
# beside the digest. A plain check then follows the RECORDED root, not cwd:
# the pointer travels inside the baseline, from the same write as the digest,
# so no later caller can repoint it. Absent a recorded root, target == root:
# the shape every existing baseline was made over, byte-for-byte.
if [ -n "$repo" ]; then
  root=$(git -C "$repo" rev-parse --show-toplevel) \
    || die "$repo is not inside a git checkout — cannot identify the instrument set"
else
  root=$(git rev-parse --show-toplevel) \
    || die "the working directory is not inside a git checkout — cannot identify the instrument set (pass --repo <path> to audit a tree other than cwd's)"
fi

# `root` is the STATE HOME (the baseline's checkout, the run's own tree);
# `target` is the AUDITED TREE the digest covers. They are the same tree in
# every ordinary run.
set='plugin/commands plugin/scripts plugin/skills plugin/agents plugin/workflows'
base="$root/.fleet/instruments.sha"

# Whether the state home tracks an instrument set OF ITS OWN decides if a
# second tree may be named at all — and it is what closes the door a recorded
# root would otherwise open: measured, a member who can write `.fleet/`
# (member-write-guard does not stop `bash`) can keep the honest
# run-start digest on line 1 and move `root=` to a pristine clone of the
# workspace whose bytes match it — the old script hashed the tampered tree and
# refused; a check that trusted the pointer would certify the clone and pass.
# The pointer therefore rides on the SAME trust the digest has: honoured only
# where the state home tracks no set of its own (the cross-workspace shape,
# where the pointer is the only tree the check CAN audit), and `--audit` is
# refused at the pin on a checkout that does track the set — so a forged pair
# can only ever aim at a tree whose own audit stays intact.
# shellcheck disable=SC2086 # $set is a deliberate list of pathspecs, not one path
home=$(git -C "$root" ls-files -- $set) \
  || die "git ls-files failed under $root for: $set"

target=$root
if [ -n "$audit" ]; then
  [ -z "$home" ] || die "--audit names a tree outside this checkout only when this checkout tracks no instrument set; it tracks one — drop --audit and the pin audits its own tree"
  target=$(git -C "$audit" rev-parse --show-toplevel) \
    || die "$audit is not inside a git checkout — cannot identify the instrument set to pin"
elif [ "$pin" = true ] && [ -z "$home" ]; then
  # The check path's unreadable-baseline refusals, mirrored here: a baseline
  # that EXISTS but cannot
  # be read names the tree this re-pin is supposed to keep certifying, and
  # overwriting it blind would discard the pointer with no record that it was
  # ever there.
  basedir="$(dirname "$base")"
  [ -d "$basedir" ] && [ ! -x "$basedir" ] \
    && die "$basedir exists but is unreadable — fix its permissions; do NOT --pin over it, --pin overwrites rather than compares"
  { [ -e "$base" ] || [ -L "$base" ]; } && [ ! -r "$base" ] \
    && die "$base exists but is unreadable — fix its permissions; do NOT --pin over it, --pin overwrites rather than compares"
  if [ -r "$base" ]; then
    prior=$(sed -n '/^root=/{s/^root=//;p;q;}' "$base") || die "cannot read $base"
    [ -n "$prior" ] && target=$prior
  fi
fi

if [ "$pin" != true ]; then
  # A check reads its baseline BEFORE it hashes anything, because the baseline
  # names the tree to hash. A run pinned with `--audit` certified a checkout
  # other than this workspace's; standing here, the only honest comparison is
  # against THAT tree, and there is no cwd, flag, or config that says
  # otherwise — `--repo` moves the state home, never the audited tree.
  #
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

  # The recorded root, if this baseline carries one. Absent — every baseline
  # pinned before the audited tree could live apart from the state home, and
  # every pin that CERTIFIED the state home itself — the audited tree IS the
  # state home, the shape that digest was made over.
  #
  # Honoured only where a foreign pointer is admissible at all: this
  # checkout's own recorded root is the shape every ordinary pin writes beside
  # its own digest and means nothing — hashing `rec` here is hashing `root`.
  # A FOREIGN pointer while the state home tracks a set of its own is the
  # alarm: a member who could rewrite `root=`, keeping the honest line-1
  # digest, would move the gate to a pristine clone whose bytes match it and
  # watch the check exit 0 over a tree nobody read. No legitimate pin of this
  # script can write that pair — the pin refuses `--audit` on a checkout that
  # tracks the set — so it is a baseline that does not belong to this home (a
  # moved or copied `.fleet/`, a clone that arrived carrying another
  # workspace's baseline) or a forgery. Both refuse; re-pin here fixes the
  # first and the second is the finding.
  rec=$(sed -n '/^root=/{s/^root=//;p;q;}' "$base")
  if [ -n "$home" ] && [ -n "$rec" ] && [ "$rec" != "$root" ]; then
    die "baseline in $base certifies a foreign audited tree ($rec) while $root tracks its own instrument set — the baseline does not belong to this checkout, or was tampered with; refuse, do not re-read"
  fi
  if [ -n "$rec" ] && [ "$rec" != "$root" ]; then
    # Re-verified, not trusted. What this catches: the tree moved (the path
    # is now inside a DIFFERENT checkout, so `--show-toplevel` answers another
    # name), or stopped being one (deleted, de-repo'd) — both refuse, because
    # comparing a digest made over one tree against the bytes of nothing (or
    # of a parent repo's tree) is not an answer. What it cannot catch is a
    # REPLACEMENT: a checkout placed at the recorded path is audited by
    # content, and content matching line 1 is exactly as indistinguishable
    # from the pinned tree as a forged digest line is — no new power, and the
    # foreign-pointer guard above already refuses this whole channel for any
    # home that tracks a set of its own.
    again=$(git -C "$rec" rev-parse --show-toplevel 2>/dev/null) \
      || die "audited tree $rec (pinned in $base) is not a git checkout — the tree moved; refuse, do not re-read"
    [ "$again" = "$rec" ] \
      || die "audited tree moved: $rec now resolves to $again — refusing to certify a tree other than the one pinned"
    target=$rec
  fi
fi

# Hash the AUDITED tree — `$target`, which a baseline's recorded root may have
# repointed above.
#
# shellcheck disable=SC2086 # $set is a deliberate list of pathspecs, not one path
files=$(mktemp) || die "cannot create a temp file"
# INT/HUP/TERM as well as EXIT: a controller that kills a stalled gate check
# should not leave the temp file behind on a shared machine.
trap 'rm -f "$files"' EXIT
trap 'rm -f "$files"; exit 2' INT HUP TERM

# shellcheck disable=SC2086 # $set is a deliberate list of pathspecs, not one path
git -C "$target" ls-files -z -- $set > "$files" \
  || die "git ls-files failed under $target for: $set"
# An empty listing is the shape a wrong root produces — a symlinked skills dir
# resolving to a different repository, most plausibly, or a workspace that
# simply does not vendor the plugin. Certifying it would hand back "unchanged"
# for a set that was never read.
[ -s "$files" ] || die "no tracked file under $target for: $set — refusing to certify an empty instrument set"

# Two steps, each with its own status check, because a pipeline reports only its
# LAST command: with `xargs … | shasum` as one pipeline, a `shasum` that cannot
# run at all leaves the second one hashing empty input and exiting 0, and the
# empty-input digest then compares unequal and reads as CHANGED. That is exit 1
# — a verdict about the tree — off a failure to look. reap.sh shipped this exact
# bug against `git cherry` and it deleted branches.
#
# `xargs` exits 123 when `shasum` failed on any file, which is how a tracked
# file deleted from the worktree arrives: as exit 2 naming it, not as a digest
# quietly missing a line. Both refuse; only one of them is honest about why.
per_file=$(cd "$target" && xargs -0 shasum -a 256 < "$files") \
  || die "could not hash every tracked file under $set — see the errors above"
digest=$(printf '%s\n' "$per_file" | shasum -a 256 | cut -d' ' -f1) \
  || die "could not digest the instrument set"
[ -n "$digest" ] || die "empty digest for $target ($set)"

if [ "$pin" = true ]; then
  mkdir -p "$root/.fleet" || die "cannot create $root/.fleet"
  # Two lines, order fixed: the digest first, the audited tree's toplevel
  # second. A reader that only knows the old one-line shape — merge-gate.mjs's
  # `readInstruments`, which takes the FIRST stdout line as the digest — keeps
  # working, and a check from this script reads both. The root rides in the
  # same write as the digest because it is not a suggestion: a pointer an
  # attacker with a writable `.fleet/` could repoint at will would move the
  # gate to a tree they control, so the check trusts nothing else, re-verifies
  # the tree at check time, and refuses if it moved.
  {
    printf '%s\n' "$digest"
    printf 'root=%s\n' "$target"
  } > "$base" || die "cannot write $base"
  printf '%s\n' "$digest"
  printf '%s: pinned %s over %s\n' "$NAME" "$digest" "$target ($set)" >&2
  exit 0
fi

printf '%s\n' "$digest"
if [ "$digest" = "$want" ]; then
  exit 0
fi

# Cold path only, so it costs the ordinary run nothing. The controller has to
# report WHAT changed, and neither digest says. `git status` names the
# uncommitted half, which is the shape this header's measured near-miss took; a
# checked-out branch that moved shows as nothing here and the HEAD line is what
# names it. Both are read from the AUDITED tree, which is the one the verdict
# is about — not the state home the baseline was found in.
printf '%s: instrument set CHANGED under this run — expected %s\n' "$NAME" "$want" >&2
printf '%s: refuse the gate and report. Do NOT re-read the instrument.\n' "$NAME" >&2
printf '%s: HEAD %s\n' "$NAME" "$(git -C "$target" rev-parse HEAD 2>/dev/null || printf '?')" >&2
# shellcheck disable=SC2086 # $set is a deliberate list of pathspecs, not one path
git -C "$target" status --porcelain -- $set >&2 || true
exit 1
