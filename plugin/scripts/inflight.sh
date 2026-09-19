#!/bin/sh
# Is ticket <N> already being worked on?
#
# Three probes, all of them, every time: an existing PR, a remote branch, a
# local worktree or branch. Any hit means taken. They are not redundant — a PR
# can exist with its branch deleted, a branch can exist with no PR yet, and a
# worktree can exist before anything is pushed.
#
# Exit 0 free, 1 taken, 2 the question could not be answered. A probe that
# cannot answer no longer aborts the run: it is recorded unknown and the other
# two still run. Each probe also commits a signal the moment it is established
# rather than at its own end, so a hit is never discarded by a later failure —
# neither one in another probe, nor one in a later stage of the probe that
# found it. Exit 2 from a probe failure carries a payload — the same shape as
# 0 and 1, plus an "unknown" list naming which probes could not look.
#
# Four failures still exit 2 with no payload at all, the four the script table
# in docs/specs/2026-07-23-fleet-plugin-design.md lists. Three of them land
# before anything has been established: a bad argument, not being inside a git
# repository, and no such issue. That last one fires inside probe 1, after its
# own `gh issue view` has already run — it is not a pre-probe check, it is the
# premise all three probes rest on, so it abandons the run rather than
# recording one probe's unknown. The fourth is the opposite end: the verdict
# itself cannot be written at all, which fails after every probe has finished,
# with everything established and no way to say it. An evidence string that
# cannot be rendered is NOT one of the four (#120): the verdict is already
# correct at that point, and a formatter breaking must not retract it — that
# field is emitted as JSON null instead, on the payload the verdict already
# earned. No gap left in that: `jstr`'s own `sed` stage used to be invisible —
# a pipeline reports only its LAST stage, so a failed `sed` rendered the field
# as "", the same value "found nothing" uses, with no null and no stderr line.
# json.sh captures each fallible stage and reads its status, so that failure now
# reaches `add_evidence` and lands in the null branch like any other (#119).
set -eu

# Byte semantics for the `tr`, `sed` and `awk` below. There is no `grep`: this
# script deliberately has none, and two comments further down — "One awk, not
# `awk | sed | grep | paste`" and "awk, not `grep -c … || true`" — are the
# standing argument for why. `tr` splits `git worktree list --porcelain -z`,
# flattens `gh`'s error text into a diagnostic, and scrubs control bytes inside
# `jstr`, which `sed` shares; `awk` parses refs, branch names and worktree
# paths. Under a UTF-8 locale BSD `tr` and `sed` exit 1 on a byte that is not
# valid UTF-8 — `sed` emitting nothing at all, measured.
#
# `awk` is NOT immune, and reap.sh's own #614 fixture measured the earlier
# claim here false: it is byte-identical only when every rule matches at an
# ANCHOR before the bad byte, never needing to convert it — a rule that must
# SCAN PAST the byte to decide dies instead (BWK awk, macOS: rc 2, `towc:
# multibyte conversion failure`). What keeps every `awk` call below safe from
# that is not the global pin two paragraphs down: each one already carries its
# OWN inline `LC_ALL=C` (grep this file for it), independent of the ambient
# locale or this global export — which is also why a regression test for this
# script's global pin has to attack one of those inline pins directly;
# deleting the global `export LC_ALL=C` below changes nothing for any of them.
#
# Such a byte reaches us from a fetched tree even where the local filesystem
# refuses to hold the name, and inside `$(...)` a `tr` failure empties the
# cause out of the diagnostic without a trace. #582 measured the cost of
# leaving this ambient in no-undo-audit.sh: a truncated list reported as a
# clean, confident answer.
#
# Safe as a global: nothing in this script sorts, folds case, or holds a POSIX
# class. It does use ONE collation range — `*[!0-9]*`, the issue-number guard
# below — and a range IS locale-sensitive by spec, its members drawn from the
# collation sequence rather than the codepoint order. Measured inert here
# (#612): `0-9` matches the ASCII digits and nothing else under `C`,
# `en_US.UTF-8`, `de_DE.UTF-8` and `tr_TR.UTF-8` alike, with superscript `²`,
# Arabic-Indic digits and `½` excluded in all four. So collation and
# case-folding — the two things `LC_ALL=C` otherwise changes — have nothing
# here to act on. locale-pin-prose.test.mjs holds that inventory as a list and
# fails if the code drifts from this paragraph in either direction.
#
# This completes a pin this script already started: the five `LC_ALL=C` prefixes
# below predate it and are now redundant. Left in place — each documents the
# hazard at its own site, and deleting them is churn this ticket did not
# measure — but no new site needs one.
export LC_ALL=C

# Below the locale pin, not above it with `set -eu`: `unset` touches no
# byte-sensitive tool, but locale-pin-prose.test.mjs treats ANY line here that
# is not a comment, a blank, or `set -[eux]+` as work the pin must sit above,
# and refuses on principle rather than on this line's own behaviour. Same
# placement, same reason, as release-ticket.sh's copy.
#
# GIT_DIR is the half with teeth here. Probe 3's git calls are all bare —
# `rev-parse --git-common-dir`, `for-each-ref`, `worktree list` — so an
# ambient one asks the WRONG repository whether this ticket is taken.
# Measured, standing in a checkout that holds both the branch and the
# worktree for #501, with `GIT_DIR` naming a second clone that holds neither:
# `no local branch or worktree for #501`, and with probes 1 and 2 silent the
# verdict is `taken: false` on a ticket already claimed. That is the
# double-claim phase 0 runs this script to prevent, and inflight.test.mjs's
# own fixture builder already deletes both variables for exactly this reason
# — a defence that protected the SUITE while leaving every real caller
# exposed.
#
# GIT_WORK_TREE is unset alongside it and is measured INERT here, three
# targets tried (the checkout root, a second clone, a plain directory): no
# call in any probe touches a work tree — `for-each-ref` and `ls-remote` read
# refs, `worktree list` and `--git-common-dir` read the admin directory — so
# there is no behaviour for it to change and no behavioural fixture can pin
# it. It stays on the line because the pair is one hazard with one remedy,
# and because "inert today" is a measurement of the current call set, not a
# property of the script. ambient-git-vars-prose.test.mjs pins the line
# itself, which is what keeps that half from being quietly dropped.
unset GIT_DIR GIT_WORK_TREE

NAME=inflight
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it; only what is true of THIS script is repeated here.
# Below `export LC_ALL=C` deliberately: locale-pin-prose.test.mjs allows only
# comments, blanks, a shebang or a `set -` line above that pin, and `json_lib=`
# is none of them.
#
# Exit 1 from this script means `taken`, so a library that merely went missing
# would fabricate a claim on a free ticket — which is why `[ -r ]` has to fire
# before the `.` can kill the shell.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to answer without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

# The bounded, prompt-suppressed git transport (#92, #346, #347). It landed here
# for probe 2 alone and now lives in net.sh, where every other unattended `git`
# network call in the fleet reaches it too; net.sh's header holds the reasoning
# and the measurements. Sourced BELOW json.sh, deliberately: exit 1 from this
# script means `taken`, and the missing-library refusal every caller shares is
# already pinned on json.sh's name, so a second lib guard above it would change
# which file a lone copy of this script blames.
net_lib="$(dirname "$0")/net.sh"
[ -r "$net_lib" ] || die "cannot read $net_lib — refusing to answer without the bounded git transport"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=net.sh
. "$net_lib" || die "$net_lib failed to load"

[ $# -eq 1 ] || die "usage: inflight.sh <issue-number>"
n=$1
case "$n" in ''|*[!0-9]*|0?*) die "issue must be a number, got '$n'";; esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

hits=""
add_hit() { hits="${hits}\"$1\","; echo "    HIT: $1" >&2; }

# A probe that cannot answer records itself here instead of dying. Same
# shape as `hits`, same trailing-comma-then-trim pattern at the end. The
# message is printed exactly as `die` used to print it — only the exit is
# gone — so every existing diagnostic string below still reads the same on
# stderr, and a caller grepping for one is unaffected by this change.
unknown=""
add_unknown() { unknown="${unknown}\"$1\","; printf '%s: %s\n' "$NAME" "$2" >&2; }

# Evidence defaults. A probe that fails leaves its own field empty rather
# than unset — `set -u` would otherwise abort the payload assembly at the
# bottom for a probe that never got the chance to fill it in, and empty is
# already what "found nothing" looks like in this field, disambiguated by
# `unknown` rather than by the field itself.
pr=""
remote=""
local_b=""
wt=""

# The three temp files, and the ONE EXIT trap that removes them. `sh` keeps a
# single EXIT trap, so a second `trap … EXIT` further down does not add a
# handler — it REPLACES this one, silently leaking whatever the first was going
# to remove. All three are therefore declared here and cleaned here rather
# than each probe installing its own. Declared empty, too, so the trap can run
# under `set -u` after a `die` that fired before any was created.
errfile=""
wtfile=""
wdfile=""
# `${…:+}` so a file that was never created contributes no argument at all
# rather than an empty one, and `rm -f` with no operands is specified to exit 0.
#
# `|| printf`, not a bare `rm -f`: this trap fires OUTSIDE the three probe
# functions, where `set -e` is still live, so a failing `rm -f` exits 1 — and
# the contract reads 1 as "taken", which would let cleanup overwrite a verdict
# already computed and announced. The same hazard the verdict `printf` at the
# foot of this file guards with `|| die`. The reporter returns 0, so the declared
# status survives and the cleanup failure is still said out loud rather than
# swallowed by a bare `|| :`.
#
# `printf`, not `echo`: these are mktemp paths, and `echo` expands a backslash
# in one. It returns 0 just as `echo` did, so the status argument above is
# unchanged. Format string double-quoted because the trap body is already
# single-quoted.
trap 'rm -f ${errfile:+"$errfile"} ${wtfile:+"$wtfile"} ${wdfile:+"$wdfile"} ||
  printf "%s: could not remove %s %s %s\n" "$NAME" "$errfile" "$wtfile" "$wdfile" >&2' EXIT

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
#
# Both `gh` calls in this probe capture stderr to this one file rather than
# folding it in with `2>&1`: `linked`/`pr_json` above need stdout alone,
# undisturbed by any stderr noise a successful call still emits. It used to be
# a fixed /tmp/.inflight.$$ — guessable from the PID, and `>` follows a
# symlink, so anything on the host that pre-plants that path pointing at a
# file this user can write gets it truncated the instant stderr lands there
# (#91, measured: a 37-byte victim file left at 14 bytes). mktemp's
# unpredictable name closes the guess; the trap closes the other half — no
# cleanup ran for an interrupt landing between the redirect and the `rm -f`
# that only ever followed a call that finished.
#
# Created ONCE and never unlinked mid-run. The intermediate `rm -f`s that used
# to stand between the two calls handed the whole guess back: they freed a path
# that is known by then, and the next `2>"$errfile"` re-created it at the
# shell's umask instead of mktemp's — measured 0600 before, 0644 after — with a
# symlink-following `>` doing the re-creating. The second call truncates the
# same inode instead, so the path never leaves this process's hands, and the
# trap is the single cleanup path. (The cost is narrow and deliberate: if the
# second redirect itself fails, the readback below can report the first call's
# stderr. A double fault, against a window open on every ordinary run.)
if ! errfile=$(mktemp); then
  # Probe-local, so it is recorded like any other probe that could not look.
  # `die` here would abandon probes 2 and 3, which need neither `gh` nor this
  # file — measured: a ticket visibly taken by a remote branch AND a worktree
  # exited 2 with an empty payload and no hits.
  add_unknown "pr" "could not create a temporary file to capture gh's stderr, so #$n's PR links are unknown"
  return 1
fi
# Removal is the EXIT trap's, installed once at the top of this file — see the
# note there on why a second `trap … EXIT` here would silently disarm it.

# One readback for both `gh` calls below, so a third capture site inherits the
# fallback rather than having to remember to copy it. Empty is not "gh said
# nothing" — it is indistinguishable from the capture itself failing
# (unwritable /tmp, a full filesystem), which still fails closed but used to
# leave the operator with nothing after the colon.
gh_cause() {
  err=$(cat "$errfile" 2>/dev/null || true)
  [ -n "$err" ] || err="cause unavailable"
}

if ! linked=$(gh issue view "$n" --json closedByPullRequestsReferences,url --jq \
                '[.url] + [.closedByPullRequestsReferences[].url] | join(",")' 2>"$errfile"); then
  gh_cause
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

echo "\$ gh pr list --state all --search $n --json number,state,headRefName,url" >&2
# Keep the cause, through the same `gh_cause` the `gh issue view` call above
# uses. Discarding it makes rate-limited, unauthenticated and offline read
# alike, and all three land on an operator who then has nothing to act on.
if ! pr_json=$(gh pr list --state all --search "$n" --limit 100 \
                 --json number,state,headRefName,url 2>"$errfile"); then
  gh_cause
  add_unknown "pr" "gh pr list failed, so whether #$n is taken is unknown: $(printf '%s' "$err" | tr '\n' ' ')"
  return 1
fi

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

# The fallback is not dead code. No *input* can reach it — the guarded python3
# above already parses this same `$pr_json` and records an unknown on anything
# malformed — but this is a second, separate process, so it can fail where the
# first succeeded: a fork failure under process-table pressure is exactly what
# a parallel fleet approaches by construction. Left unguarded the failure is
# simply silent — `probe_pr` is invoked as `probe_pr || :`, which exempts its
# whole body from `set -e`, and a failed command substitution assigns the empty
# string rather than leaving `$raw` unset, so `set -u` never fires either.
# Measured: the tally then prints the hole, `( full-text match(es) considered)`.
#
# `raw="?"` and NOT `add_unknown "pr"; return 1`, which is what stood here and
# was wrong (#96). This count feeds nothing but the two diagnostics below: the
# PR answer is `$pr`, which the guarded filter above already established, so a
# tally that could not run leaves that answer entirely intact. Returning here
# discarded an already-sufficient hit over a cosmetic number — measured exit 2
# with `hits:[]` while `evidence.pr` read `#12 OPEN (linked)`. A stage that
# cannot change the answer must not be able to retract it.
raw=$(printf '%s' "$pr_json" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') \
  || raw="?"
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
#
# ADDING A COMMAND TO probe_pr: `set -e` does not reach a command run DIRECTLY
# in the body. POSIX exempts a function's whole execution from `-e` while its
# status is what an `||` is testing, so the `set -eu` up top aborts on nothing
# at that level — measured in that shape under /bin/sh, /bin/dash and
# /bin/bash. A command substitution in the body is a DIFFERENT shape and does
# not inherit that result: it is a subshell, and only /bin/bash carries the
# exemption into one. Under /bin/sh and /bin/dash `-e` stays live in there, so
# a command added inside a `$( … )` is skipped, the capture silently
# truncates, and the substitution's own `exit` is replaced by the failing
# command's status — it never reaches the guard this rule asks for. `-u` is
# exempted at neither level and still aborts, but that abort is no backstop
# either: under the EXIT trap installed above it exits 0 with no payload — the
# free verdict — wherever /bin/sh is bash, as it is here, and under /bin/bash;
# /bin/dash exits 2.
# A command that feeds a verdict field therefore carries its own
# `|| { add_unknown "pr" "…"; return 1; }`. Unguarded, its failure leaves the
# empty result a genuinely free ticket leaves, gets reported as a definite
# absence, and frees a ticket that is taken — a free verdict puts a second
# agent on the ticket where a taken one only skips it. A command that cannot
# change the verdict is the opposite case and must record no unknown, the shape
# `probe_pr`'s `raw="?"` count already has.
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
# here than in release-ticket.sh's `git ls-remote --heads` pushed-branch lookup,
# which tests $remote raw, so a folded-in host-key notice really would read as a
# branch, whereas the awk below reduces such a line to a word no numeric segment
# can match. git's own wording is more use on the terminal anyway.
#
# This is the one network call in the script (probe 1 goes through `gh`, probe
# 3 never leaves disk), and unattended it must neither prompt nor hang (#92).
#
# The knobs that suppress the prompt and the watchdog that bounds the call both
# live in net.sh now, which every unattended `git` network call in the fleet
# routes through (#347); its header holds the reasoning and the measurements.
# What stays here is what is true of THIS call: its budget, and how a killed
# call is reported.
#
# The budget. Above what the ssh options can spend before they give up on their
# own — ConnectTimeout plus the ServerAlive pair's whole run — so this never
# preempts a bound that would have produced git's own diagnostic, and short
# enough that a stalled probe does not hold a fleet slot the way #92 describes.
# `ls-remote` moves refs and no objects, so this is generous for the work.
#
# `INFLIGHT_LS_REMOTE_TIMEOUT` is this call's own override. It can only ever
# SHORTEN, and the rule with its edge cases is net_budget's, in net.sh.
ls_budget=$(net_budget 30 "${INFLIGHT_LS_REMOTE_TIMEOUT:-}")
# A file this probe WANTS, not one it needs. Probe 2 is the one probe that
# answers when mktemp is broken — #185 fixed that deliberately and
# inflight.test.mjs pins it — so a failed mktemp costs the sharper wording
# below, never the verdict. The old exit-status inference is what the wording
# falls back to there.
wdfile=$(mktemp) || wdfile=""
ls_rc=0
heads=$(net_git "$wdfile" "$ls_budget" ls-remote --heads origin) || ls_rc=$?
wdnote=""
if [ "$ls_rc" -ne 0 ]; then
  if [ -n "$wdfile" ]; then
    wdnote=$(net_wdnote "$wdfile")
  elif net_stalled "$ls_rc"; then
    # No marker to read, so the signal number is all there is — the weaker test
    # this branch used before the marker existed, kept only for the path where
    # mktemp failed. It cannot tell our SIGTERM from anyone else's, but
    # reporting a real stall as a refusal is the worse of the two errors. That
    # rule is net_stalled's and net.sh is where it is written down, including
    # why 137 counts as well as 143 — net_kill_tree escalates to SIGKILL and
    # git can lose the race. Spelling it out a second time here is how the two
    # copies come to disagree about which signals mean killed.
    wdnote="fired"
  fi
  # A killed fetch and a refused one are different facts and get different
  # words. Before this bound existed the only failure surface here was reached
  # when `ls-remote` RETURNED, so a probe that never returned reached no label
  # at all and a stall was indistinguishable from a slow link to the caller.
  #
  # $wdfile is what separates them. Reading "the watchdog fired" off an exit
  # status of 143 inferred it from a signal number this script does not own:
  # measured, a fetch SIGTERM'd from OUTSIDE at 4s under the default budget was
  # reported as `did not finish within 30s`, naming a budget only 4s of wall
  # clock had run against. The marker is written by the watchdog and by nothing
  # else, so it answers what the exit status was being asked to guess — and it
  # keeps answering now that net_kill_tree escalates to SIGKILL and git can just as
  # well come back 137.
  kt_note=""
  case $wdnote in
    *degraded*) kt_note=", though the process table could not be read, so a transport helper may still be running" ;;
  esac
  case $wdnote in
    *fired*) add_unknown "remote" "git ls-remote did not finish within ${ls_budget}s and was killed${kt_note}, so whether #$n has a remote branch is unknown" ;;
    *) add_unknown "remote" "git ls-remote failed, so whether #$n has a remote branch is unknown" ;;
  esac
  return 1
fi
# One awk, not `awk | sed | grep | paste`. A pipeline hides every status but its
# last, and the `|| true` that used to close this one discarded that too, so a
# stage that could not run produced the same empty result a free ticket
# produces. Collapsed, the status is the filter's own and the guard can read it —
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
# ADDING A COMMAND TO probe_remote: `set -e` does not reach a command run
# DIRECTLY in the body. POSIX exempts a function's whole execution from `-e`
# while its status is what an `||` is testing, so the `set -eu` up top aborts
# on nothing at that level — measured in that shape under /bin/sh, /bin/dash
# and /bin/bash. A command substitution in the body is a DIFFERENT shape and
# does not inherit that result: it is a subshell, and only /bin/bash carries
# the exemption into one. Under /bin/sh and /bin/dash `-e` stays live in
# there, so a command added inside a `$( … )` is skipped, the capture silently
# truncates, and the substitution's own `exit` is replaced by the failing
# command's status — it never reaches the guard this rule asks for. `-u` is
# exempted at neither level and still aborts, but that abort is no backstop
# either: under the EXIT trap installed above it exits 0 with no payload — the
# free verdict — wherever /bin/sh is bash, as it is here, and under /bin/bash;
# /bin/dash exits 2.
# A command that feeds a verdict field therefore carries its own
# `|| { add_unknown "remote" "…"; return 1; }`. Unguarded, its failure leaves
# the empty result a genuinely free ticket leaves, gets reported as a definite
# absence, and frees a ticket that is taken — a free verdict puts a second
# agent on the ticket where a taken one only skips it. A command that cannot
# change the verdict is the opposite case and must record no unknown, the shape
# `probe_pr`'s `raw="?"` count already has.
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
# result from it — the same rule release-ticket.sh's `-r`/`-x` guard on
# `$wtroot` already applies to its own worktree-registry read (#84) — absence
# must be established, never inferred.
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
  # rather than inferred from find's status alone — find exits 1 on the very
  # permission-denied descent that IS the detection, so a hit in `$bad`
  # alongside a nonzero status is the finding, not a crash.
  #
  # find's status still has to be read, though — just not off the pipeline
  # that used to end in `head -1`. This script sets no `pipefail`, so `$?`
  # after `cmd | head -1` reports only `head`'s, and `head` exits 0 whether
  # find printed a permission-denied hit or never ran at all (missing binary,
  # a failed exec, any other swallowed crash) — both leave `$bad` empty, both
  # used to read as a clean tree (#1448, reproduced by shimming `find` on
  # PATH to `exit 127`). find's own status is read off the bare command
  # substitution instead, with nothing piped after it, so nothing that runs
  # after it can stand in for it again.
  #
  # `head`'s own status is kept too, not discarded — a `head` that cannot run
  # (crashed, missing) is the same class of failure, and was the one failure
  # this guard could already see before #1448 (pinned below at "a
  # refs-subdirectory walk that could not run"). Reading both separately,
  # rather than trusting whichever one the pipeline's single status happens to
  # expose, is what closes the first gap without reopening the second.
  find_rc=0
  find_out=$(find "$refsdir" -type d ! \( -exec test -r {} \; -a -exec test -x {} \; \) -print 2>/dev/null) ||
    find_rc=$?
  head_rc=0
  bad=$(printf '%s\n' "$find_out" | head -1) || head_rc=$?
  if { [ -z "$bad" ] && [ "$find_rc" -ne 0 ]; } || [ "$head_rc" -ne 0 ]; then
    add_unknown "local" "could not test the refs directories under $refsdir, so whether #$n has a local branch is unknown"
    return 1
  fi
  [ -z "$bad" ] ||
    { add_unknown "local" "refs directory $bad could not be read — whether #$n has a local branch is unknown"; return 1; }
fi
# %(refname) and a strip, never %(refname:short): the short form is
# ambiguity-aware, and where a TAG shares a branch's name it stops shortening
# and emits `heads/<name>` instead (measured, git 2.50.1 Apple Git-155). That
# string names no ref — `git branch -D heads/<name>` answers "branch not
# found" — so the `local branches:` line and the localBranch evidence below
# both hand an operator a name they cannot paste into a git command.
# %(refname) is always refs/heads/<name>, so the strip yields the bare name for
# every branch, ambiguous or not. #634 fixed the same spelling in reap.sh.
#
# Here the enumeration fix stands ALONE, and that is a finding about THIS
# script, not a conclusion carried over from that one. What made the fix unsafe
# by itself in reap.sh is that it goes on to consume the enumerated name AS A
# REV (`git cherry "$base" "$b"`), and git resolves an ambiguous rev by
# preferring refs/tags/ over refs/heads/ — so restoring the bare name made the
# merge probe answer about the TAG and authorized -D on an unmerged branch
# (measured, PR #914, which qualifies that one site `refs/heads/$b` for exactly
# this reason). Every site consuming this value here was enumerated and
# classified instead:
#
#   the awk below                      string match, on the name as reported
#   `[ -n "$local_b" ]`, twice         emptiness only
#   `[ -z "$local_b" ]`                emptiness only
#   the `local branches:` echo         print
#   `add_evidence localBranch`         print, through jstr
#
# Not one hands the value to git, and this script's other git calls — `rev-parse
# --git-dir`, `rev-parse --git-common-dir`, `ls-remote --heads origin`,
# `worktree list --porcelain -z` — take no ref argument built from it. Nor is
# there a `refs/heads/$b` key to rebuild the way reap.sh's worktree lookup has:
# probe 3's worktree half matches the LISTING's own paths by basename, never a
# name from this enumeration. `$local_b` is a comma-joined list besides, so it
# could not be a rev even by accident. Nothing to qualify. #915
if ! refs=$(git for-each-ref --format='%(refname)' refs/heads); then
  add_unknown "local" "git for-each-ref failed, so whether #$n has a local branch is unknown"
  return 1
fi
# One awk, for the reason probe 2's filter is one: a refname is the whole line,
# so the strip and the match are both on $0. Stripping BEFORE the match keeps
# the matched string and the reported string the same one — the two orders
# select identically anyway, since the prefix carries no digit for an all-digit
# `n` to match and supplies a `/` exactly where `^` would otherwise apply.
local_b=$(printf '%s\n' "$refs" | LC_ALL=C awk -v n="$n" '
  { sub(/^refs\/heads\//, "") }
  $0 ~ "(^|[/-])" n "([-/]|$)" { out = out sep $0; sep = "," }
  END { printf "%s", out }') ||
  { add_unknown "local" "could not filter the local branches for #$n"; return 1; }

# Commit the branch half here, where it is established — NOT at the end of the
# probe with the worktree half (#96). Every stage between here and there can
# fail and `return 1`: the registry read and count, `git worktree list`, the
# listed-versus-registered compare, the worktree filter. Recording the hit down
# there meant any one of them threw away a branch that already proves the
# ticket taken — measured exit 2 with `hits:[]` and `unknown:["local"]` while
# `evidence.localBranch` named `fix/77-slug` in the same payload.
#
# The two halves are independent answers to independent questions. A branch
# found is found whether or not the worktree registry can be read, and the
# probe reports the half it answered plus an unknown for the half it could not.
if [ -n "$local_b" ]; then
  echo "    local branches: $local_b" >&2
  add_hit "local"
fi

# The worktree registry's check is a different shape from the one above, on
# purpose. It began as release-ticket.sh's own fix for this defect (#84) rather
# than a second invented convention — but the two copies diverged from there
# and have converged on most of that ground, but not all of it — see the
# recount below for what still differs. Three of the four items that
# landed here first — the stray-directory skip, the awk counter and the
# direction split — were ported to that copy by #395; the recount was the last
# of the four, ported by #694. That copy's skip reading only `ls`'s output,
# not its exit STATUS, was a further divergence — #697 closed it: both
# copies' skip now reads the exit status.
#
# Porting the recount did not converge the two copies on it at once, though:
# this script's recount re-took `registered` alone (`count_registry`), while
# release-ticket.sh's copy of the SAME recount re-took `registered` AND
# `linked` together from #1408 on, because re-taking `registered` by itself
# leaves `linked` pinned to the first listing and can misname a benign
# concurrent-worktree race as a fault. #1421 closed that divergence here: both
# copies now re-take the pair, this one through the `count_linked` below. The
# mechanism under it is still each script's own — that copy reads the listing
# through worktree.sh's `wt_listing`, this one through the single EXIT trap's
# `$wtfile` — a difference in plumbing, same as before. What is no longer true
# is that the recount ITSELF is: #1424 bounds release-ticket.sh's copy at up
# to two recount passes (`recount_tries`) to close a residual third-mutation
# race window that this script's own still-single-pass recount does not
# close.
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
    # Emptiness, NOT the absence of a `gitdir` file: git drops an entry whose
    # `gitdir` was deleted, so keying the skip on that file over-skips into the
    # wrong "free" spelled out below (measured: rc 0, `taken=false`). A corrupt
    # entry still holds git's own files — commondir, HEAD, index, logs, refs —
    # so emptiness separates it from a stray and the missing `gitdir` does not.
    #
    # `ls`'s STATUS, not just its output: an entry we could not LIST is not an
    # empty one, and `2>/dev/null` hides the difference. An entry chmod'd 000
    # (unsearchable) OR 0111 (searchable, so an `-x` test passes it, but not
    # readable) fails EACCES and prints exactly what a stray `mkdir` prints.
    # Over-skip on the missing `gitdir` or on the output alone, and git has
    # dropped the entry too, so the counts AGREE (measured: 2 listed, then 1,
    # and an output-only skip counts 0 to match), no mismatch fires, and the
    # probe answers `taken=false` for a ticket whose checkout is still on disk.
    # Could not read it, so we cannot tell → count it and let the mismatch
    # below fire. #697
    if contents=$(ls -A "$entry" 2>/dev/null) && [ -z "$contents" ]; then continue; fi
    registered=$((registered + 1))
  done
  return 0
}
count_registry || return 1

# Match on the worktree's basename, not its full path — matching the whole
# absolute path would false-hit on any checkout whose directory happens to
# contain the ticket number as an earlier path segment (e.g. a home dir or
# a sibling directory named with digits), matching every ticket.
#
# `--porcelain -z`, into a temp file rather than a command substitution. The
# plain porcelain terminates every attribute with a newline, and a worktree
# path may legally contain one (APFS and ext4 both allow it), so one record
# splits into two. Measured on the plain form (#185): `…/wt/fix-66-a<LF>b`
# reported `worktree` truncated at `…/fix-66-a`, a path not on disk; and
# `…/wt/plain<LF>fix-33-slug` left the number on the orphaned second line,
# where the `^worktree ` filter never looked, so #33 came back `taken=false` at
# exit 0 with its checkout live — the one answer this script must never invent.
# A temp file because `-z`'s separator is NUL and no shell variable can hold
# one, and because it keeps the lookup's status readable on its own, apart from
# the reader's below: a pipeline would report only the last stage's, so a `git`
# that could not run at all would read as an empty listing, a wrong "free".
if ! wtfile=$(mktemp); then
  # Probe-local for the reason probe 1's is: `die` here would abandon a verdict
  # probes 1 and 2 may already have established.
  add_unknown "local" "could not create a temporary file to hold the worktree list, so whether #$n has a worktree is unknown"
  return 1
fi
# A function, not inline, because the recount below needs this whole pair —
# git's own read of the listing and the count derived from it — re-taken
# TOGETHER rather than one of them re-assigned on its own. `worktrees` and
# `linked` are this function's OUTPUT, exactly as `registered` is
# `count_registry`'s — `listed` is scratch the count derives `linked` from and
# the `-ge 1` guard below checks, never read outside this function, matching
# release-ticket.sh's own `count_linked`, whose comment (line 383) likewise
# names only `linked` and `wt_list`/`wt_err`. Mirrors that same extraction over
# the same pair for the same recount (#1408). #1421
#
# The `mktemp` stays ABOVE this function rather than moving inside it, where
# release-ticket.sh's `wt_listing` creates and removes one of its own: the temp
# files here are the ONE EXIT trap's at the top of this file, and it holds a
# single slot per file, so a second `mktemp` in here would overwrite `$wtfile`
# and leak the first path with nothing said. The re-take truncates the same
# inode instead — the reason probe 1's second `2>"$errfile"` does, spelled out
# there.
#
# `return 1` inside returns from THIS function now, not from `probe_local`, so
# every call site carries its own `|| return 1` exactly as `count_registry`'s
# do. Without it a listing that could not be read would be recorded by
# `add_unknown` and then walked straight past, and the probe would answer
# `taken=false` off a listing it never had — the one answer this script must
# never invent.
count_linked() {
  # Two operands, one status: the redirect is new here (the base ran this as a
  # command substitution, which had nothing to write to), so a `git` that could
  # not run and a `$wtfile` that could not be written are indistinguishable at
  # this `if`. The message names both rather than blaming git for a write it never
  # reached — the shell prints its own "Permission denied" naming the path when it
  # is the redirect, which is the half a reader can tell apart.
  if ! git worktree list --porcelain -z >"$wtfile"; then
    add_unknown "local" "git worktree list failed, or its output could not be written to $wtfile, so whether #$n has a worktree is unknown"
    return 1
  fi
  # NOT `awk -v RS='\0'`. That is a gawk/BWK extension, and the awk this script
  # actually runs on macOS — /usr/bin/awk, BWK awk 20200816 — does not merely
  # ignore it: it stops dead at the first NUL and reports ONE record for a
  # listing of any length. Measured, all three spellings, `-v RS='\0'`,
  # `-v RS='\000'` and `BEGIN{RS="\0"}`, every one of them `count=1`. No awk
  # program here can hold a NUL byte, so the swap has to happen before awk sees
  # the stream at all.
  #
  # One `tr` pass does it: NUL becomes the newline awk already splits on, and a
  # newline inside a path becomes \001. `tr` translates simultaneously from one
  # table, so the two mappings cannot feed each other the way two piped stages
  # would. Both awks below then read the listing unchanged.
  #
  # Ceiling, deliberate: jstr renders that \001 as a space rather than as `\n`,
  # so a path containing a newline is reported WHOLE but with the newline
  # neutralised — the treatment every C0 byte WITHOUT a JSON short form gets. Not
  # the tab in `…/fix-88-a<TAB>b`: \011 is one of the five RFC 8259 gives a short
  # form, jstr's `sed` escapes it to `\t` before this `tr` stage runs at all, and
  # jrewritten's delete set skips it — so a tab round-trips byte-identical and
  # reports `worktreeRewritten: false`, which is what the probe-3 tab case pins.
  # Swapping the byte back would restore `\n` here at the cost of corrupting the
  # opposite case — a path that really contains \001 — for a diagnostic field
  # whose verdict is already correct either way. One failure mode is better than
  # two.
  if ! worktrees=$(LC_ALL=C tr '\n\000' '\001\n' <"$wtfile"); then
    add_unknown "local" "could not read the worktree list for #$n"
    return 1
  fi
  # The main worktree is always listed first and has no registry entry of its
  # own, hence the -1.
  #
  # awk, not `grep -c … || true`, for exactly the reason probe 2's filter above
  # is one awk. `grep -c` exits 1 on zero matches — legitimate, and `set -e`
  # would read it as fatal — so a `|| true` has to absorb it, and that same
  # `|| true` absorbs a grep that could not RUN AT ALL. Then the count is the
  # empty string, `$((listed - 1))` is -1, and the mismatch report below blames
  # `git worktree list` for a count no listing can produce. awk needs no such
  # case separated out: the program contains no `exit`, so it returns 0 whether
  # or not anything matched and every non-zero status is a real failure.
  listed=$(printf '%s\n' "$worktrees" | LC_ALL=C awk '/^worktree /{c++} END{print c+0}') ||
    { add_unknown "local" "could not count the worktrees git listed for #$n"; return 1; }
  # The guard above closes only the route where awk could not RUN. An empty but
  # SUCCESSFUL listing reaches the same -1: awk exits 0 printing `0`, the guard
  # cannot fire, and the mismatch report below blames `git worktree list` for the
  # very count that guard exists to keep out of an operator's face. One comparison
  # closes it for every branch below at once, the recount included. `-ge 1`, not
  # `-gt 1`: `listed=1` is the main checkout alone, `linked=0`, the ordinary repo
  # with no linked worktree — a guard that refused that would make every probe in
  # a clean repo unknown. Real `git worktree list --porcelain` always prints the
  # main worktree, so reaching this needs a broken or shimmed git; the refusal
  # direction was already right, only the number was nonsense. #699
  [ "$listed" -ge 1 ] ||
    { add_unknown "local" "git listed no worktrees at all for #$n — not even the main checkout, so the listing cannot be trusted"; return 1; }
  linked=$((listed - 1))
}
count_linked || return 1
# Recount before refusing. The two reads happen at different instants, and the
# gap is not theoretical: measured at ~10ms (two independent methods agreeing —
# the fork+exec of git, which is almost the whole cost of `worktree list`, and
# the observed hit rate under churn). A sibling agent's `git worktree add` or
# `remove` landing in it makes the counts disagree with nothing wrong, which in
# THIS fleet is routine rather than exotic: measured 1.99% of probes aborting
# spuriously at λ = 2 mutations/s, 56.6% under saturation.
#
# One recount closes it rather than moving it: a mutation landing between the
# FIRST count and git's listing is already reflected in that listing, so the
# second count agrees with it — the invariant the ORIGINAL pair above relies
# on. Escaping still needs a SECOND mutation inside the recount's own window.
# The two rates #694 measured for recounting at all — 1.99% → 0.00% at
# λ = 2/s, 56.6% → 1.29% saturated — were taken on the registered-only
# recount this replaces, so that 1.29% residual bounds what narrowing the
# window below can still leave rather than describing it; it was not
# re-measured after that change. A real dropped entry is a standing state,
# not a moment, so it survives the recount and still refuses (verified: #84's
# unreadable `gitdir` still aborts).
#
# BOTH counts, not `registered` alone, which is what that invariant costs.
# Re-taking the registry by itself leaves `linked` pinned to the FIRST
# listing, so a second sibling mutation landing after that listing returned
# but before the recount re-scans the registry moves one count and not the
# other. Reproduced in both directions, and they fail differently. Two
# `git worktree add`s straddling the listing call FLIP the disagreement:
# `linked -gt registered` on the first pair becomes `linked -lt registered`
# on the recount, reported as "git listed 1 worktrees for 2 registry entries
# … the listing is incomplete" — a corruption report for two ordinary adds.
# A remove then an add makes it PERSIST instead: the registry count comes
# back to the same 1 for a different entry while `linked` stays at the 0 it
# read before the add, and the same message fires at 0 against 1. Neither run
# had anything wrong with it.
# Re-taking `registered` and `linked` together, in the same order the pair
# above takes them, hands the RECOUNT pair the invariant too: the window an
# escape needs is the narrow gap these two calls open between themselves, not
# the whole span back to the first listing. Both directions pinned in
# inflight.test.mjs. Mirrors release-ticket.sh's copy of this recount, which
# #1408 fixed the same way. #1421
#
# The retake pair above is still two reads, not one, and the gap it opens
# between ITSELF — after `count_registry` has already re-scanned but before
# `count_linked` re-lists — is narrower than the window this recount closes,
# not zero. A mutation landing there still escapes: `registered` is re-taken
# first, so an ADD landing in this gap is missed by the registry scan that
# already ran and IS seen by the git listing still to come — `linked -gt
# registered`, "the registry read missed entries git can see" — while a
# REMOVE the same way lands `linked -lt registered`, "the listing is
# incomplete", indistinguishable from the fault that message exists to name
# even though nothing here is actually wrong. Pinned in inflight.test.mjs.
# Reordering to `count_linked && count_registry` does not remove this
# residual, it only moves the ADD case's false report onto the
# `linked -lt registered` branch instead — the direction the comment below
# calls out by name as sending an operator hunting a permissions fault that
# is not there. `count_registry` first, `count_linked` second, mirrors
# release-ticket.sh's own recount ordering (count_registry before
# count_linked) — kept fixed for the reason that copy's own comment gives:
# not because a different order would be wrong, but so the reasoning above
# stays about one order instead of two.
#
# `&&`, not `;`, between the two: `count_registry` reports an unreadable
# registry through `add_unknown` and a non-zero return, and under `;` the
# group's status would be `count_linked`'s alone, so this probe would walk
# past a refusal it had already recorded. Measured, that is belt-and-braces
# and not a behaviour difference: every state that fails `count_registry`'s
# `[ -r ] && [ -x ]` guard also stops git enumerating $wtroot, so `linked`
# collapses to 0 alongside `registered` and the comparison below matches
# either way — checked at mode 000 landed inside this very window, under both
# spellings, and the registry message is the only one reported by both. The
# `&&` stays because the status of a count that refused is not
# `count_linked`'s to overwrite, not because a case turns on it today.
[ "$linked" -eq "$registered" ] || { count_registry && count_linked; } || return 1
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

# substr($0,10), never $2, exactly as release-ticket.sh's own substr($0,10) awks
# read the same field: the porcelain prints the path raw, so a checkout under a
# directory with a space in it — plain enough on macOS — truncates at the space
# and the ticket stops matching. That is a wrong "free", the one answer this
# script must never invent.
#
# The basename is taken in the same pass, by dropping everything through the
# last `/`. It used to be a `basename` subshell per line, which had this defect
# one level down: a failed fork there yields an empty first field and a silent
# non-match, and `$(…)` discards the status that would have said so.
#
# `\001` counts as a separator for the MATCH, and for the match only. The `tr`
# above turned every newline inside a path into `\001`, and `\001` is not in
# `([-/]|$)` — so `…/wt/fix-33<LF>slug` arrives as `fix-33\001slug`, the number
# stops matching, and a live checkout reads FREE. Measured on real repos with
# real linked worktrees: plain porcelain `taken=true` rc 1, `--porcelain -z`
# without this `gsub` `taken=false` rc 0 with `unknown: []` — the probe answers,
# so nothing upstream catches it. Mapping the byte to `/` in `b` restores that
# leaf and `…/wt/fix<LF>33-slug`, which the plain form never matched either.
# `b` is the throwaway copy: `p` is untouched, so the evidence this probe
# reports — and `worktreeRewritten` with it — still carries the raw bytes.
wt=$(printf '%s\n' "$worktrees" | LC_ALL=C awk -v n="$n" '
  /^worktree / { p = substr($0,10); b = p; sub(".*/", "", b); gsub(/\001/, "/", b)
    if (b ~ "(^|[/-])" n "([-/]|$)") { out = out sep p; sep = "," } }
  END { printf "%s", out }') ||
  { add_unknown "local" "could not filter the worktree list for #$n"; return 1; }
if [ -n "$wt" ]; then
  printf '    worktrees: %s\n' "$wt" >&2
  # `hits` is a set of probe names, not a tally, and both halves of this probe
  # answer under the one name — so record it only if the branch half above did
  # not already.
  [ -n "$local_b" ] || add_hit "local"
elif [ -z "$local_b" ]; then
  echo "    no local branch or worktree for #$n" >&2
fi
}
# ADDING A COMMAND TO probe_local: `set -e` does not reach a command run
# DIRECTLY in the body. POSIX exempts a function's whole execution from `-e`
# while its status is what an `||` is testing, so the `set -eu` up top aborts
# on nothing at that level — measured in that shape under /bin/sh, /bin/dash
# and /bin/bash. A command substitution in the body is a DIFFERENT shape and
# does not inherit that result: it is a subshell, and only /bin/bash carries
# the exemption into one. Under /bin/sh and /bin/dash `-e` stays live in
# there, so a command added inside a `$( … )` is skipped, the capture silently
# truncates, and the substitution's own `exit` is replaced by the failing
# command's status — it never reaches the guard this rule asks for. `-u` is
# exempted at neither level and still aborts, but that abort is no backstop
# either: under the EXIT trap installed above it exits 0 with no payload — the
# free verdict — wherever /bin/sh is bash, as it is here, and under /bin/bash;
# /bin/dash exits 2.
# A command that feeds a verdict field therefore carries its own
# `|| { add_unknown "local" "…"; return 1; }`. Unguarded, its failure leaves
# the empty result a genuinely free ticket leaves, gets reported as a definite
# absence, and frees a ticket that is taken — a free verdict puts a second
# agent on the ticket where a taken one only skips it. A command that cannot
# change the verdict is the opposite case and must record no unknown, the shape
# `probe_pr`'s `raw="?"` count already has.
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

# Every evidence string goes through `jstr` from json.sh. Three of the four are
# names chosen elsewhere: git accepts a `"` in a ref, so a branch — local or
# remote — carries one in; a worktree path is a filename, so it carries in `\`
# as well, which git's ref rules reject. Raw, either emits a payload no JSON
# parser accepts. The rule list and its ordering live in json.sh, once, rather
# than here and in release-ticket.sh and in no-undo-audit.sh (#119).
#
# The other three interpolations are not strings and are not wrapped: `$n` is
# refused unless it is all digits AND unpadded (the guard's `0?*` arm), which is
# what makes it a JSON number and not merely numeric — RFC 8259 forbids a
# leading zero, so `007` never reaches this printf (#121); `$taken` is this
# script's own true/false, `$hits` only the fixed literals `add_hit` is given.
# `$pr` is wrapped with the rest — GitHub's own repo, number and state
# vocabulary cannot currently produce a quote, so it is uniformity against a
# later edit rather than a reachable vector today.

# A `$(...)` in printf's ARGUMENT list sits outside the `|| die` on the printf
# itself: a substitution that fails contributes an EMPTY argument and printf
# still exits 0 — and an unquoted `%s` slot then emits `"...Rewritten":,`,
# malformed JSON at exit 0. Assigned first, each one is a simple command whose
# status this function can read.
#
# `die` is NOT the answer here (#120), unlike everywhere else in this script.
# The verdict — $taken, $hits, $rc — is already correct by this point; a
# formatter that broke AFTER a real answer was established must not convert
# that answer into "unanswerable". So a field jstr or jrewritten could not
# render becomes JSON `null` — not `""`, which already means "this probe
# looked and found nothing" — and the run continues to the payload it earned,
# at the verdict's own exit code. A failed `sed` inside `jstr` used to escape
# this branch entirely and reach `""` unannounced; json.sh reads each stage's
# own status, so it arrives here as a non-zero return like any other (#119).
#
# The message names the escaper, not just the field, because the two fail
# independently: jstr can render a string perfectly while jrewritten cannot
# say whether any byte was replaced (break `tr -d` alone and that is exactly
# what happens). Naming only the field sends a debugger to whichever of the
# two it guesses.
#
# Accumulates into $evidence rather than handing back a pair per field — the
# trailing-comma-then-trim idiom `add_hit` and `add_unknown` already use above
# — so each field name is spelled once instead of three times. $ev/$rw/$why
# are scratch: not `local` because /bin/sh has no such builtin, and nothing
# reads them outside this function.
evidence=""
add_evidence() {
  why=""
  if ! ev=$(jstr "$2"); then
    why=jstr
  elif ! rw=$(jrewritten "$2"); then
    why=jrewritten
  else
    ev="\"$ev\""
  fi
  if [ -n "$why" ]; then
    ev=null
    rw=null
    echo "$NAME: could not render the $1 evidence for #$n as JSON ($why) — reported as null" >&2
  fi
  evidence="${evidence}\"$1\":$ev,\"$1Rewritten\":$rw,"
}
add_evidence pr "$pr"
add_evidence remote "$remote"
add_evidence localBranch "$local_b"
add_evidence worktree "$wt"

# Guarded because this runs OUTSIDE the three probe functions, where `set -e` is
# still live and a failed write exits 1 — and the contract reads 1 as "taken", a
# closed or full stdout rendered as a decision. `sh inflight.sh <N> >&-`
# reproduces it. (The probe bodies cannot rely on that: each is invoked as
# `probe_X || :`, which exempts the whole body from `set -e`, so every fallible
# command in one carries its own guard.) The EXIT trap installed once at the top
# of this file is the other site outside that exemption, and carries the same
# guard for the same reason — see the `|| printf` on it.
#
# The evidence slot is an unquoted `%s`, unlike every other string slot in this
# printf, and it now carries the object's keys as well as its values:
# `add_evidence` above emits each value already wrapped in its own quotes or as
# the bare word `null`, so the format string must not wrap it again. Same
# reason `hits` and `unknown` are unquoted, and the same `${…%,}` trim.
printf '{"issue":%s,"taken":%s,"hits":[%s],"unknown":[%s],"evidence":{%s}}\n' \
  "$n" "$taken" "${hits%,}" "${unknown%,}" "${evidence%,}" \
  || die "could not write the verdict for #$n"
exit "$rc"
