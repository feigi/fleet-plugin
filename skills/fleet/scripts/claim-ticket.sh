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

# Derive the frozen install from the lockfile. No match is a refusal, not a
# default — guessing here is what corrupts the tree.
if   [ -f package-lock.json ]; then install="npm ci"
elif [ -f pnpm-lock.yaml ];   then install="pnpm i --frozen-lockfile"
elif [ -f yarn.lock ];        then install="yarn --immutable"
else die "no recognised lockfile — refusing to guess an install command"
fi
echo "    lockfile → install: $install" >&2

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
  # command ran, and the worktree is now corrupt for everyone.
  if [ -n "$(git -C "$wt" status --porcelain package-lock.json pnpm-lock.yaml yarn.lock 2>/dev/null)" ]; then
    die "install mutated the lockfile in $wt — wrong command, fix before dispatching"
  fi
  echo "    lockfile clean after install" >&2

  # Isolation as a file, not a briefing. Env vars in a prompt were missed five
  # times in one run — including by an agent whose parent was briefed but did
  # not pass them down. Anyone who finds the worktree finds the runner.
  cat > "$runner" <<SH
#!/bin/sh
export TEST_COMPOSE_PROJECT=ab-$issue TEST_POSTGRES_PORT=$pg TEST_OLLAMA_PORT=$ollama
exec npm test -- "\$@"
SH
  chmod +x "$runner"
  echo "agent-test" >> "$(git rev-parse --git-common-dir)/info/exclude"
  echo "    wrote $runner and excluded it" >&2
fi

printf '{"issue":%s,"branch":"%s","worktree":"%s","install":"%s","ports":{"postgres":%s,"ollama":%s},"runner":"%s","applied":%s}\n' \
  "$issue" "$branch" "$wt" "$install" "$pg" "$ollama" "$runner" "$apply"
