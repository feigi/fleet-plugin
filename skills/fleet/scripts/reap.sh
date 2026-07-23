#!/bin/sh
# Delete local branches whose upstream is gone, and their worktrees.
#
# Dry-run by default; --apply mutates. Every precondition is recomputed inside
# this invocation, because a branch list from an earlier call is already false:
# one observed run listed 28 gone branches and two calls later 27 had been
# reaped by a concurrent session.
#
# Deliberately NOT `/clean_gone`: its `[gone]` detection actually works —
# with an upstream configured, `git branch -v` does print `[gone]` and its
# grep matches (verified, git 2.50.1). It is disqualified because it then
# runs `git worktree remove --force` and `git branch -D` with no merged
# check at all: nothing there stops it deleting a branch whose commits exist
# nowhere else.
set -eu

NAME=reap
die() { echo "$NAME: $1" >&2; exit 2; }

apply=false
[ "${1:-}" = "--apply" ] && apply=true
[ $# -gt 1 ] && die "usage: reap.sh [--apply]"

base=${BASE_REF:-origin/main}
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

echo "\$ git fetch --prune origin" >&2
git fetch --prune --quiet origin || die "fetch failed — refusing to reap on stale refs"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"
[ "$apply" = true ] || echo "$NAME: DRY RUN — nothing will be deleted. Pass --apply to act." >&2

reaped=""
kept=""
keep() { kept="${kept}{\"branch\":\"$1\",\"reason\":\"$2\"}," ; echo "    KEEP $1 — $2" >&2; }

# %(upstream:track) emits exactly [gone] as its own field — nothing to
# pattern-match, and no -v/-vv trap.
for b in $(git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads |
           awk '$2=="[gone]"{print $1}'); do

  # git cherry against origin/main, not a local main: a local main never
  # fast-forwarded reads every merged branch as unmerged. Any + line is a commit
  # that exists nowhere else.
  if git cherry "$base" "$b" 2>/dev/null | grep -q '^+'; then
    keep "$b" "unmerged commits"
    continue
  fi

  wt=$(git worktree list --porcelain |
       awk -v b="refs/heads/$b" '/^worktree /{w=$2} /^branch /&&$2==b{print w}')

  if [ -n "$wt" ]; then
    if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null || echo dirty)" ]; then
      keep "$b" "dirty worktree $wt"
      continue
    fi
    # `git worktree remove` refuses on modified and untracked files, but NOT on
    # ignored ones — it deletes those silently. claim-ticket.sh writes exactly
    # this kind of file (its agent-test runner, appended to info/exclude), and
    # any .env or scratch file a fleet script ignores is equally invisible to
    # the plain --porcelain check above. Check --ignored explicitly and keep.
    if ! ignored_raw=$(git -C "$wt" status --porcelain --ignored 2>/dev/null); then
      keep "$b" "worktree $wt unreadable (git status --ignored failed)"
      continue
    fi
    ignored=$(printf '%s\n' "$ignored_raw" | awk '/^!! /{sub(/^!! /,""); print}' | paste -sd, -)
    if [ -n "$ignored" ]; then
      keep "$b" "ignored files present in $wt: $ignored"
      continue
    fi
    if [ "$apply" = true ]; then
      # No --force, ever. It refuses on modified and untracked files; the
      # ignored-file gap it does NOT cover is handled by the check above.
      git worktree remove "$wt" 2>/dev/null || { keep "$b" "worktree remove refused"; continue; }
    else
      echo "    would remove worktree $wt" >&2
    fi
  fi

  if [ "$apply" = true ]; then
    # -D is authorized by the cherry check above and by nothing else. -d would
    # refuse everything here: upstream is gone, so it compares against a
    # possibly-behind local HEAD.
    git branch -D "$b" >/dev/null 2>&1 || { keep "$b" "branch delete failed"; continue; }
    echo "    REAPED $b" >&2
  else
    echo "    would reap $b" >&2
  fi
  reaped="${reaped}\"$b\","
done

[ "$apply" = true ] && git worktree prune

printf '{"applied":%s,"reaped":[%s],"kept":[%s]}\n' \
  "$apply" "${reaped%,}" "${kept%,}"
