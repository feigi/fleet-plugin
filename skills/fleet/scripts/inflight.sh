#!/bin/sh
# Is ticket <N> already being worked on?
#
# Three probes, all of them, every time: an existing PR, a remote branch, a
# local worktree or branch. Any hit means taken. They are not redundant — a PR
# can exist with its branch deleted, a branch can exist with no PR yet, and a
# worktree can exist before anything is pushed.
#
# Exit 0 free, 1 taken, 2 the question could not be answered. A probe that
# cannot answer no longer aborts the run: it is recorded unknown and the
# other two still run, so a hit either of them already found (or still finds)
# is never discarded by a failure elsewhere. Exit 2 from a probe failure
# carries a payload — the same shape as 0 and 1, plus an "unknown" list
# naming which probes could not look. Only a failure before any probe can
# run at all (a bad argument, not being inside a git repository) still exits
# 2 with no payload — nothing has been established yet for a payload to hold.
set -eu

NAME=inflight
die() { echo "$NAME: $1" >&2; exit 2; }

[ $# -eq 1 ] || die "usage: inflight.sh <issue-number>"
n=$1
case "$n" in ''|*[!0-9]*) die "issue must be a number, got '$n'";; esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

hits=""
add_hit() { hits="${hits}\"$1\","; echo "    HIT: $1" >&2; }

# A probe that cannot answer records itself here instead of dying. Same
# shape as `hits`, same trailing-comma-then-trim pattern at the end. The
# message is printed exactly as `die` used to print it — only the exit is
# gone — so every existing diagnostic string below still reads the same on
# stderr, and a caller grepping for one is unaffected by this change.
unknown=""
add_unknown() { unknown="${unknown}\"$1\","; echo "$NAME: $2" >&2; }

# Evidence defaults. A probe that fails leaves its own field empty rather
# than unset — `set -u` would otherwise abort the payload assembly at the
# bottom for a probe that never got the chance to fill it in, and empty is
# already what "found nothing" looks like in this field, disambiguated by
# `unknown` rather than by the field itself.
pr=""
remote=""
local_b=""
wt=""

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
probe_pr() {
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
      # Terminal, not accumulated: a nonexistent issue is not a probe that
      # could not look, it is the premise every probe depends on being false.
      # Nothing has been established, so this stays a hard die like the
      # precondition checks above it — the other two probes would have
      # nothing meaningful to search for either.
      die "issue #$n does not exist in this repository" ;;
    *)
      # Unlike the branch above, this IS a probe that could not look — a
      # network blip, an auth failure, a renamed repository. Record it and
      # let probes 2 and 3 still run rather than discarding whatever they
      # might find.
      add_unknown "pr" "gh issue view $n failed, so #$n's PR links are unknown: $(printf '%s' "$err" | tr '\n' ' ')"
      return 1 ;;
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
  add_unknown "pr" "gh pr list failed, so whether #$n is taken is unknown: $(printf '%s' "$err" | tr '\n' ' ')"
  return 1
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
print(", ".join(out))') || { add_unknown "pr" "could not filter PR search results for #$n"; return 1; }

# The `|| die` is not dead code. No *input* can reach it — the guarded python3
# above already parses this same `$pr_json` and dies 2 on anything malformed —
# but this is a second, separate process, so it can fail where the first
# succeeded: a fork failure under process-table pressure is exactly what a
# parallel fleet approaches by construction. Without the guard, `set -e` would
# exit 1 with empty stdout, and the exit contract reads 1 as "taken" — a crash
# rendered as a decision.
raw=$(printf '%s' "$pr_json" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') \
  || { add_unknown "pr" "could not count the PR search results for #$n"; return 1; }
if [ -n "$pr" ]; then
  echo "    PRs for #$n: $pr   ($raw full-text match(es) considered)" >&2
  add_hit "pr"
else
  echo "    no PR is about #$n ($raw full-text match(es) were all incidental)" >&2
fi
}
# `|| :` is what makes this probe's own failure non-fatal to the run: `set -e`
# would otherwise treat `probe_pr` returning 1 as fatal exactly the way a bare
# failing command is, which is precisely the abort this whole change removes.
probe_pr || :

# Probe 2 — a remote branch carrying the number as its own path segment.
probe_remote() {
echo "\$ git ls-remote --heads origin" >&2
# The lookup runs on its own, never inside the filter below. A pipeline reports
# its LAST command's status, so an `ls-remote` that exited 128 used to arrive
# here as zero matching lines, which is precisely what a clean ticket produces.
#
# The two conditions are different answers and must stay apart: "looked, found
# nothing" leaves the ticket free; "could not look" is what exit 2 is for.
# Nothing here needs GitHub to be down: an unavailable SSH key or agent will do
# it, and `gh` authenticates over HTTPS independently, so probe 1 answers fine
# while this one cannot.
#
# stderr is left on stderr rather than folded into the value. That matters less
# here than in release-ticket.sh:173, whose pushed-branch lookup tests $remote
# raw, so a folded-in host-key notice really would read as a branch, whereas the
# awk below reduces such a line to a word no numeric segment can match. git's
# own wording is more use on the terminal anyway.
#
# This is the one network call in the script (probe 1 goes through `gh`, probe
# 3 never leaves disk), and unattended it must neither prompt nor hang (#92).
#
# GIT_TERMINAL_PROMPT=0 covers git's own username/password prompt.
# Unconditional, not gated on stdin being a tty: this script has a 0/1/2
# contract, and a human with no cached credential is better served by exit 2
# naming what is unknown than by a prompt a machine caller never answers.
#
# A suppressed prompt is not a bound: measured, a stalled transport blocks
# identically with or without GIT_TERMINAL_PROMPT=0 (killed at 8s, rc 142
# either way) — prompting and hanging are different failures. `timeout(1)`
# would be the obvious bound but is GNU coreutils, absent by default here
# (verified: neither `timeout` nor `gtimeout` on this host's PATH), so the
# bound comes from git's own transport knobs.
#
# ssh: BatchMode=yes refuses any interactive prompt (host key, passphrase)
# rather than hanging on one, so it doubles as prompt suppression for the ssh
# case.
#
# ConnectTimeout is the option that bounds the stalled transport measured
# above: it gates the banner exchange, not only the TCP handshake, so a peer
# that accepts the connection and then never speaks is cut off at
# ConnectTimeout. Measured against that exact case (OpenSSH_10.2p1, the
# accept-then-silent listener the test at inflight.test.mjs uses) — both
# options set: "Connection timed out during banner exchange" at 10.0s;
# ConnectTimeout alone, ServerAlive dropped: 10.0s, identical; ServerAlive
# alone, ConnectTimeout dropped: still running at 30s, killed from outside.
# ServerAlive keepalives only ride an established transport, and here that
# transport never comes up, so they contribute nothing to this case. Their job
# is the session that gets past banner and authentication and only then goes
# quiet, which nothing here exercises.
#
# 10s to connect and 2x5s of silence: generous enough for a slow-but-working
# link, short enough that a stalled probe does not hold a fleet slot for
# minutes. Retune here if either stops holding — but retune the right one: the
# accept-then-silent case rides on ConnectTimeout alone, so shortening
# ServerAlive does not tighten it and dropping ConnectTimeout removes it.
#
# A user's own ssh command is honoured, not replaced — options land on top of
# whatever GIT_SSH_COMMAND, core.sshCommand or GIT_SSH already says (falling
# back to plain "ssh"), so a configured identity file or proxy command still
# runs. All three, because git's own precedence is GIT_SSH_COMMAND >
# core.sshCommand > GIT_SSH: setting GIT_SSH_COMMAND here without consulting
# GIT_SSH would silently drop a wrapper the user had working before this
# probe was bounded at all.
#
# http: lowSpeedLimit/lowSpeedTime is git's (curl's) own bound for a transfer
# that goes quiet — abort if it sits under 1000 bytes/s for 10s.
#
# It bounds a transfer already under way and nothing before one, so it is a
# weaker bound than the ssh side, not a counterpart to it. Measured against the
# same accept-then-silent listener: a plain http origin aborts at 10.0s
# ("Operation too slow"), but an https one never starts a transfer at all — the
# TLS handshake does not complete, so the timer never arms and ls-remote ran
# past 120s. A dropped SYN costs curl's own 75s default on either scheme, and
# git exposes no connect knob to shorten it (`git help config` lists only these
# two http timing keys; http.connectTimeout does not exist). So an https origin
# can still hold a fleet slot the way #92 describes. Closing that needs a bound
# outside git — background the call and kill it — which is #346, not another -c.
base_ssh=$(git config --get core.sshCommand 2>/dev/null || true)
# GIT_SSH is a program PATH, not a command line, so it is quoted rather than
# pasted raw: git runs GIT_SSH_COMMAND through a shell, which would otherwise
# split a path containing spaces into a program and its arguments.
[ -n "$base_ssh" ] || base_ssh="${GIT_SSH:+\"$GIT_SSH\"}"
[ -n "$base_ssh" ] || base_ssh=ssh
if ! heads=$(GIT_TERMINAL_PROMPT=0 \
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-$base_ssh} -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2" \
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 ls-remote --heads origin); then
  add_unknown "remote" "git ls-remote failed, so whether #$n has a remote branch is unknown"
  return 1
fi
# One awk, not `awk | sed | grep | paste`. A pipeline hides every status but its
# last, and the `|| true` that used to close this one discarded that too, so a
# stage that could not run produced the same empty result a free ticket
# produces. Collapsed, the status is the filter's own and `|| die` can read it —
# and three fewer forks is three fewer ways to fail, a fork failure under
# process-table pressure being what a parallel fleet approaches by construction.
#
# `grep` is what made that delicate: it exits 1 for "looked, found nothing",
# which is legitimate and must never become exit 2. awk needs no such case
# separated out — the programs here contain no `exit`, so they return 0 whether
# or not anything matched, and every non-zero status is a real failure.
remote=$(printf '%s\n' "$heads" | LC_ALL=C awk -v n="$n" '
  { ref = $2; sub("^refs/heads/", "", ref)
    if (ref ~ "(^|[/-])" n "([-/]|$)") { out = out sep ref; sep = "," } }
  END { printf "%s", out }') ||
  { add_unknown "remote" "could not filter the remote branches for #$n"; return 1; }
if [ -n "$remote" ]; then
  echo "    remote branches: $remote" >&2
  add_hit "remote-branch"
else
  echo "    no remote branch for #$n" >&2
fi
}
probe_remote || :

# Probe 3 — a local worktree or branch.
#
# Same guard shape as probe 2, and it catches the same class: a lookup that
# could not run at all (git missing, a fork failure, an unreadable packed-refs,
# which exits 128). That is the floor, not the whole answer: git's own
# degraded reads exit 0 with output silently missing, which no exit-status
# guard can see. Measured (#95): `chmod 000` on refs/heads or on the worktree
# admin dir, and both lookups below report nothing, at rc 0, for a ticket that
# has a live branch or worktree — the same wrong "free" #76 exists to rule out,
# one probe down. Establish each storage was readable before trusting an empty
# result from it — the same rule release-ticket.sh:73 already applies to its
# own worktree-registry read (#84) — absence must be established, never
# inferred.
#
# Ceiling, left open on purpose: a single loose ref git skips as corrupt
# (`warning: ignoring broken ref refs/heads/x`, still rc 0) passes a
# directory-level read+execute test — the directory is fine, one file inside
# it is not — so it stays undetected. Only counting refs against a source
# independent of git's own read would catch that, roughly doubling this
# probe's cost, for a fault that usually breaks much else first; out of scope
# for #95.
probe_local() {
common=$(git rev-parse --path-format=absolute --git-common-dir) ||
  { add_unknown "local" "cannot resolve the git common directory"; return 1; }

refsdir="$common/refs/heads"
# Absent is fine and answers nothing here: `git init` creates this directory,
# but an unusual ref backend (e.g. reftable) may not, and that is storage this
# check does not reach either way.
if [ -e "$refsdir" ]; then
  # Two tests, and neither covers the other's case — measured, both directions.
  #
  # The builtin pair below tests only the top of refs/heads, and NO fleet branch
  # lives there: claim-ticket.sh builds `branch="$type/$issue-$slug"`, so the
  # loose ref is `refs/heads/fix/95-…` and the directory that goes unreadable is
  # `refs/heads/fix`, one level down. `chmod 000` there leaves refs/heads itself
  # at 755, the pair passes, and `for-each-ref` drops the branch at rc 0 with
  # nothing on stderr — the wrong "free" this whole change exists to stop,
  # surviving inside its own fix. Distinct from the broken-ref ceiling below:
  # there git warns, here it is silent.
  #
  # So `find` walks the subdirectories. It does not replace the pair, because
  # BSD `find` — the one `sh` resolves on macOS, /usr/bin/find — never evaluates
  # the expression for a starting point it cannot open: `refs/heads` at 000 or
  # 400 yields a stderr error and NOTHING on stdout, exactly as a healthy tree
  # does. (`bfs`, which may shadow it on an interactive PATH, does print it. A
  # guard that reads correct under one and blind under the other is not a
  # guard.) The pair covers the starting point, find covers below it.
  [ -r "$refsdir" ] && [ -x "$refsdir" ] ||
    { add_unknown "local" "refs directory $refsdir could not be read — whether #$n has a local branch is unknown"; return 1; }
  # `-exec test` rather than find's own `-readable`/`-executable`, which are GNU
  # extensions absent from BSD find. `-type d` alone is not enough either: a
  # subdirectory at 400 is readable enough for find to enter and exit 0 while
  # `for-each-ref` still drops the branch, so the permission has to be tested
  # rather than inferred from find's status. That status is unusable anyway —
  # find exits 1 on the very permission-denied descent that IS the detection —
  # so the `|| die` reads head's status, the one thing here that failing means
  # a crash rather than a finding.
  bad=$(find "$refsdir" -type d ! \( -exec test -r {} \; -a -exec test -x {} \; \) -print 2>/dev/null | head -1) ||
    { add_unknown "local" "could not test the refs directories under $refsdir, so whether #$n has a local branch is unknown"; return 1; }
  [ -z "$bad" ] ||
    { add_unknown "local" "refs directory $bad could not be read — whether #$n has a local branch is unknown"; return 1; }
fi
if ! refs=$(git for-each-ref --format='%(refname:short)' refs/heads); then
  add_unknown "local" "git for-each-ref failed, so whether #$n has a local branch is unknown"
  return 1
fi
# One awk, for the reason probe 2's filter is one: a short refname is the whole
# line, so the match is on $0.
local_b=$(printf '%s\n' "$refs" | LC_ALL=C awk -v n="$n" '
  $0 ~ "(^|[/-])" n "([-/]|$)" { out = out sep $0; sep = "," }
  END { printf "%s", out }') ||
  { add_unknown "local" "could not filter the local branches for #$n"; return 1; }

# The worktree registry's check is a different shape from the one above, on
# purpose. It began as release-ticket.sh's own fix for this defect (#84) rather
# than a second invented convention — but the two copies have since diverged
# and this comment no longer claims they match: the stray-directory skip, the
# awk counter, the direction split and the recount below all landed here first
# and are still open against that copy (#395).
#
# A directory-level read+execute test alone is not enough
# here: naming a registry entry needs read+execute on the PARENT only, so a
# `gitdir` file chmod'd 000 INSIDE one entry passes every test on the entry
# itself while `worktree list --porcelain` still drops it, at rc 0 (measured,
# #84). Count registry entries on disk against what git reported instead —
# that catches a silent drop whichever file inside the entry was unreadable.
wtroot="$common/worktrees"
# A function because the count is taken twice — see the recount below. Absent
# entirely is fine and answers nothing here: a repo that never had a linked
# worktree has no registry directory at all, and that emptiness is real, not a
# permission problem.
count_registry() {
  registered=0
  [ -e "$wtroot" ] || return 0
  [ -r "$wtroot" ] && [ -x "$wtroot" ] ||
    { add_unknown "local" "worktree registry $wtroot could not be read — whether #$n has a worktree is unknown"; return 1; }
  for entry in "$wtroot"/*; do
    [ -d "$entry" ] || continue
    # Skip only an EMPTY directory. That is an operator's stray `mkdir`, which
    # git ignores — and counting one fails this probe closed forever, on every
    # ticket in the repo, over something git is right to ignore (measured: git
    # lists 2, a bare `-d` count said 3). A stray FILE was already skipped by
    # the `-d` above; a stray directory was not.
    #
    # Emptiness, NOT the absence of a `gitdir` file, and the difference is a
    # wrong "free": git drops an entry whose `gitdir` was deleted, so keying the
    # skip on that file waves the entry through as "not git's" and the ticket
    # reads free while its checkout may still be on disk (measured: rc 0,
    # `taken=false`). A corrupt entry still holds git's own files — commondir,
    # HEAD, index, logs, refs — so emptiness separates it from a stray and the
    # missing `gitdir` does not.
    #
    # `-x` first, and the order is the whole point: an entry chmod'd 000 reads
    # as empty to the same test, and git drops that one too (measured: 2
    # listed, then 1). Unsearchable, so we cannot tell → count it and let the
    # mismatch below fire.
    if [ -x "$entry" ] && [ -z "$(ls -A "$entry" 2>/dev/null)" ]; then continue; fi
    registered=$((registered + 1))
  done
  return 0
}
count_registry || return 1

# Match on the worktree's basename, not its full path — matching the whole
# absolute path would false-hit on any checkout whose directory happens to
# contain the ticket number as an earlier path segment (e.g. a home dir or
# a sibling directory named with digits), matching every ticket.
if ! worktrees=$(git worktree list --porcelain); then
  add_unknown "local" "git worktree list failed, so whether #$n has a worktree is unknown"
  return 1
fi
# The main worktree is always listed first and has no registry entry of its
# own, hence the -1.
#
# awk, not `grep -c … || true`, for exactly the reason probe 2's filter above
# is one awk. `grep -c` exits 1 on zero matches — legitimate, and `set -e`
# would read it as fatal — so a `|| true` has to absorb it, and that same
# `|| true` absorbs a grep that could not RUN AT ALL. Then the count is the
# empty string, `$((listed - 1))` is -1, and the die below blames
# `git worktree list` for a count no listing can produce. awk needs no such
# case separated out: the program contains no `exit`, so it returns 0 whether
# or not anything matched and every non-zero status is a real failure.
listed=$(printf '%s\n' "$worktrees" | LC_ALL=C awk '/^worktree /{c++} END{print c+0}') ||
  { add_unknown "local" "could not count the worktrees git listed for #$n"; return 1; }
linked=$((listed - 1))
# Recount before refusing. The two reads happen at different instants, and the
# gap is not theoretical: measured at ~10ms (two independent methods agreeing —
# the fork+exec of git, which is almost the whole cost of `worktree list`, and
# the observed hit rate under churn). A sibling agent's `git worktree add` or
# `remove` landing in it makes the counts disagree with nothing wrong, which in
# THIS fleet is routine rather than exotic: measured 1.99% of probes aborting
# spuriously at λ = 2 mutations/s, 56.6% under saturation.
#
# One recount closes it rather than moving it: a mutation between the first
# count and git's read is already reflected in git's own figure, so the second
# count agrees with it. Escaping still needs a SECOND mutation inside the
# recount window — measured 1.99% → 0.00% at λ = 2/s, 56.6% → 1.29% saturated.
# A real dropped entry is a standing state, not a moment, so it survives the
# recount and still refuses (verified: #84's unreadable `gitdir` still aborts).
[ "$linked" -eq "$registered" ] || count_registry || return 1
# Name the direction actually observed. The two disagreements have opposite
# causes and send the reader to opposite places, so one message cannot serve
# both: FEWER listed than registered is git silently dropping an entry it could
# not read, which is the fault this whole check exists to catch. MORE listed
# than registered is the opposite — the on-disk count is the stale read, a
# sibling agent's `git worktree add` having landed between the two, which in a
# parallel fleet is routine rather than exotic. Calling that "the listing is
# incomplete" sends an operator hunting a permissions fault that is not there.
if [ "$linked" -lt "$registered" ]; then
  add_unknown "local" "git listed $linked worktrees for $registered registry entries in $wtroot — the listing is incomplete, so no absence it reports can be trusted"
  return 1
elif [ "$linked" -gt "$registered" ]; then
  add_unknown "local" "git listed $linked worktrees but only $registered registry entries were counted in $wtroot — the registry read missed entries git can see, so no absence it reports can be trusted"
  return 1
fi

# substr($0,10), never $2, exactly as release-ticket.sh:78 reads the same field:
# the porcelain prints the path raw, so a checkout under a directory with a
# space in it — plain enough on macOS — truncates at the space and the ticket
# stops matching. That is a wrong "free", the one answer this script must never
# invent.
#
# The basename is taken in the same pass, by dropping everything through the
# last `/`. It used to be a `basename` subshell per line, which had this defect
# one level down: a failed fork there yields an empty first field and a silent
# non-match, and `$(…)` discards the status that would have said so.
wt=$(printf '%s\n' "$worktrees" | LC_ALL=C awk -v n="$n" '
  /^worktree / { p = substr($0,10); b = p; sub(".*/", "", b)
    if (b ~ "(^|[/-])" n "([-/]|$)") { out = out sep p; sep = "," } }
  END { printf "%s", out }') ||
  { add_unknown "local" "could not filter the worktree list for #$n"; return 1; }
if [ -n "$local_b" ] || [ -n "$wt" ]; then
  [ -n "$local_b" ] && echo "    local branches: $local_b" >&2
  [ -n "$wt" ] && echo "    worktrees: $wt" >&2
  add_hit "local"
else
  echo "    no local branch or worktree for #$n" >&2
fi
}
probe_local || :

if [ -n "$hits" ]; then
  # A hit outranks an unknown: the disjunction is monotone, so one sufficient
  # "yes" answers the question regardless of what any other probe could not
  # determine. This is the accumulate half of the fix — it is checked first,
  # unconditionally, however many probes above returned 1.
  taken=true
  rc=1
elif [ -n "$unknown" ]; then
  taken=false
  rc=2
else
  taken=false
  rc=0
fi
echo "$NAME: #$n taken=$taken" >&2

# Every evidence string goes through here, the same helper and the same pipeline
# as release-ticket.sh:115. Three of the four are names chosen elsewhere: git
# accepts a `"` in a ref, so a branch — local or remote — carries one in; a
# worktree path is a filename, so it carries in `\` as well, which git's ref
# rules reject. Raw, either emits a payload no JSON parser accepts.
#
# Backslash first, always — escaping the quote (or a short form below) before
# the backslash rule runs turns the backslash IT just introduced into `\\` on
# the second pass, so every rule that adds a backslash has to come after this
# one. The five C0 bytes RFC 8259 gives a two-character short form — \010 \011
# \012 \014 \015 (\b \t \n \f \r) — get theirs; BS and FF are matched as a
# literal byte spelled with `printf`, never as `\b` or `\f`. Neither spelling
# matches \010, and neither fails quietly: `\b` in a BRE is a zero-width word
# BOUNDARY to GNU sed and a literal `b` to BSD sed, so the rule would insert
# `\b` at every word edge on one and mangle every letter `b` on the other
# (measured, GNU sed 4.9 and macOS sed). \177 (DEL) is not a C0 byte and JSON
# permits it unescaped, so — unlike every version of this helper before #146 —
# it is left alone. Every remaining byte below \040 has no short form, \013 (VT)
# included: RFC 8259 lists exactly the five above and `\v` is not among them; tr
# still turns it into a space, and jrewritten (below) is how a caller finds out
# that happened, since a replaced value is not the original bytes and must not
# be treated as a real path or ref. Byte-safe because the tr set is ASCII-only
# and a multi-byte UTF-8 sequence uses no byte below \200, so nothing here can
# split one — not because UTF-8 avoids the low bytes, which it does not: half of
# it is ASCII. tr pads the replacement with its last character.
#
# `:a;$!N;$!ba` slurps the whole value into one pattern space before any rule
# runs, so a literal newline in $1 is data the LF rule can reach rather than a
# line break sed's own per-line cycling would otherwise swallow. Guarding `N`
# with `$!` matters on its own: unguarded, BSD sed's `N` on the last line hits
# EOF with nothing to append and discards the pattern space instead of printing
# it — POSIX leaves this undefined and GNU sed's answer differs — so plain
# `N;$!ba` prints nothing at all for a single-line value.
#
# The other three interpolations are not strings and are not wrapped: `$n` is
# already refused unless it is all digits — which is not the same as a valid
# JSON number, since a zero-padded `007` clears that guard and still emits a
# payload no parser accepts (#121); `$taken` is this script's own true/false,
# and `$hits` is built only from the fixed literals `add_hit` is called with.
# `$pr` is wrapped with the rest — GitHub's own repo, number and state
# vocabulary cannot currently produce a quote, so it is uniformity against a
# later edit rather than a reachable vector today.
jstr() {
  printf '%s' "$1" \
    | sed -e ':a' -e '$!N' -e '$!ba' \
        -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        -e "s/$(printf '\010')/\\\\b/g" -e 's/\t/\\t/g' -e 's/\n/\\n/g' \
        -e "s/$(printf '\014')/\\\\f/g" -e 's/\r/\\r/g' \
    | tr '\001-\007\013\016-\037' ' '
}

# True iff $1 held a byte jstr had to replace rather than escape — every C0
# byte except \010 \011 \012 \014 \015 (BS, tab, LF, FF, CR: escaped above,
# never replaced) and \177 (DEL: preserved, never replaced). `$()` strips
# trailing newlines off both sides, and \012 is the one byte it strips: it is
# not in the delete set, so the same suffix comes off `raw` and `orig` and the
# strip can neither manufacture a difference nor hide one. An `X` sentinel
# appended to both sides stood here for that job and did nothing — measured
# across every arrangement of these bytes, it changed no answer — so it is gone
# rather than defended.
jrewritten() {
  raw=$(printf '%s' "$1" | tr -d '\001-\007\013\016-\037')
  orig=$(printf '%s' "$1")
  [ "$raw" = "$orig" ] && printf false || printf true
}

# A `$(...)` in printf's ARGUMENT list sits outside the `|| die` on the printf
# itself: a substitution that fails contributes an EMPTY argument and printf
# still exits 0 — and an unquoted `%s` slot then emits `"...Rewritten":,`,
# malformed JSON at exit 0, which is the failure the receipt exists to rule
# out. Assigned first, each one is a simple command whose status the `&&` chain
# can read and this `|| die` can act on.
pr_j=$(jstr "$pr") && pr_rw=$(jrewritten "$pr") \
  && remote_j=$(jstr "$remote") && remote_rw=$(jrewritten "$remote") \
  && local_b_j=$(jstr "$local_b") && local_b_rw=$(jrewritten "$local_b") \
  && wt_j=$(jstr "$wt") && wt_rw=$(jrewritten "$wt") \
  || die "could not escape the evidence for #$n"

# Guarded for the same reason as the python3 call above: under `set -e` a failed
# write exits 1, and the contract reads 1 as "taken" — a closed or full stdout
# rendered as a decision. `sh inflight.sh <N> >&-` reproduces it.
printf '{"issue":%s,"taken":%s,"hits":[%s],"unknown":[%s],"evidence":{"pr":"%s","prRewritten":%s,"remote":"%s","remoteRewritten":%s,"localBranch":"%s","localBranchRewritten":%s,"worktree":"%s","worktreeRewritten":%s}}\n' \
  "$n" "$taken" "${hits%,}" "${unknown%,}" \
  "$pr_j" "$pr_rw" "$remote_j" "$remote_rw" \
  "$local_b_j" "$local_b_rw" "$wt_j" "$wt_rw" \
  || die "could not write the verdict for #$n"
exit "$rc"
