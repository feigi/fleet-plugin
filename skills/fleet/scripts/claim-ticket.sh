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
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -ge 3 ] || die "usage: claim-ticket.sh <issue> <slug> <type> [--apply]"
issue=$1
slug=$2
type=$3
apply=false
[ "${4:-}" = "--apply" ] && apply=true

case "$issue" in ''|*[!0-9]*) die "issue must be a number, got '$issue'";; esac

branch="$type/$issue-$slug"
wt=".worktrees/$issue-$slug"
runner="$wt/agent-test"

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
[ -e "$wt" ] && die "$wt already exists — ticket may already be claimed"
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
elif ! ndeps=$(printf '%s' "$pkg" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(["dependencies","devDependencies","peerDependencies","optionalDependencies","workspaces"].reduce((n,k)=>n+Object.keys(p[k]||{}).length,0))' 2>&1); then
  die "could not read origin/main:package.json — $ndeps"
elif [ "$ndeps" = 0 ]; then install="true"
else die "origin/main declares $ndeps dependencies but has no lockfile — refusing to guess an install command"
fi
echo "    lockfile → install: $install" >&2

# One shape for "is a test file", shared by the emit guard below and by the
# directory expansion in the runner it writes. Separate copies would drift,
# and the two disagreeing means a directory the guard counted as a suite
# expands to nothing at run time.
testfile_re='\.(test|spec)\.[cm]?[jt]sx?$'

# The runner runs the repo's own test entrypoint. Both guesses are unsafe when
# wrong: `npm test` with no `test` script fails with an npm error that reads
# like a broken worktree, and `node --test` with no test files exits 0 — a
# runner that passes vacuously is worse than one that is dead, because the
# review fan-out consumes it as a green suite. Refuse rather than guess.
if printf '%s' "$pkg" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit((p.scripts||{}).test?0:1)' 2>/dev/null; then
  testcmd="npm test --"
elif git ls-tree -r --name-only origin/main | grep -qE "$testfile_re"; then
  testcmd="node --test"
else
  die "origin/main has no scripts.test and no test files — refusing to emit a runner that would pass vacuously"
fi
echo "    test entrypoint → $testcmd" >&2

pg=$((16000 + issue))
ollama=$((22000 + issue))
echo "    ports derive from the issue number: postgres=$pg ollama=$ollama" >&2

if [ "$apply" = false ]; then
  echo "$NAME: DRY RUN — nothing created. Pass --apply to act." >&2
  echo "    would: gh issue edit $issue --add-label in-progress" >&2
  echo "    would: git worktree add $wt -b $branch origin/main" >&2
  echo "    would: (cd $wt && $install)" >&2
  echo "    would: write $runner and add it to .git/info/exclude" >&2
else
  echo "\$ gh issue edit $issue --add-label in-progress" >&2
  gh issue edit "$issue" --add-label in-progress >/dev/null || die "could not label issue $issue"

  echo "\$ git worktree add $wt -b $branch origin/main" >&2
  git worktree add "$wt" -b "$branch" origin/main >/dev/null || die "worktree add failed"

  echo "\$ (cd $wt && $install)" >&2
  (cd "$wt" && $install >/dev/null 2>&1) || die "install failed in $wt"

  # The lockfile must be untouched by the install. Non-empty means the wrong
  # command ran, and the worktree is now corrupt for everyone. Check git's exit
  # status too: a failed status prints nothing, which is byte-identical to
  # "clean" and would let this guard pass without having verified anything.
  if ! dirty=$(git -C "$wt" status --porcelain package-lock.json pnpm-lock.yaml yarn.lock 2>&1); then
    die "could not verify lockfile state in $wt — $dirty"
  elif [ -n "$dirty" ]; then
    die "install mutated the lockfile in $wt — wrong command, fix before dispatching"
  fi
  echo "    lockfile clean after install" >&2

  # Isolation as a file, not a briefing. Env vars in a prompt were missed five
  # times in one run — including by an agent whose parent was briefed but did
  # not pass them down. Anyone who finds the worktree finds the runner.
  cat > "$runner" <<SH
#!/bin/sh
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
for arg do
  shift
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
    # Node's own discovery excludes \`node_modules\`; find does not. Without the
    # prune a vendored test runs and the suite's result hangs on third-party
    # code passing. Nested \`node_modules\` — the pnpm / workspaces shape — is
    # the live case; the top-level one is inert only because node refuses those
    # paths outright, and refused paths in a mixed argv are dropped silently.
    found=\$(find "\$arg" -type f -not -path '*/node_modules/*') || { echo "agent-test: cannot read every path under \$arg" >&2; exit 1; }
    files=\$(printf '%s\n' "\$found" | grep -E '$testfile_re' | sed 's/\[/[[]/g')
    # No \`set -e\` in this runner, and that is load-bearing: grep exits 1 on no
    # match, so under -e the shell would abort here and the refusal below would
    # never print. Read a status you care about explicitly, as find does above.
    [ -n "\$files" ] || { echo "agent-test: no test files under \$arg" >&2; exit 1; }
    set -- "\$@" \$files
  else
    set -- "\$@" "\$arg"
  fi
done
SH
  fi

  cat >> "$runner" <<SH
exec $testcmd "\$@"
SH
  chmod +x "$runner"
  excl="$(git rev-parse --git-common-dir)/info/exclude"
  grep -qx agent-test "$excl" 2>/dev/null || echo "agent-test" >> "$excl"
  echo "    wrote $runner and excluded it" >&2
fi

printf '{"issue":%s,"branch":"%s","worktree":"%s","install":"%s","ports":{"postgres":%s,"ollama":%s},"runner":"%s","applied":%s}\n' \
  "$issue" "$branch" "$wt" "$install" "$pg" "$ollama" "$runner" "$apply"
