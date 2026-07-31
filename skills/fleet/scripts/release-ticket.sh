#!/bin/sh
# Release a claim that was never dispatched: drop the in-progress label, remove
# the worktree, delete the branch — but only when the claim provably carries no
# work. The inverse of claim-ticket.sh.
#
# Dry-run by default; --apply mutates the tracker and the filesystem.
#
# reap.sh will not do this: no merge happened, so no remote branch was ever
# deleted, so the branch is not [gone] and reap's for-each-ref filter never
# selects it. (Having no unique commits is not a second reason — in reap that is
# what AUTHORIZES the delete.) Nothing else fires either, so the three artefacts
# survive the run and phase 0's in-flight probe reads the ticket as taken — the
# same silent queue shrink the reaping section names for merged tickets.
#
# Every precondition is recomputed inside THIS invocation rather than trusted
# from an earlier tool call, for the reason reap.sh gives: the dangerous
# direction is a worktree that gained work after it was checked. Only the dirty
# check is also recomputed at the moment of the delete, by git itself — that is
# what `worktree remove` without --force and `branch -d` are for, and it is why
# both run before the label is dropped rather than after. That second opinion
# covers the live-directory case ONLY: `worktree remove` gates its own clean
# check on the same stat this script does, so wherever the path cannot be
# stat'ed git reaches the same conclusion rather than an independent one, and
# the guard at the dirty check below is left as sole arbiter — which is why it
# establishes absence instead of inferring it.
set -eu

NAME=release-ticket
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -ge 3 ] && [ $# -le 4 ] || die "usage: release-ticket.sh <issue> <slug> <type> [--apply]"
issue=$1
slug=$2
type=$3
# Exact match, and nothing else tolerated in the slot: `--aply` silently became a
# dry run that still reported "released":true, so a caller keying on that field
# marked the claim released while every artefact survived — the silent queue
# shrink this script exists to undo, produced by a typo.
case "${4:-}" in
  ''|--apply) ;;
  *) die "unknown argument '$4' — the only option is --apply";;
esac
apply=false
[ "${4:-}" = "--apply" ] && apply=true

case "$issue" in ''|*[!0-9]*) die "issue must be a number, got '$issue'";; esac

branch="$type/$issue-$slug"
base=${BASE_REF:-origin/main}

# The fleet harness is exactly the caller that sets BASE_REF, and pointing it at
# the claim's own branch makes both commit guards vacuous — ahead 0 and cherry
# empty on a branch that still carries unpushed work. Only a remote-tracking ref
# can answer "is this upstream", so only one is accepted.
case "$base" in
  origin/*|refs/remotes/*) ;;
  *) die "BASE_REF must be a remote-tracking ref, got '$base'";;
esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

# Locate the worktree by the branch it has checked out, the way reap.sh does —
# not by claim-ticket.sh's ".worktrees/$issue-$slug", which is relative to the
# caller's cwd.
#
# Only a LINKED worktree is ours: `worktree list --porcelain` lists the main one
# first, and a checkout that happens to sit on this branch would otherwise be
# selected for removal. git refuses to remove it — but not before the label was
# dropped, which is the half-release this script exists to prevent. Measured in
# a fresh clone, where the branch really is the main checkout's HEAD.
#
# The path is the whole rest of the line, never $2: `worktree list --porcelain`
# prints it raw, so any checkout living under a directory with a space in it —
# ordinary on macOS — would otherwise be truncated at the first one.
wt_list=$(git worktree list --porcelain)
wt=$(printf '%s\n' "$wt_list" |
     awk -v b="refs/heads/$branch" '/^worktree /{w=substr($0,10);n++} /^branch /&&$2==b&&n>1{print w}')
main_branch=$(printf '%s\n' "$wt_list" | awk '/^worktree /{n++} n==1&&/^branch /{print $2; exit}')

# claim-ticket.sh creates the worktree on this branch, but it does not stay
# there: an interrupted rebase leaves it detached, and a member can switch it.
# The branch lookup above then finds nothing, which reads as "no worktree of
# ours" — so the dirty check is skipped entirely and the script reports a
# release that left the worktree standing, with the member's uncommitted work in
# it. Next run the in-flight probe still sees it and the ticket still reads as
# taken: the exact failure this script exists to fix, reported as success.
#
# The directory name is the one part of the claim that does not move, so match
# on it — by exact suffix, not a pattern, since <slug> is caller-supplied.
stray=$(printf '%s\n' "$wt_list" |
        awk -v d="/$issue-$slug" '/^worktree /{n++; p=substr($0,10)
          if (n>1 && substr(p, length(p)-length(d)+1) == d) {print p; exit}}')

has_branch=false
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && has_branch=true

# A mistyped <slug>/<type> names a branch that does not exist, and without this
# the run would drop the label off a ticket whose real claim is untouched —
# invisible to candidates.mjs and still in-flight. Refuse instead of guessing.
if [ "$has_branch" = false ] && [ -z "$wt" ] && [ -z "$stray" ]; then
  die "no branch $branch and no worktree on it — check the <slug> and <type> arguments"
fi

# Every string that reaches the JSON goes through here. <slug> and <type> are
# caller-supplied and git's own stderr is quoted back verbatim, so without it a
# single `"` or backslash anywhere emits a payload the caller cannot parse —
# while the delete has already happened and the exit code still says success.
#
# The whole C0 range, not just the three whitespace ones: JSON forbids every
# character below \040 unescaped, and a worktree directory may carry one where a
# branch may not (git rejects them in a ref, so `stray` — matched on the
# directory name — is the way in). Byte-safe for the UTF-8 in these messages,
# whose bytes are all >= \200. tr pads the replacement with its last character.
jstr() { printf '%s' "$1" | tr '\001-\037\177' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# A mutation refused with earlier ones already applied. `die` printed prose and
# exited before every printf, so a caller parsing this script's stdout got
# nothing at all out of the one case where it most needs to know what happened.
# Enumerate what landed, name the compensating action, still emit the receipt.
done_wt=false
done_branch=false
halt() {
  echo "$NAME: #$issue PARTIALLY RELEASED — $1" >&2
  echo "    worktree removed: $done_wt, branch deleted: $done_branch, in-progress: still on the issue" >&2
  echo "    the ticket still reads as taken — finish or restore it by hand" >&2
  printf '{"issue":%s,"branch":"%s","worktree":"%s","label":%s,"released":false,"applied":true,"blockers":["%s"]}\n' \
    "$issue" "$(jstr "$branch")" "$(jstr "$wt")" "$has_label" "$(jstr "$1")"
  exit 2
}

blockers=""
block() { blockers="${blockers}\"$(jstr "$1")\","; echo "    BLOCKED: $1" >&2; }

if [ "$main_branch" = "refs/heads/$branch" ]; then
  block "branch $branch is checked out in the main checkout — release it from elsewhere"
fi

if [ -z "$wt" ] && [ -n "$stray" ]; then
  block "worktree $stray is this claim's but is not on $branch — release it by hand"
fi

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
  #
  # Run and count in two steps. Piped straight into `grep -c ... || true`, a
  # `git cherry` that failed outright (rc 128 on a corrupt object store, say)
  # yielded a count of 0 and the check silently passed; only the `ahead` guard
  # above, failing on the same conditions, kept that from being a delete.
  cherry=$(git cherry "$base" "refs/heads/$branch") ||
    die "git cherry failed on $branch against $base, so whether it carries unique commits is unknown"
  uniq=$(printf '%s' "$cherry" | grep -c '^+' || true)
  [ "$uniq" -eq 0 ] || block "$uniq commit(s) unique to $branch (git cherry)"
fi

# A pushed branch — work that survives the local delete and that a PR may
# already point at. Live query, so this one cannot be stale; a failure here is
# an unknown answer, never a "no".
# stderr stays on stderr, never folded into the value: the emptiness of $remote
# IS the answer, so an SSH host-key notice on a successful query used to read as
# a branch that exists. git's own message is more useful on the terminal anyway.
if ! remote=$(git ls-remote --heads origin "refs/heads/$branch"); then
  die "git ls-remote failed, so whether $branch was pushed is unknown"
fi
[ -z "$remote" ] || block "branch $branch exists on origin"

# `-d`, because a directory that is not there holds no uncommitted work. Deleted
# by hand, a worktree leaves its admin files registered, so `worktree list
# --porcelain` keeps listing the entry and the status below ran against a path
# that is gone: it failed, the die read that as "unknown", and the claim could
# then never be released — label, branch and worktree entry all surviving every
# run while the in-flight probe kept reading the ticket as taken. git agrees at
# the delete: `worktree remove` accepts the gone entry and clears the admin
# files outright, so the `prune` below finds nothing left to do (verified, git
# 2.50.1) — and it is only reachable at all once that remove has succeeded.
#
# Not git's own `prunable` annotation, which marks this entry but is not the
# same question: removing only a LIVE worktree's .git file marks it `prunable`
# too, with the directory and every uncommitted change still sitting in it.
# Keying on the annotation would skip the check on that one, and `worktree
# remove` then refuses it (rc 128) — so instead of the refusal the linkage guard
# below reaches on its own, the run gets as far as `halt` and exits 2 announcing
# a partial release that never happened, on a worktree still holding the work.
#
# Absence is ESTABLISHED here, never inferred from a failed -d, because -d is
# also false for a directory we are not permitted to stat. git cannot separate
# those two either: it marks both `prunable`, and `worktree remove` ACCEPTS a
# prunable-because-absent entry (rc 0) — a live worktree whose .git was merely
# deleted it refuses instead — so the delete-time recomputation the header leans
# on is the one thing absent on this path and this test is the only check left
# standing. Read as "gone", an unsearchable prefix released the claim — branch
# deleted, label dropped, exit 0, `"blockers":[]` — with the member's
# uncommitted work still on disk and now orphaned. So walk up to the nearest
# ancestor that does exist and require THAT to be searchable: only then is "not
# there" a measurement rather than a guess. The walk is what keeps `rm -rf
# .worktrees` answerable — the parent goes with the child, and testing the
# immediate parent alone reads its absence as unknown and puts that case back
# on the permanent exit 2 this fix exists to end.
look=$wt
# `!=`, not a non-empty test: `${p%/*}` returns p unchanged when p holds no
# slash, so the emptiness form spins forever on one. git emits absolute paths
# here, but a delete script may not hang on the input that proves otherwise.
while [ ! -e "$look" ] && [ "$look" != "${look%/*}" ]; do look=${look%/*}; done
if [ -n "$wt" ] && [ ! -e "$wt" ] && [ ! -x "$look" ]; then
  die "cannot tell whether $wt exists, so whether it holds uncommitted work is unknown"
fi

if [ -n "$wt" ] && [ -d "$wt" ]; then
  # Establish that a .git linkage EXISTS before believing the status below.
  # Delete the .git file outright — directory and every uncommitted file still on
  # disk — and `git -C` does not fail: it walks UP to the enclosing repository and
  # reports the PARENT's status at rc 0. `.worktrees/` is gitignored here, so the
  # worktree never appears in that status either: with a clean parent the answer
  # is empty, a positive assertion that the claim is clean produced without ever
  # having looked at it. The -d gate above does not reach it (the directory is
  # there) and neither does the status die below (git succeeded).
  #
  # Existence, NOT "points at this worktree", which is deliberately not claimed:
  # a .git naming a gitdir whose core.worktree is some other directory passes
  # this and still answers about that other tree at rc 0 (measured). Stopped
  # downstream by `worktree remove` today, and left to its own ticket rather
  # than widened into here.
  #
  # `-f` and not `-e`: an empty `.git` DIRECTORY leaks exactly like an absent
  # one — git walks up and reports the parent at rc 0 — and -e is true for it
  # (measured). A linked worktree's .git is always a regular file, since
  # `git worktree add` writes one, so -f costs nothing and refuses that too. A
  # dangling .git symlink is likewise rc 0, not the rc 128 the status die needs,
  # so this guard is what catches that one as well.
  #
  # `! -x` for the reason the block above gives: -f is ALSO false for a .git we
  # are not permitted to stat, and this guard may not infer absence from that any
  # more than -d may. An unsearchable worktree still has its .git, so leave it to
  # the status die, which keeps git's own "Permission denied" rather than
  # asserting an absence nothing established (measured: chmod 644 on the worktree
  # makes -f false with the .git sitting right there).
  [ -f "$wt/.git" ] || [ ! -x "$wt" ] || die "$wt has no .git file, so whether it holds uncommitted work is unknown"
  # Same reason: folded-in stderr would be counted as uncommitted changes.
  if ! dirty=$(git -C "$wt" status --porcelain); then
    die "cannot read the status of $wt, so whether it holds uncommitted work is unknown"
  fi
  # Ignored files are deliberately not a blocker: claim-ticket.sh writes
  # agent-test and excludes it, so every fleet worktree has one, and blocking on
  # it would strand every claim. `git worktree remove` deletes ignored files
  # silently and refuses on modified and untracked ones (verified, git 2.50.1) —
  # which is this same check, recomputed by git at the moment of the delete.
  n=$(printf '%s' "$dirty" | grep -c . || true)
  [ "$n" -eq 0 ] || block "worktree $wt has $n uncommitted change(s)"
fi

# Report the blockers before asking GitHub anything. The answer cannot change —
# every artefact stays put either way — and reaching for the tracker first turns
# an offline blocked claim into an unanswerable one, burying the finding the
# caller actually needs. "label":null says it was never read.
if [ -n "$blockers" ]; then
  echo "$NAME: #$issue NOT released — nothing was touched" >&2
  printf '{"issue":%s,"branch":"%s","worktree":"%s","label":null,"released":false,"applied":%s,"blockers":[%s]}\n' \
    "$issue" "$(jstr "$branch")" "$(jstr "$wt")" "$apply" "${blockers%,}"
  exit 1
fi

# Read the label before touching anything, so a tracker that cannot answer stops
# the run before any delete rather than halfway through it.
#
# One name per line, matched whole. Captured with 2>&1 and substring-matched,
# any stderr from a SUCCESSFUL gh — its "a new release is available" notice, an
# auth warning — broke the delimiting, the match missed, and the script deleted
# the worktree and the branch while leaving in-progress on the ticket: exit 0,
# "label":false, indistinguishable from a legitimately already-dropped label,
# and the ticket invisible to candidates.mjs with no artefact left to explain it.
echo "\$ gh issue view $issue --json labels" >&2
if ! labels=$(gh issue view "$issue" --json labels --jq '.labels[].name'); then
  die "gh issue view $issue failed, so the in-progress label cannot be released"
fi
if printf '%s\n' "$labels" | grep -qx in-progress; then has_label=true; else has_label=false; fi

if [ "$apply" = false ]; then
  echo "$NAME: DRY RUN — nothing removed. Pass --apply to act." >&2
  [ "$has_label" = true ] && echo "    would: gh issue edit $issue --remove-label in-progress" >&2
  [ -n "$wt" ] && echo "    would: git worktree remove $wt" >&2
  [ "$has_branch" = true ] && echo "    would: git branch -d $branch" >&2
else
  # Label LAST. The two local deletes are the ones that refuse — that refusal is
  # the dirty check recomputed by git at the moment of the delete, so it is
  # expected, not exceptional. Dropping the label first meant every such refusal
  # left in-progress already gone: with the worktree still standing the ticket
  # read free to candidates.mjs while re-claiming failed on the existing branch.
  # Run them first and a refusal leaves the claim exactly as it was, label and
  # all, which reads as still taken — the direction that costs nothing.
  if [ -n "$wt" ]; then
    # No --force, ever. A refusal is a finding to report, never something to
    # force past. Quote git's own reason: this fires precisely when something
    # appeared that the checks above did not see, so naming a cause here would
    # be a guess.
    echo "\$ git worktree remove $wt" >&2
    if ! err=$(git worktree remove "$wt" 2>&1); then
      halt "git worktree remove refused $wt: $(printf '%s' "$err" | tr '\n' ' ')"
    fi
    done_wt=true
  fi

  if [ "$has_branch" = true ]; then
    # -d, never -D. Unlike reap.sh's [gone] branches, this one still has its
    # upstream, so -d compares against THAT — origin/main for a fresh claim —
    # and accepts an unmodified claim even when local main is behind. A refusal
    # means the branch carries something the checks above did not see.
    echo "\$ git branch -d $branch" >&2
    if ! err=$(git branch -d "$branch" 2>&1); then
      halt "git branch -d refused $branch: $(printf '%s' "$err" | tr '\n' ' ')"
    fi
    done_branch=true
  fi

  if [ "$has_label" = true ]; then
    echo "\$ gh issue edit $issue --remove-label in-progress" >&2
    gh issue edit "$issue" --remove-label in-progress >/dev/null ||
      halt "could not drop in-progress from issue $issue"
  fi
  # Housekeeping, and the final statement under `set -e`: unchecked, a prune
  # failure exited 1 out of a release that had fully succeeded — the code this
  # script uses for "NOT released, nothing was touched" — before printing any
  # receipt. Nothing about the release depends on it, so it cannot decide the
  # exit status.
  git worktree prune || echo "$NAME: git worktree prune failed; the release itself is done" >&2
fi

printf '{"issue":%s,"branch":"%s","worktree":"%s","label":%s,"released":true,"applied":%s,"blockers":[]}\n' \
  "$issue" "$(jstr "$branch")" "$(jstr "$wt")" "$has_label" "$apply"
