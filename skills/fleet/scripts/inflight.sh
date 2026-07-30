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
echo "\$ gh issue view $n --json closedByPullRequestsReferences,url" >&2
# URLs, not bare numbers. A closing reference may live in another repository
# (`Closes owner/repo#N` is legal, which is why the node carries `repository`),
# and a bare number would collide with an unrelated local PR of the same number
# and silently inherit its state. A URL is globally unique, so the lookup below
# cannot mismatch. The issue's own URL rides along as the first field to name
# the repo the search window covers — same call, no extra round-trip.
if ! linked=$(gh issue view "$n" --json closedByPullRequestsReferences,url --jq \
                '[.url] + [.closedByPullRequestsReferences[].url] | join(",")' 2>/tmp/.inflight.$$); then
  err=$(cat /tmp/.inflight.$$ 2>/dev/null || true); rm -f /tmp/.inflight.$$
  # "No such issue" and "GitHub is unreachable" are different facts and must not
  # share a message. An unattended fleet reading a network blip as "that ticket
  # does not exist" would drop real work on the floor.
  # GitHub's text is "Could not resolve to an issue or pull request with the
  # number of N" — issues and PRs share one number space, so the wording covers
  # both and the match must not assume a capital I.
  #
  # Match the whole phrase, not a bare "Could not resolve": GitHub uses the same
  # opening for repository-level failures (renamed or deleted repo, revoked
  # access, a token that lost `repo` scope), and reporting those as "issue #N
  # does not exist" sends the reader after the wrong thing. Exit is 2 either way.
  case "$err" in
    *"Could not resolve to an "[Ii]"ssue"*|*"NOT_FOUND"*)
      die "issue #$n does not exist in this repository" ;;
    *)
      die "gh issue view $n failed, so #$n's PR links are unknown: $(printf '%s' "$err" | tr '\n' ' ')" ;;
  esac
fi
rm -f /tmp/.inflight.$$

echo "\$ gh pr list --state all --search $n --json number,state,headRefName,url" >&2
# Keep the cause, the way the `gh issue view` call twelve lines up does.
# Discarding it makes rate-limited, unauthenticated and offline read alike, and
# all three land on an operator who then has nothing to act on.
if ! pr_json=$(gh pr list --state all --search "$n" --limit 100 \
                 --json number,state,headRefName,url 2>/tmp/.inflight.$$); then
  err=$(cat /tmp/.inflight.$$ 2>/dev/null || true); rm -f /tmp/.inflight.$$
  die "gh pr list failed, so whether #$n is taken is unknown: $(printf '%s' "$err" | tr '\n' ' ')"
fi
rm -f /tmp/.inflight.$$

pr=$(printf '%s' "$pr_json" | NUM="$n" LINKED="$linked" python3 -c '
import json, os, re, sys
n = os.environ["NUM"]
seg = re.compile(r"(^|[/-])" + re.escape(n) + r"([-/]|$)")
prs = json.load(sys.stdin)
# Only an OPEN PR is in-flight. A merged PR means the work is done; a closed,
# unmerged PR means it was abandoned. Either would otherwise make a finished
# or dead ticket read as taken forever.
#
# That applies to BOTH signals, but only the branch half can read the state off
# its own source. `gh issue view --json closedByPullRequestsReferences` projects
# only {id, number, repository, url} — measured; the underlying GraphQL nodes are
# PullRequest and do carry `state`, reachable via `gh api graphql`, but that is a
# third round-trip. The `gh pr list` window is already fetched and already carries
# state, so the linked half looks itself up there. Hence one dict, two filters.
#
# Keyed by URL, not number: a linked PR can belong to another repository, where
# its number means nothing here and would collide with a local PR.
state = {p["url"]: p.get("state") for p in prs}
out = []
linked = os.environ["LINKED"].split(",")
here = "/".join(linked[0].split("/")[3:5])          # owner/repo of the issue
for url in filter(None, linked[1:]):
    # A PR linked through the Development sidebar need not carry "#N" text
    # anywhere, so the full-text window can miss it; so can a repo with more than
    # the 100 matches asked for, and so does every PR in another repository,
    # which the window never covers. An unknown state stays a hit and says "?"
    # rather than freeing the ticket: a wrong "taken" costs one skipped ticket, a
    # wrong "free" puts two agents on the same one. `or` rather than a dict
    # default, because a present-but-null state is unknown too.
    s = state.get(url) or "?"
    if s not in ("MERGED", "CLOSED"):
        repo, num = "/".join(url.split("/")[3:5]), url.rsplit("/", 1)[-1]
        # Name the repo only when it is not this one, so a foreign hit is
        # diagnosable instead of reading as a local number that does not exist.
        out.append("#%s %s (linked)" % (num, s) if repo == here
                   else "%s#%s %s (linked)" % (repo, num, s))
out += ["#%s %s (branch)" % (p["number"], p["state"]) for p in prs
        if seg.search(p.get("headRefName") or "") and p.get("state") == "OPEN"]
print(", ".join(out))') || die "could not filter PR search results for #$n"

# The `|| die` is not dead code. No *input* can reach it — the guarded python3
# above already parses this same `$pr_json` and dies 2 on anything malformed —
# but this is a second, separate process, so it can fail where the first
# succeeded: a fork failure under process-table pressure is exactly what a
# parallel fleet approaches by construction. Without the guard, `set -e` would
# exit 1 with empty stdout, and the exit contract reads 1 as "taken" — a crash
# rendered as a decision.
raw=$(printf '%s' "$pr_json" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') \
  || die "could not count the PR search results for #$n"
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
# Match on the worktree's basename, not its full path — grepping the whole
# absolute path would false-hit on any checkout whose directory happens to
# contain the ticket number as an earlier path segment (e.g. a home dir or
# a sibling directory named with digits), matching every ticket.
wt=$(git worktree list --porcelain | awk '/^worktree /{print $2}' |
     while IFS= read -r p; do printf '%s\t%s\n' "$(basename "$p")" "$p"; done |
     awk -F'\t' -v n="$n" '$1 ~ "(^|[/-])" n "([-/]|$)" {print $2}' |
     paste -sd, - || true)
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
