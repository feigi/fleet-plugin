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
# backslash that escape just introduced into `\\` on the second pass. Every byte
# below \040 becomes a space, JSON forbidding those unescaped, and \177 rides
# along with them; the UTF-8 in these strings is untouched, its bytes all being
# >= \200. tr pads the replacement with its last character. (No line number: the
# same citation named a line that had not been written yet, and #129 tracks four
# more that drifted.)
jstr() { printf '%s' "$1" | tr '\001-\037\177' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# The array form: one JSON string per input line, comma-joined. Identical except
# that it spares \012, the record separator here rather than part of an element.
jarr() { tr '\001-\011\013-\037\177' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/' | paste -sd, -; }

[ $# -eq 2 ] || die "usage: no-undo-audit.sh <worktree> <branch>"
wt=$1
branch=$2
base=${BASE_REF:-origin/main}

[ -d "$wt" ] || die "worktree $wt does not exist"
git -C "$wt" rev-parse --git-dir >/dev/null 2>&1 || die "$wt is not a git worktree"
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
stash=$(git -C "$wt" stash list 2>/dev/null | wc -l | tr -d ' ')
echo "    stash entries (repo-global, not gated): $stash" >&2

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
# Unanswerable is exit 2; a shell variable cannot hold the NUL that answering it
# properly would need.
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
  # which is the same false safe by a different byte.
  at_risk=$(printf '%s\n' "$conflicts" | sed 's/^/:(literal)/' | tr '\n' '\0' \
    | xargs -0 git -C "$wt" log --oneline "$fork".."$base" --) \
    || die "git log failed for the conflicting paths — cannot tell what a resolution would eat"
  [ -n "$at_risk" ] && echo "$at_risk" | sed 's/^/    at risk: /' >&2
fi
at_risk_json=$(printf '%s' "$at_risk" | jarr)

if [ "$clean" = true ]; then
  rc=0
else
  rc=1
  echo "$NAME: REFUSED — commit the worktree before rebasing. Never \`git clean\`," >&2
  echo "  \`git checkout .\`, \`git reset --hard\` or \`git stash\` to make a rebase start." >&2
fi

# `$wt` is a filename, so it admits both `"` and `\`; git accepts `"` in a ref
# name, so `$branch` admits one too. `$clean` and `$stash` are this script's own
# boolean and a digit count, and the two arrays arrive escaped already.
printf '{"worktree":"%s","branch":"%s","clean":%s,"stash":%s,"conflicts":[%s],"atRisk":[%s]}\n' \
  "$(jstr "$wt")" "$(jstr "$branch")" "$clean" "$stash" "$conflicts_json" "$at_risk_json" \
  || die "could not write the audit for $branch"
exit "$rc"
