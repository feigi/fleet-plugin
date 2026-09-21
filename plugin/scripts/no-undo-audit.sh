#!/bin/sh
# Is this worktree safe to rebase, and what would a careless resolution eat?
#
# A rebase resolved the wrong way silently reverts work already in main. It looks
# like an ordinary conflict resolution and passes CI, because the branch's own
# tests never covered what it undid.
#
# This REFUSES; it does not repair. Choosing the resolution is judgement and
# stays with the caller. Exit 0 safe, 1 refused, 2 unanswerable.
set -eu

# Byte semantics for every tool below, and not a stylistic pin. `tr` is
# locale-sensitive: under a UTF-8 locale BSD tr exits 1 on a byte that is not
# valid UTF-8, wherever in the line it sits. `tr` is not the only carrier, and
# the others are pickier: `sed` exits 1 emitting nothing at all, but only on
# some positions — measured under `LANG=en_US.UTF-8` with LC_ALL unset,
# `printf 'b\377ad.txt\n' | sed 's/^/x: /'` gives `sed: RE error: illegal byte
# sequence` at rc 1 while `printf 'bad\377path.txt\n' | sed 's/^/x: /'`
# renders it at rc 0, so a fixture proving sed immune proves only that its
# byte landed somewhere sed tolerates. `paste -sd, -` truncates its whole
# output at the byte while still exiting 0.
#
# `awk` is NOT immune, and reap.sh's own #614 fixture measured the earlier
# claim here false: it is byte-identical only when every rule matches at an
# ANCHOR before the bad byte, never needing to convert it — a rule that must
# SCAN PAST the byte to decide dies instead (BWK awk, macOS: rc 2, `towc:
# multibyte conversion failure`), and under `set -eu` that death aborts the
# whole script rather than mis-scoring one record. Reachable only from a
# fetched tree — a Linux- or latin-1-authored commit — since APFS refuses to
# hold the name locally. #582.
#
# What that cost was measured on the pipeline that used to split merge-tree's
# output: PIPESTATUS `1 0 0` — its first stage exiting 1 and truncating, the
# two behind it exiting 0 on the short input it handed them. The real status
# sat in a non-final slot, where `set -e` cannot see it and where no `|| die`
# was watching either, so a conflicting path carrying such a byte dropped every
# path after it and reported `atRisk: []` at exit 0: a FALSE SAFE from the one
# tool whose whole job is to say whether a rebase would eat a commit. That
# split is now a single byte-oriented reader whose status nothing discards
# (#583), so this pin is no longer the only thing standing between that byte
# and a false safe there. Nor is it anywhere else: the `sed` and `tr` below
# that render a path or git's own diagnostic to stderr used to take the audit
# down with them on that byte, at the exit status that means dirty, and since
# #1160 each renders through a guard (`render`, and the fold in the stash
# branch) whose failure cannot reach the verdict. What the pin still buys is
# those renders WORKING: unpinned, BSD sed exits emitting nothing and BSD tr
# exits truncating, so the operator loses the diagnostic while the payload and
# the exit status stay correct. That is now the whole cost of removing it here,
# and no-undo-audit.test.mjs' invalid-UTF-8 case is what measures it — grep
# this file for those renders; json.sh's escapers do not rely on this pin,
# pinning the locale on each call instead.
#
# Global rather than per-site, unlike inflight.sh's five: this script sorts
# nothing, folds no case, and uses a `[a-z]` range nowhere. It does hold ONE
# POSIX class — `${back%"${back##*[![:space:]]}"}`, where the worktree-linkage
# check trims `$gd/gitdir` — and that class IS locale-sensitive, measured: a
# trailing NBSP is stripped under `en_US.UTF-8` and kept under `C`. Neither
# locale can reach it here, because a `gitdir` file always ends `.git` and
# `$(cat …)` has already eaten the trailing newline, so the last non-space byte
# is always `t`. That one site is why this paragraph says "one, unreachable"
# where the five sibling scripts' copies say "none" — two of theirs now name a
# `*[!0-9]*` range instead, this one is the POSIX-class exception.
# locale-pin-prose.test.mjs holds all six inventories as lists and fails if the
# code drifts from them (#612); this paragraph is why the entry below exists.
# Non-ASCII paths are untouched either way:
# every scrub set below is \001-\037 and every byte of a multi-byte UTF-8
# sequence is >= \200.
export LC_ALL=C

# Below the locale pin, not above it with `set -eu`: `unset` touches no
# byte-sensitive tool, but locale-pin-prose.test.mjs treats ANY line here that
# is not a comment, a blank, or `set -[eux]+` as work the pin must sit above,
# and refuses on principle rather than on this line's own behaviour. Same
# placement, same reason, as release-ticket.sh's copy.
#
# The `--show-prefix` gate below is the guard against exactly this class —
# "can git operate here" is not "is this the tree it answers about" — and the
# environment walks straight past it. Both halves measured (#1020).
#
# GIT_WORK_TREE outranks `-C`, so `git -C "$wt" rev-parse --show-prefix`
# answers about the AMBIENT tree. When that tree is not an ancestor of the
# cwd, git returns an EMPTY prefix — which is the exact value the gate reads
# as "$wt IS the root" — and the `status --porcelain -uall` below then
# compares $wt's index against the ambient tree's files. Measured, with the
# ambient tree holding a copy of the branch's tracked content: a worktree
# carrying an uncommitted file comes back `clean: true` at rc 0, and the
# rebase this script gates is authorised over work that exists nowhere else.
# That is verbatim the failure the gate's own comment describes, reached
# through a door the gate cannot close.
#
# GIT_DIR reaches the linkage check instead: `$wt`'s healthy `.git` is
# compared against the ambient repository's worktree and blamed for the
# mismatch. Measured: exit 2 naming `$wt`'s `.git` as the fault, on a
# worktree whose linkage is perfect — a rebase blocked, and the operator sent
# to repair a file that was never broken.
unset GIT_DIR GIT_WORK_TREE

NAME=no-undo-audit
# `printf`, not `echo`: 11 of these messages interpolate `$wt`, a
# caller-supplied path, and this is the one place they all route through.
#
# `|| :` on the WRITE, not around the call: `die`'s whole job is to reach
# exit 2, and `set -e` reads the printf's status before `exit` is ever
# reached. With fd 2 closed that status is 1 — REFUSED on this script — so
# every unanswerable question blamed the worktree instead of saying it could
# not be answered (#1514, measured: a path that is not a worktree, `2>&-`,
# exit 1 where the contract says 2).
die() { ( trap '' PIPE; printf '%s: %s\n' "$NAME" "$1" >&2 ) || :; exit 2; }

# THE RULE FOR EVERY STDERR WRITE IN THIS SCRIPT, and why each one is
# guarded. Exit 0 is safe, 1 is refused, 2 is unanswerable, and a caller
# branches on which. A diagnostic answers nothing — it shows a human what the
# run already determined — so its write must not reach `set -e`, which ends
# the script on that write's own status. Both `printf` and `echo` exit 1 on a
# failed write, and 1 out of here is the dirty-worktree refusal: with fd 2
# closed, a clean tree came back "commit the worktree before rebasing", from
# the one tool whose job is to say whether a rebase would eat a commit.
# Measured before the fix — clean tree, stdout open, `2>&-`: exit 1 (#1514).
#
# The guard is centralized, never hand-appended per site: `die` and `render`
# carry it in a function body every caller inherits, and every other bare
# diagnostic below calls `emit()` (defined after `render`), which does the
# same — a future call site cannot add an unguarded `>&2` write without also
# adding a new function to sidestep it. `|| :` is the third piece of
# `render`'s guard, and it is what `emit()` carries on its own: these sites
# have nothing to fall back TO, the line that could not be written IS the
# message, so there is no second, shorter thing to say about it. `render`
# needs its extra piece because a dropped LIST reads as an empty one — a
# finding silently downgraded — while a dropped single line reads as nothing
# at all, and the payload on stdout still carries every finding.
#
# The guard goes on the write itself, never on the surrounding statement:
# most call sites sit in `if`/`elif` chains or in a function whose later
# lines must still run. It covers a write that FAILS, which is what a closed
# or full fd 2 produces. A SIGNAL is a different failure class: `printf` is a
# shell builtin, so its write to fd 2 runs IN THIS PROCESS rather than a
# forked child, and the default disposition of SIGPIPE is to kill whatever
# receives it — on the spot, mid-syscall, before the interpreter ever returns
# to evaluate the `||` that follows. `|| :` cannot catch a kill; it can only
# catch a status, and a killed process never produces one for this shell to
# read (#1571, measured: a reader that exits before the script finishes
# writing — not merely a closed fd — took the whole process out at 141,
# outside the script's own 0/1/2 contract).
#
# The fix is `( trap '' PIPE; write )`, not a script-wide `trap '' PIPE`.
# Ignoring the signal turns the write's own failure back into a status — the
# write's fd 2 syscall returns EPIPE instead of delivering a kill — which is
# exactly the shape `|| :` already exists to swallow, so the fix opens no new
# failure path; it only makes the existing one reachable from a signal too.
# Confined to a subshell rather than the whole process for two measured
# reasons. First, it must leave every pipeline inside this script exactly as
# exposed to SIGPIPE as it is today: `render`'s own pipe below already
# tolerates it correctly, because `sed` there is exec'd rather than built in,
# and a forked child's death by signal reaches `set -e` as an ordinary
# nonzero status — ignoring PIPE for the whole process would reach past that
# pipe into every subprocess this script forks, which this script has no way
# to audit is equally inert under it. Second: macOS's `/bin/sh` (bash 3.2.57)
# does not recover cleanly once a script-wide `trap '' PIPE` has absorbed one
# EPIPE on a builtin write — measured, a LATER command substitution came back
# holding an earlier diagnostic line instead of the command it actually ran.
# A trap set inside a subshell never outlives it: it is gone the instant that
# subshell exits, which is also the instant the write it guards finishes.

# Every operator-facing render that pipes a captured value through an external
# tool goes through here — bar the stash-diagnostic fold below, which folds
# rather than indents and carries the same guard inline — and the point of it
# is that a render CANNOT decide the verdict (#1160).
# Written bare — `printf '%s\n' "$v" | sed 's/^/    /' >&2` — the pipeline's
# status is sed's, `set -eu` takes it, and the script exits with it: on this
# script exit 1 is the dirty-worktree refusal, so a render fabricated that
# refusal over a worktree the run had already printed `clean` for, with the
# payload never emitted and nothing naming a cause. Reachable with no shim at
# all, on the byte and the position the header above measures: with the pin
# deleted, a conflicting path spelled `b\377ad.txt` gave
# `sed: RE error: illegal byte sequence`, nothing rendered, and exit 1 over a
# worktree the same run had just reported clean. Same shape as the
# `|| die`s further down, opposite resolution: those guard statements that
# ANSWER something and so must reach exit 2, this one guards statements that
# answer nothing and so must reach no exit at all.
#
# Three pieces, each covering what the others cannot. The first `||` keeps the
# verdict out of the render's hands. Its message keeps the failure out of
# silence — a bare `|| :` fixes the status and leaves a lost conflict list
# indistinguishable from an empty one, which is the same silent-failure class
# as the abort. The trailing `|| :` is for the render whose fallback ALSO
# fails, stderr itself being gone: an unguarded `||` branch is one more command
# whose status `set -e` reads, and it would abort for the reason this function
# exists to remove.
#
# `$1` lands in sed's REPLACEMENT text, where `&` and `\` are metacharacters.
# Every prefix passed below is a literal in this file and holds neither; a
# caller-derived prefix would have to be escaped first.
render() { # render <line-prefix> <text> <what-the-text-is>
  printf '%s\n' "$2" | sed "s/^/$1/" >&2 \
    || ( trap '' PIPE; printf '%s: could not render %s to stderr; the payload and the exit status stand\n' "$NAME" "$3" >&2 ) \
    || :
}

# Every plain diagnostic below writes one already-assembled line with no
# external pipeline to fail on its own account — unlike `render`, which pipes
# through `sed` and so needs its own fallback piece. Routed through one
# function rather than a `|| :` hand-appended at each call site, so a future
# site cannot add an unguarded write without also adding a new function to
# sidestep this one.
emit() { ( trap '' PIPE; printf '%s\n' "$1" >&2 ) || :; }


# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it; only what is true of THIS script is repeated here.
# Below `export LC_ALL=C` deliberately: locale-pin-prose.test.mjs allows only
# comments, blanks, a shebang or a `set -` line above that pin, and `json_lib=`
# is none of them.
#
# Exit 1 from this script is a verdict too: `REFUSED — commit the worktree
# before rebasing`. A library that merely went missing would report a dirty
# worktree without having looked at one, blocking a rebase that was safe to
# start, so `[ -r ]` has to fire before the `.` can kill the shell.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to act without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

# Every string that reaches the JSON goes through `jstr`/`jarr` from json.sh —
# `$wt` is argv and therefore a filesystem path, which may hold a `"`, a `\`
# or a control byte that git's ref rules would reject. The rule list, its
# ordering and the jarr/jstr split live in json.sh, once, rather than here and
# in inflight.sh and in release-ticket.sh — five copies of the same rules
# before the extraction, counting jarr and jarr_rewritten (#119).
#
# This script is the only caller that reaches the multi-line machinery: `$wt`
# is the one value here that can carry a newline, which is why json.sh's slurp
# is not dead code even though no other consumer can feed it one.
[ $# -eq 2 ] || die "usage: no-undo-audit.sh <worktree> <branch>"
wt=$1
branch=$2
base=${BASE_REF:-origin/main}
# Only a remote-tracking ref is accepted — the accept-list release-ticket.sh:229
# and reap.sh:156 carry, and the one this script had none of. worktree-audit.sh
# is NOT a precedent for it: that script still measures the bare shorthand
# (worktree-audit.sh:117 reads BASE_REF, :119 rev-parses `$base` and :211
# rev-lists it), so the fix is not yet applied there — #1329 is where that half
# is tracked, and it is closed with nothing in the tree to show for it. Being
# audit-only is what lets worktree-audit.sh wait — it only ever prints a
# report, while this script GATES something consequential: the comment below
# (see "the merge bot leans on this audit to authorize a REBASE") says a caller
# uses this audit's exit status to decide whether to replay unpushed work. A
# wrong BASE_REF here does not just make a report wrong, it can feed that
# decision a false "clean" — the blast radius release-ticket.sh restricted
# BASE_REF for, so this script restricts it too rather than leaving it as
# permissive as an audit-only reader could afford. The qualify step below
# unconditionally prepends `refs/remotes/` to whatever $base is, so a spelling
# that used to resolve fine before this fix — a bare `main`, a raw SHA, `HEAD`,
# `refs/heads/main` — would otherwise turn into a ref nothing asked to exist,
# and die below with a message that blames a guess for a qualification this
# script chose to make.
#
# The die names the two spellings the list takes rather than calling them "a
# remote-tracking ref", because the list is narrower than that phrase in one
# direction and wider in the other: `refs/remotes/upstream/main` is accepted
# and `upstream/main` is refused (both measured), so a second remote's
# shorthand would otherwise be refused for not being something it is.
case "$base" in
  origin/*|refs/remotes/*) ;;
  *) die "BASE_REF must be spelled origin/<branch> or refs/remotes/<path>, got '$base'";;
esac

# release-ticket.sh's SECOND guard — `*/"$branch") die` — is carried too, for
# the reason release-ticket.sh:233 gives and not reap.sh:161's reason for
# leaving it out. `origin/$branch` IS a remote-tracking ref, so the accept-list
# above passes it and nothing else here refuses it, and every measurement below
# then asks whether the branch conflicts with ITSELF: merge-tree reports no
# conflicting files, the at-risk list stays empty, and the audit prints
# `conflicts: []`, `atRisk: []` at exit 0 for a worktree whose branch really
# does add/add-conflict with the real origin/main. Measured on a bare-origin
# fixture: the same tree and the same commit report `conflicts: ["conflict.txt"]`
# with one at-risk main commit when BASE_REF is unset, and the empty pair above
# when it is `origin/<the audited branch>`. That is the false "clean" the
# comment above says must not reach a rebase decision. reap.sh can leave the
# guard out because its `fetch --prune` drops the stale refs that make the same
# spelling vacuous there; this script fetches nothing — the only fetch it names
# is the advice in the `$branch_rev does not resolve` die below.
case "$base" in
  */"$branch") die "BASE_REF must not name the audited branch, got '$base'";;
esac

# `origin/main` is a SHORTHAND, and git resolves a shorthand through its own
# disambiguation order (gitrevisions: refs/<name>, refs/tags/<name>,
# refs/heads/<name>, refs/remotes/<name>, …), in which refs/remotes/origin/
# main comes LAST. A local TAG or BRANCH literally named `origin/main`
# outranks the real remote-tracking branch, so every measurement against
# the bare shorthand below would answer about that ref's target instead — at
# rc 0, with git's own `warning: refname 'origin/main' is ambiguous.` on
# stderr as the only tell (measured), which this script reads nothing of and
# which an unattended caller has no one to read. The same class
# release-ticket.sh:243 and reap.sh:174 already found in the same default.
# Fix: qualify to the full refs/remotes/ path, where there is nothing left to
# disambiguate, unless it is already qualified. The accept-list above is
# what makes this qualify step safe rather than a guess — BASE_REF could
# otherwise name a tag, a SHA or a local branch, leaving no prefix that is
# always correct. `$base` itself stays unqualified in this script's `die`
# text, where the shorthand spelling is what an operator expects to read;
# where the two spellings can disagree the die names BOTH, so a refusal
# earned by `refs/remotes/<x>` is not read as a refusal about `<x>` — a
# local ref shadowing the shorthand makes "<x> does not resolve" false of
# the very spelling the operator typed. The trace lines below use
# `$base_rev` instead, because this script's own rule for those lines (see
# the `status --porcelain` trace above) is that they echo the command AS
# RUN, and the command that runs is against `$base_rev`.
case "$base" in
  refs/remotes/*) base_rev=$base;;
  *) base_rev="refs/remotes/$base";;
esac

# `$branch` is argv — the script's own second positional (`no-undo-audit.sh
# <worktree> <branch>`) — not an operator-typed ref spelling the way BASE_REF
# is. BASE_REF earned an accept-list before it earned a qualify step because
# qualifying an arbitrary spelling was a guess: a bare `main`, a SHA or `HEAD`
# all resolved fine unqualified, and prepending `refs/remotes/` to any of
# those would have manufactured a ref nothing asked for. `$branch` carries
# none of that ambiguity — every site below has only ever meant "the branch
# named `$branch` in the `origin` remote", so there is no second shape a
# caller could have meant and no guess an accept-list would be needed to make
# safe first. The qualify step is unconditional too, unlike base_rev's
# two-armed case: `$branch` is a bare short name off the usage line, never
# itself a `refs/remotes/...` path, so there is nothing already-qualified to
# detect.
branch_rev="refs/remotes/origin/$branch"

[ -d "$wt" ] || die "worktree $wt does not exist"
# "Can git operate here" is NOT "is this the tree it answers about", and only
# the second licenses the status below — every git command here walks UP,
# `status` included. Delete the worktree's `.git` and git resolves the ENCLOSING
# repo at rc 0, so a gate asking only the first waves the run through (a bare
# `rev-parse --git-dir` stood here and did exactly that); the status below then
# answers for that repo, and with a clean parent (`.worktrees/` gitignored, the
# fleet's own layout) the answer is EMPTY at rc 0 while the uncommitted work
# sits on disk. `clean` for a tree nothing looked at, out of a script whose
# whole job is gating an irreversible action. The `die` on a failing status
# cannot catch it: this failure is a SUCCESSFUL command answering about another
# repository.
#
# `--show-prefix` is where git states which tree it actually resolved: the path
# of the directory asked about, RELATIVE to that tree's root. Empty iff `$wt` IS
# the root, `.worktrees/9-x/` when git walked up. Ask git for the identity
# rather than infer it from what `.git` looks like on disk.
#
# Inferring from disk is one byte from a manufactured clean in every spelling:
# `-e "$wt/.git"` calls an EMPTY `.git` directory present; `-f "$wt/.git"` alone
# refuses every main checkout, whose `.git` is a DIRECTORY and which `$wt` may
# be, being any worktree the caller names; `-e "$wt/.git/HEAD"` calls a `.git`
# directory holding a lone HEAD present. git wants HEAD *and* `objects/` *and*
# `refs/` and walks up past anything less — including a REAL `.git` whose HEAD
# an interrupted write truncated (measured, git 2.50.1).
#
# The rc is captured, not swallowed: `--show-prefix` is empty both when `$wt` is
# the root and when the command FAILS, so `[ -z ]` over a swallowed failure
# would admit exactly what this refuses. Capturing it is also what retired the
# `--git-dir` gate rather than leaving it above: the two return the SAME rc on
# every shape (measured — plain directory, garbage `.git`, dangling symlink,
# unsearchable worktree all 128 for both; main checkout, linked worktree, bare
# repo, deleted/empty/lone-HEAD `.git` all 0), so keeping both left one gate
# that could never fire and an ordering dependency that did not exist.
#
# `--show-toplevel` compared against `$wt` is the spelling to avoid: it needs a
# string compare, and `$wt` arrives relative (claim-ticket.sh's
# `wt=".worktrees/$issue-$slug"`), through a
# symlink, or under a macOS tmpdir git reports back through `/private` — three
# false-refusal classes `--show-prefix` cannot have, comparing nothing. git's
# `prunable` is no use either: it marks a worktree whose DIRECTORY is gone, and
# stays silent for one still holding work whose linkage broke (measured).
prefix=$(git -C "$wt" rev-parse --show-prefix) \
  || die "$wt is not a git worktree"
[ -z "$prefix" ] \
  || die "git answers for the repo above $wt, not $wt — cannot tell a clean worktree from a dirty one"

# --show-prefix answers "is $wt the root git resolved" — for a `.git` FILE that
# is a question about the file's own LOCATION, since that is where git starts
# walking up from. It says nothing about "is the git-dir behind that file
# actually $wt's". A `.git` file rewritten to name a SIBLING worktree's admin
# dir still resolves its root to $wt (the file's location did not move) while
# every git command below — `status` included — answers against the sibling's
# HEAD and index. #189.
#
# So the second claim is asked separately: which git dir answered, and which
# worktree does THAT dir belong to. Never keyed on the string `--git-dir`
# returns without `--path-format=absolute`: that is the literal `.git` for a
# main checkout AND — measured, git 2.50.1 — for a LINKED worktree whose `.git`
# is a SYMLINK to another worktree's admin dir, so a guard exempting `.git` as
# "the main worktree, nothing to verify" exempts the #189 spoof spelled as a
# symlink instead of a `gitdir:` file. Absolute, and compared as paths: the one
# place in the script that compares paths, because unlike `--show-prefix` there
# is no rc/emptiness shortcut for "do these two name the same tree".
#
# `pwd -P` puts all three in ONE spelling. Only `$wt` needs it to be correct
# today: it arrives as the caller typed it — relative (claim-ticket.sh's
# `wt=".worktrees/$issue-$slug"`), or
# through a symlink — and never goes through git, while git's
# `--path-format=absolute` answers came back already resolved on every shape
# measured, symlinked `$wt` and symlinked `.git` included (measured: dropping
# `pwd -P` from `common` alone changes no verdict, git 2.50.1). It is on `$gd`
# and `common` as insurance, and the reason to apply that insurance to BOTH or
# neither is that a spelling difference between them is not a false refusal on
# one shape but on every main checkout. `--show-toplevel` remains the spelling
# to avoid, for the reason the comment above gives.
#
# `--git-common-dir` is what says which shape $gd is. A LINKED worktree gets
# its own per-worktree admin dir, so $gd differs from the common dir, and every
# such dir carries its OWN `gitdir` file, written by `git worktree add` and
# never touched by this script, pointing back at the worktree `.git` it belongs
# to. Resolved against the admin dir — git's own base for it, and git writes it
# RELATIVE, not absolute, whenever `worktree.useRelativePaths` is set — its
# directory must be $wt. Every other shape answers with the common dir itself:
# a main checkout, a submodule, a `--separate-git-dir` clone. There $gd IS the
# repo and has no back-pointer to read, so identity is where it sits — a git
# dir named `.git` belongs to its parent directory, and a `.git` redirected at
# the enclosing repo's own `.git` is caught by exactly that.
#
# Ceiling: a git dir that IS the common dir and is NOT named `.git` — a
# submodule's `.git/modules/<name>`, a `--separate-git-dir` target — records
# nothing naming its worktree (measured: no `gitdir`, no `core.worktree`), so
# there is nothing here to verify and the root claim above stands alone for it.
# Admitted rather than refused: git's own linkage for those is one-directional
# by construction, and refusing turned two healthy checkouts into "ask a human"
# for having no record to check. The residual is a `.git` redirected at a
# FOREIGN repo of that shape, which no `git worktree add` can produce.
# `core.worktree` redirection is not that residual and is not left open here:
# the `--show-prefix` claim above already refuses it (measured, #189).
#
# Both rev-parse calls keep a `|| die` the comment above says can never fire,
# for one reason the retired gate did not have: their job is to produce a path,
# not an rc. `set -e` does abort the script on a failed command substitution
# (measured: rc 128), so an unguarded one cannot reach the compare with an empty
# variable — but it would exit 128, and 128 is not one of the three verdicts
# this script's callers read. The `cd`/`pwd -P` lines below are left bare for
# the same measurement: unreachable, and `set -e` stops them regardless.
gd=$(git -C "$wt" rev-parse --path-format=absolute --git-dir) \
  || die "git will not name the git dir answering for $wt — cannot verify its linkage"
common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir) \
  || die "git will not name $wt's common git dir — cannot verify its linkage"
gd=$(cd "$gd" && pwd -P)
common=$(cd "$common" && pwd -P)
wt_real=$(cd "$wt" && pwd -P)
if [ "$gd" != "$common" ]; then
  back=$(cat "$gd/gitdir" 2>/dev/null) \
    || die "$gd/gitdir is missing or unreadable — cannot verify $wt's linkage"
  back=${back%"${back##*[![:space:]]}"}
  owner=$(cd "$gd" && cd "$(dirname "$back")" && pwd -P) \
    || die "$gd/gitdir names a directory that does not resolve — cannot verify $wt's linkage"
  [ "$owner" = "$wt_real" ] \
    || die "$wt's .git names another worktree's admin dir — cannot tell a clean worktree from a dirty one"
else
  owner=${gd%/.git}
  [ "$owner" = "$gd" ] || [ "$owner" = "$wt_real" ] \
    || die "$wt's .git names $gd, whose worktree is $owner, not $wt — cannot tell a clean worktree from a dirty one"
fi

git -C "$wt" rev-parse --verify "$base_rev" >/dev/null || die "$base does not resolve as $base_rev"
# Left unchecked, merge-tree below fails silently and "no conflicting files" is
# printed for a question that was never actually answered.
#
# The message names what the guard observed and then what to DO, and stops. It
# used to name CAUSES instead — a branch never pushed, a stale remote-tracking
# ref, a caller who already prefixed the name "origin/" — which it cannot tell
# apart, and neither can git: unsuppressed, rev-parse answers the constant
# "fatal: Needed a single revision" for every one of them. A fetch is the right
# next move whichever fired, so an action survives where the cause list could
# not. --verify stays: without it a name that matches a FILE resolves, prints
# the path and exits 0, and the guard passes something that is not a ref.
git -C "$wt" rev-parse --verify "$branch_rev" >/dev/null \
  || die "$branch_rev does not resolve — run 'git fetch origin' and retry"

# 1. Uncommitted work. This may exist nowhere else on disk. `|| true` here would
#    turn a failed `status` into empty output and print "clean" over a dirty
#    tree — and since the stash count stopped gating, nothing else would catch
#    it. Unanswerable is exit 2, never exit 0. Same rule as worktree-audit.sh.
# `printf`, not `echo`, here and at every other site carrying caller text.
# This script is `#!/bin/sh`, and both dash and macOS sh expand escapes in an
# `echo` OPERAND — `\c` truncates the line and swallows its newline, so the
# next stderr line collides with it. `$wt` is a caller-supplied path, so a
# worktree named `back\clue` does it with no corruption at all. Recognised:
# `\c \t \n \b \f \r \v \\ \0`; unknown ones like `\s` pass through, which is
# why a `back\slash` fixture reads as coverage and catches nothing.
#
# The other operands are safe by construction, not by luck: `$stash` is a
# digit count or the literal `null`, and git forbids a backslash in a refname
# (`check-ref-format` rejects it, `git branch` refuses to create it), so
# `$base`, `$branch` and `$fork` cannot carry one.
#
# `-uall`: #730 (see reap.sh's branch sweep for the full explanation) — a
# bare `--porcelain` reads clean over a dirty tree under
# `status.showUntrackedFiles = no`. Load-bearing here beyond a reap: the merge
# bot leans on this audit to authorize a REBASE, and the work a rebase
# replays over may exist nowhere else. The trace line below echoes the
# command as RUN, flag included, so a reader reproducing it by hand does not
# reproduce the unsound form.
emit "\$ git -C $wt status --porcelain -uall"
porcelain=$(git -C "$wt" status --porcelain -uall) \
  || die "git status failed in $wt — cannot tell a clean worktree from a dirty one"
if [ -n "$porcelain" ]; then
  clean=false
  render '    ' "$porcelain" "the uncommitted-work list"
else
  clean=true
  emit "    clean"
fi

# Repo-global across worktrees, and a rebase never consumes a pre-existing entry
# — `--autostash` stores its own on top, never takes yours. So the count says
# nothing about whether THIS rebase loses THIS branch's work. Reported, never
# gated: gating refused every run in a repo holding any entry, and a check that
# always fires is one nobody reads. Read the list when it is nonzero — an entry
# labelled `on <this branch>` may be a dead member's only copy.
#
# It cannot cover the hazard it looks like it covers, either. A member running
# `git stash` to clear a dirty worktree leaves `porcelain` empty, so `clean` is
# already true — and `-u` takes the untracked files too, so no case is left that
# this still refuses. Entries carry `WIP on <branch>`, so an old entry on
# ANOTHER branch is separable; a stale one on THIS branch is not, and telling it
# from the member's fresh entry needs a count the caller captured before the
# member ran. This script runs once, before the rebase, so it has no baseline.
#
# Never pop, drop or apply an entry this process did not create.
#
# The count above is only honest when the list can be trusted, and it cannot
# always be. `git stash list` prints nothing at rc 0 for a reflog this process
# cannot read (`chmod 000 .git/logs/refs/stash`), nothing at rc 1 for a stash
# ref whose object is gone (`fatal: bad object refs/stash`), and nothing at rc 0
# again for a `refs/stash` FILE this process cannot read (`chmod 000
# .git/refs/stash`) — all measured, and none distinguishable from a genuinely
# empty stash by the list alone, while `0` is the one value the runbook reads as
# nothing to look at.
#
# `show-ref` is the discriminator because its exit code separates "no such ref"
# from "could not read the ref". Measured, git 2.50.1:
#
#   state                | stash list   | show-ref | verdict
#   healthy, entries     | rc0 nonempty | rc0      | the count
#   genuinely empty      | rc0 empty    | rc1      | 0
#   unreadable reflog    | rc0 empty    | rc0      | unknown
#   stash object gone    | rc1 empty    | rc128    | unknown
#   unreadable ref file  | rc0 empty    | rc128    | unknown
#   malformed ref file   | rc0 empty    | rc128    | unknown
#   ref file DELETED     | rc0 empty    | rc1      | unknown  (reflog probe)
#
# The `malformed ref file` row is a fourth CAUSE, not a fourth signature:
# `printf 'not-a-sha' > .git/refs/stash` is indistinguishable from a `chmod
# 000` on the same file — same rc pair, same `show-ref` stderr, measured. So
# the line this branch prints names three causes for four, and `ls -l` on the
# two files, which is what the runbook sends the operator to read next, shows a
# healthy mode for that row. Widening either is #437, not this ticket.
#
# `rev-parse --verify --quiet` cannot do this job: it returns 1 for the
# unreadable ref FILE for the same reason the list is empty, collapsing that
# case onto the genuinely-empty branch and printing a confident `0` with a real
# entry on the stack. A plain exit-status guard on `stash list` cannot do it
# either, because neither reflog case fails.
#
# rc 1 says the REF is absent. It does not say the stash is empty, and the
# `ref file DELETED` row is the difference: `rm -f .git/refs/stash` leaves the
# reflog naming commits that are still reachable, and `show-ref` answers 1 for
# it exactly as it does for a repo that never stashed (#376). So rc 1 buys a
# second question rather than a verdict — is the reflog gone too? Only then is
# `0` a claim this can make. It composes with the discriminant above rather
# than replacing it: the three states that land on rc 0/128 never reach the
# probe.
#
# The probe can be this blunt because git empties the reflog whenever it empties
# the stack. `pop`, `drop`, `clear` and `update-ref -d` each REMOVE
# `logs/refs/stash` outright (measured, git 2.50.1) — there is no ordinary
# lifecycle that leaves it behind, so this cannot turn an honest `0` into
# `unknown`, which would be the worse bug: this line gates an irreversible
# action, and an operator who sees `unknown` on every run stops reading it.
# `-s`, not `-e`: a zero-byte reflog names nothing recoverable.
#
# `--git-path`, never `$wt/.git/logs/...`. The stack is repo-global, and `$wt`
# is routinely a LINKED worktree — the fleet's own layout — where `.git` is a
# FILE and that path reaches nothing, so a hand-built one reads "no reflog" and
# prints the confident `0` this exists to remove, in the layout that matters.
# `--git-path` is the right question rather than `--git-common-dir` joined by
# hand because git owns the per-worktree/common split: `logs/refs` is common,
# `logs/HEAD` and `logs/refs/bisect` are not, and that rule is git's to change.
# `--path-format=absolute` is load-bearing, not decoration: the bare answer is
# already absolute from a linked worktree but relative to `-C` from a main one,
# and this script runs from the CALLER's cwd, not `$wt`'s, so the relative form
# would look for the reflog under the caller and print the confident `0` this
# exists to remove. An unsearchable `logs/refs` DIRECTORY is no longer a
# ceiling here and never printed the `0` this once recorded: the path
# resolution needs search permission on every ancestor, so it fails before the
# `-s` stat, and it now answers unknown on its own line rather than refusing
# the whole audit (#570 — see the resolution below).
# `core.logAllRefUpdates=false` is NOT a second one: it suppresses the HEAD
# reflog, but `git stash push` force-creates `logs/refs/stash` regardless, so
# such a repo probes normally and reports `unknown` (measured, git 2.50.1).
#
# This does not close every unreadable reflog: one that is merely TRUNCATED —
# some entries lost, the rest still parses — resolves the ref and returns a
# nonempty list, so the cross-check sees no disagreement and reports the
# (too-low) count as exact. That gap is a remaining ceiling. #306's
# characterization test pins it without closing it — closing it was ruled out
# separately as not worth the complexity.
#
# A corrupt loose object behind a NON-TIP entry is one shape of that ceiling,
# and it is not one, because git is loud about it. The reflog there is
# intact, so `stash list` resolves the ref, prints the entries it could read,
# says `fatal: loose object ... is corrupt` and exits 1 — a nonempty list at a
# nonzero rc, a shape none of the rows above has, so `show-ref` agrees with the
# ref and the cross-check has nothing to disagree with. The rc is the only
# signal, which is why the list is captured rather than piped: `| wc -l` made
# this statement's status `wc`'s, always 0, and git's own rc unrecoverable.
# Nothing else moves — the count is still the lines the list printed, its stderr
# is still dropped here, and a list that succeeds is still read as a count. #482.
#
# Only the CORRUPT half of that shape is loud. A non-tip object that is MISSING
# rather than corrupt leaves the reflog intact too, but `stash list` then skips
# the entry it cannot read in silence: rc 0, no stderr, one line short
# (measured: three entries, `rm` the loose object behind `refs/stash@{2}` ->
# rc 0, two lines, empty stderr, git 2.50.1). Nothing here can tell that from a
# genuinely shorter stack, so it still reports the exact-looking count and stays
# under the #306 ceiling above.
sl_rc=0
sl=$(git -C "$wt" stash list 2>/dev/null) || sl_rc=$?
# `awk 'END{print NR}'`, not `wc -l`, and the difference is the empty stack.
# `$()` has stripped the trailing newline, so `wc -l` on the bare capture counts
# one short (measured: two entries, `printf '%s'`, `wc -l` -> 1), and padding it
# back with `printf '%s\n'` turns an EMPTY stack into a lone newline `wc -l`
# counts as one entry — two errors needing a `[ -z ]` guard between them. awk
# counts the final incomplete record, so one statement answers both ends
# (measured under `/bin/sh` with `set -eu`: "" -> 0, one/two/three entries with
# no trailing newline -> 1/2/3, and no padding to strip).
stash=$(printf '%s' "$sl" | awk 'END{print NR}') \
  || die "awk failed counting the stash entries — cannot report the stash count"
sr_rc=0
git -C "$wt" show-ref refs/stash >/dev/null 2>&1 || sr_rc=$?
# Resolved lazily, inside the one state that asks the question: a healthy repo
# with entries short-circuits on `$stash` and never pays for this call.
#
# It used to `|| die`, reasoning that `$wt` had already answered three
# `rev-parse` calls above so a failure here was the repo going away mid-run.
# Measurement falsified that: `--path-format=absolute` has to realify the path,
# which needs search permission on every ancestor, so an unsearchable
# `logs/refs` fails it with the repository entirely present — after the
# worktree status and those three resolutions have all succeeded on it. No
# stash history and no deleted ref are needed either, because this branch is
# what a repo that never stashed looks like. Refusing there withheld `clean`,
# `conflicts` and `atRisk` — the answers this script exists to give before an
# irreversible rebase — over a field its own line declares reported, not gated.
# A repo that really did go away still refuses, from the steps that need it:
# the status above and the merge-tree probe below each die on their own.
# `$stash_reflog_rc` rather than a bare empty `$stash_reflog`, because an empty
# path lands on `[ -s "" ]`, false, and prints the confident `0`; the state
# gets its own emission below instead of falling through to one. git's own
# `fatal:` naming the path and the errno is left on stderr, unwrapped, as the
# operator's whole lead on which directory to look at. #570.
stash_reflog=
stash_reflog_rc=0
if [ "$stash" = 0 ] && [ "$sr_rc" = 1 ]; then
  stash_reflog=$(git -C "$wt" rev-parse --path-format=absolute --git-path logs/refs/stash) \
    || stash_reflog_rc=$?
fi
# Two ways to the same answer, and each names its own state. The empty-list
# states are asked first and keep the sentence they already print, because a
# corrupt TIP object satisfies both tests (empty list, rc 1, `show-ref` rc 0)
# and `refs/stash` is what is wrong with it — the sentence below is about the
# ref, and it is the more specific of the two there. What is left for the rc is
# the state no cross-check can reach: git printed entries and then said it could
# not finish, so the ref resolves, nothing disagrees, and the number would be
# short by exactly the entries git refused to read (#482).
msg=
if [ "$stash" = 0 ] && [ "$sr_rc" -ne 1 ]; then
  msg="    stash entries (repo-global, not gated): unknown — the list came back empty but refs/stash is not absent (an unreadable ref or reflog, or a ref pointing at a missing object)"
elif [ "$sl_rc" -ne 0 ]; then
  msg="    stash entries (repo-global, not gated): unknown — the list call itself failed, so what it printed cannot be read as a count"
fi
if [ -n "$msg" ]; then
  stash=null
  # One of those causes is one git will name outright — the missing object,
  # where it says `fatal: bad object refs/stash` and the "refs/stash is not
  # absent" message degrades that into a guess across all four. So ask a second
  # time, on this branch only, and let git speak for itself. `stash list` is
  # silent in the other three (rc 0, no stderr — measured, git 2.50.1), so
  # `$diag` is empty there and the line comes out exactly as it did before.
  #
  # CEILING: git is not silent in two of those three — only `stash list` is.
  # `show-ref`, called above with its stderr thrown away, prints `fatal: git
  # show-ref: bad ref refs/stash (0000000000000000000000000000000000000000)`
  # for BOTH the unreadable and the malformed ref file: one canned line for two
  # causes, naming a null SHA that neither ref holds. It is silent only for the
  # unreadable reflog. Whether that wrong-but-specific line beats this
  # right-but-vague one is #481; this change captures `stash list` and nothing
  # else.
  #
  # The counting statement above takes git's exit code and nothing else, and
  # that is the whole of what it takes. Capturing its stderr THERE means
  # splitting stdout from stderr around one substitution, a temp file on every
  # run, and a rule for git writing to stderr while succeeding — paid on every
  # healthy audit to serve the one path that has already decided something is
  # wrong. Here the second call costs nothing: it runs only on a run that is
  # already reporting a fault, which now includes the run whose rc brought it
  # here. #304, #482.
  #
  # `2>&1 >/dev/null` in that order captures stderr and drops stdout — the list
  # itself is not wanted, it was already counted. `|| true` is load-bearing
  # under `set -e`: git exits 1 in exactly the state this exists for, and an
  # unguarded substitution would abort the audit before it emits a payload,
  # turning a report into a refusal.
  #
  # `tr` because `$diag` is not one line. A stash object that is CORRUPT
  # rather than missing (`echo junk > .git/objects/<xx>/<rest>`) reaches this
  # same branch — list empty at rc 1, show-ref rc 0 — and git says it in 7
  # lines, 10 with a bad `objects/info/alternates`. Unfolded they land at
  # column 0 in the audit's stderr, which is where only its own `$ git ...`
  # step headers belong. `$()` has already stripped the trailing newline, so
  # the fold adds no trailing space and the silent states still append nothing.
  #
  # `printf`, not `echo`: `$msg` now carries git's text under `#!/bin/sh`, and
  # both dash and macOS sh expand escapes in an `echo` operand — a `\c` in it
  # truncates the operator's line and swallows its newline. Reachable: with
  # `objects/info/alternates` holding a path containing a backslash, git prints
  # it back verbatim, `error: unable to normalize alternate object path:
  # /no\clue/objects`.
  #
  # The fold is guarded for the reason `render` at the top of this file is: it
  # decides nothing — `$stash` is already `null` and this branch already
  # reports a fault — while an unguarded `$( … | tr … )` inside an assignment
  # hands `set -eu` tr's own status, and 1 out of this script is the
  # dirty-worktree refusal. `tr` is the surer carrier of that abort than the
  # `sed` renders are, per the header's own measurement — it exits on the byte
  # wherever in the line it sits, where sed tolerates some positions. Losing
  # the fold is not losing the line — `$msg` already names the state, and the
  # fallback says which part went missing rather than printing git's text
  # truncated at the byte, which is what tr leaves behind on its way out.
  diag=$(git -C "$wt" stash list 2>&1 >/dev/null) || true
  if [ -n "$diag" ]; then
    flat=$(printf '%s' "$diag" | tr '\n' ' ') \
      || flat="(git said more, and folding it onto this line failed)"
    msg="$msg — $flat"
  fi
  emit "$msg"
elif [ "$stash_reflog_rc" -ne 0 ]; then
  stash=null
  # Its own sentence, and asked BEFORE the `-s` test the resolved path feeds:
  # `$stash_reflog` is empty here, `[ -s "" ]` is false, and the trailing
  # branch prints the confident `0` this exists to remove. It says only that
  # the reflog could not be reached. The `-s "$stash_reflog"` branch asserts
  # what the reflog CONTAINS — "still names entries no ref points at" — and
  # that is a claim about a file this state has not read; one sentence spanning
  # both states is the conflation the header rule forbids.
  emit "    stash entries (repo-global, not gated): unknown — the reflog path could not be resolved, so the reflog could not be read"
elif [ -s "$stash_reflog" ]; then
  stash=null
  # Its own sentence, not the one above: there `refs/stash` is present and
  # unreadable, here it is gone while its reflog is not, and the branch above
  # would tell the operator "refs/stash is not absent" about the one state
  # whose whole shape is that it IS — then send them to `ls -l` on a file that
  # no longer exists. No `$diag`: git is silent here, empty list at rc 0.
  emit "    stash entries (repo-global, not gated): unknown — refs/stash is absent but its reflog is not, and still names entries no ref points at"
else
  emit "    stash entries (repo-global, not gated): $stash"
fi

# 2. Which files would conflict.
#
#    `-z` is load-bearing twice. It turns OFF git's C-quoting, so a path holding
#    a `"` arrives verbatim instead of as the rendering
#    `"has\"quote and space.txt"` — which is neither a pathspec git will match
#    nor a JSON string, and which used to reach both the caller and the `git
#    log` below. A space alone git does NOT quote, so that half of the fixture
#    was broken by the word-split at step 3 and by nothing here; `-z` earns its
#    place on `"`, `\` and the control bytes. And it separates records with NUL,
#    the one byte a filename cannot contain. NUL does not survive a command
#    substitution, so this lands in a file rather than a variable.
#
#    merge-tree exits 0 clean, 1 conflicts found, >=2 on gross failure. Exit 1
#    is NOT only "ran fine, found conflicts": git 2.50.1 spends it on
#    `not something we can merge` too, which is where a BASE_REF naming a tag
#    that dereferences to a blob lands — that tag satisfies the `rev-parse
#    --verify` guard above, so it gets this far. The exit code cannot carry the
#    distinction alone. Every run that ran at all prints the tree OID first, so
#    empty output is the outcome the exit code will not name; it used to be
#    read as "no conflicting files" and reported safe, which is exactly the
#    branch-that-never-resolved case this step exists to catch.
mt_out=$(mktemp) || die "cannot create a temporary file"
# Armed before the SECOND `mktemp` rather than after it, because a `die` between
# the two would otherwise run with no trap installed and leave the first
# temporary on disk. `ps_out` is emptied first so the trap body is legal under
# `set -u` while it names a variable the run has not reached yet; `rm -f ""` is
# a no-op, so the trap is correct in both windows.
ps_out=
trap 'rm -f "$mt_out" "$ps_out"' EXIT
# The at-risk step's pathspec list, written by the same reader that answers the
# conflicts question below. NUL-separated, so it cannot travel in a variable;
# `mktemp` rather than a name derived from `$mt_out`, so a shared TMPDIR offers
# no predictable name to plant a symlink on.
ps_out=$(mktemp) || die "cannot create a temporary file"
emit "\$ git merge-tree --write-tree --name-only -z $base_rev $branch_rev"
mt_rc=0
git -C "$wt" merge-tree --write-tree --name-only -z "$base_rev" "$branch_rev" >"$mt_out" || mt_rc=$?
[ "$mt_rc" -le 1 ] && [ -s "$mt_out" ] \
  || die "git merge-tree could not answer (exit $mt_rc) against origin/$branch — cannot determine conflicts"
# This die does not gain `$branch_rev` the way the rev-parse guard above and
# the merge-base die below do: by the time it can fire, both `$base_rev` and
# `$branch_rev` have already survived their own `rev-parse --verify`, so a
# merge-tree failure here is not a spelling question either of those dies
# could get wrong.

# --name-only output is: tree OID, then (if conflicted) the conflicted-file
# list, then an EMPTY record, then prose ("Auto-merging ...", "CONFLICT ...").
# Only the section before that empty record is filenames — the old
# `tail -n +2` grabbed the prose section too and word-split it into the
# `git log -- $conflicts` pathspec below.
#
# Read by one NUL-capable reader rather than a `tr | tr | awk` pipeline, and
# the reason is the exit status, not the parse. A POSIX pipeline's status is its
# LAST command's, so a fault in any earlier stage is invisible to `set -e` and
# to a trailing `|| die` alike: the stage yields short output, the pipeline
# exits 0, and this script reports a SMALLER conflicts list with full
# confidence — the false safe the prologue describes, and precisely the outcome
# the standard below says must be exit 2 instead. `export LC_ALL=C` answers the
# one byte that was measured getting in; it cannot make a status readable, and
# any other fault in a prefix stage reproduces the under-report. #583.
#
# `set -o pipefail` is NOT the alternative, and not merely because POSIX sh
# lacks it (dash rejects `set -o pipefail` outright). Measured: a healthy
# conflicted run already ends with the prefix stages killed by SIGPIPE —
# `pipestatus 141 141 0 0` on a run whose answer is entirely CORRECT — because
# the reader stops at the empty record BY DESIGN and leaves merge-tree's prose
# tail unread, and once that tail outgrows a pipe buffer whatever is upstream is
# still writing when the reader goes away. `pipefail` would turn every such run
# into a refusal, which is a worse failure than the one it fixes. The control
# for that is a test rather than this paragraph: no-undo-audit.test.mjs builds a
# run whose unread tail outgrows a pipe buffer and requires a full answer.
#
# One reader answers both questions, so there is nothing left to discard a
# status. stdout carries the paths for the payload, a literal NEWLINE in a
# filename parked on \001 — a shell variable cannot hold NUL, and macOS awk
# 20200816 reads RS="\0" as RS="" and silently switches to paragraph mode, so
# an unparked newline manufactured the empty record that ends the section and
# `conflicts` came back short or empty while the audit exited 0. `$ps_out` gets
# the same paths NUL-separated and `:(literal)`-prefixed, which is what the
# at-risk step feeds to xargs. The reader works in bytes end to end (`rb`,
# `stdout.buffer`), so no path is decoded and none can be rejected for its
# bytes; the locale cannot reach it.
conflicts=$(python3 -c '
import sys
recs = open(sys.argv[1], "rb").read().split(b"\0")
paths = []
for r in recs[1:]:
    if not r:
        break
    paths.append(r)
with open(sys.argv[2], "wb") as f:
    f.write(b"".join(b":(literal)" + p + b"\0" for p in paths))
sys.stdout.buffer.write(b"\n".join(p.replace(b"\n", b"\x01") for p in paths))
' "$mt_out" "$ps_out") \
  || die "could not read git merge-tree's output (python3) — cannot determine conflicts"
# Unanswerable is exit 2, and worse than what this replaced: git C-quoted such a
# path, which at least emitted JSON the caller choked on. ponytail: refusing,
# not answering. `$ps_out` already carries the newline-holding path unparked, so
# the at-risk half could answer for it; `conflicts[]` cannot, because it reaches
# the payload through a shell variable and NUL is the one byte that cannot
# travel there. Answering both halves means keeping the payload side in a file
# too. Bought for a shape nobody has produced — upgrade there if one turns up.
nl=$(printf '\001')
case "$conflicts" in
  *"$nl"*) die "a conflicting path contains a newline — cannot build a pathspec for it" ;;
esac
if [ -n "$conflicts" ]; then
  render '    conflict: ' "$conflicts" "the conflicting-path list"
else
  emit "    no conflicting files"
fi
# `jarr`/`jarr_rewritten` return non-zero when a stage fails (#119), and a bare
# `var=$(pipeline)` under `set -eu` would abort with the failing tool's own
# status — 1 out of THIS script is the dirty-worktree refusal, fabricated here
# on a worktree already measured clean, with no payload and nothing on stderr.
# The `|| die` converts it to the exit 2 this script's contract reserves for a
# question it could not answer.
conflicts_json=$(printf '%s' "$conflicts" | jarr) \
  && conflicts_rewritten_json=$(printf '%s' "$conflicts" | jarr_rewritten) \
  || die "could not escape the conflicting paths for $branch"

# 3. What main gained in those files since the fork. These are the commits a
#    careless resolution deletes — read them before resolving, not after.
at_risk=""
if [ -n "$conflicts" ]; then
  fork=$(git -C "$wt" merge-base "$base_rev" "$branch_rev") \
    || die "git merge-base failed for $base ($base_rev) and $branch_rev — cannot tell what a resolution would eat"
  emit "\$ git log --oneline $fork..$base_rev -- <conflicting files>"
  # One pathspec per argument. Word-splitting `$conflicts` turned a path with a
  # space into two pathspecs that match nothing, and `git log` spends exit 0 on
  # a pathspec that matches nothing — so `2>/dev/null || true` was not even what
  # hid it. There was no error to swallow and no output to lose: the answer came
  # back empty on a branch that really was about to eat a commit. The swallow
  # goes anyway, because a `git log` that genuinely fails leaves the same empty
  # answer, and that one is unanswerable rather than safe.
  #
  # `:(literal)` because `--` ends the OPTIONS, not the magic: a real file named
  # `:colon.txt` is read as a pathspec expression and silently matches nothing,
  # which is the same false safe by a different byte. It is reachable: `git add
  # -A` and `git add .` track such a file happily, because the name never
  # appears as a pathspec there. Naming it as one is what fails — so
  # `git add -- :colon.txt` erroring is not evidence this guard is dead weight.
  #
  # The pathspec list arrives NUL-separated in `$ps_out`, written by the reader
  # that produced `$conflicts`, so this is a single command and not a pipeline:
  # nothing sits ahead of it with a status to discard. It used to be
  # `printf | sed | tr | xargs`, where the `|| die` could only ever answer for
  # the last of the four and a fault in any of the other three under-reported
  # `at_risk` at exit 0. #583.
  at_risk=$(xargs -0 git -C "$wt" log --oneline "$fork".."$base_rev" -- <"$ps_out") \
    || die "listing commits for the conflicting paths failed (git log or xargs) — cannot tell what a resolution would eat"
  # Above ARG_MAX (1048576 on macOS) xargs splits the pathspec list across
  # more than one `git log` invocation, and each invocation reports every
  # commit touching ITS OWN batch — so a commit whose changes span more than
  # one batch is printed once per batch it lands in. Deduped on the abbreviated
  # SHA, `--oneline`'s first field, keeping each commit's FIRST occurrence; a
  # no-op when xargs did not split. Only the SET is claimed. The order that
  # survives is the order the batches came back in, which once xargs has split
  # is PATHSPEC order, not `git log`'s reverse-chronological one — an older
  # commit can be listed above a newer, and nothing marks which case you are
  # reading. Left that way deliberately: re-sorting costs a second `git log`
  # to buy a ranking this audit does not offer, since it names the commits a
  # resolution would eat rather than ordering them.
  # Kept as its own statement rather than piped onto the xargs/git-log command
  # that produced $at_risk: piped, `awk` would become that pipeline's LAST
  # command, and with no `pipefail` in POSIX sh (dash rejects `set -o pipefail`
  # outright) its `|| die` would read awk's exit status, not git log's —
  # silently swallowing a real git-log failure behind a trivially-successful
  # awk pass on whatever partial output preceded it. A fresh statement over the
  # already-captured string leaves the xargs/git-log `|| die` reading xargs,
  # which is what its own message names.
  at_risk=$(printf '%s\n' "$at_risk" | awk '!seen[$1]++') \
    || die "awk failed deduplicating the at-risk commits — cannot tell what a resolution would eat"
  # An `if`, not `[ -n "$at_risk" ] && render …`: an empty at-risk list is a
  # normal outcome, and as the non-last member of an AND-OR list its false
  # test left that list exiting 1 — silent under `set -e` only because -e
  # skips every member but the last. The guard inside `render` cannot reach
  # that status, so the shape stays out of the way of it entirely.
  if [ -n "$at_risk" ]; then
    render '    at risk: ' "$at_risk" "the at-risk commit list"
  fi
fi
# Same guard, same reason as the conflicts pair above.
at_risk_json=$(printf '%s' "$at_risk" | jarr) \
  && at_risk_rewritten_json=$(printf '%s' "$at_risk" | jarr_rewritten) \
  || die "could not escape the at-risk commits for $branch"

if [ "$clean" = true ]; then
  rc=0
else
  rc=1
  emit "$NAME: REFUSED — commit the worktree before rebasing. Never \`git clean\`,"
  emit "  \`git checkout .\`, \`git reset --hard\` or \`git stash\` to make a rebase start."
fi

# `$wt` is a filename, so it admits both `"` and `\`; git accepts `"` in a ref
# name, so `$branch` admits one too. `$clean` and `$stash` are this script's own
# boolean and a digit count (or the literal `null` when the count is unknown),
# and the four arrays arrive escaped already.
# `*Rewritten` says which of the paired values lost bytes to the space-scrub
# above and so is not safe to treat as the real path or ref — most concretely,
# not safe to hand to `git diff -- <path>` in the no-undo-audit runbook step.
# A `$(...)` in printf's ARGUMENT list sits outside the `|| die` on the printf
# itself: a substitution that fails contributes an EMPTY argument and printf
# still exits 0 — and an unquoted `%s` slot then emits `"...Rewritten":,`,
# malformed JSON at exit 0, which is the failure the receipt exists to rule
# out. Assigned first, each one is a simple command whose status `add_field`
# can read.
#
# `die` is NOT the answer here (#431), unlike the conflicts and at-risk escapes
# above, and the difference is which kind of value each renders. Those two are
# FINDINGS — the operator can obtain them nowhere else, and step 5 of the
# no-undo runbook hands `conflicts[]` straight to `git diff -- <path>`, where an
# absent list reads as "nothing to prove" rather than "unproven". A run that
# cannot render them has not answered, so they still abandon the run.
#
# `worktree` and `branch` are the other kind: echoes of argv the caller supplied
# and still holds. By the time this block runs `clean` has been measured,
# `stash` counted, and both arrays already rendered — so every field this
# payload carries is established, and a formatter breaking HERE would convert a
# finished audit into "unanswerable" over the formatting of two values the
# caller typed. Each renders independently and reports JSON `null` when it
# cannot, which is what #120 shipped for this same class in inflight.sh. Not a
# quieter `""`: a field that could not be escaped has no usable path to hand to
# `git diff` in any case, and `""` is indistinguishable from a path.
#
# The message names the escaper as well as the field, because the two fail
# independently — `jstr` can render a string perfectly while `jrewritten` cannot
# say whether any byte was replaced (break `tr -d` alone and that is exactly
# what happens). Naming only the field sends a debugger to whichever it guesses.
# `printf`, not `echo`: `$branch` is caller text like every other site here.
#
# Accumulated into one string rather than four named variables, the shape
# `inflight.sh`'s `add_evidence` already uses, so each field name is spelled
# once instead of three times. The trailing comma is kept rather than trimmed —
# `"clean"` follows immediately — and the slot carrying it is an unquoted `%s`
# because each value arrives already wrapped in its own quotes or as the bare
# word `null`, so the format string must not wrap it again. $ev/$rw/$why are
# scratch: not `local`, which /bin/sh has no builtin for, and nothing reads them
# outside this function.
fields=""
add_field() {
  why=""
  if ! ev=$(jstr "$2"); then
    why=jstr
  elif ! rw=$(jrewritten "$2"); then
    why=jrewritten
  else
    ev="\"$ev\""
  fi
  if [ -n "$why" ]; then
    ev=null
    rw=null
    emit "$NAME: could not render the $1 for $branch as JSON ($why) — reported as null"
  fi
  fields="${fields}\"$1\":$ev,\"$1Rewritten\":$rw,"
}
add_field worktree "$wt"
add_field branch "$branch"
printf '{%s"clean":%s,"stash":%s,"conflicts":[%s],"conflictsRewritten":[%s],"atRisk":[%s],"atRiskRewritten":[%s]}\n' \
  "$fields" "$clean" "$stash" \
  "$conflicts_json" "$conflicts_rewritten_json" "$at_risk_json" "$at_risk_rewritten_json" \
  || die "could not write the audit for $branch"
exit "$rc"
