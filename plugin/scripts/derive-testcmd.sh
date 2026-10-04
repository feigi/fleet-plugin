#!/bin/sh
# Read one command of a repository's proven Recipe out of its Recipe cache:
# `install` (the Install step) or `test` (the Test entrypoint). ADR 0015.
#
# The fleet keeps no table of technologies. A Recipe is DERIVED by an agent
# reasoning over the repository and PROVEN before it is written — the Install
# step ran in a fresh worktree and left the tree clean, the Test entrypoint ran
# and showed real tests — so this script infers nothing. A missing cache is a
# refusal naming the step that derives one, never a guess: a guessed command
# that passes vacuously reads as a green suite to every consumer, which is the
# #142 hazard the old inference already refused over.
#
# The ONE reader of the cache — reused, not reimplemented, by claim-ticket.sh
# (the Install step it runs and the Test entrypoint it bakes into the runner)
# and by review-core.mjs's snapshot agent (the Test entrypoint handed to the
# specialists). Two independent readers is what drifts; see #142.
#
# THE CACHE is `<workspace>/.fleet/recipe.json`, where <workspace> is the
# directory holding the repository's COMMON git dir — the main checkout, the
# same place the ledger and the heartbeat live — so a claimed worktree and a
# review worktree read the one cache the main checkout holds rather than a
# private copy each. A single JSON object:
#
#   install       string  the Install step, a shell command run from the root
#   test          string  the Test entrypoint, a shell command run from the root
#   derivedAt     string  the full commit id (40 or 64 hex) it was proven at
#   installClean  true    the Install step left `git status --porcelain` empty
#   testCount     integer >0, the test count the proving run reported, and/or
#   mutation      string  the deliberate failing mutation that turned it red
#
# At least one of testCount/mutation is the proof; a cache carrying neither,
# or `installClean` anything but `true`, is an UNPROVEN Recipe and refused like
# an absent one. Written only by recipe-prove.mjs, the derivation step's proof,
# and only once that proof holds; this script never writes it.
#
# INVALID on failure to RUN, never on failing tests: the command this script
# is asked for must name something that resolves from <repo> (a builtin, a
# PATH entry, an executable path). A red suite is a finding, not a stale
# Recipe, so nothing here ever runs the command.
#
# Exit status: 0 the command is printed; 1 a refusal about the cache, the
# repository or the arguments; 3 a tool this script needs to read the cache
# (node, mktemp, cat) could not be started or node died mid-read, so nothing
# was read and the cache's usability is unknown.
set -eu

# Byte semantics for every construct below that reads a string by bytes:
#
#   the `case` patterns that pick the command's leading word apart past
#   `NAME=value` prefixes — `[A-Za-z_]` ranges, ASCII by intent, and `*` over
#   an arbitrary byte string from the cache. Under an ambient UTF-8 locale a
#   range is collation-ordered and `*` refuses to match across an invalid byte.
#
#   the digit-only guard on node's byte-count file (`*[!0-9]*`), ASCII digits
#   by intent like the ranges above.
#
#   the `${#framed}` length compare, which must count BYTES to equal the byte
#   count node writes. Under a UTF-8 locale `${#…}` counts characters, so a
#   valid cache whose command holds a multi-byte character would be refused
#   as chatter on node's stdout.
#
# The hex range in the inline `node -e` validator is JavaScript and out of the
# shell locale's reach. Nothing here sorts or folds case. The pin sits ahead of
# every line that does work, so it covers all of the above.
export LC_ALL=C

# Below the locale pin, not above it with `set -eu`: `unset` touches no
# byte-sensitive tool, but locale-pin-prose.test.mjs treats ANY line here that
# is not a comment, a blank, or `set -[eux]+` as work the pin must sit above,
# and refuses on principle rather than on this line's own behaviour. Same
# placement, same reason, as release-ticket.sh's copy.
#
# GIT_DIR outranks the `-C "$repo"` on the git calls below, so an ambient one
# answers `--git-common-dir` for the WRONG repository while still being handed
# `$repo` — and the cache it then reads is another repository's Recipe,
# reported as this one's. Both consumers act on that string: claim-ticket.sh
# runs it in a fresh worktree and bakes it into the runner, and review-core.mjs's
# snapshot agent hands it to every specialist.
#
# GIT_WORK_TREE is unset alongside it and is INERT here: `rev-parse --git-dir`
# and `--git-common-dir` consult no work tree. It stays on the line because the
# pair is one hazard with one remedy, and "inert today" is a measurement of the
# current call set, not a property of the script.
# ambient-git-vars-prose.test.mjs pins the line itself.
unset GIT_DIR GIT_WORK_TREE

# shellcheck disable=SC2100 # literal name "derive-testcmd", not arithmetic — the unrelated $derive var assigned below is what the heuristic collides on, not this line
NAME=derive-testcmd
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 1; }

# A refusal about the environment, not the cache: a tool this script needs to
# read the cache (the interpreter, mktemp, cat) could not be started, or the
# interpreter died mid-read, so nothing was read and the cache's usability is
# unknown. Exit 3, where every refusal about the cache, the repository or the
# arguments is exit 1. A git that cannot be started is not told apart: it reads
# as no repository, exit 1. A consumer that only tests for non-zero sees no
# difference.
unrunnable() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 3; }

# Named once: every refusal that sends the caller to re-derive names the same
# step, so a controller or reviewer reading any of them knows what to run.
derive="run the Recipe derivation step (run-team phase 0, before the first claim — ADR 0015) to derive, prove and write it"

[ $# -eq 2 ] || die "usage: derive-testcmd.sh <repo> <install|test>"
repo=$1
field=$2

git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "$repo is not a git repository"

case $field in
  install|test) ;;
  *) die "unknown Recipe field '$field' — expected install or test" ;;
esac

# `--path-format=absolute` so the workspace is a real directory whatever the
# caller's cwd; the workspace is the common dir's parent, the same rule
# git-env.mjs's workspaceDirFromGitCommonDir() applies for the ledger.
common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>&1) \
  || die "cannot resolve the common git dir of $repo — $common"
cache="${common%/*}/.fleet/recipe.json"

# Absent is its own refusal, ahead of the interpreter probe: it is the one
# state every fresh repository starts in, and its message must name the step
# that ends it rather than anything about a parser.
[ -e "$cache" ] || die "no Recipe cache at $cache — refusing to infer an Install step or a Test entrypoint; $derive"

# An INVOCATION, not a name lookup (#1141): a version-manager shim satisfies
# `command -v node` and then fails, and its stderr would arrive below under the
# cache's name — a corrupt-cache refusal for a cache nobody read.
nodeerr=$(node -e 0 </dev/null 2>&1) || unrunnable "node is unusable, refusing to read the Recipe cache without the interpreter — $nodeerr"

# Validation and extraction in one pass, so a field is never printed out of a
# cache the checks did not pass. rc 0 prints the value; anything else carries
# the reason on stderr. An interpreter made chatty by the caller's environment
# writes on the SUCCESS path too, and whatever reaches the capture arrives
# inside the command this script hands claim-ticket.sh to run — so each stream
# is guarded on its own:
#
#   stderr is kept APART — to a file, never merged into the capture — because
#   NODE_OPTIONS or NODE_DEBUG chatter lands there (#752, #1175).
#
#   stdout carries the value FRAMED, `recipe<` before it and `>recipe` after,
#   and the WHOLE capture must be exactly that frame, byte for byte (#2217):
#   the anchored match alone only proves the ends line up, so a shim whose
#   own chatter happens to spell out `recipe<`/`>recipe` around the real
#   frame would still pass it and splice that chatter into the value — node
#   writes the frame's own byte length to a second temp file ($lenf) before
#   writing the frame itself, and the capture is refused unless its length
#   matches that count exactly, closing the gap no anchor check alone can
#   close. A version-manager or proxy shim prints to stdout before exec'ing
#   the real node (`Now using node v22.0.0`), and one that does not exec can
#   print after node exits; the anchor and the length check both refuse it,
#   and the refusal names node's output, never the cache — the cache passed.
#   Refused, never recovered: no value is cut out of chatter. The end
#   sentinel also stops `$(…)` stripping a trailing newline off a value the
#   way an unframed capture always did — a value that itself ends in a
#   newline now survives inside the frame, and the trailing-operator check
#   below treats it exactly like a trailing `;` or `&`: refused, not
#   silently accepted.
errf=$(mktemp) || unrunnable "cannot create a temporary file to read the Recipe cache"
lenf=$(mktemp) || unrunnable "cannot create a temporary file to read the Recipe cache"
# Cleanup decides nothing: an `rm` that cannot be started would otherwise
# replace the script's own exit status with 127 (and print a line on the
# success path), so the status the script was leaving with is kept.
trap 'rc=$?; rm -f "$errf" "$lenf" 2>/dev/null || :; exit $rc' EXIT

open='recipe<' close='>recipe'
rc=0
framed=$(node -e '
const fs = require("fs");
const [file, field, open, close, lenFile] = process.argv.slice(1);
const bad = (why) => { console.error(why.replace(/\0/g, "")); process.exit(2); };
let r;
try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { bad(`it does not parse: ${e.message}`); }
if (r === null || typeof r !== "object" || Array.isArray(r)) bad("it is not a JSON object");
for (const k of ["install", "test"])
  if (typeof r[k] !== "string" || !r[k].trim() || r[k].includes("\0")) bad(`\`${k}\` is not a non-empty command string`);
if (typeof r.derivedAt !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(r.derivedAt))
  bad("`derivedAt` is not a full commit id");
if (r.installClean !== true) bad("`installClean` is not true — the Install step was never proven to leave the tree clean");
const counted = Number.isInteger(r.testCount) && r.testCount > 0;
const mutated = typeof r.mutation === "string" && r.mutation.trim() !== "";
if (!counted && !mutated) bad("it carries no proof of real tests — neither a positive `testCount` nor a `mutation`");
const value = r[field];
fs.writeFileSync(lenFile, String(Buffer.byteLength(open + value + close)));
process.stdout.write(open + value + close);
' "$cache" "$field" "$open" "$close" "$lenf" 2>"$errf") || rc=$?
# node's own refusal of the cache is exit 2 (an uncaught fault is exit 1), the
# reason on stderr either way; a status of 126 or above is the shell failing to
# run node or the system killing it mid-read, which says nothing about the cache.
if [ "$rc" -ge 126 ]; then
  unrunnable "node did not finish reading the Recipe cache (exit $rc), so its usability is unknown"
fi
# The reason is read back with the shell's own `read`, never `cat`: a cat that
# cannot be started would otherwise leave a cache node really refused with an
# empty reason and a stray "cat: command not found" line. Like `$(cat ...)`, the
# substitution drops trailing newlines; `|| [ -n "$line" ]` keeps a last line
# that has none. A shell string cannot hold a NUL and a `read` loop stops at
# one, where `cat` kept the rest, so node's `bad` above strips NULs from its
# reason — a cache that holds NUL bytes is quoted back in its parse error.
# Nothing here may end the script before `die`: a stderr file that cannot be
# read back (opened, or read — bash's `read` leaves `line` unset on an error,
# which `set -u` then trips on) fails the substitution, and the `||` names that
# in the reason instead of aborting on the shell's own error, which under dash
# would also be an exit outside 0/1/3.
if [ "$rc" -ne 0 ]; then
  reason=$({ while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$line"; done <"$errf"; } 2>/dev/null) ||
    reason="(node's reason could not be read back from $errf)"
  die "the Recipe cache at $cache is unusable: $reason — $derive"
fi
carriedmsg="node's stdout carried more than the framed Recipe value — expected exactly the value between '$open' and '$close', got '$framed'. The cache at $cache passed validation; the extra output comes from how node is launched here (a version-manager or proxy shim, a preload), and is refused rather than cut out of the command"
case $framed in
  "$open"*"$close") ;;
  *) die "$carriedmsg" ;;
esac
# A `cat` that cannot be started (126/127) is the environment's fault, as for
# `node` above; a `cat` that ran and failed refuses with its own reason, and a
# count file that was read but holds no digits is the corrupt-count refusal
# below.
rc=0
framedlen=$(cat "$lenf" 2>"$errf") || rc=$?
case $rc in
  0) ;;
  126|127) unrunnable "cat could not be started (exit $rc), so the Recipe cache cannot be read" ;;
  *) die "the Recipe cache at $cache is unusable: cat failed reading node's byte-count file (exit $rc): $(cat "$errf" 2>/dev/null) — $derive" ;;
esac
case $framedlen in
  ''|*[!0-9]*) die "the Recipe cache at $cache is unusable: node's byte-count file is missing or corrupt — $derive" ;;
esac
[ "${#framed}" -eq "$framedlen" ] || die "$carriedmsg"
value=${framed#"$open"}
value=${value%"$close"}

# Both consumers append the runner's own arguments after this string
# textually (claim-ticket.sh's `exec sh -c '<cmd> "$@"' agent-test "$@"`), so
# a command ending in `;`, `&`, or a newline lets a real shell read the
# caller's "$@" as an unrelated top-level command instead of args reaching
# the Test entrypoint, and one containing a `#`-led word swallows everything
# after it, "$@" included, as a comment — measured on both. A trailing
# newline is checked here too (#2217): the frame above lets a value keep one
# where an unframed `$(…)` capture always dropped it silently, so a value
# that used to read as `true;` now reads as `true;\n` and would otherwise
# slip past a check written for the no-newline case. Checked on the raw
# string for the trailing operator (adjacency to whitespace is not what
# makes `;`/`&` a shell operator) and on the same naive field split the
# leading-word check below already trusts for the comment word, since
# neither hazard is about whether the command resolves.
case $value in
  *';'|*'&'|*'
') die "the Recipe cache at $cache is invalid: its $field command '$value' ends in ';', '&', or a newline — a runner-appended argument after it would run as an unrelated command instead of reaching the Test entrypoint; $derive" ;;
esac
set -f
IFS=' 	
'
# shellcheck disable=SC2086 # field splitting is the point: scanning every word
for word in $value; do
  case $word in
    '#'*) set +f; die "the Recipe cache at $cache is invalid: its $field command '$value' contains a '#' word — a runner-appended argument would be swallowed as a comment rather than reaching the Test entrypoint; $derive" ;;
  esac
done
set +f

# The failure-to-run probe. The leading word is found by the shell's own field
# splitting with globbing off, past any `NAME=value` prefix assignments. A word
# carrying quoting or an expansion cannot be settled without running the
# command, and running it is exactly what this script never does, so such a
# word is accepted unprobed rather than refused on a split it cannot trust —
# the runner then fails loudly at run time, which is where it would anyway.
# IFS is set, not inherited, so the split is the default one whatever the
# caller exported.
set -f
IFS=' 	
'
# shellcheck disable=SC2086 # field splitting is the point: the leading word
set -- $value
set +f
while [ $# -gt 0 ]; do
  case $1 in
    [A-Za-z_]*=*)
      case ${1%%=*} in *[!A-Za-z0-9_]*) break ;; esac
      shift ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || die "the Recipe cache at $cache is invalid: its $field command names no command, only assignments — $derive"
case $1 in
  *[\'\"\\\$\`\(\)\{\}\<\>\|\&\;\*\?\[\~]*) ;;
  *)
    # In <repo>, so a relative `./run-tests.sh` resolves where the command
    # itself will run from. `command -v` alone is not exec-bit-aware for a
    # `/`-containing word under dash (Ubuntu's default /bin/sh): it only
    # stat()s the path there, never checking execute permission — measured:
    # `dash -c 'command -v ./run.sh'` on a chmod 0644 file exits 0. `[ -x ]`
    # is the exec-bit-aware check that closes the gap; a bare name (builtin
    # or a PATH match) has no path to test and is left to `command -v`.
    (cd "$repo" && command -v -- "$1" || exit 1
      case $1 in */*) [ -x "$1" ] || exit 1 ;; esac) >/dev/null 2>&1 \
      || die "the Recipe cache at $cache is invalid: its $field command '$1' is not found or not executable from $repo — a Recipe that cannot run is stale, not a finding; $derive"
    ;;
esac

printf '%s\n' "$value"
