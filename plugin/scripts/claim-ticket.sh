#!/bin/sh
# Claim a ticket: label it, create its worktree and branch, install with the
# frozen command, and materialise the isolation runner.
#
# Dry-run by default; --apply mutates the tracker and the filesystem.
#
# The install command is DERIVED from the lockfile, never defaulted. A
# lockfile-mutating install in a throwaway worktree corrupts it for everyone:
# npm@11 prunes cross-platform @esbuild optional deps and breaks CI and the
# Docker build.
set -eu

# Directly below `set -eu`, not below a locale pin: this script has none, and
# locale-pin-prose.test.mjs deliberately leaves it off the PINNED list (whether
# its generated runner needs one is #600's question). The five siblings that DO
# carry a pin put this line under it instead, because that file's PROLOGUE
# regex admits only comments, blanks and `set -[eux]+` above the pin. Here
# there is no pin to sit under, so the only constraint left is the real one:
# above the first git call. #1020
#
# Both halves are measured on this script, and each defeats a different guard.
#
# GIT_DIR: not one git call here carries a `-C` until after `worktree add`, so
# an ambient one moves the whole claim to another repository. Measured,
# standing in clone A whose `fix/777-ccc` already exists, with `GIT_DIR`
# naming clone B's `.git`: the `rev-parse --verify refs/heads/$branch`
# collision guard looks in B, finds nothing, and the run reports the ticket
# claimable at rc 0 with a full receipt — the double-claim that guard is the
# whole defence against. `--apply` then builds the worktree and the branch
# over there.
#
# GIT_WORK_TREE: it outranks `-C`, so the lockfile-mutation check below —
# `git -C "$wt" status --porcelain -uall package-lock.json …`, the one thing
# standing between a wrong install command and a lockfile corrupted for
# everyone — reads the AMBIENT tree against $wt's index. Measured with an
# install that really does rewrite `package-lock.json` in the fresh worktree:
# `lockfile clean after install`, rc 0, claim handed out, where the
# unpoisoned run refuses at exit 2.
unset GIT_DIR GIT_WORK_TREE

NAME=claim-ticket
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it. This script uses exit 2 for every refusal and has
# no exit 1, so a bare 1 out of it is a code its caller has no reading for. The
# guard sits ahead of every mutation, so a missing library refuses before a
# worktree, a branch, a label or a runner exists.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to claim without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

# The worktree readers (#551, #725). worktree.sh's header holds the sourcing
# contract; the `[ -r ]` ahead of the `.` is load-bearing there, not decoration.
# Sourced for `gone()` alone — this script reads no listing.
wt_lib="$(dirname "$0")/worktree.sh"
[ -r "$wt_lib" ] || die "cannot read $wt_lib — refusing to claim without the worktree predicates"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=worktree.sh
. "$wt_lib" || die "$wt_lib failed to load"

# Materializing the runner is not claiming a ticket: no label, no branch, no
# worktree, no install. `--write-runner` reaches the emitter below and nothing
# else, so the repo root's tracked `agent-test` can ask this script for the
# CURRENT runner instead of carrying a copy of it (#55). A committed copy would
# be the same decoy every `.worktrees/*/agent-test` already is — 24 KB frozen
# at whichever commit added it, while this emitter moved on — and worse, being
# tracked it would read as authoritative.
#
# <issue> only picks the isolation triple and defaults to 0: the main checkout
# and any clone, which share a stack with no claim. The positional rewrite
# below is what routes it through the argument validation the claim path
# already has, `$issue` included.
writeonly=false
dest=
if [ "${1:-}" = "--write-runner" ]; then
  # Bounded at both ends. The rewrite below collapses argv to exactly four
  # positionals, so the claim path's own arity check cannot see a trailing
  # argument that arrived on THIS branch — measured: `--write-runner <dest>
  # <issue> EXTRA --junk` dropped both extras without a word, exited 0 and
  # wrote the runner. Every caller in this repo passes <dest> and <issue>.
  [ $# -ge 2 ] && [ $# -le 3 ] || die "usage: claim-ticket.sh --write-runner <dest> [<issue>]"
  writeonly=true
  dest=$2
  [ -n "$dest" ] || die "--write-runner destination must not be empty"
  destdir=$(dirname -- "$dest")
  [ -d "$destdir" ] || die "--write-runner destination's directory does not exist: $destdir"
  set -- "${3:-0}" write-runner fix --apply
fi

[ $# -ge 3 ] && [ $# -le 4 ] || die "usage: claim-ticket.sh <issue> <slug> <type> [--apply]"
issue=$1
slug=$2
type=$3
# Exact match, and nothing else tolerated in the slot — the #250 demotion, in
# the file that still carried it. Measured on the unguarded script: `5 slug fix`
# and `5 slug fix --aply` were byte-identical on stdout AND stderr at exit 0,
# so nothing anywhere said the flag was not understood; and the arity check
# above was a lower bound alone, so `5 slug fix --apply extra --whatever`
# dropped both extras and reached `gh issue edit --add-label in-progress`,
# mutating the tracker on an argv the script never agreed to.
case "${4:-}" in
  ''|--apply) ;;
  *) die "unknown argument '$4' — the only option is --apply";;
esac
apply=false
[ "${4:-}" = "--apply" ] && apply=true

case "$issue" in ''|*[!0-9]*|0?*) die "issue must be a number, got '$issue'";; esac

branch="$type/$issue-$slug"
wt=".worktrees/$issue-$slug"
runner="$wt/agent-test"
# The one field `--write-runner` overrides. Everything else it derives is the
# claim path's own derivation, unchanged, which is the point: one emitter, one
# set of inputs, no second inference to drift.
[ "$writeonly" = false ] || runner=$dest

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
# `-e` alone STATS, so it follows the link and reads a DANGLING symlink as an
# absent path, while `git worktree add` refuses it on lstat semantics (`fatal:
# '…' already exists`) — leaving the refusal to fire only inside the NEXT
# mutation, `git worktree add` itself, stranding the branch ref it just created,
# with the in-progress label already on the issue, and in the DEFAULT dry run
# leaving it not to fire at all: exit 0 and a receipt naming the path claimable.
# Same predicate release-ticket.sh's `occupied()` already carries, for residue
# this fleet leaves itself — a symlink pointing AT the registered directory
# survives the `git worktree remove` that deletes its target. Measured on git
# 2.50.1: every path `-L` adds here (dangling link, symlink loop) is one `git
# worktree add` refuses too, so it cannot refuse a claim that would have worked.
#
# But the pair answers only TWO of the three states, and silently folds the
# third into "absent": both `-e` and `-L` are false when the stat could not RUN.
# An unreadable or unsearchable ancestor fails them EACCES and the shell
# discards the errno, so an occupied path read as claimable with nothing on
# stderr — in the DEFAULT dry run, where `git worktree add` never runs to refuse
# it downstream, that is exit 0 and a receipt byte-identical to a free path's.
# `gone()` is the predicate that keeps established-absent and could-not-measure
# apart (worktree.sh; #725 made it one definition rather than three), so the
# refusal below is the existing helper, not a new EACCES-aware stat. #727
#
# ABSOLUTE, and this is the term to leave alone. `gone()` walks up to the
# nearest existing ancestor and asks whether IT is searchable; git hands every
# other caller an absolute path, and `$wt` is the first relative one. Measured:
# handed `.worktrees/42-slug`, the walk reaches the bare `.worktrees` component,
# cannot strip further, finds it missing on a repo that has never had a
# worktree, and answers "not established absent" — turning every first claim in
# a repo into a refusal. `$PWD` is what the walk needs to reach the repo root.
# Measured on /bin/sh, dash and bash: each sets PWD from getcwd() at startup, so
# a stale inherited value is corrected and an unset one does not trip `set -u` —
# the two ways this term could have asked about the wrong path.
#
# Kept as a PAIR rather than `gone` alone, the way gone()'s own header prescribes
# for a caller that needs the two refusals apart. The messages are not
# interchangeable: an occupied path is diagnosed, an unmeasured one is admitted
# to. And the wording of the first stays hedged — a dangling link here has two
# provenances with opposite claim states (rc-0 residue, and a release halted
# mid-flight with the branch and the label still live), and only the hedge is
# true of both. #728
# The claim-only guards: a fresh worktree/branch not yet existing is a claim
# precondition, meaningless for `--write-runner`, which targets an arbitrary
# `$dest` in a tree that may already exist (the main checkout, an existing
# worktree). Ungated, these refused a runner emission over residue from a
# claim this invocation never intends to make.
if [ "$writeonly" = false ]; then
  if [ -e "$wt" ] || [ -L "$wt" ]; then
    die "$wt already exists — ticket may already be claimed"
  elif ! gone "$PWD/$wt"; then
    die "could not establish whether $wt exists — an ancestor is unreadable, not searchable, or not a directory; refusing to claim a path nothing measured"
  fi
  git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && die "branch $branch already exists"
fi

# Everything below is derived from $ref, the tree the runner reflects. The
# claim path builds a fresh worktree FROM origin/main, so origin/main is the
# only tree that exists to derive from — never $PWD, which can hold untracked
# or gitignored files the worktree will never have (this repo's own
# package.json is gitignored), or sit on a different commit entirely. Probing
# $PWD there let the script announce "no lockfile" and then build a worktree
# containing one.
#
# `--write-runner` is the opposite case: $dest already lives inside a tree
# that exists NOW (the main checkout, an existing worktree), so HEAD is what
# "the CURRENT runner" (#55, top of file) means, and requiring an origin/main
# ref to exist at all — the main checkout need not have one — refused runner
# emission over a precondition the claim path alone needs.
ref=origin/main
[ "$writeonly" = false ] || ref=HEAD
pkg=$(git show "$ref:package.json" 2>/dev/null) || pkg=

# Derive the frozen install from the lockfile. No match is a refusal, not a
# default — guessing here is what corrupts the tree. The one safe exception is
# nothing to install: no manifest, or one whose four dependency fields are all
# empty and which is not a workspaces root. An unparseable manifest is not
# evidence of an empty one, so it refuses too.
if   git cat-file -e "$ref:package-lock.json" 2>/dev/null; then install="npm ci"
elif git cat-file -e "$ref:pnpm-lock.yaml"    2>/dev/null; then install="pnpm i --frozen-lockfile"
elif git cat-file -e "$ref:yarn.lock"         2>/dev/null; then install="yarn --immutable"
elif [ -z "$pkg" ]; then install="true"
# Ahead of the capture below, and only on the arm that reaches it — every
# lockfile arm and the no-manifest arm settle the install without an
# interpreter, so an unavailable one is not their problem. The capture merges
# stderr (see the block under it), so without this the shell's own `node:
# command not found` arrives INSIDE $ndeps and the refusal reports it as
# `could not read origin/main:package.json — <that line>`: the manifest's name
# for a fault the manifest had no part in, indistinguishable by message from a
# manifest that genuinely does not parse. The probe is an INVOCATION rather
# than a name lookup, because those are not the same question: `command -v`
# answers only that a PATH entry named `node` exists and is executable, which a
# version-manager shim that resolves and then fails satisfies — and that shim's
# own stderr then arrives under the manifest's name, which is this defect itself
# rather than a narrower cousin of it. Running the interpreter asks what the
# capture below asks, so this refuses exactly where that one would have, and
# reports the interpreter's own words rather than a cause inferred from a name.
# #1141
elif ! nodeerr=$(node -e 0 </dev/null 2>&1); then
  die "node is unusable, refusing to claim without the interpreter this derivation needs — $nodeerr"
elif ! ndeps=$(printf '%s' "$pkg" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(String(["dependencies","devDependencies","peerDependencies","optionalDependencies","workspaces"].reduce((n,k)=>n+Object.keys(p[k]||{}).length,0)))' 2>&1); then
  die "could not read $ref:package.json — $ndeps"
# The `2>&1` on the ndeps capture is load-bearing — without it the failure
# path's die has no reason to print — but it merges node's stderr into $ndeps
# on the SUCCESS path too. The hazard is not an enumerable set of env vars
# (#752 arrived through NODE_DEBUG and NODE_OPTIONS=--inspect): it is anything
# that writes to node's stderr and still exits 0, a --require preload or a
# version-manager shim on PATH included.
# A clean count is always bare digits, so anything else is certainly not one —
# refuse it before comparing. That buys no false refusals, not a trustworthy
# capture: digit-only chatter ending without a newline runs together with the
# count and still reads as one, and a shape check cannot see the merge that
# produced it.
# The derive-testcmd.sh capture merges its stderr the same way with no such
# guard. What protects it is its callee folding its own node's stderr into the
# reason it returns rather than emitting it — not the capture's shape.
elif case "$ndeps" in ''|*[!0-9]*) true ;; *) false ;; esac; then
  die "could not read $ref:package.json — unexpected output: $ndeps"
elif [ "$ndeps" = 0 ]; then install="true"
else die "$ref declares $ndeps dependencies but has no lockfile — refusing to guess an install command"
fi
echo "    lockfile → install: $install" >&2

# One shape for "is a test file", fed into the directory-expansion shim the
# runner writes below (a shell string at RUN time, not a git query, so it
# cannot simply call derive-testcmd.sh for this value). Kept in sync BY HAND
# with derive-testcmd.sh's own copy, which the emit guard below now defers to.
testfile_re='\.(test|spec)\.[cm]?[jt]sx?$'

# The runner runs the repo's own test entrypoint. The inference itself — a
# manifest test script, else a direct test-file run, else refuse rather than
# emit a runner that would pass vacuously — is NOT reimplemented here: it lives
# once in derive-testcmd.sh, reused by review-pr.js's snapshot agent for the
# same decision against a reviewed repo's HEAD (#142). A second copy is what
# drifts.
#
# `2>&1`, exactly as the install probe above does at its own capture: the
# script's refusal reason travels on its STDERR, and `$(...)` captures stdout
# only — without the merge `die "$testcmd"` fires with an empty argument and
# prints the bare line `claim-ticket: `. The reason survives today only
# because the child's stderr happens to share this terminal; any caller that
# captures or redirects it gets nothing, and the missing-sibling case (a PATH
# or symlink invocation where `dirname -- "$0"` is not this directory) is
# unreadable either way. derive-testcmd.sh writes nothing to stderr when it
# succeeds, so the success path still captures the command alone.
script_dir=$(dirname -- "$0")
if ! testcmd=$("$script_dir/derive-testcmd.sh" . "$ref" 2>&1); then
  die "$testcmd"
fi
echo "    test entrypoint → $testcmd" >&2

pg=$((16000 + issue))
ollama=$((22000 + issue))
echo "    ports derive from the issue number: postgres=$pg ollama=$ollama" >&2

# The stamp the runner carries. The runner is written once at claim time and
# never rewritten (#124), so an old worktree can be sitting on a runner a later
# template fix never reached. This stamp does not detect or fix that — nothing
# reads it, nothing refuses on a mismatch — it only makes staleness legible:
# diff the stamp against a fresh `cksum` of this script to see if they match.
# It is a checksum of the WHOLE script, not of the emitted template, so it
# over-reports: any edit to this file moves it — a reworded die message, a
# comment — while the runner it produces stays byte-identical. It under-reports
# too, so the error is not one-way and a match does not mean fresh: which body
# the runner gets is decided by $testcmd, which comes from the sibling
# derive-testcmd.sh, and this checksum does not cover that file. Measured — two
# byte-identical copies of this script, differing only in that sibling, emitted
# runners of very different sizes under one stamp. So what the stamp covers is
# this file's own bytes: a mismatch means "re-materialize to be sure", and a
# match means only that this script has not changed.
#
# One command, not `cksum | cut`: the convention inflight.sh states in its own
# comments — a pipeline reports only its last stage's status, so `set -eu`
# reads `cut`'s success and a `cksum` that could not read its operand yields a
# stamp line with nothing after the colon, at exit 0 and a claim reported as
# applied. Measured on the pipeline form. The trailing fields come off by
# parameter expansion rather than another process, since `cksum` prints the
# checksum, the byte count and the path.
#
# Reading the status is only half of it: this derivation sits with the others
# that run before the apply branch, not beside the heredoc that consumes it.
# Guarded where that heredoc is, the refusal fires after the issue has been
# labelled and after `git worktree add`, so it exchanges a blank stamp for a
# half-claimed ticket — label applied, branch ref and worktree on disk, and a
# claim reporting failure — needing a manual release-ticket. Measured on that
# form too. Derived here it has nothing to clean up, the same property the
# json.sh guard is placed for. Nothing blocks the move: the value depends on
# this script's own path and on nothing the branch establishes.
tmpl_stamp=$(cksum "$0") || die "could not checksum $0 — refusing to claim without a runner template stamp"
tmpl_stamp=${tmpl_stamp%% *}
# Status is not content, so that is two parts and not one — the same shape the
# lockfile guard uses, status then value. A `cksum` that exits 0 printing
# nothing leaves this empty, and `set -u` catches an unset variable, never an
# empty one, so without this the blank stamp line ships at exit 0 with the
# ticket claimed: the rc-0 half of the same hole the pipeline form opened.
[ -n "$tmpl_stamp" ] || die "cksum $0 produced no checksum — refusing to claim without a runner template stamp"

if [ "$apply" = false ]; then
  echo "$NAME: DRY RUN — nothing created. Pass --apply to act." >&2
  echo "    would: gh issue edit $issue --add-label in-progress" >&2
  printf '    would: git worktree add --no-track %s -b %s origin/main\n' "$wt" "$branch" >&2
  printf '    would: (cd %s && %s)\n' "$wt" "$install" >&2
  printf '    would: write %s and add it to .git/info/exclude — skipped if %s is\n' "$runner" "$runner" >&2
  printf '      already tracked, checked out with the worktree (#55)\n' >&2
else
  # Everything down to the lockfile check is the CLAIM; `--write-runner` wants
  # none of it and must not be able to reach it. Left at the branch's own
  # indentation deliberately — re-indenting sixty lines to add a guard buys a
  # whitespace diff over the block whose comments carry #128.
  if [ "$writeonly" = false ]; then
  echo "\$ gh issue edit $issue --add-label in-progress" >&2
  gh issue edit "$issue" --add-label in-progress >/dev/null || die "could not label issue $issue"

  # `--no-track`: without it, `-b … origin/main` leaves $branch tracking
  # origin/main, so `@{u}` RESOLVES — to main. Every "did my push land?" check a
  # member might reach for (`git rev-parse HEAD @{u}`, `git status -sb`) then
  # answers a question about main and reads healthy no matter what the push did.
  # That is #760's sharp half, measured on two live worktrees. Under
  # push.default=upstream the same config is a live hazard rather than a
  # misleading guard: a bare `git push` would push $branch's commits onto
  # origin/main. (Under the default push.default=simple it refuses loudly, exit
  # 128 — so the ticket's "silently no-ops" framing does not reproduce; the
  # observed silent no-op came from a push through an explicit URL, which sets
  # no upstream either way.) With no upstream, all of those fail loudly instead.
  #
  # No upstream at all, rather than one pre-seeded at refs/heads/$branch: git
  # computes `%(upstream:track)` against the REMOTE ref, and an upstream naming
  # a remote ref that has never existed reads as `[gone]`, not as "no upstream"
  # — measured, a freshly claimed branch was reaped by `reap.sh --apply` before
  # any work was done in it. The real upstream arrives with the documented first
  # push, `git push --force-with-lease -u origin HEAD` (skills/next-ticket/SKILL.md
  # step 7; its no-lease fallback carries `-u` too), and only then can be `[gone]`.
  #
  # release-ticket.sh's branch delete is `-D` because of this line: `-d` measures
  # an upstream-less branch against local HEAD and refuses a pristine claim
  # whenever local main is behind origin/main.
  printf '$ git worktree add --no-track %s -b %s origin/main\n' "$wt" "$branch" >&2
  git worktree add --no-track "$wt" -b "$branch" origin/main >/dev/null || die "worktree add failed"

  printf '$ (cd %s && %s)\n' "$wt" "$install" >&2
  (cd "$wt" && $install >/dev/null 2>&1) || die "install failed in $wt"

  # The lockfile must be untouched by the install. Non-empty means the wrong
  # command ran, and the worktree is now corrupt for everyone. Check git's exit
  # status too: a failed status prints nothing, which is byte-identical to
  # "clean" and would let this guard pass without having verified anything.
  #
  # That same guard does not cover the rc-0 form of the identical hole: delete
  # $wt's .git outright (or empty it into a directory, or leave a dangling
  # symlink) between the `worktree add` above and here, and `git -C` does not
  # fail — it walks UP to the enclosing repo and answers about THAT at rc 0,
  # which this check would read as an untouched lockfile it never actually
  # looked at. `-f`: `git worktree add` writes $wt's `.git` as a regular file,
  # so no healthy run trips this; reference shape and same reason as
  # release-ticket.sh's own linkage guard (#128). `-x "$wt"` for the reason
  # reap.sh and worktree-audit.sh give their own copy: `-f` is equally false
  # for a `.git` that is absent and for one this process may not stat, and an
  # unsearchable $wt must not be reported as an absence nothing established.
  # Left ungated it ate the case before the `git -C` below could reach it —
  # measured: `.git` still sitting there while the run blamed its deletion.
  # Gated, git answers with its own denial through the elif, which is what
  # release-ticket.test.mjs already pins as the wording to prefer over one this
  # script invents.
  if [ -x "$wt" ] && [ ! -f "$wt/.git" ]; then
    die "$wt has no .git file — cannot verify the lockfile was not mutated"
  # No `2>&1` here, unlike the two captures above: those capture a refusal
  # REASON, this captures DATA that is then compared. The comment above
  # release-ticket.sh's own dirty-worktree status capture already states it
  # — folded-in stderr would be counted as a change. A git
  # that exits 0 still writes to stderr for a malformed `.gitattributes` line
  # or a chatty `core.fsmonitor`, and merged that chatter became the whole of
  # $dirty and refused a lockfile it had just verified as clean — after the
  # label, the branch and the worktree were already created. git's denial
  # reaches this terminal on its own, which is the "its own denial" the
  # paragraph above means; the die names the failure, not the reason.
  #
  # `-uall`: #730 (see reap.sh's branch sweep for the full explanation) —
  # the untracked mode is CONFIG, and not decorative under a pathspec: an
  # install that CREATES a lockfile the tree does not track is exactly the
  # mutation this die exists to catch, and unpinned it is invisible at rc 0.
  elif ! dirty=$(git -C "$wt" status --porcelain -uall package-lock.json pnpm-lock.yaml yarn.lock); then
    die "could not verify lockfile state in $wt"
  elif [ -n "$dirty" ]; then
    die "install mutated the lockfile in $wt — wrong command, fix before dispatching"
  fi
  echo "    lockfile clean after install" >&2
  fi

  # A runner is already there: the repo tracks one, and `git worktree add`
  # checked it out with everything else. Overwriting it is what must not
  # happen — the file is TRACKED, so the write leaves a modified tracked path,
  # and `reap.sh` calls `git worktree remove` without `--force` (its own
  # comment: "refuses on modified and untracked files"). Every release of every
  # claim would then strand on a file this script wrote itself. Leave it: it is
  # the bootstrap that asks this script for the current runner anyway, so the
  # worktree gets a fresher one than this branch could have written. #55
  #
  # `--write-runner` is exempt from THAT test — $dest is the artifact it was
  # asked to produce, and refusing to overwrite it would refuse every run after
  # the first — but not from the tracked-path refusal below.
  #
  # Existence is the wrong question to be the only one asked, because it
  # answers about the caller's intent rather than about the damage. The damage
  # is a MODIFIED TRACKED path, and every route to it routes through this one
  # write: the claim path when its own condition is wrong, and `--write-runner`
  # with a caller-supplied $dest, which no guard reads at all today. #1262 is
  # what that costs — a claim run from a checkout whose `claim-ticket.sh`
  # predated the `-e` test overwrote the bootstrap `git worktree add` had just
  # checked out, and the corruption was silent until three implementers each
  # diagnosed it by hand. Asking git makes the same clobber a refusal.
  #
  # Fail-open when git cannot answer, unlike the `gone()` pair above, and the
  # asymmetry is deliberate: those guard a CLAIM, where an unmeasured path is a
  # worktree that may already exist, while this one guards a WRITE whose only
  # hazard is trackedness. $dest need not sit in the repo the cwd is in, so
  # `git -C` outside one is an ordinary input rather than a fault, and nothing
  # untracked is lost by writing. The refusal fires on trackedness this
  # established, never on a question it could not put.
  if [ "$writeonly" = false ] && [ -e "$runner" ]; then
    printf '    %s already present — tracked runner, checked out with the worktree; left as is\n' "$runner" >&2
  else
    # Gated to --write-runner only. On the claim path $runner is always the
    # worktree's own agent-test — freshly checked out by `git worktree add`
    # whenever it is tracked at all, so the `-e` branch above already catches
    # every real case; reaching this far on the claim path means an untracked
    # path, and firing a `die` here would land AFTER the label, the worktree
    # and the install already happened — a half-claim needing manual
    # release-ticket.sh, for a check the claim path gets no protection from
    # (`--write-runner`'s $dest has no such checkout to shortcut it, so it's
    # the one path this guard actually protects). #1262
    if [ "$writeonly" = true ]; then
      runner_dir=$(dirname -- "$runner")
      runner_base=$(basename -- "$runner")
      # `:(literal)` pins the pathspec to $runner_base's own literal text.
      # Bare, it is a pathspec, not a filename — a $dest whose basename holds
      # `*`, `?` or `[` matched a DIFFERENT tracked file sharing that
      # directory and answered about that file's trackedness instead of this
      # one's (measured — 'agent-test-?' matched a real 'agent-test-x').
      #
      # The exit STATUS alone cannot tell a real git failure apart from the
      # two states this guard fails open on — a corrupted or unreadable index
      # exits 128, the same code "not a git repository" does — so both sides
      # of this branch route through the message git itself printed, captured
      # with stdout discarded and stderr kept (`2>&1 >/dev/null`, order
      # matters): the ls-files call this replaced folded errors into rc alone
      # and could not distinguish "genuinely untracked" from "git could not
      # tell" — the latter silently read as the former, which is #1262's own
      # clobber through a different door (a live git fault standing in for
      # "outside any repo").
      if trackedmsg=$(git -C "$runner_dir" ls-files --error-unmatch -- ":(literal)$runner_base" 2>&1 >/dev/null); then
        die "$runner is tracked — writing the generated runner over it would leave a modified tracked path, which \`git worktree remove\` refuses and every release would then strand on; refusing"
      fi
      case "$trackedmsg" in
        # $runner_dir is not inside any repository at all — $dest need not
        # share a repo with the cwd, so this is an ordinary input, not a
        # fault, and nothing untracked is lost by writing.
        *'not a git repository'*) ;;
        # A real repo, ':(literal)' pathspec, genuinely no match — this is
        # what "untracked" actually looks like once the wildcard hazard above
        # is closed.
        *'did not match any file'*) ;;
        # Anything else is git unable to answer at all — a corrupted or
        # locked index, a permission fault — and folding that into "untracked"
        # is the exact silent clobber #1262 exists to refuse.
        *) die "could not determine whether $runner is tracked — refusing rather than risk overwriting a tracked path; git said: $trackedmsg" ;;
      esac
    fi

  # Isolation as a file, not a briefing. Env vars in a prompt were missed five
  # times in one run — including by an agent whose parent was briefed but did
  # not pass them down. Anyone who finds the worktree finds the runner.
  cat > "$runner" <<SH
#!/bin/sh
# agent-test template: $tmpl_stamp
export TEST_COMPOSE_PROJECT=ab-$issue TEST_POSTGRES_PORT=$pg TEST_OLLAMA_PORT=$ollama
SH

  # Only `node --test` gets the directory shim. Every other entrypoint is
  # somebody else's runner — vitest and jest already take a directory, as a
  # filter against naming conventions that need not be this regex — and
  # rewriting their arguments would refuse suites that are perfectly fine.
  if [ "$testcmd" = "node --test" ]; then
    cat >> "$runner" <<SH
# A directory is the ergonomic way to say "run this suite", but node resolves
# it as a module specifier and dies with MODULE_NOT_FOUND before a test runs.
# Expand it to the test files underneath instead. IFS and -f settle only how
# the *shell* splits that expansion: a newline IFS keeps a path with a space
# in it one word, and -f stops the shell re-globbing the result.
IFS='
'
set -f
# A bare invocation (zero arguments) must run the same suite the emit guard
# above certified, not node's own default discovery. \`for arg do\` with no
# \`in\` clause iterates "\$@" — on an empty argv the loop body never runs, so
# both the expansion and its zero-match refusal are skipped and the runner
# falls straight through to \`exec node --test "\$@"\` below with an empty
# "\$@": node's own discovery, which does not recognise the \`.spec.\` form
# or the \`x\` variants of the extensions this shim matches. Routing it
# through "." here gives it the same expansion, the same test-file shape, and
# the same node_modules prune as every other invocation. (#97)
[ \$# -gt 0 ] || set -- .
# A flag counts toward \$#, so an argv of flags alone clears the bare-form
# default and then contributes nothing for the loop to expand: argv reached
# \`exec node --test\` holding only flags, which is node's own discovery and the
# same vacuous pass the bare-form default exists to refuse. \$operand records
# whether any argument named something to run, so the flags-only refusal can
# tell that argv from a bare one, which the bare-form default has already
# turned into ".". Assigned rather than assumed empty, because an exported
# \$operand in the caller's environment would otherwise disarm the refusal.
# Refusing rather than defaulting: prepending "." ahead of node's own flags
# reorders argv, which needs its own measurement, and no briefed workflow
# passes flags alone. (#352)
operand=
# Where this runner itself lives, resolved physically. Both vendored guards
# below judge an argument by where it DIVERGES from here, and each used to
# derive that for itself from the same \`dirname "\$0"\` — byte-identical
# commands 276 lines apart, re-run once per argument.
# Once, above the loop, is value-identical and not merely cheaper: every \`cd\`
# in this runner is inside a \`\$( )\` and so cannot move this process's cwd
# between iterations, \`\$0\` is never reassigned, and \`CDPATH=\` pins the one
# lookup an inherited CDPATH could otherwise answer differently per argument.
root=\$(CDPATH= cd -- "\$(dirname "\$0")" 2>/dev/null && pwd -P)
# The deepest ancestor of \$root that also contains \$1, left in \$shared. Both
# vendored guards judge an argument from that point down, because a
# \`node_modules\` segment ABOVE it is an ancestor of the runner itself and says
# nothing about the argument — and both walked the identical loop to find it.
# It takes an ALREADY-RESOLVED path and resolves nothing itself, which is the
# whole of what makes it shareable. The two callers deliberately resolve
# differently — the directory branch \`cd\`+\`pwd -P\` (#186), the file branch
# \`realpath\` (#424), one logical guard away from each other by #401's
# ruling — and a helper that picked either mode for both would reinstate the
# defect #424 closed. Pass the resolution in; never derive it here.
# \$shared is a global because POSIX \`sh\` has no \`local\`, and it is rewritten
# on every call — read it in the same breath, as both callers do. The \`|
# "\$shared"\` alternative is the equality case: an argument resolving TO the
# ancestor, not under it, must still terminate the walk there.
diverge() {
  shared=\$root
  while [ -n "\$shared" ]; do
    case "\$1" in "\$shared"/* | "\$shared") break ;; esac
    shared=\${shared%/*}
  done
}
for arg do
  shift
  # Judged on the argument's shape, not on what that shape resolves to: a
  # directory expands, an existing file passes through escaped, a quoted glob is
  # node's to expand whether or not it matches anything, and a typo is refused
  # outright. A flag is the one shape that can name nothing at all.
  # \$operand is recorded by the dispatch itself rather than derived a second
  # time ahead of it (#961). The branch below already settles \`-d\`, then
  # \`-e\`, then the argument's shape — the same three questions a standalone
  # classification had to ask again, in another shape, with nothing but a
  # comment keeping the two answers in agreement. Each arm that names
  # something to run says so; the flag arm names nothing and stays silent.
  # Existence, not spelling, is what settles a dash-led argument, and the arm
  # ORDER is what carries that: an existing dash-named path reaches \`-d\` or
  # \`-e\` before anything can read it as a flag, while a dash-led glob that
  # does not exist meets \`-*\` ahead of the glob arm and stays a flag.
  # Agreement is the whole of what this buys, never a working invocation: a
  # dash-spelled path is refused either way, and the classification settles
  # only WHICH refusal a caller sees. Measured on a runner built from this
  # emitter, with a file named \`-dash.test.mjs\` present and named as the sole
  # argument: as an operand, node reads it as an option and exits 9 with
  # \`node: bad option\`; as a flag, the refusal below exits 1 in this runner's
  # own voice. Both rows are pinned in claim-ticket.test.mjs.
  # The arms that refuse an argument outright — every vendored spelling, the
  # unreadable directory, the typo — used to run after the classification and
  # now run before any arm records one. Nothing observable rides on that,
  # because each of the nine exits inside this loop is \`exit 1\`: an argument
  # they refuse leaves the process there, and \$operand is never read again.
  if [ -d "\$arg" ]; then
    operand=1
    # Zero matches must refuse. Appending nothing does not run nothing — it
    # leaves argv empty, and bare \`node --test\` then discovers the whole
    # worktree: a green for a suite nobody asked for. Shrugging instead, when
    # something else is on the line, runs a subset and still exits 0. Both are
    # the vacuous pass this script exists to refuse.
    # Node globs its own argv, downstream of anything the shell settled. A
    # literal \`[\` there is a bracket expression that cannot match itself, so
    # an unescaped path matches nothing — and node runs nothing and exits 0,
    # the same vacuous pass, reached past this guard because find did match.
    # \`[[]\` is the bracket idiom for a literal \`[\`; \`*\` and \`?\` need no
    # escape, since a path holding one still matches itself.
    # find's own status has to be read before grep overwrites it. A subtree it
    # cannot descend still yields the part it reached, grep still matches, and
    # the guard below still passes — a green over a suite that silently lost
    # whatever was under the unreadable directory.
    # Node's own discovery excludes \`node_modules\`; find does not, so without
    # this a vendored test runs and the suite's result hangs on third-party
    # code passing. Node refuses an argv path only when its relative form
    # starts with \`node_modules/\` — a deeper segment or an absolute path runs,
    # and in a mixed argv the refused ones are dropped silently — so this
    # walk, not node, is what keeps vendored tests out.
    # It takes two mechanisms, because they cover disjoint cases. \`-prune\`
    # fires only where the walk DESCENDS through a dirent named
    # \`node_modules\`; where the argument is itself at or under one, find
    # starts inside it, prunes nothing, and prints every file. Measured under
    # the prune alone: \`t/node_modules/pkg\` and every absolute spelling ran
    # their vendored tests and exited 0. So the \`case\` refuses a vendored
    # argument up front, and the prune covers vendored directories met during
    # a walk that started outside one.
    # The \`case\` also has to be the thing that reports it. Falling through to
    # the emptiness guard below prints \`no test files under \$arg\` — false,
    # since the files are there and deliberately excluded — sending a reader
    # after a discovery bug that does not exist.
    # Pruning rather than filtering the walk's output after the fact is what
    # buys the readability property: an unreadable directory under
    # \`node_modules\` can no longer flip find's exit status, so the check
    # above stops refusing a whole suite over content that was excluded
    # regardless. The previously-shipped \`-not -path '*/node_modules/*'\` still
    # descended, so it did not.
    # The trailing slash is what lets a symlinked directory through. \`[ -d ]\`
    # above follows symlinks and find does not descend a symlinked *argument*,
    # so without it the two disagree on one target: the branch admits the
    # symlink, find matches nothing under it, and the guard below refuses a
    # suite that is right there. \`find -L\` would agree with \`[ -d ]\` too, but
    # by following symlinks *inside* the tree as well — sweeping in vendored
    # code reached through a symlink named anything other than
    # \`node_modules\`, which neither guard catches: the \`case\` reads the
    # argument itself — its spelling and where it resolves to — and
    # \`-prune\` the directory's own name, and a symlink met INSIDE the walk
    # under another name carries \`node_modules\` in neither. On a
    # cycle the platforms then disagree: GNU find exits 1,
    # which the \`||\` below reports as an unreadable directory, while BSD find
    # skips it silently. The slash settles the argument alone.
    # Judged by the argument's spelling OR its RESOLVED directory (#186).
    # Spelling alone missed a symlink whose target lies inside a vendored
    # tree — its own name carries no \`node_modules\`, and \`-prune\` below
    # only fires on a dirent NAMED \`node_modules\` met during the walk:
    # traversal starts at the symlink's target, so the vendored component is
    # already behind the walk's starting point and neither mechanism ever
    # sees it. \`cd\`+\`pwd -P\` follows the argument's own symlink (and any
    # inside its path) to the real directory, so the test also becomes
    # "resolves inside a vendored tree" however the caller spelled it.
    # BOTH, because they cover disjoint inputs. \`cd\` fails on a directory
    # \`[ -d ]\` admits but that carries no search bit, and the resolution is
    # then empty. Its PARENT is still enterable — only the directory itself
    # lost the bit, and \`[ -d ]\` above had to traverse the parent to answer —
    # so resolving that and re-appending the basename hands the walk below a
    # \`pwd -P\` path for this input too, and the \`case\` stays what reports it
    # (see above) rather than the readability message from \`find\`. Falling
    # \`\$resolved\` back to the argument's own text instead is what left #230
    # half-open: an absolute spelling through a symlinked ancestor (a macOS
    # \$TMPDIR is one) shares no literal prefix with \$root, so \$shared empties,
    # \`\${resolved#"\$shared"}\` is the whole spelling, and a NON-vendored
    # directory was refused as vendored under its own absolute name while the
    # relative and realpath spellings of it reported the permission fault.
    # The last resort is the fail-safe for a parent that will not resolve
    # either: it restores the older behaviour rather than leave \$resolved
    # empty. \`[ -d ]\` above already traversed the parent, so no input
    # is known to reach it and no test does — kept because a guard whose
    # recovery can leave nothing to measure is the wrong way to be wrong.
    # Judged from where the argument DIVERGES from the runner's own location,
    # because \`pwd -P\` is absolute and a \`node_modules\` segment ABOVE the
    # divergence is an ancestor of the runner itself — shared with it, so it
    # says nothing about the argument. Matched absolutely, a worktree living
    # under one refused every directory argument, including the bare
    # invocation's implicit \`.\`. Anchoring at the worktree root instead is
    # the opposite error: it discards every resolution that lands outside, so
    # a symlink to a vendored tree elsewhere on disk ran green — #186's own
    # class, one input over.
    # The SPELLING is read only where it is anchored at all, which is why
    # \`\${arg##/*}\` empties an absolute one (#230). A relative spelling is
    # anchored at the cwd and means something there; an absolute spelling
    # names the whole path from the root, so it necessarily carries the
    # ancestor shared with the runner inside its own text and matched on the
    # \`node_modules\` the divergence walk had just ruled irrelevant. One
    # directory then drew opposite verdicts under two names — the same
    # directory that ran as \`t\` refused as its own absolute path. Exempting
    # it is the rule the file branch below already applies, and stripping
    # \$shared off the spelling instead is not equivalent: that is lexical,
    # while \$shared comes from \`pwd -P\`, so a caller naming a path through a
    # symlinked ancestor (a macOS \$TMPDIR is one) shares no literal prefix
    # with it and nothing is stripped. Both sides of that comparison are
    # \`pwd -P\`-derived wherever the argument or its parent resolves, which is
    # what makes the resolved term immune to the spelling; the one input that
    # escapes is the last resort above, where neither did.
    # The spelling term's own remaining input is a cwd OUTSIDE the worktree,
    # from which a relative argument descending through the shared ancestor
    # does name that \`node_modules\` and is refused — measured, and node reads
    # the file branch's arguments the same way. Nothing else in the suite
    # reaches the term, so that input is what pins it.
    # \`CDPATH=\` on each \`cd\` here, and on \$root above: an inherited CDPATH
    # resolves a bare relative name against a same-named directory somewhere
    # else entirely, so the guard would judge one directory while \`find\`
    # below — which never consults CDPATH — walks another, and the vendored
    # suite runs green. It also stops \`cd\` echoing its target into the
    # substitution.
    # A symlink to a directory that merely CONTAINS a vendored tree resolves
    # outside \`node_modules\` and passes here untouched; \`-prune\` below
    # still excludes its vendored contents once the walk reaches them.
    resolved=\$(CDPATH= cd -- "\$arg" 2>/dev/null && pwd -P)
    if [ -z "\$resolved" ]; then
      parent=\$(CDPATH= cd -- "\$(dirname -- "\$arg")" 2>/dev/null && pwd -P)
      [ -z "\$parent" ] || resolved=\${parent%/}/\$(basename -- "\$arg")
      [ -n "\$resolved" ] || resolved=\$arg
    fi
    diverge "\$resolved"
    case "/\${arg##/*}/ /\${resolved#"\$shared"}/" in
      */node_modules/*) printf 'agent-test: %s is under node_modules — excluded from the run, not missing\n' "\$arg" >&2; exit 1 ;;
    esac
    # BSD find (macOS's /usr/bin/find) and GNU find (ubuntu-latest CI's)
    # both read a leading \`-\` in \$arg as the start of an option cluster,
    # trailing slash and all, and neither is rescued by a POSIX \`--\`:
    # measured directly on this machine and inside an ubuntu:latest
    # container, \`find "-dir/" ...\` and \`find -- "-dir/" ...\` both die
    # before reading a single path — "illegal option -- i" (BSD) /
    # "unknown predicate \`-dir/'" (GNU), rc 1 either way — for a directory
    # that holds tests and is otherwise perfectly readable. That refusal
    # used to fall into the \`||\` below and report it as an unreadable
    # subtree, which is not what happened: find never got far enough to
    # try reading anything.
    # \`./\$arg/\` is not a workaround for that refusal, it is a spelling
    # that never triggers it — measured the same two ways, \`find
    # "./-dir/" ...\` runs clean (rc 0) on both finds, and still follows a
    # dash-led SYMLINK argument exactly as the trailing slash already does
    # for every other spelling (measured against a symlink named
    # \`-slink\`). So a dash-led \$arg is routed through \`./\` before it
    # ever reaches find, and the \`||\` below is left with only its own
    # job: whatever non-zero status find returns from here on is a genuine
    # read fault, not its argument parser losing a fight with the caller's
    # spelling.
    case "\$arg" in
      -*) findarg="./\$arg/" ;;
      *) findarg="\$arg/" ;;
    esac
    # GNU find (ubuntu-latest CI) answers \`-type f\` straight from the
    # dirent's own \`d_type\` field when the filesystem provides one (ext4
    # does) — no \`stat\`/\`lstat\` at all — and \`-print\` only ever needs the
    # name, so the pair together can name a file behind a directory that is
    # READABLE but not SEARCHABLE (chmod 600: \`r\` present, \`x\` missing)
    # without ever touching it. BSD find (macOS's /usr/bin/find) carries no
    # such shortcut and always stats, so the identical fixture that finds
    # here in one process EACCESes there, and the divergence reaches all
    # the way to node: the \$arg this runner handed it looked found, and
    # node then fails to actually open it, misreporting the runner's own
    # permission fault as node's "Could not find". Measured directly:
    # inside an ubuntu:latest container, as a non-root user, \`find
    # locked/ -type f -print\` on a \`chmod 600 locked\` directory prints
    # \`locked/a.test.mjs\` and exits 0 — strace shows find never calls
    # \`stat\`/\`lstat\` on that path at all, only \`getdents64\` on \`locked\`
    # itself, which the missing search bit does not gate.
    # \`-perm\` cannot be answered from a dirent — it needs the file's real
    # mode bits, which only \`stat\` carries — so adding it to the SAME
    # \`-type f\` test forces the very stat the shortcut above was skipping,
    # surfacing the same EACCES BSD find already hits (measured, same
    # container) and reaching the existing \`||\` below exactly as BSD's own
    # failure does. \`-400\` ("owner-read set"), not GNU's \`/444\`
    # ("any of owner/group/other read"): measured directly on this
    # machine, this BSD find rejects \`/444\` outright ("illegal mode
    # string") — the GNU any-bits spelling is not the portable one here,
    # \`-N\` ("these bits, at minimum") is. Owner-read is what every fixture
    # and every real worktree in this repo actually has: files this runner
    # discovers are created and chmod'd by the one user running it, never
    # handed over from another owner, so the narrower bit costs nothing a
    # real invocation would ever hit.
    # A second, distinct \`find\` invocation was tried here first, auditing
    # \`-type d ! -perm -u+x\` on its own — it works standalone, but this
    # arm's own stub-based tests (e.g. "an invalid UTF-8 byte in a
    # discovered path does not drop it") replace \`find\` on \$PATH with a
    # single canned script answering whatever it is asked, and a SECOND
    # invocation gets the identical canned output as the first, corrupting
    # a check that was never meant to see it. One call, on the existing
    # \`-type f\` term, is what stays inside every fixture's contract that
    # this runner calls \`find\` exactly once per directory argument.
    found=\$(find "\$findarg" -name node_modules -prune -o -type f -perm -400 -print) || { printf 'agent-test: cannot read every path under %s\n' "\$arg" >&2; exit 1; }
    # Byte semantics for the two tools that read find's output, because a
    # filename is bytes and neither tool is told which. Measured on macOS with
    # a name holding \377, under en_US.UTF-8: \`grep\` drops that line silently
    # (#582's own false-green shape — a green over a smaller suite). Measured
    # with \`sed\` fed that byte directly, BSD \`sed\` gives up on the whole
    # stream ("RE error: illegal byte sequence", exit 1) — but in THIS pipeline
    # grep's own drop reaches the byte first, so sed never sees it here and its
    # pin is defense in depth, not a live defect in this ordering. It stays: if
    # sed ever is reached, it empties \$files outright, which is worse than
    # grep's silent shrink. Under LC_ALL=C both pass every line through. GNU is
    # byte-oriented and already does, so this changes nothing on Linux — the
    # platform CI runs, which is why no behavioural test here can fail on CI.
    # (#600)
    # A per-command prefix, not \`export LC_ALL=C\` in this runner's prologue,
    # which is the form the six fleet scripts use. This runner \`exec\`s the
    # suite: an exported pin would reach node and every process the tests spawn,
    # so the fleet's OWN locale fixtures — which need a UTF-8 ambient locale to
    # discriminate — would go green with their scripts' pins deleted. The pin
    # belongs to these two commands, not to the suite they discover.
    files=\$(printf '%s\n' "\$found" | LC_ALL=C grep -E '$testfile_re' | LC_ALL=C sed 's/\[/[[]/g')
    # No \`set -e\` in this runner, and that is load-bearing: grep exits 1 on no
    # match, so under -e the shell would abort here and the refusal below would
    # never print. Read a status you care about explicitly, as find does above.
    [ -n "\$files" ] || { printf 'agent-test: no test files under %s\n' "\$arg" >&2; exit 1; }
    # Even where find now succeeds, node's own \`--test\` CLI still cannot
    # take what it just found: measured directly (node v26.8.1 here; CI's
    # .nvmrc pins v26.5.0), a relative file spec that starts with \`-\`
    # AFTER node's own internal normalisation is read as an unrecognised
    # option, not a path — true of every file find just printed under a
    # dash-led \$arg, whether or not it carries the \`./\` this arm routed
    # it through: node strips that prefix before making the judgment, so
    # \`node --test ./-dir/a.test.mjs\` still dies "bad option:
    # -dir/a.test.mjs", the same as the unprefixed form. Only an absolute
    # spelling escapes it, and rewriting every file this arm hands to node
    # into one is a far larger change than this bug — it would touch what
    # EVERY invocation passes through, not just a dash-led one.
    # So refuse rather than \`exec\`. Letting it through trades one
    # misdiagnosis for a worse one: node's own "bad option" prints as a
    # FAILING TEST — exit 1, a summary that reads like a suite ran and one
    # of its tests broke — for an argument this runner never got node to
    # attempt. Gated on \$files being non-empty (checked above): an empty
    # or genuinely unreadable dash-led directory keeps reporting that,
    # unchanged, since this hazard only exists for files this arm would
    # otherwise actually hand to node.
    case "\$arg" in
      -*) printf 'agent-test: %s holds tests, but node reads a relative dash-led path as an option, not a file — refusing rather than letting it run as a false failure\n' "\$arg" >&2; exit 1 ;;
    esac
    set -- "\$@" \$files
  else
    # find only ever sees what a directory argument expanded to; a bare file
    # or glob argument reaches here unchecked, and node decides on its own
    # whether to run it. The two disagree, and node's discard is silent
    # whenever anything else in argv resolves (#100) — so each one is
    # validated here before it can pass through, or refused loudly.
    #
    # The order below is the guard: existence is settled BEFORE an argument
    # is read as a glob, and vendoredness before either. Classifying first
    # let one property of a path defeat the check meant for another — a real
    # file whose name holds a \`[\` was read as a glob and passed through
    # unescaped, and a vendored path with a \`*\` in it skipped the vendored
    # refusal outright.
    #
    # One \`case\`, three arms. The two this replaces judged the same \$arg a
    # hundred lines apart and had to stay disjoint, with nothing but prose in
    # between saying so; every spelling now lands in exactly one arm by
    # construction (#1016). Each guard's own comment block moved with its code,
    # so the \`-P\` defence below still sits above the guard that omits it.
    case "\$arg" in
      # Absolute AND already naming a \`node_modules\` SEGMENT — the one shape
      # both guards below decline, so nothing judges it, deliberately. The
      # logical guard declines every ABSOLUTE spelling: node runs and counts
      # an absolute vendored path rather than dropping it, so there is no
      # silent drop to refuse (#401's ruling, measured on Node v26.5.0). The
      # physical guard declines every SEGMENT-naming spelling, because
      # re-judging one would overturn that ruling from a second place. This
      # arm is where the two declinations meet, and it is the merge that makes
      # it visible: before, the overlap was a gap between two \`case\`s.
      # Two alternatives because a \`case\` pattern cannot spell a conjunction:
      # an absolute path carrying the segment either opens with it or reaches
      # it later. The one-glob spelling (\`/*node_modules/*\`) is not the same
      # test — it drops the segment bound the other two arms carry, and
      # \`/x_node_modules/f\` is not vendored and must reach the physical guard.
      /node_modules/*|/*/node_modules/*) ;;
      # Vendored, on the argument's own spelling: node excludes an argv entry
      # when its NORMALIZED relative form starts with \`node_modules/\`, so
      # \`t/../node_modules/pkg/x.test.mjs\` is excluded too and a literal prefix
      # match misses it. A deeper segment (\`t/node_modules/pkg/x.test.mjs\`) and
      # an absolute path are NOT excluded — node runs both, and counts them, so
      # there is no silent drop to guard and the arm above keeps an absolute
      # spelling out of this one (measured, Node v26.5.0). Resolving the
      # argument's own directory is what separates those cases; \`cd\`/\`pwd\`
      # without \`-P\` is the logical form, the same textual resolution node
      # applies. \`..\` only ever removes segments, so an argument that does
      # not mention \`node_modules\` cannot normalize into one — the outer
      # pattern keeps the subshell off every other path. Passing an excluded
      # spelling through would be the same silent drop as the typo case below,
      # for a different reason.
      # \`-P\` here is not a hardening opportunity, and the omission is not an
      # oversight (#401). The ordinary npm/pnpm workspace shape is where the two
      # resolution modes diverge: \`node_modules/pkg\` is itself a symlink to a
      # sibling real directory (a hoisted or linked workspace package). Physical
      # resolution follows \`pkg\` OUT of \`node_modules\`, so the pattern below
      # stops matching, this guard falls through without refusing, and the
      # argument reaches node unrefused — where it is excluded anyway, on its
      # own unresolved spelling, silently, at exit 0. That reintroduces #100's
      # silent drop, minus the loud refusal this guard exists to give it first.
      # Bounded to a path SEGMENT, as the resolved arm below now is. No verdict
      # moves here — this arm's own test is already anchored at
      # \`"\$PWD"/node_modules/*\`, so a directory whose name merely ENDS in the
      # word (\`vendor_node_modules/\`) reached this arm and fell straight back
      # out of it. The bound is what keeps the three arms reading disjoint
      # arguments, which is the property the arm below rests on; the verdict it
      # changes is down there, where the same unbounded pattern was a skip.
      */node_modules/*|node_modules/*)
        # Unconditional, because the \`*/*\` test this used to make could not
        # lose: both alternatives of the arm above spell a literal \`/\`
        # (\`*/node_modules/*\` and \`node_modules/*\`), and a glob only matches
        # a string carrying every literal character in its pattern — so an
        # argument without a \`/\` never reaches here and the \`argdir="."\`
        # fallback was unreachable. Dropped rather than kept as cover (#1005).
        # The \`CDPATH= \` on the \`cd\` below is NOT part of that collapse and
        # must survive any further one: a bare \`cd\` lets an inherited CDPATH
        # resolve \$argdir into a same-named decoy, so the vendored match
        # misses, the guard falls through, and node drops the file silently at
        # exit 0 (41d7743, #401) — its own suite row pins that.
        argdir="\${arg%/*}"
        # \`cd\`'s own status used to be discarded outright (\`2>/dev/null\`,
        # nothing read from the pipeline afterwards), so an \$argdir that
        # EXISTS but has lost its own search bit (\`chmod 000\`) failed \`cd\`
        # exactly as a typo'd one does, fell through this \`case\` unrefused,
        # and reached the \`does not exist\` arm far below — a permission
        # fault reported as a spelling mistake. The directory branch's own
        # \$resolved fallback above already reads \`cd\`'s status for the same
        # fault one arm over, but only to keep a fallback path flowing into
        # the node_modules match — its own unreadable-\$arg case surfaces
        # later, off \`find\`'s failure far below, a different mechanism from
        # this branch's own immediate report. (#1006)
        # \`[ -d \$argdir ]\` is what keeps this from reporting a permission
        # fault it cannot actually back up, and the two fixtures that decide
        # it are not one and the same — measured, not assumed. \`stat\` on a
        # directory needs search only on ITS OWN PARENT, so \`chmod 000\` on
        # \$argdir itself still leaves \`-d\` true while \`cd\` fails: the
        # shape this guard exists for. \`chmod 000\` on \$argdir's PARENT
        # instead leaves \`-d\` false too, since resolving \$argdir at all now
        # needs the very search bit that was removed — so the term does not
        # fire there, and an argument this guard genuinely cannot vouch for
        # keeps falling through to whatever the missing-path arms below
        # already do with it, unchanged.
        argpwd=\$(CDPATH= cd -- "\$argdir" 2>/dev/null && pwd)
        if [ -z "\$argpwd" ] && [ -d "\$argdir" ]; then
          printf 'agent-test: cannot read %s — check its permissions\n' "\$argdir" >&2
          exit 1
        fi
        case "\$argpwd/" in
          "\$PWD"/node_modules/*)
            printf 'agent-test: %s is under node_modules — node discards it silently, not a test failure\n' "\$arg" >&2
            exit 1
            ;;
        esac
        ;;
      # Judged on the argument's RESOLVED path as well (#424) — #186's
      # directory-branch rule applied to the file arm. A symlink whose own name
      # carries no \`node_modules\` but whose target is vendored defeats every
      # term above, and node does not discard it: node RUNS it, so the suite's
      # result comes to hang on third-party code passing. That is #186's hazard,
      # not #100's, and it takes #186's remedy rather than another spelling.
      # Reached only where the spelling does not already name a \`node_modules\`
      # SEGMENT — the two arms above take every spelling that does.
      # Unbounded, that skip also swallowed a directory whose name merely ENDS in
      # the word: \`vendor_node_modules/link.test.mjs\` was handed to the guard
      # above as already-judged, and that guard's own test is anchored and never
      # fired — so a symlink under such a name to a vendored file was judged by
      # neither, and node ran it and counted it (measured). Every arm carries the
      # bound, so they still partition the arguments with nothing in the gap.
      # The arguments the arms above hold back are the logical guard's own input
      # — the deeper-segment and absolute spellings it deliberately lets through
      # because node runs and counts them included — and re-judging them here
      # would overturn that ruling from a second place. Disjointness is what lets
      # this check be physical while the one above stays logical (#401): the two
      # never see the same argument, so neither can undo the other's resolution
      # mode. As arms of one \`case\` that is structural — an argument matched
      # above cannot reach here at all — where two separate \`case\`s held it
      # only for as long as their pattern lists stayed in agreement (#1016).
      # \`realpath\` rather than \`cd\`+\`pwd -P\`: \`cd\` resolves symlinked
      # DIRECTORY components, but a symlink whose own target is a FILE is this
      # ticket's input and \`cd\` never reaches it. It also follows a chain of
      # them, and reports a cycle as a failure instead of looping.
      # Asked only of an argument that EXISTS, and that gate is what makes the
      # answer the same on both platforms: BSD \`realpath\` fails on a
      # nonexistent final component and GNU's succeeds on it, so one quoted glob
      # spelled through a symlinked vendored directory was refused on CI and run
      # green on macOS. Nothing absent can be vendored, so a glob and a typo keep
      # exactly today's treatment in the arms below — the typo refused as
      # missing, the glob handed to node unexpanded, this guard's documented
      # ceiling — which is what those arms depend on, now held by the \`-e\` test
      # rather than by a resolver that disagrees with itself. Refusing the glob
      # was never the design: GNU only reached that verdict by reading \`*\` as an
      # ordinary character, and it charged for it in the same breath by reporting
      # a typo under a vendored symlink as "not missing".
      # An argument that DOES exist is still judged before it is read as a glob,
      # which is the order the block above depends on: a real file whose name
      # holds a \`*\` still reaches this check, not the glob arm.
      # What is left is a path that IS there and still will not resolve, or no
      # \`realpath\` at all. Neither is a question this can answer, and the
      # unanswered one used to be silent — the guard disarmed whole, the vendored
      # file ran, the run exited 0, nothing on stderr. Die instead, as
      # release-ticket.sh's own \`cd\`+\`pwd -P\` does ("none is guaranteed to
      # exist"); dropping \`2>/dev/null\` puts \`realpath\`'s own reason on
      # stderr on the way out, where the discarded status never went.
      # Anchored at the divergence from the runner's own location, as the
      # directory branch is: a \`node_modules\` ABOVE the divergence is an
      # ancestor of the runner too and says nothing about the argument.
      # Matched absolutely instead, a worktree living under one refused
      # every file argument as vendored.
      # \$root is that location, derived once above the loop rather than a
      # second time here, and \`diverge\` is the walk down from it — the same
      # one the directory branch runs, over a resolution this branch derived
      # its own way. What is shared is the anchor and the walk, never the
      # resolution mode: that stays disjoint (#401, #424).
      *)
        if [ -e "\$arg" ]; then
          fresolved=\$(realpath -- "\$arg") || { printf 'agent-test: cannot resolve %s — refusing rather than running it unchecked\n' "\$arg" >&2; exit 1; }
          diverge "\$fresolved"
          case "\${fresolved#"\$shared"}" in
            */node_modules/*)
              printf 'agent-test: %s resolves to %s, inside node_modules — excluded from the run, not missing\n' "\$arg" "\$fresolved" >&2
              exit 1
              ;;
          esac
        fi
        ;;
    esac
    if [ -e "\$arg" ]; then
      operand=1
      # An existing path is a path, whatever characters it holds. Node globs
      # its own argv, where a literal \`[\` is a bracket expression that cannot
      # match itself — so the file matches nothing, node drops it, and mixed
      # with anything resolvable that drop is silent. Escaping it is what the
      # directory branch already does to find's output (\`sed 's/\[/[[]/g'\`);
      # a file named directly needs the same escape or #100's own bracketed
      # case survives the fix meant to close it.
      # Same failure the directory branch's own sed pin guards against (#600) —
      # but no grep runs ahead of this \$arg to drop the byte first, so this pin
      # is the only guard here, not defense in depth: sed emits nothing, \$arg
      # empties, and node runs one path fewer than it was given, silently
      # (#100's own drop).
      arg=\$(printf '%s\n' "\$arg" | LC_ALL=C sed 's/\[/[[]/g')
    else
      case "\$arg" in
        # Only node can judge its own flags. Read as paths, every documented
        # \`node --test\` flag (\`--test-name-pattern=x\`, \`--test-only\`,
        # \`--test-reporter=tap\`) and POSIX's own \`--\` refused as a missing
        # file. A typo'd flag stays loud: node rejects it itself.
        -*) ;;
        # Shell globbing is off (\`set -f\` above), so an argument like this
        # reached the shell unexpanded on purpose — the deliberately
        # supported quoted-glob form (\`./agent-test 't/*.test.mjs'\`). Only
        # node can expand it, so it passes through unvalidated. The residual:
        # a glob matching nothing and a typo holding a metacharacter are the
        # same string to this runner, so that one drop stays silent — node
        # does not report what it ran and this runner cannot expand the glob
        # to check. That is this guard's honest ceiling, not a gap in it.
        # An *existing* path is not part of it: it never reaches here.
        *[*?[]*) operand=1 ;;
        # [ -e ] above cannot tell "not there" from "could not look": stat()
        # answers the same false whether \$arg is genuinely absent or a
        # directory earlier in its path lacks the search bit needed to
        # resolve the rest — POSIX gives EACCES and ENOENT no separate
        # channel through \`[ -e ]\`, and the builtin keeps nothing past
        # that bare result. The directory branch above already answers the
        # identical fixture correctly one level up: \`agent-test t\` on a
        # \`t\` chmod'd 0600 names find's own Permission denied rather than
        # calling the suite missing; this file arm used to fall straight
        # through to the typo case below on the same fixture, naming a
        # permission fault as a spelling mistake.
        # \`[ -x \$fparent ]\` is what separates them, not \`cd\`'s own text:
        # measured inside an ubuntu:latest container running dash (the
        # shell ubuntu-latest's \`#!/bin/sh\` actually runs), \`cd\`'s
        # failure message is identical for both causes — "can't cd to sub"
        # whether \$fparent is unsearchable or does not exist at all — so
        # parsing it could not have told them apart. \`stat\` on a directory
        # needs a search bit on ITS OWN parent, not on itself, so \`[ -d ]\`
        # still answers true for a directory that exists but cannot be
        # entered; \`-x\` then asks the one question \`[ -e \$arg ]\` above
        # could not get past.
        # Checking \$fparent alone is not enough: an unsearchable GRANDparent
        # or higher ancestor (\`t/u/a.test.mjs\` with \`t\`, not \`u\`, chmod'd
        # 0600) leaves \`[ -d \$fparent ]\` itself false — resolving \`t/u\`
        # needs search on \`t\`, which is exactly the bit missing — so the
        # single-level check fell through to the same "does not exist"
        # misreport this whole guard exists to fix, one level further up.
        # The loop below walks from \$fparent toward the root, stopping at
        # the first ancestor that STATS at all (\`[ -d \$p ]\` true, which
        # needs search only on THAT ancestor's own parent) and reporting
        # unsearchable only if that one lacks \`-x\`. An ancestor closer to
        # the root than the block cannot be reached by the walk, but it
        # does not need to be: the first one the walk DOES reach is the one
        # blocking resolution of everything below it.
        # Bounded the same way the single-level check was: a chain that
        # never resolves any existing directory (\`nosuchdir/x.test.mjs\`,
        # walked up to a bare relative name with nothing left to check) is
        # the ordinary typo this arm already reported correctly, not a
        # permission fault — \`faultparent\` stays empty and the loop ends
        # having found nothing to blame.
        *)
          case "\$arg" in
            */*) fparent=\${arg%/*} ;;
            *) fparent=. ;;
          esac
          faultparent=
          p=\$fparent
          while [ -n "\$p" ]; do
            if [ -d "\$p" ]; then
              [ -x "\$p" ] || faultparent=\$p
              break
            fi
            case "\$p" in
              */*) p=\${p%/*} ;;
              *) p= ;;
            esac
          done
          if [ -n "\$faultparent" ]; then
            printf 'agent-test: cannot read %s — %s is not searchable, refusing rather than reporting it missing\n' "\$arg" "\$faultparent" >&2
          else
            printf 'agent-test: %s does not exist\n' "\$arg" >&2
          fi
          exit 1
          ;;
      esac
    fi
    set -- "\$@" "\$arg"
  fi
done
# Argv holding no path is what node answers with its own discovery, and that is
# the vacuous pass this runner exists to refuse — a path that does not exist and
# an underivable test command both refuse rather than guess. POSIX's \`--\` is
# refused by the same rule: it reaches the flag pass-through and is no more a
# path than a flag is.
# The quoted-glob arm is the one deliberate exemption, not an oversight, and
# this guard does not close it. The shell is not expanding that argument
# (\`set -f\` above), node is, and this runner never learns the match count: it
# hands argv to node through \`exec\`, which has no return path. So a glob
# matching nothing still classifies as an operand here, reaches node, and exits
# 0 having run nothing — measured. That is the ceiling the file branch already
# states above, and closing it would mean running node rather than \`exec\`ing
# it, so that it could read the summary back. Separate change.
[ -n "\$operand" ] || { printf "agent-test: no test file or directory in the arguments — refusing rather than falling through to node's own discovery\n" >&2; exit 1; }
SH
  fi

  cat >> "$runner" <<SH
exec $testcmd "\$@"
SH
  chmod +x "$runner"
  if [ "$writeonly" = false ]; then
    excl="$(git rev-parse --git-common-dir)/info/exclude"
    grep -qx agent-test "$excl" 2>/dev/null || echo "agent-test" >> "$excl"
    printf '    wrote %s and excluded it\n' "$runner" >&2
  else
    printf '    wrote %s\n' "$runner" >&2
  fi
  fi
fi

# The receipt is a CLAIM receipt — an issue, a branch, a worktree, an install.
# `--write-runner` created none of them, so printing one would report a claim
# that never happened, in the shape the ledger reads.
[ "$writeonly" = false ] || exit 0

# `$issue` is guarded above (`case … ''|*[!0-9]*|0?*`), but <slug> and <type> are
# not, and all four string fields derive from them — `$branch` is
# `$type/$issue-$slug`, `$wt` is `.worktrees/$issue-$slug`, `$runner` is
# `$wt/agent-test`. A quote in either argument emitted a payload no parser
# accepts, at exit 0 and — under `--apply` — after the worktree and the label
# already existed (#119). `$install` is chosen from this script's own case
# statement and cannot carry one; it is wrapped for uniformity, the same reason
# inflight.sh wraps `$pr`. The numeric fields stay unwrapped: `$issue` is a JSON
# number by the guard above, and the ports are arithmetic on it.
#
# Assigned before the printf, never inline in its argument list — a `$()` there
# sits outside this `|| die`, contributes an empty argument on failure, and
# printf still exits 0 with a malformed payload.
issue_branch=$(jstr "$branch") && issue_wt=$(jstr "$wt") \
  && issue_install=$(jstr "$install") && issue_runner=$(jstr "$runner") \
  || die "could not escape the receipt fields for #$issue"
printf '{"issue":%s,"branch":"%s","worktree":"%s","install":"%s","ports":{"postgres":%s,"ollama":%s},"runner":"%s","applied":%s}\n' \
  "$issue" "$issue_branch" "$issue_wt" "$issue_install" "$pg" "$ollama" "$issue_runner" "$apply"
