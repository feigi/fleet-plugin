#!/bin/sh
# Release a claim that was never dispatched: drop the in-progress label, remove
# the worktree, delete the branch — but only when the claim provably carries no
# work. The inverse of claim-ticket.sh.
#
# Dry-run by default; --apply mutates the tracker and the filesystem.
#
# reap.sh will not do this: an undispatched claim's branch is not [gone] and has
# no unique commits, so it is correctly not reapable. Nothing else fires either,
# so the three artefacts survive the run and phase 0's in-flight probe reads the
# ticket as taken — the same silent queue shrink the reaping section names for
# merged tickets.
#
# Every precondition is recomputed inside THIS invocation, immediately before
# the delete, for the reason reap.sh gives: a check from an earlier tool call is
# already false, and the dangerous direction is a worktree that gained work
# after it was checked.
set -eu

NAME=release-ticket
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -ge 3 ] || die "usage: release-ticket.sh <issue> <slug> <type> [--apply]"
issue=$1
slug=$2
type=$3
apply=false
[ "${4:-}" = "--apply" ] && apply=true

case "$issue" in ''|*[!0-9]*) die "issue must be a number, got '$issue'";; esac

branch="$type/$issue-$slug"
base=${BASE_REF:-origin/main}

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

# Locate the worktree by the branch it has checked out, the way reap.sh does —
# not by claim-ticket.sh's ".worktrees/$issue-$slug", which is relative to the
# caller's cwd. claim-ticket.sh always creates the worktree ON this branch, so
# no match means there is no worktree of ours to remove.
wt=$(git worktree list --porcelain |
     awk -v b="refs/heads/$branch" '/^worktree /{w=$2} /^branch /&&$2==b{print w}')

has_branch=false
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && has_branch=true

# A mistyped <slug>/<type> names a branch that does not exist, and without this
# the run would drop the label off a ticket whose real claim is untouched —
# invisible to candidates.mjs and still in-flight. Refuse instead of guessing.
if [ "$has_branch" = false ] && [ -z "$wt" ]; then
  die "no branch $branch and no worktree on it — check the <slug> and <type> arguments"
fi

blockers=""
block() { blockers="${blockers}\"$1\","; echo "    BLOCKED: $1" >&2; }

if [ "$has_branch" = true ]; then
  # Commits ahead — a member that did work. Measured on the branch ref rather
  # than the worktree's HEAD: the worktree above was located BY that ref, so the
  # two agree, and this still runs when the worktree is already gone.
  ahead=$(git rev-list --count "$base..refs/heads/$branch") ||
    die "cannot count commits on $branch against $base"
  [ "$ahead" -eq 0 ] || block "$ahead commit(s) ahead of $base"

  # Commits that exist nowhere else. Against the remote-tracking ref, never a
  # local main: a local main you never fast-forwarded reads every merged branch
  # as unmerged. Stricter than `ahead` in what it means, weaker in what it
  # catches — a commit already cherry-picked upstream is upstream-equivalent
  # here (a `-` line) and only `ahead` blocks it. Both, or that one walks.
  uniq=$(git cherry "$base" "refs/heads/$branch" | grep -c '^+' || true)
  [ "$uniq" -eq 0 ] || block "$uniq commit(s) unique to $branch (git cherry)"
fi

# A pushed branch — work that survives the local delete and that a PR may
# already point at. Live query, so this one cannot be stale; a failure here is
# an unknown answer, never a "no".
if ! remote=$(git ls-remote --heads origin "refs/heads/$branch" 2>&1); then
  die "git ls-remote failed, so whether $branch was pushed is unknown: $(printf '%s' "$remote" | tr '\n' ' ')"
fi
[ -z "$remote" ] || block "branch $branch exists on origin"

if [ -n "$wt" ]; then
  if ! dirty=$(git -C "$wt" status --porcelain 2>&1); then
    die "cannot read the status of $wt: $(printf '%s' "$dirty" | tr '\n' ' ')"
  fi
  # Ignored files are deliberately not a blocker: claim-ticket.sh writes
  # agent-test and excludes it, so every fleet worktree has one, and blocking on
  # it would strand every claim. `git worktree remove` deletes ignored files
  # silently and refuses on modified and untracked ones (verified, git 2.50.1) —
  # which is this same check, recomputed by git at the moment of the delete.
  n=$(printf '%s' "$dirty" | grep -c . || true)
  [ "$n" -eq 0 ] || block "worktree $wt has $n uncommitted change(s)"
fi

# Read the label before touching anything: a release that removes the worktree
# and branch but leaves in-progress hides the ticket from candidates.mjs, which
# is worse than not releasing at all. All three artefacts or none.
echo "\$ gh issue view $issue --json labels" >&2
if ! labels=$(gh issue view "$issue" --json labels --jq '[.labels[].name]|join(",")' 2>&1); then
  die "gh issue view $issue failed, so the in-progress label cannot be released: $(printf '%s' "$labels" | tr '\n' ' ')"
fi
case ",$labels," in *,in-progress,*) has_label=true;; *) has_label=false;; esac

if [ -n "$blockers" ]; then
  echo "$NAME: #$issue NOT released — nothing was touched" >&2
  printf '{"issue":%s,"branch":"%s","worktree":"%s","label":%s,"released":false,"applied":%s,"blockers":[%s]}\n' \
    "$issue" "$branch" "$wt" "$has_label" "$apply" "${blockers%,}"
  exit 1
fi

if [ "$apply" = false ]; then
  echo "$NAME: DRY RUN — nothing removed. Pass --apply to act." >&2
  [ "$has_label" = true ] && echo "    would: gh issue edit $issue --remove-label in-progress" >&2
  [ -n "$wt" ] && echo "    would: git worktree remove $wt" >&2
  [ "$has_branch" = true ] && echo "    would: git branch -d $branch" >&2
else
  if [ "$has_label" = true ]; then
    echo "\$ gh issue edit $issue --remove-label in-progress" >&2
    gh issue edit "$issue" --remove-label in-progress >/dev/null ||
      die "could not drop in-progress from issue $issue — nothing else was touched"
  fi

  if [ -n "$wt" ]; then
    # No --force, ever. Its refusal is the dirty check recomputed at delete time,
    # and a refusal is a finding to report, never something to force past.
    echo "\$ git worktree remove $wt" >&2
    git worktree remove "$wt" || die "git worktree remove refused $wt — branch $branch kept"
  fi

  if [ "$has_branch" = true ]; then
    # -d, never -D. Unlike reap.sh's [gone] branches, this one still has its
    # upstream, so -d compares against origin/main and accepts an unmodified
    # claim even when local main is behind. A refusal means the branch carries
    # something the checks above did not see — report it, do not escalate.
    echo "\$ git branch -d $branch" >&2
    git branch -d "$branch" >/dev/null || die "git branch -d refused $branch — it is not merged into $base"
  fi
  git worktree prune
fi

printf '{"issue":%s,"branch":"%s","worktree":"%s","label":%s,"released":true,"applied":%s,"blockers":[]}\n' \
  "$issue" "$branch" "$wt" "$has_label" "$apply"
