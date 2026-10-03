#!/bin/sh
# Claim a ticket: label it, create its worktree and branch, run the Recipe's
# Install step, and materialise the isolation runner.
#
# Dry-run by default; --apply mutates the tracker and the filesystem.
#
# The claim is branch `<type>/<issue>-<slug>` and worktree
# `.worktrees/<issue>-<slug>`. The fleet always calls it as
# `claim-ticket.sh <N> impl-<N> implementer` (run-team SKILL.md, **Claiming**),
# giving `implementer/<N>-impl-<N>` and `.worktrees/<N>-impl-<N>`, and releases
# with the same pair through release-ticket.sh. <slug> and <type> are
# free text — neither derived nor validated here — so a caller outside the fleet
# can pass its own shape, e.g. next-ticket's human-facing `fix/<N>-<slug>`.
#
# The Install step and the Test entrypoint are READ from the repository's
# proven Recipe cache through derive-testcmd.sh — never inferred, never
# defaulted: this script keeps no table of technologies. An Install
# step that modifies the tree in a throwaway worktree corrupts it for everyone
# (npm@11 pruning cross-platform @esbuild optional deps out of a lockfile broke
# CI and the Docker build), so a dirty tree after it is a refusal.
set -eu

# Directly below `set -eu`, not below a locale pin: this script has none, and
# the locale-pin test deliberately leaves it off its PINNED list (whether
# its generated runner needs one is not settled here). The siblings that DO
# carry a pin put this line under it instead, because that file's PROLOGUE
# regex admits only comments, blanks and `set -[eux]+` above the pin. Here
# there is no pin to sit under, so the only constraint left is the real one:
# above the first git call.
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
# GIT_WORK_TREE: it outranks `-C`, so the tree-mutation check below — `git -C
# "$wt" status --porcelain -uall`, the one thing standing between a wrong
# Install step and a worktree corrupted for everyone — reads the AMBIENT tree
# against $wt's index. Measured (against the lockfile-only form this check
# had before the Recipe cache) with an install that really does rewrite a tracked file
# in the fresh worktree: reported clean, rc 0, claim handed out, where the
# unpoisoned run refuses at exit 2.
unset GIT_DIR GIT_WORK_TREE

NAME=claim-ticket
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# The escaping helpers. json.sh's header holds the sourcing contract and
# the measurements behind it. This script uses exit 2 for every refusal and has
# no exit 1, so a bare 1 out of it is a code its caller has no reading for. The
# guard sits ahead of every mutation, so a missing library refuses before a
# worktree, a branch, a label or a runner exists.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to claim without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

# The worktree readers. worktree.sh's header holds the sourcing
# contract; the `[ -r ]` ahead of the `.` is load-bearing there, not decoration.
# Sourced for `gone()` alone — this script reads no listing.
wt_lib="$(dirname "$0")/worktree.sh"
[ -r "$wt_lib" ] || die "cannot read $wt_lib — refusing to claim without the worktree predicates"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=worktree.sh
. "$wt_lib" || die "$wt_lib failed to load"

[ $# -ge 3 ] && [ $# -le 4 ] || die "usage: claim-ticket.sh <issue> <slug> <type> [--apply]"
issue=$1
slug=$2
type=$3
# Exact match, and nothing else tolerated in the slot: an unknown flag is refused
# rather than demoted to a dry run. Measured on the unguarded script: `5 slug fix`
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

# A repository probe, and deliberately no more. The git-dir identity invariant
# release-ticket.sh and no-undo-audit.sh check (the git dir answering for $wt
# must belong to $wt) is not owed here: this script never asks git
# anything through a $wt it did not just create. The pair below establishes the
# path is absent, `git worktree add` then writes the .git and its admin dir
# itself, and the one later `git -C "$wt"` call (the tree-mutation check) runs
# against that fresh linkage, so there is no prior one to verify. The ambient
# GIT_DIR / GIT_WORK_TREE version of "which repo answered" is closed by the
# unset above.
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
# apart (worktree.sh holds the one definition), so the
# refusal below is the existing helper, not a new EACCES-aware stat.
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
# true of both.
if [ -e "$wt" ] || [ -L "$wt" ]; then
  die "$wt already exists — ticket may already be claimed"
elif ! gone "$PWD/$wt"; then
  die "could not establish whether $wt exists — an ancestor is unreadable, not searchable, or not a directory; refusing to claim a path nothing measured"
fi
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && die "branch $branch already exists"

# The worktree is built FROM origin/main, so it must resolve before anything is
# claimed. The lockfile probe the Recipe cache replaced read origin/main
# and refused on its absence as a side effect; reading the Recipe cache reads
# no ref at all, so the precondition is asked for directly — unasked, the
# DEFAULT dry run would report a ticket claimable that `git worktree add` then
# refuses under --apply, after the in-progress label is already on the issue.
# No `--quiet`: git's own reason for not resolving it reaches the terminal
# beside this refusal.
git rev-parse --verify "origin/main^{commit}" >/dev/null \
  || die "origin/main does not resolve to a commit — nothing to build the worktree from"

# The Recipe: its Install step and Test entrypoint, READ from the repository's
# Recipe cache by derive-testcmd.sh — the one reader, reused rather than
# reimplemented, so the claim and the review snapshot cannot disagree about
# the cache's shape or what makes it usable. Nothing here infers either
# command: an absent, unproven or unrunnable cache is derive-testcmd.sh's own
# refusal, passed through in its own words, which name the step that derives
# the Recipe.
#
# `2>&1` so the reason travels: the child refuses on its STDERR and `$(...)`
# captures stdout only, so without the merge `die` fires with an empty
# argument and prints the bare line `claim-ticket: `. It is safe on the success
# path only because derive-testcmd.sh writes nothing to stderr when it
# succeeds, even under an interpreter made deliberately chatty — a
# cross-file invariant, so derive-testcmd.sh's own tests pin it where the behaviour
# lives. The sibling is found beside this script (`dirname -- "$0"`), never on
# PATH, for the reason json.sh and worktree.sh are.
script_dir=$(dirname -- "$0")
# Held in one variable, not repeated as a literal at each die below — the two
# copies could drift apart, and derive-testcmd.sh already keeps its own
# version the same way (`$derive`).
rederive="the Recipe cache is invalid; run the Recipe derivation step (run-team phase 0, before the first claim) to re-derive it"
install=$("$script_dir/derive-testcmd.sh" . install 2>&1) || die "$install"
echo "    Install step → $install" >&2
testcmd=$("$script_dir/derive-testcmd.sh" . test 2>&1) || die "$testcmd"
echo "    test entrypoint → $testcmd" >&2

# The Test entrypoint is a shell COMMAND, not an argv: the runner hands it to
# `sh -c`, so a compound one (`cd sub && make test`) keeps its meaning, with the
# runner's own arguments appended as "$@". It reaches the runner's source
# single-quoted — each embedded `'` closed, escaped and reopened — so nothing
# in it expands at write time. `LC_ALL=C` so sed reads the command as bytes.
# Derived here, ahead of every mutation, so a failure refuses before
# the label.
quoted=$(printf '%s\n' "$testcmd" | LC_ALL=C sed "s/'/'\\\\''/g") \
  || die "could not quote the Test entrypoint for the runner"

pg=$((16000 + issue))
ollama=$((22000 + issue))
echo "    ports derive from the issue number: postgres=$pg ollama=$ollama" >&2

# Ports above are only ever exported into a FRESH runner this script writes
# (below): a tracked repo-local agent-test is left byte-identical, so
# it never carries them. Starts true and flips to false in that branch, so
# the receipt can report which happened instead of asserting exports that
# never reached the runner.
runner_ports_applied=true

# The stamp the runner carries. The runner is written once at claim time and
# never rewritten, so an old worktree can be sitting on a runner a later
# template fix never reached. This stamp does not detect or fix that — nothing
# reads it, nothing refuses on a mismatch — it only makes staleness legible:
# diff the stamp against a fresh `cksum` of this script to see if they match.
# It is a checksum of the WHOLE script, not of the emitted template, so it
# over-reports: any edit to this file moves it — a reworded die message, a
# comment — while the runner it produces stays byte-identical. It under-reports
# too, so the error is not one-way and a match does not mean fresh: the command
# the runner execs is the Recipe cache's Test entrypoint, which this checksum
# does not cover — two claims under one stamp exec different commands once the
# Recipe is re-derived between them. So what the stamp covers is
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
# tree-mutation guard uses, status then value. A `cksum` that exits 0 printing
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
  printf '      already present, a repo-local runner checked out with the worktree\n' >&2
else
  echo "\$ gh issue edit $issue --add-label in-progress" >&2
  gh issue edit "$issue" --add-label in-progress >/dev/null || die "could not label issue $issue"

  # `--no-track`: without it, `-b … origin/main` leaves $branch tracking
  # origin/main, so `@{u}` RESOLVES — to main. Every "did my push land?" check a
  # member might reach for (`git rev-parse HEAD @{u}`, `git status -sb`) then
  # answers a question about main and reads healthy no matter what the push did.
  # That is the sharp half, measured on two live worktrees. Under
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
  # `--no-track` is also why no branch delete uses `-d`: `-d` measures an
  # upstream-less branch against local HEAD, refusing a pristine claim behind
  # origin/main. release-ticket.sh's is `git update-ref -d` on a tip read once.
  printf '$ git worktree add --no-track %s -b %s origin/main\n' "$wt" "$branch" >&2
  git worktree add --no-track "$wt" -b "$branch" origin/main >/dev/null || die "worktree add failed"

  printf '$ (cd %s && %s)\n' "$wt" "$install" >&2
  # Through `sh -c`, as the runner runs the Test entrypoint: the Install step
  # is a shell command out of the cache, not an argv to split. 126 and 127 are
  # the shell's own "cannot execute" and "not found" — the Recipe failed to
  # RUN, which is what invalidates a cache — so they are named as
  # that; any other non-zero is the install itself failing, reported as such.
  irc=0
  (cd "$wt" && sh -c "$install" >/dev/null 2>&1) || irc=$?
  case $irc in
    0) ;;
    126|127) die "the Install step '$install' did not run in $wt (exit $irc: not executable or not found) — $rederive" ;;
    *) die "install failed in $wt (exit $irc)" ;;
  esac

  # The Install step must leave the tree exactly as `worktree add` checked it
  # out: the `installClean` proof the cache records, re-asserted on every
  # claim, over the WHOLE tree rather than a list of lockfile names — fleet-ctl
  # keeps no table of which files an install may touch. Non-empty
  # means the Recipe no longer holds, and the worktree is now corrupt for
  # everyone. Check git's exit status too: a failed status prints nothing,
  # which is byte-identical to "clean" and would let this guard pass without
  # having verified anything.
  #
  # That same guard does not cover the rc-0 form of the identical hole: delete
  # $wt's .git outright (or empty it into a directory, or leave a dangling
  # symlink) between the `worktree add` above and here, and `git -C` does not
  # fail — it walks UP to the enclosing repo and answers about THAT at rc 0,
  # which this check would read as an untouched tree it never actually
  # looked at. `-f`: `git worktree add` writes $wt's `.git` as a regular file,
  # so no healthy run trips this; reference shape and same reason as
  # release-ticket.sh's own linkage guard. `-x "$wt"` for the reason
  # reap.sh and worktree-audit.sh give their own copy: `-f` is equally false
  # for a `.git` that is absent and for one this process may not stat, and an
  # unsearchable $wt must not be reported as an absence nothing established.
  # Left ungated it ate the case before the `git -C` below could reach it —
  # measured: `.git` still sitting there while the run blamed its deletion.
  # Gated, git answers with its own denial through the elif, which is what
  # release-ticket.sh's tests already pin as the wording to prefer over one this
  # script invents.
  if [ -x "$wt" ] && [ ! -f "$wt/.git" ]; then
    die "$wt has no .git file — cannot verify the Install step left the tree clean"
  # No `2>&1` here, unlike the two captures above: those capture a refusal
  # REASON, this captures DATA that is then compared. The comment above
  # release-ticket.sh's own dirty-worktree status capture already states it
  # — folded-in stderr would be counted as a change. A git
  # that exits 0 still writes to stderr for a malformed `.gitattributes` line
  # or a chatty `core.fsmonitor`, and merged that chatter became the whole of
  # $dirty and refused a tree it had just verified as clean — after the
  # label, the branch and the worktree were already created. git's denial
  # reaches this terminal on its own, which is the "its own denial" the
  # paragraph above means; the die names the failure, not the reason.
  #
  # `-uall`: see reap.sh's branch sweep for the full explanation —
  # the untracked mode is CONFIG: an install that CREATES a file the tree does
  # not track or ignore (a lockfile it was never given) dirties the tree as
  # surely as one that rewrites a tracked file, and under
  # `status.showUntrackedFiles=no` it is invisible at rc 0 unless pinned. It
  # is also the form the deriving agent's own proof reads, so a Recipe proven
  # clean there reads clean here.
  elif ! dirty=$(git -C "$wt" status --porcelain -uall); then
    die "could not verify the tree state in $wt after the Install step"
  elif [ -n "$dirty" ]; then
    nl='
'
    die "the Install step '$install' changed the tree in $wt (first: ${dirty%%"$nl"*}) — $rederive"
  fi
  echo "    tree clean after the Install step" >&2

  # A runner is already there: the repo tracks its own `agent-test`, and `git
  # worktree add` checked it out with everything else — a repo-local runner,
  # the home for any convenience beyond "exec the Test entrypoint"
  # (this repository's own test-argument shim lives in one). Writing
  # over it is what must not happen: the file is TRACKED, so the write leaves a
  # modified tracked path, and `reap.sh` calls `git worktree remove` without
  # `--force` (its own comment: "refuses on modified and untracked files").
  # Every release of every claim would then strand on a file this script wrote
  # itself. On this path $runner is always the fresh worktree's own
  # `agent-test`, so existence IS trackedness: nothing else could have put a
  # file there between `worktree add` and here.
  if [ -e "$runner" ]; then
    runner_ports_applied=false
    printf '    %s already present — a repo-local runner, checked out with the worktree; left as is (its own script owns isolation — the ports below were not exported into it)\n' "$runner" >&2
  else
  # Isolation as a file, not a briefing. Env vars in a prompt were missed five
  # times in one run — including by an agent whose parent was briefed but did
  # not pass them down. Anyone who finds the worktree finds the runner. The
  # isolation triple is per claim and language-neutral; everything else is the
  # Test entrypoint's own business, so the runner is a thin exec of it.
  cat > "$runner" <<SH
#!/bin/sh
# agent-test template: $tmpl_stamp
export TEST_COMPOSE_PROJECT=ab-$issue TEST_POSTGRES_PORT=$pg TEST_OLLAMA_PORT=$ollama
exec sh -c '$quoted "\$@"' agent-test "\$@"
SH
  chmod +x "$runner"
  excl="$(git rev-parse --git-common-dir)/info/exclude"
  grep -qx agent-test "$excl" 2>/dev/null || echo "agent-test" >> "$excl"
  printf '    wrote %s and excluded it\n' "$runner" >&2
  fi
fi

# `$issue` is guarded above (`case … ''|*[!0-9]*|0?*`), but <slug> and <type> are
# not, and all four string fields derive from them — `$branch` is
# `$type/$issue-$slug`, `$wt` is `.worktrees/$issue-$slug`, `$runner` is
# `$wt/agent-test`. A quote in either argument emitted a payload no parser
# accepts, at exit 0 and — under `--apply` — after the worktree and the label
# already existed. `$install` is the Recipe cache's own string and can
# carry any byte a shell command can, a quote included; jstr is what keeps it a
# JSON string. The numeric fields stay unwrapped: `$issue` is a JSON
# number by the guard above, and the ports are arithmetic on it.
#
# Assigned before the printf, never inline in its argument list — a `$()` there
# sits outside this `|| die`, contributes an empty argument on failure, and
# printf still exits 0 with a malformed payload.
issue_branch=$(jstr "$branch") && issue_wt=$(jstr "$wt") \
  && issue_install=$(jstr "$install") && issue_runner=$(jstr "$runner") \
  || die "could not escape the receipt fields for #$issue"
# `null`, not the arithmetic object, when a tracked runner kept its own
# isolation and never received these exports — a receipt claiming ports were
# applied to a script that does not carry them would be false.
if [ "$runner_ports_applied" = true ]; then
  ports_json="{\"postgres\":$pg,\"ollama\":$ollama}"
else
  ports_json=null
fi
printf '{"issue":%s,"branch":"%s","worktree":"%s","install":"%s","ports":%s,"runner":"%s","applied":%s}\n' \
  "$issue" "$issue_branch" "$issue_wt" "$issue_install" "$ports_json" "$issue_runner" "$apply"
