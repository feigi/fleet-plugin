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
# $1 and $2 are spliced raw into the payload: a `"` or `\` in either — a branch
# name may legally carry one — still emits unparseable JSON. Pre-dates this
# script's cherry fix and is shared with the other fleet scripts; tracked as #119.
keep() { kept="${kept}{\"branch\":\"$1\",\"reason\":\"$2\"}," ; echo "    KEEP $1 — $2" >&2; }

# %(upstream:track) emits exactly [gone] as its own field — nothing to
# pattern-match, and no -v/-vv trap.
for b in $(git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads |
           awk '$2=="[gone]"{print $1}'); do

  # git cherry against origin/main, not a local main: a local main never
  # fast-forwarded reads every merged branch as unmerged. Any + line is a commit
  # that exists nowhere else.
  #
  # Captured, not piped: `cmd | grep -q` takes grep's exit status, never cmd's,
  # so a `git cherry` that dies (exit 128 — one unreadable loose object is
  # enough) prints nothing, grep sees empty input and exits 1 — the identical
  # verdict a genuinely clean cherry produces, so "merged" is indistinguishable
  # from "the probe could not answer". An unmerged branch is never the ambiguous
  # one: its `+` line makes grep exit 0 and always keeps. -D is authorized by
  # this check and by nothing else, so an unanswerable probe must KEEP, the
  # same fail-closed shape the worktree `status` check below already uses.
  if ! cherry=$(git cherry "$base" "$b" 2>&1); then
    keep "$b" "cherry probe failed — cannot tell if merged: $(printf '%s' "$cherry" | tr '\n' ' ')"
    continue
  fi
  # A `+` only at line start is a commit. $cherry holds stderr too — 2>&1 above,
  # so the failure reason can carry git's own words — and an unanchored match
  # reads a `+` anywhere in a diagnostic as a commit line, keeping a branch that
  # is merged. This pipe is safe where the one it replaces was not: it consumes
  # a variable, never git, and git's status was already taken on the line above,
  # so grep's is the only status left to take. Anchored like release-ticket.sh's.
  if printf '%s\n' "$cherry" | grep -q '^+'; then
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
    # ignored ones — it deletes those silently. In a NON-fleet worktree a precious
    # ignored file (.env, scratch) must not vanish, so check --ignored and keep.
    # A fleet worktree is different: claim-ticket.sh creates it under .worktrees/
    # fresh from origin/main. Merged (cherry-clean above) + tracked-clean
    # (--porcelain above), its ONLY ignored files are machine-generated
    # (agent-test, node_modules, build output) — nothing precious. Since every
    # fleet worktree carries them, keeping on ignored files would strand them all
    # and defeat reap. Run the ignored-keep for non-fleet trees only, keyed on the
    # .worktrees/ home (robust to an older tree that predates the agent-test marker).
    case "$wt" in
      */.worktrees/*) : ;;
      *)
        if ! ignored_raw=$(git -C "$wt" status --porcelain --ignored 2>/dev/null); then
          keep "$b" "worktree $wt unreadable (git status --ignored failed)"
          continue
        fi
        ignored=$(printf '%s\n' "$ignored_raw" | awk '/^!! /{sub(/^!! /,""); print}' | paste -sd, -)
        if [ -n "$ignored" ]; then
          keep "$b" "ignored files present in $wt: $ignored"
          continue
        fi
        ;;
    esac
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
