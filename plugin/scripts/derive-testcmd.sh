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
# "$testfile_re"` over the listed file paths. There is no `sed` or plain `awk`
# in this script; `tr` joined it below.
#
# #614 measured the earlier claim here FALSE: git C-quotes a path holding a
# high-bit byte only under the DEFAULT `core.quotePath true` — with
# `core.quotePath false` set, `git ls-tree -r --name-only` emits the raw byte
# UNQUOTED, and that raw byte is exactly what makes grep locale-sensitive
# (#582's own hazard). Measured on a repo whose one test file is named
# `b\377ad.test.mjs`: with the pin's `LC_ALL=C`, `core.quotePath false` finds
# it (exit 0, `node --test`); with an ambient `en_US.UTF-8` and the pin
# deleted, the identical repo is refused as having no tests at all — so the
# byte-reaches-grep behaviour DID depend on an operator's git config, not on
# anything this script controls.
#
# Fixed by listing with `-z`: `git ls-tree -r -z --name-only` always emits the
# raw byte, unquoted, regardless of `core.quotePath` — the config dependence
# above is closed outright rather than argued into never mattering. As a side
# effect it also fixes a second, unrelated bug the C-quoted form carried: a
# quoted name never matched `$testfile_re` at all, because the closing `"`
# defeats the `$` anchor — so a repo whose test files carry non-ASCII names
# under the (default) quoted form was refused as having none.
#
# Two separate fixtures in derive-testcmd.test.mjs, because one config does
# not exercise the other bug: "...under core.quotePath's default true" pins
# the C-quoting/`$`-anchor defect this comment just described — mutation-
# verified, it goes red if `-z` is reverted. "...with core.quotePath false
# survives an ambient UTF-8 locale" pins the separate, locale-dependent hazard
# from #582 (an unquoted byte only surviving `tr`/`grep` under `LC_ALL=C`) —
# `-z` is not load-bearing for that one, since plain `--name-only` already
# emits the byte unquoted when `core.quotePath` is false.
#
# `-z` terminates each entry with NUL, and a shell variable cannot hold an
# embedded NUL — POSIX `$()` strips it, silently concatenating every entry
# after the first bad byte into one unmatchable blob. So the raw listing is
# captured to a FILE, never a variable, and translated to newlines only once
# every NUL is already gone from the stream. `git`'s own exit status is still
# checked directly against that write, never through a pipe whose status would
# belong to `tr` instead — the same swallow the comment below still guards
# against for `grep`.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on. "Nothing" is an
# inventory, not a hope: locale-pin-prose.test.mjs enforces it (#612), because
# this sentence shipped false in no-undo-audit.sh and a `sort` added below
# would otherwise leave every test in this suite green.
export LC_ALL=C

# Below the locale pin, not above it with `set -eu`: `unset` touches no
# byte-sensitive tool, but locale-pin-prose.test.mjs treats ANY line here that
# is not a comment, a blank, or `set -[eux]+` as work the pin must sit above,
# and refuses on principle rather than on this line's own behaviour. Same
# placement, same reason, as release-ticket.sh's copy.
#
# GIT_DIR outranks the `-C "$repo"` on all three calls below, so an ambient
# one answers about the WRONG repository while still being handed `$repo`.
# Measured: asked for a checkout whose `package.json` declares `scripts.test`,
# with `GIT_DIR` naming a clone whose manifest does not, this script emits
# `node --test` at rc 0 — the other repository's entrypoint, reported as this
# one's, with no cue anywhere that the question asked was not the question
# answered. Both consumers act on that string: claim-ticket.sh bakes it into
# the runner it materialises, and review-pr.js's snapshot agent runs it
# against the repo under review. A silently wrong entrypoint passes
# vacuously, which is the one outcome the refusal at the foot of this file
# exists to rule out.
#
# GIT_WORK_TREE is unset alongside it and is measured INERT here: every call
# is an object-database read — `rev-parse --git-dir`, `ls-tree`, `show` —
# and none of the three consults a work tree, so no target changes the
# output. It stays on the line because the pair is one hazard with one
# remedy, and because "inert today" is a measurement of the current call set,
# not a property of the script: the first `git -C "$repo" status` or
# `diff --quiet` added below would reintroduce the half nothing here can see.
# ambient-git-vars-prose.test.mjs pins the line itself, which is what keeps
# that half from being quietly dropped.
unset GIT_DIR GIT_WORK_TREE

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
#
# A FILE, not a variable: `-z`'s NUL terminators cannot survive `$()` (see the
# header comment), so git's raw output is written to disk first — where an
# embedded NUL is just a byte — and only translated to newlines by the `tr`
# below, after which nothing downstream ever sees one again.
ls_tmp=$(mktemp) || die "cannot create a temporary file to list $ref"
trap 'rm -f "$ls_tmp"' EXIT
if ! git -C "$repo" ls-tree -r -z --name-only "$ref" >"$ls_tmp" 2>&1; then
  ls_err=$(cat "$ls_tmp")
  die "cannot list $ref — $ls_err"
fi
files=$(tr '\0' '\n' <"$ls_tmp")

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
