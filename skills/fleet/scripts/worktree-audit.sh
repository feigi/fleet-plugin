#!/bin/sh
# Per worktree: how many commits ahead of the base, and what is uncommitted.
#
# Run before dispatching a replacement for a killed member. The distinction that
# matters is committed-and-pushed vs committed-only vs uncommitted-in-the-worktree:
# only the last exists nowhere else, and a replacement told the wrong one will
# either redo finished work or destroy unfinished work.
#
# Read-only. Never exits non-zero for a dirty or absent worktree — that is the
# finding, not an error. A worktree that IS present but whose git commands
# fail (permissions, corrupt git dir) is reported readable:false with null
# counts — never silently as ahead:0, dirty:0, which reads as "nothing here,
# safe to discard" and is indistinguishable from a genuinely empty worktree.
set -eu

NAME=worktree-audit
die() { echo "$NAME: $1" >&2; exit 2; }

base=${BASE_REF:-origin/main}
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

echo "\$ git worktree list --porcelain" >&2

first=1
printf '['
git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{print w"\t"$2} /^detached$/{print w"\tDETACHED"}' |
while IFS="$(printf '\t')" read -r wt br; do
  short=${br#refs/heads/}
  if [ -d "$wt" ]; then
    # Chain on `&&`, not `|| echo 0`: a piped `wc -l` always exits 0 even when
    # the git command feeding it failed, so a fallback tacked onto the pipe
    # never fires and a permissions/corruption failure reads as "0 ahead, 0
    # dirty" — indistinguishable from a genuinely clean worktree.
    if ahead=$(git -C "$wt" rev-list --count "$base"..HEAD 2>/dev/null) \
       && status_out=$(git -C "$wt" status --porcelain 2>/dev/null); then
      readable=true
      dirty=$(printf '%s\n' "$status_out" | awk 'NF{c++} END{print c+0}')
      files=$(printf '%s\n' "$status_out" | awk 'NF{print "\""$2"\""}' | paste -sd, -)
    else
      readable=false
      ahead=null; dirty=null; files=""
      echo "    UNREADABLE: $wt (git rev-list/status failed — treat as unknown, not empty)" >&2
    fi
  else
    readable=false
    ahead=0; dirty=0; files=""
    echo "    MISSING on disk: $wt" >&2
  fi
  echo "    $wt  branch=$short  ahead=$ahead  dirty=$dirty" >&2
  [ "$first" = 1 ] || printf ','
  first=0
  printf '{"worktree":"%s","branch":"%s","ahead":%s,"dirty":%s,"dirtyFiles":[%s],"readable":%s}' \
    "$wt" "$short" "$ahead" "$dirty" "$files" "$readable"
done
printf ']\n'
