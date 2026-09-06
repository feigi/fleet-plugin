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

# Byte semantics for the one byte-sensitive call below: `grep -qE
# "$testfile_re"` over the changed file paths. There is no `tr`, `sed` or `awk`
# in this script. Under a UTF-8 locale BSD grep silently DROPS a line holding a
# byte that is not valid UTF-8 — measured over a three-name listing whose middle
# entry is `b\377ad.test.mjs`: `grep -cE` with this script's own regex matches 2
# under `en_US.UTF-8` and 3 under `C`, stderr empty either way — so such a name
# reads as "no test files" with nothing there to notice. It reaches us from a
# fetched tree even where the local filesystem refuses to hold the name. #582
# measured the cost of leaving this ambient in no-undo-audit.sh: a truncated
# list reported as a clean, confident answer.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on. "Nothing" is an
# inventory, not a hope: locale-pin-prose.test.mjs enforces it (#612), because
# this sentence shipped false in no-undo-audit.sh and a `sort` added below
# would otherwise leave every test in this suite green.
export LC_ALL=C

NAME=derive-testcmd
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: derive-testcmd.sh <repo> <ref>"
repo=$1
ref=$2

git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "$repo is not a git repository"

# Materialize the listing instead of piping ls-tree straight into grep: a
# pipeline's status is the LAST command's, so an ls-tree that DIES (unknown
# ref, unborn HEAD, unreadable object DB) is indistinguishable from "no
# matches" and the refusal below would name a cause that is not the cause —
# on a repo that demonstrably HAS test files. Same class as reap.sh's
# `git cherry ... | grep -q`, which cost a branch deletion.
files=$(git -C "$repo" ls-tree -r --name-only "$ref" 2>&1) || die "cannot list $ref — $files"

pkg=$(git -C "$repo" show "$ref:package.json" 2>/dev/null) || pkg=

# Kept in sync with claim-ticket.sh's own `testfile_re` by hand: that copy
# feeds the runner heredoc it writes at RUN time (a shell string, not a git
# query), so it cannot simply call this script for its value. Same pattern,
# same regex, two necessarily separate homes — derive-testcmd.test.mjs asserts
# the two literals are byte-identical, so the sync is checked, not promised.
testfile_re='\.(test|spec)\.[cm]?[jt]sx?$'

# THREE outcomes from the manifest, not two: it declares scripts.test (0), it
# parses and declares none (1), or it does not parse at all (2). Folding 2
# into 1 is what let a corrupt package.json that DOES declare `scripts.test`
# degrade silently to `node --test` — the wrong entrypoint, reported as a
# success. An unparseable manifest is not evidence of an absent test script,
# which is the same policy claim-ticket.sh already applies to the dependency
# count it reads out of this same file. Anything other than 0 or 1 (unreadable
# stdin) refuses too, rather than being read as an answer.
if [ -n "$pkg" ]; then
  # An unavailable interpreter is the one such status that is not about the
  # manifest at all, so it does not reach the arm above. The capture merges
  # stderr, so unguarded the shell's own `node: command not found` arrives
  # inside $pkgerr and the refusal reports it as `could not read
  # <ref>:package.json` — indistinguishable by message from a manifest that
  # genuinely does not parse, which is the very distinction the three-outcome
  # split exists to keep. Two consumers read this refusal: claim-ticket.sh
  # wraps it into its own, and review-pr.js's snapshot agent reads it against
  # the repo under review. The probe is an INVOCATION rather than a name
  # lookup, because those are not the same question: `command -v` answers only
  # that a PATH entry named `node` exists and is executable, which a
  # version-manager shim that resolves and then fails satisfies — and that
  # shim's own stderr then arrives under the manifest's name, which is this
  # defect itself rather than a narrower cousin of it. Running the interpreter
  # asks what the capture below asks, so this refuses exactly where that one
  # would have, and reports the interpreter's own words rather than a cause
  # inferred from a name. #1141
  nodeerr=$(node -e 0 </dev/null 2>&1) || die "node is unusable, refusing to derive a test entrypoint without the interpreter — $nodeerr"
  st=0
  pkgerr=$(printf '%s' "$pkg" | node -e 'const fs=require("fs");let p;try{p=JSON.parse(fs.readFileSync(0,"utf8"))}catch(e){console.error(e.message);process.exit(2)}process.exit((p.scripts||{}).test?0:1)' 2>&1) || st=$?
  case $st in
    0) echo "npm test --"; exit 0 ;;
    1) : ;;
    *) die "could not read $ref:package.json — $pkgerr" ;;
  esac
fi

if printf '%s\n' "$files" | grep -qE "$testfile_re"; then
  echo "node --test"
else
  die "$ref has no scripts.test and no test files — refusing to emit a command that would pass vacuously"
fi
