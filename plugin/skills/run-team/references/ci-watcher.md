# The CI watcher: its block, and why it is shaped the way it is

SKILL.md's **Own the CI waits** arms the persistent Monitor from the block
below, verbatim. The rules beside the block follow it; the evidence for each
rule is under the heading naming it.

## The block

**A probe that cannot read is a transition event, not silence.** So check the REST budget *before* polling — `gh api rate_limit` is itself
unmetered (`gh api rate_limit --jq '.resources.core.remaining'`, re-confirmed
2026-09-08) — and give an unreadable `ci-state` payload the same treatment one
level down. The shape is **one outer tick loop with an inner pass over the open
PRs**, because the two causes live at different levels — the budget is one
account, the payload is one PR:

```sh
budget_out= hidden_out= list_out= cap_out= blind= # seed the latches: set -u reads each below before tick 1 ever assigns one
pr_cap=200                                   # the open-PR read's --limit; gh stops there with exit 0 and no warning
while :; do                                   # one tick
  rl=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo ERR)
  case "$rl" in ''|*[!0-9]*) rl=ERR;; esac    # a non-numeric read is an outage, not a budget
  if [ "$rl" = ERR ] || [ "$rl" -lt 200 ]; then
    if [ -z "$budget_out" ]; then             # ONE global latch: a quota outage hits every PR
      echo "WATCHER DEGRADED: core REST budget=$rl — CI polling paused, silence is NOT green"
      budget_out=1
    fi
  else                                        # every RECOVERED waits for the pass gates below
    prs=$(gh pr list --state open --limit "$pr_cap" --json number --jq '.[].number' 2>/dev/null) || prs=ERR
    if [ "$prs" = ERR ]; then
      if [ -z "$list_out" ]; then             # global latch: this cause is account-level too
        echo "WATCHER DEGRADED: cannot list open PRs — CI polling paused, silence is NOT green"
        list_out=1
      fi
    else                                      # a list or cap RECOVERED waits for the pass gates too
      count=$(printf '%s\n' "$prs" | grep -c .) || : # grep -c exits 1 on zero matches; set -e must not take it
      if [ "$count" -ge "$pr_cap" ] && [ -z "$cap_out" ]; then # global latch: a full page may have been cut there
        echo "WATCHER DEGRADED: open-PR list hit its --limit $pr_cap — PRs past it are NOT watched, silence on them is NOT green"
        cap_out=1
      fi
      # gh pr list is GraphQL, so $rl still holds. The pass is budgeted at 4 core
      # REST units per listed PR on top of the 200 floor.
      # A shortfall here, or at the Actions-bucket gate below, pauses this tick's pass.
      if [ "$rl" -lt $((200 + 4 * count)) ]; then
        if [ -z "$budget_out" ]; then
          echo "WATCHER DEGRADED: core REST budget=$rl < $((200 + 4 * count)) needed for $count PRs — CI polling paused, silence is NOT green"
          budget_out=1
        fi
      else
        # The workflow and run lookups bill a second core bucket that
        # `rate_limit` does not report. Its count is only in the response
        # headers of a lookup that bills it: one 1-unit read per tick, 4 units
        # per listed PR on the same 200 floor. Recovery for every global latch
        # waits until this gate clears too, so no line says polling resumed
        # while this one still pauses it.
        hrl=$(gh api -i 'repos/{owner}/{repo}/actions/workflows?per_page=1' 2>/dev/null | awk 'tolower($1)=="x-ratelimit-remaining:" {sub(/\r$/, "", $2); print $2; exit}')
        case "$hrl" in ''|*[!0-9]*) hrl=ERR;; esac # a missing header is an outage, not a budget
        if [ "$hrl" = ERR ] || [ "$hrl" -lt $((200 + 4 * count)) ]; then
          if [ -z "$hidden_out" ]; then
            need=; [ "$hrl" = ERR ] || need=" < $((200 + 4 * count)) needed for $count PRs" # an unreadable header has no amount to compare
            echo "WATCHER DEGRADED: unreported Actions core REST bucket=$hrl$need — CI polling paused, silence is NOT green"
            hidden_out=1
          fi
        else
          if [ -n "$list_out" ]; then
            echo "WATCHER RECOVERED: open-PR list readable again — CI polling resumed"
            list_out=
          fi
          if [ -n "$cap_out" ] && [ "$count" -lt "$pr_cap" ]; then
            echo "WATCHER RECOVERED: open-PR list under its --limit $pr_cap — every open PR watched again"
            cap_out=
          fi
          if [ -n "$budget_out" ]; then
            echo "WATCHER RECOVERED: core budget=$rl — CI polling resumed"
            budget_out=
          fi
          if [ -n "$hidden_out" ]; then
            echo "WATCHER RECOVERED: unreported Actions core REST bucket=$hrl — CI polling resumed"
            hidden_out=
          fi
          for pr in $(printf '%s\n' "$prs"); do # inline $(...): `for pr in $prs` is ONE iteration under zsh
            st=$(~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run ci-state.mjs --pr "$pr" 2>/dev/null) || : # not-green exits non-zero; the payload is the verdict
            if ! printf '%s' "$st" | jq -e '.verdict and .verdict != "rate-limited"' >/dev/null 2>&1; then
              case " $blind " in *" $pr "*) ;; *) # latch keyed BY PR: this cause is per-PR
                echo "WATCHER DEGRADED: no usable ci-state reading for #$pr — silence is NOT green"
                blind="$blind $pr" ;;
              esac
              continue                        # inner continue — still reaches the tick sleep
            fi
            case " $blind " in *" $pr "*)
              echo "WATCHER RECOVERED: ci-state reading #$pr again — CI polling resumed"
              keep=; for b in $(printf '%s\n' "$blind"); do [ "$b" = "$pr" ] || keep="$keep $b"; done; blind=$keep ;;
            esac
            : # your normal handling of $st for this PR; a run at a terminal state is the CI wake: fleet-event.mjs ci "$pr"
          done
        fi
      fi
    fi
  fi
  sleep 120                                   # the block's only pacing, once per tick
done
```

**It has to latch** — one line entering the degraded state, one leaving it,
never one per tick. **Latch each cause at the level its cause lives
at**: the budget, the unreported Actions bucket, the open-PR list and that
list's cap are one global flag each — all account-level — but the payload latch is keyed by PR, and a
shared scalar for those is an unlatched line wearing a latch's clothes — one
persistently blind PR alongside one healthy PR re-clears the flag on every tick,
emitting a DEGRADED and a false RECOVERED pair forever. The recovery line is
what says the watch is alive again, so emit it on the first good pass even when
nothing about the CI state changed; without it a reader cannot tell a recovered
watcher from a dead one.

**Guard every probe, not just the ones with a verdict field.** Capture its status (`prs=$(…) || prs=ERR`), latch it globally, and fall
through to the same tail sleep. **Then iterate with the inline `$(printf '%s\n'
"$prs")` form, never a bare `for pr in $prs`** — the assigned-variable trap in
**Shell traps**, in references/shell-traps.md, which carries the mechanism and its
measurements. It
applies to **every** loop in this block, the `blind`-latch removal included:
under a bare `for b in $blind` a recovered PR never leaves the list and the block
emits a fresh RECOVERED every tick thereafter — the per-tick volume the latch
exists to prevent, wearing a latch's clothes again.

**A readable list can still be a short one.** Pass an explicit `--limit`
(`pr_cap`: one variable for the flag and the check, so the two cannot drift)
and treat a full page as its own degraded cause — the "no silent caps" rule
`candidates.mjs`'s `refuseIfCapped()` and `fleet-tick.mjs`'s `PR_LIMIT` already
enforce. It latches globally like the list failure but does not pause polling:
the PRs it did return are real, so the pass still watches them, and the
DEGRADED line names the rest as unwatched until a pass comes back under the cap.

**Judge `ci-state` on its payload, never its exit code** — the same rule as
`merge-gate.mjs` applies on the merge path, applied to the watcher. Empty
or unparseable output is the degraded case; parseable JSON reading
`verdict: "not-green"` is normal. An exhausted quota may also name itself,
`verdict: "rate-limited"` on stdout — likewise degraded, and likewise not a
reading, which is why the gate above tests the verdict rather than mere
parseability: that payload is perfectly good JSON.

## The pass is budgeted at 4 core REST units per listed PR

The 4 is the measured ceiling of one ci-state.mjs call on the counter `gh api rate_limit` reports, for single-page reads: 2 on the common path, 4 for a PR whose head dropped required jobs.

## One gate, not a gate plus a caveat

**One gate, not a gate plus a caveat.** `jq -e '.verdict and .verdict !=
"rate-limited"'` exits non-zero on unparseable input *and* on a false result, so
that single test covers empty, garbage AND a self-named quota refusal. Empty
stdin produces no result at all, which `-e` reports as exit 4 (measured), so a
`[ -z "$st" ] ||` pre-check in front of it is a *second* gate testing what this
one already tests — the caveat this heading is about. Leaving
the named verdict to prose instead is how a watcher clears its latch on an
outage payload and hands it downstream as CI state — the very blindness this
section exists to remove, one level in. **The `.verdict and` half is load-bearing
and not belt-and-braces**: inequality alone never tests that a verdict *exists*,
so `{}`, `null` and `{"verdict":null}` all evaluate `null != "rate-limited"` →
true and clear the gate (measured), handing an empty or error object downstream
as a CI reading. Require the field, then compare it.

## All pacing in exactly one place — the tick loop's own tail `sleep`

**All pacing in exactly one place — the tick loop's own tail `sleep`.** A sleep
inside the per-PR pass multiplies by the number of open PRs (8 open PRs → 960s
of pause per tick, against the 24s outage reset measured below), and a degraded
branch that `continue`s the *outer* loop skips the tail sleep and busy-spins
probe pairs during exactly the outage it is reporting. Every degraded branch of this file's watcher block falls through to the same single sleep instead.

## The budget is gated at the floor and again at the pass

**The budget is gated at the floor and again at the pass, and only the pass
gates announce recovery.** The tick-top floor (`200`) covers the `rate_limit`
and `gh pr list` reads. Once the open-PR list is
read, the pass gate reserves `200 + 4 × count` core REST units — 4 per listed PR
on top of the floor, so the reserve grows with the list instead of staying a
flat 200 that a long list drains mid-pass. The 4 is the measured ceiling of one
`ci-state.mjs` call's cost on the counter `gh api rate_limit` reports (measured
2026-10-13): 2 on the common path, 4 when the head dropped required jobs, for up
to 100 jobs and 100 rules — more pages cost more. That counter is not the only
core bucket one call bills. The lookups `actions/workflows`,
`actions/workflows/<id>`, `actions/workflows/<id>/runs` and `actions/runs/<id>`
bill a second one that `rate_limit` does not report; the boundary is per route,
so `actions/runs/<id>/jobs` is on the reported counter. Every response says
`X-Ratelimit-Resource: core`, so only the reset epoch and the used sequence tell
the two apart, and the unreported bucket's remaining count is readable only from
the `X-Ratelimit-Remaining` header of a call that bills it. GitHub's REST
rate-limit documentation does not describe this bucket (it says `core` covers
"all non-search-related resources in the REST API"), so the gate rests on
measurement (2026-10-13 and 2026-10-19), not on documentation. **A second pass
gate therefore probes it too**: one `gh api -i` read of
`actions/workflows?per_page=1` per tick, 1 unit of that bucket (measured
2026-10-13: its remaining count fell by 1 per call while `rate_limit` stood
still, and its reset epoch differed from `rate_limit`'s). A `ci-state` call
spends 4 units of it on the common path — one `gh run list` and one `gh run view`
cost 2 each (measured the same day) — so it is held to the same `200 + 4 × count`
reserve. 4 is the most one call spends on this bucket for a repo with at most 100
workflows: 0 with no CI, 2 with no run on the PR's head, 4 otherwise. The
dropped-required-jobs path adds only reported-bucket calls, and the workflow-name
lookup pages 100 workflows per page, so a repo with more pays more per call. The
bucket is account-wide, not per repository: probes on three unrelated
repositories drew one countdown and one reset epoch (measured 2026-10-19), so
another run on the same token, or any `gh run` use, spends it, and its
DEGRADED line can fire with few open PRs on this repository. It has its own
global latch (`hidden_out`) and its DEGRADED and
RECOVERED lines name it, so a pause on this bucket is not misread as the
reported budget running low. An unreadable header is an outage here exactly as a
non-numeric `rate_limit` read is. The probe runs only when the reported-bucket
gate has cleared, so a tick costs at most one probe call. The gate pauses before
the per-PR pass, so it never touches the per-PR blind latch: a PR is either not
polled — no per-PR line, and one already latched blind stays latched — or polled
and reported through that latch alone, never by both. A shortfall at any of
these gates pauses the **whole** pass and never polls a prefix of the list: a prefix runs
in list order, so the same tail PRs would go unread every tick with no line at
all (never polled, so nothing marks them blind), while the PRs that were polled
would run dry mid-pass and each emit a blind line. The DEGRADED line from each
pass gate names the amount it needed and the count it needed it for — except an
unreadable header, which has no amount to compare and prints `bucket=ERR` alone
— so a healthy-looking `budget=999` is not read as an outage with no cause. Only the
pass gates emit RECOVERED lines — the budget's and the unreported bucket's, and the
open-PR list's and its cap's with them — and all of them only once the pass will
actually run: announcing recovery at the floor, or for one bucket while the other
still pauses the pass, would report resumption on a tick whose other gate then
pauses it again — a DEGRADED/RECOVERED pair every tick — and announcing the list or
its cap on the tick that reads it back would say polling resumed on a tick that
polls nothing. A list or cap latch held across a paused tick stays latched and says
nothing more.

## Do not back off and wait

**Do not back off and wait.** These outages are short — a rolling window; one
measured reset came 24 seconds after `remaining: 0` — and pausing members for a
fixed interval stalls the fleet longer than the outage itself would have. A
retry-and-wait loop is what turns a 60s outage into a stalled member. Report it,
keep the local work moving (git, tests and mutation runs are all unaffected),
re-probe.

## While the budget is exhausted, `ledger.mjs check` reads unverified

**While the budget is exhausted, `ledger.mjs check` reads
`verdict: "unverified"`** — the ledger was read and the tracker was not. That is
correct behaviour, but `unverified` exits **0**, the same as `clean`, so a
member treating exit 0 as "safe to file" files blind during exactly this window.
Say so when you flag the outage: members read `verdict` explicitly until you
report recovery, never the exit code alone.

## A probe that cannot read is a transition event, not silence

The natural
watcher shape — `st=$(ci-state.mjs --pr "$pr" 2>/dev/null) || continue` — fails
closed correctly and then throws the failure away, so a rate-limited probe emits
NOTHING and "no event" becomes indistinguishable from "not green yet". Every
open PR stalls unlabelled while the run reads as merely quiet; observed live
twice.

## It has to latch

An unlatched line at a 120s poll gets the Monitor
auto-stopped for volume during even a two-minute outage, reintroducing the same
blindness by another route.

## Guard every probe, not just the ones with a verdict field

The block makes
several API calls, and `gh pr list` is the one that looks like
plumbing rather than a probe. A non-quota failure there (secondary/abuse limit,
5xx, network blip, expired token) does not lower `.resources.core.remaining`, so
the budget gate clears, and an unguarded `for pr in $(gh pr list …)` then
iterates zero times over the empty substitution: no error, no latch, no DEGRADED
line — total silence per tick, which is exactly what this section exists to
remove.

## A readable list can still be a short one

`gh pr list` stops at its
`--limit` — 30 when the flag is absent — with exit 0 and no warning, so a list
that fills its limit reads exactly like one that happens to be that long, and
every open PR past it goes unwatched without a line.

## Judge `ci-state` on its payload, never its exit code

`not-green` is an
ordinary, frequent state that exits non-zero, so a watcher treating any non-zero
exit as an outage misfires constantly on PRs that are merely in progress.
