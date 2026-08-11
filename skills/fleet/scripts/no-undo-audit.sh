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

NAME=no-undo-audit
die() { echo "$NAME: $1" >&2; exit 2; }

# JSON string escaping. Same helper and same pipeline as release-ticket.sh's
# `jstr` — backslashes BEFORE quotes, because escaping the quote first turns the
# backslash that escape just introduced into `\\` on the second pass. The five
# C0 bytes RFC 8259 gives a two-character short form — \010 \011 \012 \014 \015
# (\b \t \n \f \r) — get the same treatment, in the same order, for the same
# reason: each rule that introduces a backslash has to run after the one
# escaping backslash itself, or its own backslash gets doubled right back. BS
# and FF are matched as a literal byte spelled with `printf`, never as `\b` or
# `\f`. Neither spelling matches \010, and neither fails quietly: `\b` in a BRE
# is a zero-width word BOUNDARY to GNU sed and a literal `b` to BSD sed, so the
# rule would insert `\b` at every word edge on one and mangle every letter `b`
# on the other (measured, GNU sed 4.9 and macOS sed). \177 (DEL) is not a C0
# byte and JSON permits it unescaped, so — unlike every version of this helper
# before #146 — it is left alone. Every remaining byte below \040 has no JSON
# short form, \013 (VT) included — RFC 8259 lists exactly the five above and
# `\v` is not among them; tr turns it into a space, and jrewritten (below) is
# how a caller finds out that happened, since a replaced value is not the
# original bytes and must not be treated as a real path or ref. Byte-safe for
# the UTF-8 in these strings, whose bytes are all >= \200. tr pads the
# replacement with its last character. (No line number: the same citation
# named a line that had not been written yet, and #129 tracks four more that
# drifted.)
#
# `:a;$!N;$!ba` slurps the whole value into one pattern space before any rule
# runs, so a literal newline in $1 is data the LF rule can reach rather than a
# line break sed's own per-line cycling would otherwise swallow. Guarding `N`
# with `$!` matters on its own: unguarded, BSD sed's `N` on the last line hits
# EOF with nothing to append and discards the pattern space instead of printing
# it — POSIX leaves this undefined and GNU sed's answer differs — so plain
# `N;$!ba` prints nothing at all for a single-line value (measured, both sit
# behind the *same* three -e flags either way).
jstr() {
  printf '%s' "$1" \
    | sed -e ':a' -e '$!N' -e '$!ba' \
        -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        -e "s/$(printf '\010')/\\\\b/g" -e 's/\t/\\t/g' -e 's/\n/\\n/g' \
        -e "s/$(printf '\014')/\\\\f/g" -e 's/\r/\\r/g' \
    | tr '\001-\007\013\016-\037' ' '
}

# True iff $1 held a byte jstr/jarr had to replace rather than escape — every
# C0 byte except \010 \011 \012 \014 \015 (BS, tab, LF, FF, CR: escaped above,
# never replaced) and \177 (DEL: preserved, never replaced). `$()` strips
# trailing newlines off both sides, and \012 is the one byte it strips: it is
# not in the delete set, so the same suffix comes off `raw` and `orig` and the
# strip can neither manufacture a difference nor hide one. An `X` sentinel
# appended to both sides stood here for that job and did nothing — measured
# across every arrangement of these bytes, it changed no answer — and the
# sentence defending it named a trap a trailing `\r` cannot spring, `\r` being
# neither stripped by `$()` nor deleted by tr. Both are gone.
jrewritten() {
  raw=$(printf '%s' "$1" | tr -d '\001-\007\013\016-\037')
  orig=$(printf '%s' "$1")
  [ "$raw" = "$orig" ] && printf false || printf true
}

# The array form: one JSON string per input line, comma-joined. Same ruleset as
# jstr minus the LF rule — \012 is the record separator here, never data, and
# never can be: a caller has already lost the ability to tell an element's own
# newline from the boundary between two elements by the time a value reaches
# per-line stdin, which is why no-undo-audit.sh refuses a conflicting path
# holding one before it ever calls this (see the `nl` guard below). Escaping a
# byte this function structurally never receives would be dead code standing
# in for a restructure nobody has needed; #89 owns that class.
jarr() {
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
      -e "s/$(printf '\010')/\\\\b/g" -e 's/\t/\\t/g' \
      -e "s/$(printf '\014')/\\\\f/g" -e 's/\r/\\r/g' \
      -e 's/^/"/' -e 's/$/"/' \
    | tr '\001-\007\013\016-\037' ' ' \
    | paste -sd, -
}
# Parallel boolean array to jarr's own output, true where that line held a byte
# jarr replaced. `read` alone drops a final line with no trailing newline —
# `set -eu` never sees it fail, the loop just never runs its body for that
# line — so `|| [ -n "$line" ]` is load-bearing on the last element, not
# defensive filler.
jarr_rewritten() {
  while IFS= read -r line || [ -n "$line" ]; do
    jrewritten "$line"
    echo
  done | paste -sd, -
}

[ $# -eq 2 ] || die "usage: no-undo-audit.sh <worktree> <branch>"
wt=$1
branch=$2
base=${BASE_REF:-origin/main}

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
# string compare, and `$wt` arrives relative (`claim-ticket.sh:26`), through a
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
# today: it arrives as the caller typed it — relative (`claim-ticket.sh:26`), or
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

git -C "$wt" rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"
# A branch never pushed, a stale remote-tracking ref, or a caller who already
# passed a name prefixed "origin/" all make this not resolve. Left unchecked,
# merge-tree below fails silently and "no conflicting files" is printed for a
# question that was never actually answered.
git -C "$wt" rev-parse --verify --quiet "origin/$branch" >/dev/null \
  || die "origin/$branch does not resolve — fetch it, or it was never pushed"

# 1. Uncommitted work. This may exist nowhere else on disk. `|| true` here would
#    turn a failed `status` into empty output and print "clean" over a dirty
#    tree — and since the stash count stopped gating, nothing else would catch
#    it. Unanswerable is exit 2, never exit 0. Same rule as worktree-audit.sh.
echo "\$ git -C $wt status --porcelain" >&2
porcelain=$(git -C "$wt" status --porcelain) \
  || die "git status failed in $wt — cannot tell a clean worktree from a dirty one"
if [ -n "$porcelain" ]; then
  clean=false
  echo "$porcelain" | sed 's/^/    /' >&2
else
  clean=true
  echo "    clean" >&2
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
#
# rc 1 is genuine absence and nothing else, so `-ne 1` is the whole test.
# `rev-parse --verify --quiet` cannot do this job: it returns 1 for the
# unreadable ref FILE for the same reason the list is empty, collapsing that
# case onto the genuinely-empty branch and printing a confident `0` with a real
# entry on the stack. A plain exit-status guard on `stash list` cannot do it
# either, because neither reflog case fails.
#
# This does not close every unreadable reflog: one that is merely TRUNCATED —
# some entries lost, the rest still parses — resolves the ref and returns a
# nonempty list, so the cross-check sees no disagreement and reports the
# (too-low) count as exact. That gap is the remaining ceiling.
stash=$(git -C "$wt" stash list 2>/dev/null | wc -l | tr -d ' ')
sr_rc=0
git -C "$wt" show-ref refs/stash >/dev/null 2>&1 || sr_rc=$?
if [ "$stash" = 0 ] && [ "$sr_rc" -ne 1 ]; then
  stash=null
  echo "    stash entries (repo-global, not gated): unknown — the list came back empty but refs/stash is not absent (an unreadable ref or reflog, or a ref pointing at a missing object)" >&2
else
  echo "    stash entries (repo-global, not gated): $stash" >&2
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
trap 'rm -f "$mt_out"' EXIT
echo "\$ git merge-tree --write-tree --name-only -z $base origin/$branch" >&2
mt_rc=0
git -C "$wt" merge-tree --write-tree --name-only -z "$base" "origin/$branch" >"$mt_out" || mt_rc=$?
[ "$mt_rc" -le 1 ] && [ -s "$mt_out" ] \
  || die "git merge-tree could not answer (exit $mt_rc) against origin/$branch — cannot determine conflicts"

# --name-only output is: tree OID, then (if conflicted) the conflicted-file
# list, then an EMPTY record, then prose ("Auto-merging ...", "CONFLICT ...").
# Only the section before that empty record is filenames — the old
# `tail -n +2` grabbed the prose section too and word-split it into the
# `git log -- $conflicts` pathspec below.
#
# The section split needs newline as the separator, because macOS awk 20200816
# reads RS="\0" as RS="" and silently switches to paragraph mode, and POSIX sh
# has no `read -d ''`. So a filename holding a literal newline has to be got out
# of the way FIRST — parking it on \001 — or it manufactures the empty record
# that ends the section, and `conflicts` comes back short or empty while the
# audit exits 0. That is a false safe, and worse than what this replaced: git
# C-quoted such a path, which at least emitted JSON the caller choked on.
# Unanswerable is exit 2. ponytail: refusing, not answering — a shell variable
# cannot hold NUL, so answering means keeping the whole list in a file and
# reading it with something NUL-capable. That is available (inflight.sh already
# shells out to python3, claim-ticket.sh to node) and is not the constraint; it
# is a restructure bought for a filename shape nobody has produced. Upgrade
# there if one ever turns up.
conflicts=$(tr '\n' '\001' <"$mt_out" | tr '\0' '\n' | awk 'NR==1{next} /^$/{exit} {print}')
nl=$(printf '\001')
case "$conflicts" in
  *"$nl"*) die "a conflicting path contains a newline — cannot build a pathspec for it" ;;
esac
if [ -n "$conflicts" ]; then
  echo "$conflicts" | sed 's/^/    conflict: /' >&2
else
  echo "    no conflicting files" >&2
fi
conflicts_json=$(printf '%s' "$conflicts" | jarr)
conflicts_rewritten_json=$(printf '%s' "$conflicts" | jarr_rewritten)

# 3. What main gained in those files since the fork. These are the commits a
#    careless resolution deletes — read them before resolving, not after.
at_risk=""
if [ -n "$conflicts" ]; then
  fork=$(git -C "$wt" merge-base "$base" "origin/$branch") \
    || die "git merge-base failed for $base and origin/$branch — cannot tell what a resolution would eat"
  echo "\$ git log --oneline $fork..$base -- <conflicting files>" >&2
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
  at_risk=$(printf '%s\n' "$conflicts" | sed 's/^/:(literal)/' | tr '\n' '\0' \
    | xargs -0 git -C "$wt" log --oneline "$fork".."$base" --) \
    || die "git log failed for the conflicting paths — cannot tell what a resolution would eat"
  [ -n "$at_risk" ] && echo "$at_risk" | sed 's/^/    at risk: /' >&2
fi
at_risk_json=$(printf '%s' "$at_risk" | jarr)
at_risk_rewritten_json=$(printf '%s' "$at_risk" | jarr_rewritten)

if [ "$clean" = true ]; then
  rc=0
else
  rc=1
  echo "$NAME: REFUSED — commit the worktree before rebasing. Never \`git clean\`," >&2
  echo "  \`git checkout .\`, \`git reset --hard\` or \`git stash\` to make a rebase start." >&2
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
# out. Assigned first, each one is a simple command whose status the `&&` chain
# can read and this `|| die` can act on.
wt_j=$(jstr "$wt") && wt_rw=$(jrewritten "$wt") \
  && branch_j=$(jstr "$branch") && branch_rw=$(jrewritten "$branch") \
  || die "could not escape the audit fields for $branch"
printf '{"worktree":"%s","worktreeRewritten":%s,"branch":"%s","branchRewritten":%s,"clean":%s,"stash":%s,"conflicts":[%s],"conflictsRewritten":[%s],"atRisk":[%s],"atRiskRewritten":[%s]}\n' \
  "$wt_j" "$wt_rw" "$branch_j" "$branch_rw" "$clean" "$stash" \
  "$conflicts_json" "$conflicts_rewritten_json" "$at_risk_json" "$at_risk_rewritten_json" \
  || die "could not write the audit for $branch"
exit "$rc"
