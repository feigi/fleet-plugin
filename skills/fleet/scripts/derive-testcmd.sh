#!/bin/sh
# Derive a repository's test entrypoint at a git ref: a manifest test script,
# else a direct test-file run, else refuse rather than emit a command that
# could pass vacuously.
#
# Both guesses are unsafe when wrong: `npm test` with no `test` script fails
# with an npm error that reads like a broken tree, and `node --test` with no
# test files exits 0 — a runner that passes vacuously is worse than one that
# is dead, because a consumer (a review fan-out, a claimed worktree) reads the
# silence as a green suite. Refuse rather than guess.
#
# The ONE place this inference lives — reused, not reimplemented, by
# claim-ticket.sh (worktree setup, ref origin/main) and by review-pr.js's
# snapshot agent (review fan-out, ref HEAD of the repo under review). Two
# independent copies is what drifts; see #142.
set -eu

NAME=derive-testcmd
die() { echo "$NAME: $1" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: derive-testcmd.sh <repo> <ref>"
repo=$1
ref=$2

git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "$repo is not a git repository"

pkg=$(git -C "$repo" show "$ref:package.json" 2>/dev/null) || pkg=

# Kept in sync with claim-ticket.sh's own `testfile_re` by hand: that copy
# feeds the runner heredoc it writes at RUN time (a shell string, not a git
# query), so it cannot simply call this script for its value. Same pattern,
# same regex, two necessarily separate homes.
testfile_re='\.(test|spec)\.[cm]?[jt]sx?$'

if printf '%s' "$pkg" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit((p.scripts||{}).test?0:1)' 2>/dev/null; then
  echo "npm test --"
elif git -C "$repo" ls-tree -r --name-only "$ref" | grep -qE "$testfile_re"; then
  echo "node --test"
else
  die "$ref has no scripts.test and no test files — refusing to emit a command that would pass vacuously"
fi
