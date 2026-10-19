# The CI watcher: why its block is shaped the way it is

Evidence for the rules SKILL.md states beside Phase 3's watcher block, keyed by the rule each justifies.

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
probe pairs during exactly the outage it is reporting. Every degraded branch of SKILL.md's watcher block falls through to the same single sleep instead.

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
bucket is account-wide, not per
repository: probes on three unrelated repositories drew one countdown and one
reset epoch (measured 2026-10-19), so another run on the same token, or any
`gh run` use, spends it, and its DEGRADED line can fire with few open PRs on
this repository. It has its own global latch (`hidden_out`) and its DEGRADED and
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
