#!/bin/sh
# Is ticket <N> already being worked on?
#
# Three probes, all of them, every time: an existing PR, a remote branch, a
# local worktree or branch. Any hit means taken. They are not redundant — a PR
# can exist with its branch deleted, a branch can exist with no PR yet, and a
# worktree can exist before anything is pushed.
#
# Exit 0 free, 1 taken, 2 the question could not be answered.
set -eu

NAME=inflight
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -eq 1 ] || die "usage: inflight.sh <issue-number>"
n=$1
case "$n" in ''|*[!0-9]*) die "issue must be a number, got '$n'";; esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

hits=""
add_hit() { hits="${hits}\"$1\","; echo "    HIT: $1" >&2; }

# Probe 1 — a PR that is actually ABOUT this ticket.
#
# NOT `gh pr list --search "<N>"` on its own. That is a full-text search and is
# uselessly noisy: measured here, searching 41 returned six PRs, five of which
# merely contained the digits somewhere. Trusting it makes nearly every ticket
# read as taken, so the fleet skips free work silently and permanently.
#
# Nor a closing-keyword regex over the body. Also measured here: PR #344 is a
# docs fix ABOUT issue references, so its body quotes `Closes #41.` inside a
# markdown table. A regex cannot tell quoted text from a real link.
#
# Ask GitHub instead. `closedByPullRequestsReferences` is its own resolution of
# which PRs close this issue — it returns [] for 41 and [396] for 393, both
# correct. Then add branch-segment matching as a second signal, because a PR can
# exist before anyone writes a closing keyword.
echo "\$ gh issue view $n --json closedByPullRequestsReferences" >&2
if ! linked=$(gh issue view "$n" --json closedByPullRequestsReferences --jq \
                '[.closedByPullRequestsReferences[]|"#\(.number) (linked)"]|join(", ")' 2>/tmp/.inflight.$$); then
  err=$(cat /tmp/.inflight.$$ 2>/dev/null || true); rm -f /tmp/.inflight.$$
  # "No such issue" and "GitHub is unreachable" are different facts and must not
  # share a message. An unattended fleet reading a network blip as "that ticket
  # does not exist" would drop real work on the floor.
  # GitHub's text is "Could not resolve to an issue or pull request with the
  # number of N" — issues and PRs share one number space, so the wording covers
  # both and the match must not assume a capital I.
  case "$err" in
    *"Could not resolve"*|*"not found"*|*"NOT_FOUND"*)
      die "issue #$n does not exist in this repository" ;;
    *)
      die "gh issue view $n failed, so #$n's PR links are unknown: $(printf '%s' "$err" | tr '\n' ' ')" ;;
  esac
fi
rm -f /tmp/.inflight.$$

echo "\$ gh pr list --state all --search $n --json number,state,headRefName" >&2
pr_json=$(gh pr list --state all --search "$n" --limit 100 \
            --json number,state,headRefName 2>/dev/null) \
  || die "gh pr list failed — cannot determine whether #$n is taken"

by_branch=$(printf '%s' "$pr_json" | NUM="$n" python3 -c '
import json, os, re, sys
n = os.environ["NUM"]
seg = re.compile(r"(^|[/-])" + re.escape(n) + r"([-/]|$)")
# Only an OPEN PR is in-flight. A merged PR means the work is done; a closed,
# unmerged PR means it was abandoned. Either would otherwise make a finished
# or dead ticket read as taken forever.
print(", ".join(
    "#%s %s (branch)" % (p["number"], p["state"])
    for p in json.load(sys.stdin)
    if seg.search(p.get("headRefName") or "") and p.get("state") == "OPEN"
))') || die "could not filter PR search results for #$n"

raw=$(printf '%s' "$pr_json" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')
pr=$(printf '%s' "$linked${linked:+${by_branch:+, }}$by_branch")
if [ -n "$pr" ]; then
  echo "    PRs for #$n: $pr   ($raw full-text match(es) considered)" >&2
  add_hit "pr"
else
  echo "    no PR is about #$n ($raw full-text match(es) were all incidental)" >&2
fi

# Probe 2 — a remote branch carrying the number as its own path segment.
echo "\$ git ls-remote --heads origin" >&2
remote=$(git ls-remote --heads origin 2>/dev/null | awk '{print $2}' | sed 's#refs/heads/##' |
         grep -E "(^|[/-])$n([-/]|$)" | paste -sd, - || true)
if [ -n "$remote" ]; then
  echo "    remote branches: $remote" >&2
  add_hit "remote-branch"
else
  echo "    no remote branch for #$n" >&2
fi

# Probe 3 — a local worktree or branch.
local_b=$(git for-each-ref --format='%(refname:short)' refs/heads |
          grep -E "(^|[/-])$n([-/]|$)" | paste -sd, - || true)
wt=$(git worktree list --porcelain | awk '/^worktree /{print $2}' |
     grep -E "(^|[/-])$n([-/]|$)" | paste -sd, - || true)
if [ -n "$local_b" ] || [ -n "$wt" ]; then
  [ -n "$local_b" ] && echo "    local branches: $local_b" >&2
  [ -n "$wt" ] && echo "    worktrees: $wt" >&2
  add_hit "local"
else
  echo "    no local branch or worktree for #$n" >&2
fi

if [ -n "$hits" ]; then
  taken=true
  rc=1
else
  taken=false
  rc=0
fi
echo "$NAME: #$n taken=$taken" >&2

printf '{"issue":%s,"taken":%s,"hits":[%s],"evidence":{"pr":"%s","remote":"%s","localBranch":"%s","worktree":"%s"}}\n' \
  "$n" "$taken" "${hits%,}" "$pr" "$remote" "$local_b" "$wt"
exit "$rc"
