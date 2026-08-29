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

[ $# -ge 3 ] || die "usage: claim-ticket.sh <issue> <slug> <type> [--apply]"
issue=$1
slug=$2
type=$3
apply=false
[ "${4:-}" = "--apply" ] && apply=true

case "$issue" in ''|*[!0-9]*|0?*) die "issue must be a number, got '$issue'";; esac

branch="$type/$issue-$slug"
wt=".worktrees/$issue-$slug"
runner="$wt/agent-test"

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
{ [ -e "$wt" ] || [ -L "$wt" ]; } && die "$wt already exists — ticket may already be claimed"
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && die "branch $branch already exists"

# Everything below is derived from origin/main, the ref the worktree is built
# from — never from $PWD. The checkout can hold untracked or gitignored files
# the worktree will never have (this repo's own package.json is gitignored),
# and can sit on a different commit entirely. Probing $PWD let the script
# announce "no lockfile" and then build a worktree containing one.
pkg=$(git show origin/main:package.json 2>/dev/null) || pkg=

# Derive the frozen install from the lockfile. No match is a refusal, not a
# default — guessing here is what corrupts the tree. The one safe exception is
# nothing to install: no manifest, or one whose four dependency fields are all
# empty and which is not a workspaces root. An unparseable manifest is not
# evidence of an empty one, so it refuses too.
if   git cat-file -e origin/main:package-lock.json 2>/dev/null; then install="npm ci"
elif git cat-file -e origin/main:pnpm-lock.yaml    2>/dev/null; then install="pnpm i --frozen-lockfile"
elif git cat-file -e origin/main:yarn.lock         2>/dev/null; then install="yarn --immutable"
elif [ -z "$pkg" ]; then install="true"
elif ! ndeps=$(printf '%s' "$pkg" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(String(["dependencies","devDependencies","peerDependencies","optionalDependencies","workspaces"].reduce((n,k)=>n+Object.keys(p[k]||{}).length,0)))' 2>&1); then
  die "could not read origin/main:package.json — $ndeps"
elif [ "$ndeps" = 0 ]; then install="true"
else die "origin/main declares $ndeps dependencies but has no lockfile — refusing to guess an install command"
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
if ! testcmd=$("$script_dir/derive-testcmd.sh" . origin/main 2>&1); then
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
  printf '    would: git worktree add %s -b %s origin/main\n' "$wt" "$branch" >&2
  printf '    would: (cd %s && %s)\n' "$wt" "$install" >&2
  printf '    would: write %s and add it to .git/info/exclude\n' "$runner" >&2
else
  echo "\$ gh issue edit $issue --add-label in-progress" >&2
  gh issue edit "$issue" --add-label in-progress >/dev/null || die "could not label issue $issue"

  printf '$ git worktree add %s -b %s origin/main\n' "$wt" "$branch" >&2
  git worktree add "$wt" -b "$branch" origin/main >/dev/null || die "worktree add failed"

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
  # release-ticket.sh's own `git -C "$wt" status --porcelain` capture already
  # states it — folded-in stderr would be counted as a change. A git
  # that exits 0 still writes to stderr for a malformed `.gitattributes` line
  # or a chatty `core.fsmonitor`, and merged that chatter became the whole of
  # $dirty and refused a lockfile it had just verified as clean — after the
  # label, the branch and the worktree were already created. git's denial
  # reaches this terminal on its own, which is the "its own denial" the
  # paragraph above means; the die names the failure, not the reason.
  elif ! dirty=$(git -C "$wt" status --porcelain package-lock.json pnpm-lock.yaml yarn.lock); then
    die "could not verify lockfile state in $wt"
  elif [ -n "$dirty" ]; then
    die "install mutated the lockfile in $wt — wrong command, fix before dispatching"
  fi
  echo "    lockfile clean after install" >&2

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
for arg do
  shift
  # Judged on the argument's shape, not on what that shape resolves to: a
  # directory expands, an existing file passes through escaped, a quoted glob is
  # node's to expand whether or not it matches anything, and a typo is refused
  # outright. A flag is the one shape that can name nothing at all.
  # The \`[ -e ]\` term is what keeps this classification in step with the
  # branch that consumes the argument below, which settles \`-d\` and then
  # \`-e\` before it reads anything as a flag — that branch is where existence
  # genuinely comes first; here the \`-*\` shape has to match before the term is
  # reached at all.
  # Agreement is the whole of what it buys, never a working invocation: a
  # dash-spelled path is refused either way, and the term settles only WHICH
  # refusal a caller sees. Measured on a runner built from this emitter, with a
  # file named \`-dash.spec.mjs\` present and named as the sole argument: with
  # the term, node reads it as an option and exits 9 with \`node: bad option\`;
  # without it, the argument classifies as a flag and the refusal below exits 1
  # in this runner's own voice.
  case "\$arg" in -*) [ -e "\$arg" ] && operand=1 ;; *) operand=1 ;; esac
  if [ -d "\$arg" ]; then
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
    # \`CDPATH=\` on both: an inherited CDPATH resolves a bare relative name
    # against a same-named directory somewhere else entirely, so the guard
    # would judge one directory while \`find\` below — which never consults
    # CDPATH — walks another, and the vendored suite runs green. It also
    # stops \`cd\` echoing its target into the substitution.
    # A symlink to a directory that merely CONTAINS a vendored tree resolves
    # outside \`node_modules\` and passes here untouched; \`-prune\` below
    # still excludes its vendored contents once the walk reaches them.
    root=\$(CDPATH= cd -- "\$(dirname "\$0")" 2>/dev/null && pwd -P)
    resolved=\$(CDPATH= cd -- "\$arg" 2>/dev/null && pwd -P)
    if [ -z "\$resolved" ]; then
      parent=\$(CDPATH= cd -- "\$(dirname -- "\$arg")" 2>/dev/null && pwd -P)
      [ -z "\$parent" ] || resolved=\${parent%/}/\$(basename -- "\$arg")
      [ -n "\$resolved" ] || resolved=\$arg
    fi
    shared=\$root
    while [ -n "\$shared" ]; do
      case "\$resolved" in "\$shared"/* | "\$shared") break ;; esac
      shared=\${shared%/*}
    done
    case "/\${arg##/*}/ /\${resolved#"\$shared"}/" in
      */node_modules/*) printf 'agent-test: %s is under node_modules — excluded from the run, not missing\n' "\$arg" >&2; exit 1 ;;
    esac
    found=\$(find "\$arg/" -name node_modules -prune -o -type f -print) || { printf 'agent-test: cannot read every path under %s\n' "\$arg" >&2; exit 1; }
    files=\$(printf '%s\n' "\$found" | grep -E '$testfile_re' | sed 's/\[/[[]/g')
    # No \`set -e\` in this runner, and that is load-bearing: grep exits 1 on no
    # match, so under -e the shell would abort here and the refusal below would
    # never print. Read a status you care about explicitly, as find does above.
    [ -n "\$files" ] || { printf 'agent-test: no test files under %s\n' "\$arg" >&2; exit 1; }
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
    # Vendored, on the argument's own spelling: node excludes an argv entry
    # when its NORMALIZED relative form starts with \`node_modules/\`, so
    # \`t/../node_modules/pkg/x.test.mjs\` is excluded too and a literal prefix
    # match misses it. A deeper segment (\`t/node_modules/pkg/x.test.mjs\`) and
    # an absolute path are NOT excluded — node runs both, and counts them, so
    # there is no silent drop to guard and the \`/*\` arm leaves absolute
    # spellings alone (measured, Node v26.5.0). Resolving the argument's own
    # directory is what separates those cases; \`cd\`/\`pwd\` without \`-P\` is the
    # logical form, the same textual resolution node applies. \`..\` only ever
    # removes segments, so an argument that does not mention \`node_modules\`
    # cannot normalize into one — the outer pattern keeps the subshell off
    # every other path. Passing an excluded spelling through would be the
    # same silent drop as the typo case below, for a different reason.
    # \`-P\` here is not a hardening opportunity, and the omission is not an
    # oversight (#401). The ordinary npm/pnpm workspace shape is where the two
    # resolution modes diverge: \`node_modules/pkg\` is itself a symlink to a
    # sibling real directory (a hoisted or linked workspace package). Physical
    # resolution follows \`pkg\` OUT of \`node_modules\`, so the pattern below
    # stops matching, this guard falls through without refusing, and the
    # argument reaches node unrefused — where it is excluded anyway, on its
    # own unresolved spelling, silently, at exit 0. That reintroduces #100's
    # silent drop, minus the loud refusal this guard exists to give it first.
    case "\$arg" in
      /*) ;;
      *node_modules/*)
        case "\$arg" in */*) argdir="\${arg%/*}" ;; *) argdir="." ;; esac
        case "\$(CDPATH= cd -- "\$argdir" 2>/dev/null && pwd)/" in
          "\$PWD"/node_modules/*)
            printf 'agent-test: %s is under node_modules — node discards it silently, not a test failure\n' "\$arg" >&2
            exit 1
            ;;
        esac
        ;;
    esac
    # Judged on the argument's RESOLVED path as well (#424) — #186's
    # directory-branch rule applied to the file arm. A symlink whose own name
    # carries no \`node_modules\` but whose target is vendored defeats every
    # term above, and node does not discard it: node RUNS it, so the suite's
    # result comes to hang on third-party code passing. That is #186's hazard,
    # not #100's, and it takes #186's remedy rather than another spelling.
    # Only where the spelling does not already name \`node_modules\`. Those
    # arguments are the guard above's own input — the deeper-segment and
    # absolute spellings it deliberately lets through because node runs and
    # counts them included — and re-judging them here would overturn that
    # ruling from a second place. Reading disjoint arguments is also what lets
    # this check be physical while the one above stays logical (#401): the two
    # never see the same argument, so neither can undo the other's resolution
    # mode.
    # \`realpath\` rather than \`cd\`+\`pwd -P\`: \`cd\` resolves symlinked
    # DIRECTORY components, but a symlink whose own target is a FILE is this
    # ticket's input and \`cd\` never reaches it. It also follows a chain of
    # them, and reports a cycle as a failure instead of looping. Where it fails
    # or is absent \$fresolved is empty, the strip below leaves nothing to
    # match, and the argument keeps exactly today's treatment — which is what
    # the arms below depend on, since a quoted glob and a typo both reach here
    # and neither resolves.
    # Anchored at the divergence from the runner's own location, as the
    # directory branch's \$shared walk is: a \`node_modules\` ABOVE the
    # divergence is an ancestor of the runner too and says nothing about the
    # argument. Matched absolutely instead, a worktree living under one refused
    # every file argument as vendored.
    case "\$arg" in
      *node_modules/*) ;;
      *)
        froot=\$(CDPATH= cd -- "\$(dirname "\$0")" 2>/dev/null && pwd -P)
        fresolved=\$(realpath -- "\$arg" 2>/dev/null)
        fshared=\$froot
        while [ -n "\$fshared" ]; do
          case "\$fresolved" in "\$fshared"/* | "\$fshared") break ;; esac
          fshared=\${fshared%/*}
        done
        case "\${fresolved#"\$fshared"}" in
          */node_modules/*)
            printf 'agent-test: %s resolves inside node_modules — excluded from the run, not missing\n' "\$arg" >&2
            exit 1
            ;;
        esac
        ;;
    esac
    if [ -e "\$arg" ]; then
      # An existing path is a path, whatever characters it holds. Node globs
      # its own argv, where a literal \`[\` is a bracket expression that cannot
      # match itself — so the file matches nothing, node drops it, and mixed
      # with anything resolvable that drop is silent. Escaping it is what the
      # directory branch already does to find's output (\`sed 's/\[/[[]/g'\`);
      # a file named directly needs the same escape or #100's own bracketed
      # case survives the fix meant to close it.
      arg=\$(printf '%s\n' "\$arg" | sed 's/\[/[[]/g')
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
        *[*?[]*) ;;
        # A path that does not exist and holds no metacharacter is a typo.
        # Alone it is loud already (node's own \`Could not find\`, exit 1) —
        # this is for the mixed case, where node drops it and runs the rest,
        # and the runner would otherwise report a pass for a suite that
        # never ran.
        *) printf 'agent-test: %s does not exist\n' "\$arg" >&2; exit 1 ;;
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
  excl="$(git rev-parse --git-common-dir)/info/exclude"
  grep -qx agent-test "$excl" 2>/dev/null || echo "agent-test" >> "$excl"
  printf '    wrote %s and excluded it\n' "$runner" >&2
fi

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
