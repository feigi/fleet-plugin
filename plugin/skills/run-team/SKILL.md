---
name: run-team
description: Run an agent fleet — implementers, reviewers, one merge bot — over the ready-for-agent queue. Invoke-only; the fleet writes to a live repo and must never start unasked.
argument-hint: "[in-flight]"
disable-model-invocation: true
---

Run `next-ticket`, `review-and-fix`, `run-merge-bot` as one fleet. You are the
**controller**, in the main thread, never a member.

`$ARGUMENTS` = `[in-flight]`, optional, one positive integer, default 5: the
In-flight bound, the most tickets between Claim and merge at once. It becomes
the tick's `--in-flight` and `tier-roles.mjs --check --in-flight`.
Merge bot is at most one, not configurable.

The war story behind a rule ending `See references/<file>` lives in that file; load
it only when a member needs the *why*. A rule without that line carries its
reasoning inline — nothing is missing.

## Invariants

These hold in every phase: check a wake against them before you act on it, and report any evidence that one is broken.

- In-flight tickets at most the bound (default 5), at most one merge bot; the bound counts tickets, not live agents.
- A grandchild surfaces as its own task-notification; an unrecognized task-id is not a member reporting done.
- A reviewer never reviews a PR it implemented.
- The merge bot only touches PRs whose implementer reported done; rebasing a worktree someone is working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never you — but for the run's own artifact PR, which this line does not reach: label and merge that one yourself.
- Every member acts through the maintainer's `gh` credentials, so no write is attributable: when a label moves unexpectedly, ask members directly, rule out automation with `grep -rn '<label>' .github/workflows/`, and do not re-add it.
- Phase 1 is serial; everything else may run concurrently.

The reasoning behind each line is in references/invariants.md.

## Phase 0 — shortlist

This phase is done when `phase0.mjs` exits 0: run it again after an exit 3 (a step failed) or an exit 4 (a `NEED` line asks you to act), and dispatch nothing before.

Once per run, at start. Supply is automatic after that: the tick
refreshes the Shortlist itself, and every admission is a **Pull** — one ticket
into one free implementer slot, the moment it frees (phase 1). Nothing in this
phase, or in any later one, asks the maintainer which tickets to take.

0. **Once per run, before anything else.** Run phase 0 from a Python eval
   cell in this main checkout, without `--session`:
   `subprocess.run([os.path.expanduser("~/.fleet/bin/fleet-run"),
   "phase0.mjs", …], stderr=subprocess.STDOUT)`. Add `--in-flight <n>` when
   `$ARGUMENTS` gave one, `--plugin-checkout <dir>` when this workspace tracks
   no `plugin/…` of its own, `--spend-dir <dir>` to name the directory the
   cockpit's spend panel reads, and `--workflow <name>` or `--declare-no-ci`
   when the repository has no workflow named CI. Its steps and receipt: See
   references/phase-0.md. Dispatch nothing before it exits 0. Exit 4 is a
   step that needs you: act on each `NEED` line below, then run it again. Once
   `rotate` has run, a re-run skips every `ok` step but `alarm` and resumes
   where the last one stopped; before it, a re-run runs every step again.

   The `tier-roles` step runs `~/.fleet/bin/fleet-run tier-roles.mjs --check
   --in-flight <B>`, `<B>` being the `--in-flight` given, else the default.
   **Default: In-flight bound 5, fixed for the run.** See references/pull.md. What it checks is in the header of `scripts/tier-roles.mjs`, under
   the tier routes. A line it prints on a pass about omp's `task.maxConcurrency`
   is a notice in the step's output and never holds: read it, report it, and
   go on — the fleet never writes that setting.

   - `NEED derive-recipe` — the Recipe cache holds nothing valid. Dispatch a
     `task` member named `derive-recipe`, agent `fleet-recipe-deriver`, its
     prompt the brief `~/.fleet/bin/fleet-run dispatch-prompt.mjs render
     recipe-deriver --member derive-recipe --repo <repo> --scratch <scratch>`
     prints (`<repo>` this main checkout's absolute path, `<scratch>` what
     `scratch-root.mjs` prints), and wait for its report. `RECIPE PROVEN` →
     run `phase0.mjs` again. `RECIPE NOT PROVEN` → stall: report `STALL —
     Recipe not proven: <cause>` to the maintainer with the deriver's reason
     verbatim, and claim, Pull and review nothing.
   - `NEED resume #<n> <worktree> <branch>` — a dead run's claim: no PR, or not only `CLOSED` ones.
     Dispatch a stranded `impl-<n>-b` the ordinary way (record it with
     `ledger.mjs row`, render its brief, `ledger.mjs dispatch`, the `task`
     call, the tier check), in that worktree and branch, and never with
     `claim-ticket.sh`: the claim stands. A re-run finds the need met once its
     row is written. A `report #<n> — <why>` line is the maintainer's and
     nothing else, and a `carried` line is a live token to reconcile first.
     A closed-PR `report` takes `replace`/`release #<n>`.
   - `NEED review PR#<pr> (closes no issue)` — an open PR a prior run left
     that no row can queue. Advice, never an exit status: hand-dispatch its
     review exactly as ticket work, or leave it.

   A `drift` or `unanswered` ruleset step is advice too: surface the diff and
   go on. See references/phase-0.md.

1. **Build the Shortlist** — `~/.fleet/bin/fleet-run shortlist.mjs`, then read
   `.fleet/shortlist.json` — `{scanned, shortlist: [{n, t}], dropped: [{n, reason}]}`:
   the survivors of its cheap filters, every probe failing CLOSED
   (references/phase-0.md, **Build the Shortlist**). Exit 0 is the file
   written, an empty shortlist included; exit 2 is a refusal and the previous
   file stands — never read 2 as empty. **`--require-label ready-for-agent`
   mandatory, no fallback**: never run `candidates.mjs --allow-fallback` by hand.

   `candidates.mjs`'s exit 3 reaches you as an empty shortlist whose `dropped`
   names every ticket the to-spec filter took, by number and reason — and the
   tick prints the same list on every tick, `specs-dropped=#<N> (to-spec: User
   Stories heading)` on the implementer row. **Exit 3 is not that empty queue, and never a reason to
   widen the net.** It says the labeled query returned rows and the to-spec
   filter took every one: what is queued is to-tickets' input rather than
   claimable tickets, and a member handed one implements an entire spec as a
   single ticket. Log it as
   specs awaiting to-tickets, not as no work — read the numbers off
   `dropped` or `specs-dropped=`, not off stderr, which the tick's own
   refresh discards — and still do not pass
   `--allow-fallback`, whose second pass is unfiltered and so reaches the
   `ready-for-human` and untriaged work you have no channel for. A partial
   drop, survivors and specs together, is named the same way.
2. **Refresh is the tick's from here on**: it prints `REFRESHED shortlist: <n>
   entries; <k> lifted` (references/tick-rows.md, **Refresh is the tick's**).

## The wake table

A wake is done when its one `fleet-event.mjs` call has run and you have acted on every line it printed, the tick's last; with nothing left to act on, mark the beat and end your turn. What a wake owes beyond its call is under **What a wake owes beyond its call**, below. The loop has no exit but the run's own end: drain the run when it ends (**End of run**).

React to events; never block on one.

**React to artifacts, not agents.** `idle` means "not currently executing", not
"done", and a finished member's finding may never arrive. Read `gh pr view`,
`gh run view`, `git -C <worktree> status` **before** messaging; when you message,
send the specific next action, never "what is your status".
See references/member-lifecycle.md.

**Do not ask permission to run the loop.** Dispatching a reviewer, spawning a
merge bot, Pulling a ticket, re-verifying a SHA, filing a follow-up — all proceed
unconfirmed. Invoking the command was the opt-in. One exception: **a judgement the
evidence cannot settle**.

**Rule: record, tick, act, beat.** Every wake — a member report, a review
notification, a label, a CI run reaching a terminal state, a `CONFLICT` line, a
heartbeat, the maintainer's drain — is one `fleet-event.mjs` call, which makes
the wake's writes and ends in one `fleet-tick.mjs` invocation, and you do what
it prints. There are no hand-run refill or dispatch edges left, and no hand
edit of the ledger. See references/ci-and-staleness.md.

Run each as `~/.fleet/bin/fleet-run fleet-event.mjs <kind> <args>`, from the main checkout:

| Wake | Command |
|---|---|
| Implementer report | `fleet-event.mjs impl-report impl-<N>` |
| Review result file written (workflow notification / `review-pr-<n>` report) | `fleet-event.mjs review-result <pr> <path>` |
| Review launch failed | `fleet-event.mjs review-failed <pr> <launch>` |
| Fix-applier report | `fleet-event.mjs fix-report fix-pr-<M>` |
| Finisher report | `fleet-event.mjs finisher-report finisher-pr-<M>` |
| Merge-bot pass report | `fleet-event.mjs merge-bot-report merge-bot-<n>` |
| CI run terminal | `fleet-event.mjs ci <pr>` |
| Label seen (persistent Monitor) | `fleet-event.mjs label <pr>` |
| `CONFLICT` line | `fleet-event.mjs conflict <pr>` |
| Alarm (a [fleet-alarm] turn) | `fleet-event.mjs heartbeat` |
| Drain | `fleet-event.mjs drain --reason "<reason>"` |
| Undrain | `fleet-event.mjs undrain --reason "<reason>"` |
| Member confirmed dead or never dispatched | `fleet-event.mjs member-died <member>` |

### What a wake owes beyond its call

Act on every line the call prints, the tick's last, and mark the beat. What a wake
owes beyond its call:

- **Implementer report** → the PR is owed a review from here on:
  the tick names it as `DISPATCH review PR#<M>`, and it names the next
  shortlist head whenever the In-flight count is below the bound. Pull
  nothing the tick did not name.
- **Finisher reports halted** → the per-cause rule (**Resolving a finisher
  halt**, below).
- **A finisher failed or was killed** → the **Member confirmed dead or never dispatched** wake (`member-died finisher-pr-<M>`), which settles it `failed` or `killed`; no label, and the tick prints no dispatch for it. The cockpit flags the PR `finisher:failed` / `finisher:killed` at severity 4 and you resolve it by hand (**Resolving a finisher that died**, below), then run the tick.
- **Implementer bails before implementing** → `fleet-event.mjs impl-report impl-<N>`; the causes and the issue action each takes are under **Relabel causes**. **Only an explicit bail report — the member itself naming the cause — reaches Implementer bails before implementing**; a died or merely-quiet member's silence never does.
- **A review result lands** → see the result file written (by you or by the
  runner — **The reviewer** says which, per harness), then
  `fleet-event.mjs review-result <pr> <path>`: a PR with survived or unverified findings prints as
  `DISPATCH fix-pr PR#<M>`. No survived or unverified finding and nothing to file → skip the
  fix-applier and dispatch the **finisher** directly — or, when that head's
  bound conclusion is red and not solely staleness, the red-check fixer
  instead (**Then dispatch a red-check fixer**, below): no member will touch that
  PR, so no push is coming and nothing will wake you. A review that failed is
  not a result — **Recovery** says who retries it and what takes over.
  Read the digest as **Reading a review result** says.
- **Monitor: `ready-to-merge` appears** → `fleet-event.mjs label <pr>`, and
  on `DISPATCH merge-bot` dispatch the next `merge-bot-<n>` (**The merge bot**).
  **You own the watcher, not the bot.** Arm one yourself,
  `persistent: true`, seeded before the loop so handled PRs do not re-fire.
  **One rebase per PR, at merge time.** Any behind-count you hand a bot is
  expired on arrival; say so. See references/ci-and-staleness.md.
- **Merge-bot pass reports done** → `fleet-event.mjs merge-bot-report merge-bot-<n>`. A label that
  landed at the last moment reads `DISPATCH
  merge-bot` again: dispatch the next bot straight away. A `rebase-fallback-#<pr>`
  on a conflict needs no record from you — the bot already appended
  `conflict-hold:#<pr>` to that PR's row, and the tick turns it into `DISPATCH
  fix-pr PR#<pr>` (**The fix-applier**). The tick's `--apply` reaps after the
  pass. Read `worktreesRemoved` alongside `reaped`: a pass that
  reaps branches and removes no worktrees is a finding, not a quiet success.
  Update the reaped tickets' ledger rows in the same step.
  **Do not invoke `commit-commands:clean_gone`**: do the reap yourself. **Never
  reap a branch a live member is on** — cross-check `.fleet/ledger.md` first
  for a row without a terminal state.
  See references/reaping.md.
- **The run ends, or the maintainer says drain** → **End of run**, in this
  order; the drain starts the end of the run, it does not end it:
  1. `~/.fleet/bin/fleet-run fleet-event.mjs drain --reason "<reason>"` — runs
     `closeout.mjs begin --reason "<reason>"` (references/reaping.md), then the
     tick, which holds the implementer row at `HOLD (draining)` from then on. A
     claim it refuses prints `NEED hand-release #<N> <blocker>`: that refusal is
     the finding, so run `worktree-audit.sh` and decide by hand. `begin`
     selects a claim with no PR and a live or `bailed` implementer token on
     every run, so a claim you keep leaves `begin` at exit 4 on every run:
     release the rest by hand and run `begin` again.
  2. Act on the review, fix-applier and merge rows until the tick prints
     `ACTION: run over → fleet-heartbeat.mjs --stop "<reason>"`, which it does
     once the run is draining with no open PR and no live implementer.
  3. `~/.fleet/bin/fleet-run closeout.mjs finish --reason "<reason>"`, which
     then records `fleet-heartbeat.mjs --stop` last, because every reader takes
     a recorded stop as the end of the run. A `NEED tier-outcomes append
     <pr>` is a PR the ledger marks reviewed with no verdict row: append it with
     the verdict you rule (**Guard: accumulate per PR**) and run `finish` again.
     A PR closing none or several: a row only if an impl token names it.
     A step it fails is explained in references/close-out.md. Exit 0 is the run
     closed.
  Drain only when a documented trigger fired, and name the trigger in `--reason`.
  **Undrain** only when the maintainer asks, never a drain that budget or
  context exhaustion caused (references/close-out.md).
- **The finisher-gate wakes** — a CI run reaching a terminal state, a fix-applier reporting `no-op`, a `no-ci` verdict → each is a bullet of **The finisher gate**.

Write each state change through `ledger.mjs` before you act on it, never by hand: a wake is done when no row, filing or ruling lives only in your context.

Compaction parks every in-flight member and nothing reports it, so on resume take the registry census first (**Member unaccounted**, in **Failure handling**) before you trust a live token.

`ledger.mjs token <key> <token>…` adds a token and keeps every token already on the row; re-typing the row with `row` drops the tokens you do not restate. Write member tokens and `review=` tokens only through `ledger.mjs`, never by hand.

Never rotate the ledger mid-run: it is phase 0's step alone.

Record each ruling with `ledger.mjs ruled <pr> <decision>`, one line with its reason. Gate on the `ledger.ok` field of `check`, not on the stderr warning. The writer policy, the gap the lock does not close, and `check`'s exits: See references/ledger.md.

**Write the ledger line before dispatching, not after.** Record the member with `ledger.mjs dispatch`, or `review` for a review, before its `task` call.

### Dispatching the members a wake names

- **The reviewer.** **Dispatch the review, never wait on it, and act when its result lands. That is the default path.** `DISPATCH review PR#<M>`: a `task` member named `review-pr-<pr#>`, agent `fleet-review-runner`, its prompt the five args `pr`, `branch`, `worktree`, `testCmd` and `scratch`. Record `review=member:review-pr-<pr#>` on the PR's row before the call, with `ledger.mjs review <pr> <token>`: the tick counts in-flight reviews off the ledger and nowhere else. `scratch` is the scratch root itself, never a `pr<N>` partition (`references/reviewers.md`). The runner writes the result file and reports its path and `reviewed=` token.
A row with `review=` and no `reviewed=` is a review in flight, and the tick counts it as a live review unit unless gh reports its PR MERGED or CLOSED.
- **The fix-applier.** `DISPATCH fix-pr PR#<M>` on a `reviewed=` count that survived or unverified findings, with no fix-applier live: name `fix-pr-<pr#>` (the next suffix if that name is on record), never the PR's implementer; render with `dispatch-prompt.mjs render fix-applier --kind review --member fix-pr-<pr#> …`, then record `ledger.mjs dispatch <pr#> fix-pr-<pr#>` before the call. Its brief carries the PR number, the worktree abs path, the PR's branch, the same `testCmd` you passed the review, and the **path** `<scratch>/pr<pr>/<run>/review.json`, `<run>` off the PR's latest `reviewed=` — never the findings. Every `<scratch>` in that brief is the absolute path `scratch-root.mjs` printed. Its rulings are the fix-applier body's (`agents/fleet-fix-applier.agent.md`); you hold none, and a refuter report that surfaces to you is its to retrieve, never yours to scan or pass on. On a PR carrying `ready-to-merge`, its push moves the head after the label: a fresh finisher, per **Failure handling**.
- **The conflict hold.** `DISPATCH fix-pr PR#<M>` on a conflict hold: the row carries an unresolved `conflict-hold:#<M>`, the merge bot's or one you recorded off the tick's `CONFLICT` line. It is the same slot with a different job, and no review file to hand over. Name it `fix-pr-<M>`, or the next suffix (`-b`, `-c` …) when that name is on record; render with `dispatch-prompt.mjs render fix-applier --kind conflict --member <name> …`; dispatch with the `agent` `ledger.mjs dispatch` printed, in the PR's existing worktree. Read the definition off that output (`fleet-fix-applier` whatever the row's `tier=`), never recall it. Settle `applied:<head>`, or `no-op` if no conflict was left, which lifts the merge hold; a dispatched-but-live one does not, and `failed`/`killed` leave the PR fix-due for a replacement. It answers the hold and nothing else: review findings the row also carries get a review `DISPATCH fix-pr PR#<M>` once it lands.
- **Then dispatch a red-check fixer** — on a `check`-job `failure` bound to the PR's current head that is not **solely** staleness (the five-condition note in `agents/fleet-fix-applier.agent.md`). Name `fix-pr-<M>`, or the next free suffix; render with `dispatch-prompt.mjs render fix-applier --kind red-check --member <name> …`, record with `ledger.mjs dispatch <pr#> <name>` before the call, and dispatch with the printed `agent` in the PR's existing worktree. Never while a review or a review fix-applier on the PR is live or still owes its report — a dispositions mismatch awaiting its retry and a conflict hold awaiting its fix-applier included; a red before any review still gets its review first. The tick prints no `DISPATCH` for it: reconcile it yourself, always after the review. The finisher gate applies to it as to a fix-applier. Settle it `applied:<head>` once a fix is pushed; `no-op` only when the red is not its to fix — a flake that passes on rerun, or staleness — with nothing pushed, never for "could not fix"; `failed` when it cannot reach green (**Failure handling**). Its three dispatch edges are under **The finisher gate**; their rationale is in `references/member-lifecycle.md` (The red-check fixer's three edges).
- **The merge bot.** Named `merge-bot-<n>`; `ledger.mjs dispatch merge-bot` numbers it. Never two at once. Render `--member merge-bot-<n> --n <n> --scratch <scratch>`. Dispatch with the printed agent, omit `model`, and dispatch on the first `ready-to-merge` label without waiting for the finisher report.
- **The finisher.** Its render and receives are in `references/finisher.md`.

**A fleet member is never dispatched with omp's `isolated: true`.** See references/isolation.md.

**A member's tree is the claimed worktree, addressed by absolute path.** See references/isolation.md.

**The controller's own cwd stays the main checkout, unchanged.** See references/isolation.md.

**Name every member.**
Names follow the unit of work: `impl-<issue#>`, `fix-pr-<pr#>`,
`review-pr-<pr#>`, `finisher-pr-<pr#>`, `merge-bot-<n>`.

**Fresh context per member.** One member, one unit of work, gone. Refill =
**new** member, **new** name. See references/member-lifecycle.md.

**The scratch root is computed, never invented and never recorded.** You run
`~/.fleet/bin/fleet-run scratch-root.mjs`; a non-zero exit is an environment to
fix, not a cue to pick another root.
`<scratch>` in this file is the path it prints, resolved before you send
anything: every brief that carries one carries the absolute path. A member
whose prompt names no path asks you by name and never makes one up. See
references/isolation.md.

### Reading a review result

**You read the digest; the findings are the fix-applier's.**
`jq '{pr, head, resume, testEnvironment, suiteVerdict, dimensionsRun, dimensionsUnrun, cwdAudit, counts}' <scratch>/pr<pr>/<run>/review.json`
is the whole of your read, and it is what you record: `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`,
off `head`, `counts` and the run root's name — the runner's `ledger` field — on
the PR's row, with `ledger.mjs review <pr>`. Every later path to the review is built from that token, before a
restart or after one: `<scratch>/pr<pr>/<run>/review.json`, `<run>` off the PR's
latest `reviewed=`. Findings never enter your context. The fix-applier
reads every one off the file and makes every ruling on them
(`review-and-fix.md`'s **The review result file**); never rule on one
yourself. Each digest field in full: See references/reviewers.md. What the
digest asks of you:

- **`testEnvironment` says what the review's shared test run is evidence about**: read it so a degraded review never passes for a clean one.
- **`resume`** non-null: resume beats handing a crash-heavy review on, except that no replay exists for a review that ran in a runner's own kernel — `resume` is reported, not acted on, and the fix-applier defers what it names.
- **`unverified`** is *not* "checked and cleared", and **`refuted`** may be reversed: copy the fix-applier's reversals to the ledger's `ruled` line by running `fleet-event.mjs fix-report`.
- **`suiteVerdict`** — **Exit 75 is not a test result.** In a review it makes
  `suiteVerdict` not usable, `suiteVerdict.reason` beginning "no suite slot within
  <n> s — the host is at its suite bound; not a test failure", with no retry
  inside the run: read that `reason` off the digest and re-review it
  under the next runner letter (`review-pr-<pr#>-b` after a first runner), as for
  a runner that reported `failed`.
- **`cwdAudit`**: `missing` is exactly as loud as `dirty`, and both name a
  checkout you should treat as a live scratch write until you have checked it.

**Know the trim before you rely on it — it is wider than `docsOnly` suggests.** See references/reviewers.md.

**A refutation resting on an injection nothing proved landed is not a refutation — it is a cell that never ran.** See references/reviewers.md.

**Guard: accumulate per PR, never conclude inside one run.** **Append one row to
`docs/metrics/tier-outcomes.tsv` when you rule each PR's review, with
`~/.fleet/bin/fleet-run tier-outcomes.mjs append <pr> --closed-own-ticket yes|no --minted-false-claim yes|no --note "<text>"`,
never by hand** (that file's header carries the column meanings). The script
fills `run_date`, `pr`, `ticket` and `tier` itself — `tier` from what actually
ran, off the implementer's `tier-ok=` ledger verdict or else its one
member-outcomes row (a `tier-unverifiable=` member has no ledger verdict, so
its one member-outcomes row decides), and BLANK with a WARNING naming why
when neither settles
it; never type a tier in over that. That append is the whole duty. See references/pull.md.

**A verdict is a measurement only if it post-dates the run that produced it.** See references/reviewers.md.

### Nothing to do: mark the beat and end your turn

- **Nothing to do right now** → mark the beat, then end your turn.

**Mark the beat when there is nothing to do, and end your turn.** See references/ci-and-staleness.md.

```bash
~/.fleet/bin/fleet-run fleet-heartbeat.mjs \
  [--base 300] [--ceiling 1200] [--multiplier 2]
```

It returns at once and prints one line. Which line it is, is the whole protocol:

- `… beat marked, alarm due in <N>s (quiet=<n>) → end your turn` — the mark is
  recorded. The alarm's turn arrives as a user message that
  starts `[fleet-alarm]` and names `fleet-event.mjs heartbeat`: run that
  command and act on what the tick it ends in prints. Then mark the beat again.
- `… beat NOT marked …` — this beat arms no alarm you can count on, so ending
  your turn could be the stall. Fix what it names; rerun.

**Do not raise `--ceiling` past 30 minutes.** See references/ci-and-staleness.md.

**The beat does not stop on idleness**: the run ends when you drain it, when
the budget goes, or when this context does, and zeroes on the cockpit are not
proof the pipeline is idle. See references/ci-and-staleness.md.

**When you stop on purpose, say why — one command, and it is the last thing
you owe the next run.** See references/ci-and-staleness.md.

```bash
~/.fleet/bin/fleet-run fleet-heartbeat.mjs --stop "budget exhausted"
```

It holds nothing and returns at once. Use it when the budget goes, or when
you can see the context ceiling coming. A drained run records it as the last
step of **End of run** (above), never at the drain itself.
Skipping it is not fatal: the next reader reports a stop *without a recorded reason*.

**A stall line names whose stall it is.** Its opening words come off the controller
record:

- `heartbeat STALLED, controller gone` — the run that stranded them is dead.
  Its claims without a PR come back through the next run's phase 0
  stranded-claim step (references/phase-0.md, "Resume the claims a dead run
  left without a PR"), and its open PRs through the fold-in.
- `heartbeat not beating, controller alive (pid N)` — a controller that
  stopped beating and kept going. Nothing died, so nothing is resumed; when
  that controller is you, the fix is to tick on every wake and beat when there
  is nothing to do.
- `heartbeat STALLED` alone — no record says whether that controller lives.
  The line is detection only.

Your first tick may print `previous run stopped deliberately at <time> (<age>
ago) — recorded reason: <reason>` instead: the stop the previous run recorded.
It is that run's end, not a verdict on yours, and no later tick prints it.

Read the line and carry on; nothing in the fleet releases, relabels or
reaps the stranded tickets for you, and nothing restarts the run that stranded them.

## The tick's rows

Act on each line the tick prints as its row reads here, then stop: the next wake runs the tick again, and a row marked advice or not actionable asks nothing of you. The full text of each row is in references/tick-rows.md.

**In one line, every wake is one `fleet-event.mjs` call, which ends in the tick.** One tick invocation, and you act on what it prints:

```
~/.fleet/bin/fleet-run fleet-tick.mjs --apply [--in-flight <n>]
```

Read the depth off the tick and never derive it by hand: act on the row it prints, and when it prints `SUGGEST /triage, hold idle`, hold the implementer row idle and suggest `/triage` in the report. See references/tick-rows.md.

**The review backlog never gates, and the merge-queue depth is still no
signal.** The only gate on a Pull is the In-flight count. A deep backlog is a
`DISPATCH review` on the same tick, never a reason to idle an implementer.
A starved implementer queue never stalls the review or merge side.
For the merge queue, see references/pull.md.

**Reconcile, do not wait for an event.** With the shortlist empty the tick's rows
govern — refresh, and never Pull a ticket the shortlist does not hold.
See references/pull.md.

The tick reads the run itself, off `.fleet/ledger.md`, `.fleet/shortlist.json`
and `gh`; nobody states a count (references/tick-rows.md, **What the tick
reads**). A ledger token it cannot read, it refuses rather than guessing:
correct that row with `ledger.mjs row` and tick again. The In-flight bound is fixed for the run:
pass `--in-flight` on every tick when `$ARGUMENTS` set it, and never otherwise.

It prints `actual/target` and a named ACTION per role. Act on each line as it reads:

- `PULL #<N> …` — one Pull per named ticket, in the order printed: `pull.mjs next --head <N>`, or the `pull.mjs answer` the row names (phase 1), then the dispatch under **Dispatching the Pull's member**.
- `REFRESHED shortlist: <n> entries; <k> lifted` — the tick refreshed the shortlist itself, and its `PULL` row already reads the result; `REFRESH FAILED` is yours, since `shortlist.mjs` could not run.
- `SUGGEST /triage, hold idle` — nothing is admissible after the refresh: suggest `/triage` in the report, never run it. The suggestion is a report, not a blocking prompt.
- `specs-dropped=#<N> …` — never actionable: log those tickets as specs awaiting to-tickets, not as no work.
- `DISPATCH fix-pr PR#<M> …` — a fix-applier for that PR (review findings, a dispositions mismatch no retry has answered, or a conflict hold): render its brief with `dispatch-prompt.mjs render fix-applier --kind <kind>`, `ledger.mjs dispatch <M> fix-pr-<M>` (the next suffix when that name is already on record), then the `task` call.
- `DISPATCH review PR#<M> …` — a review per PR, oldest first, off your turn: record `review=member:review-pr-<M>` with `ledger.mjs review <M> …`, then dispatch `review-pr-<M>`.
- `DISPATCH merge-bot` — the next `merge-bot-<n>`: render its brief with `dispatch-prompt.mjs render merge-bot --member merge-bot-<n> …`, `ledger.mjs dispatch merge-bot`, then the `task` call.
- `DISPATCH finisher PR#<M> …` — a finisher settled `labelled` with no label on the PR and no `label-off=` to account for it: apply the finisher gate, render the next-suffix finisher's brief with `dispatch-prompt.mjs render finisher --kind repair --member finisher-pr-<M>-<x> …`, `ledger.mjs dispatch <M> finisher-pr-<M>-<x>`, and never add the label yourself.
- `ESCALATE unlabelled PR#<M> …` — a second finisher settled `labelled` and the label is still off: not actionable, the maintainer's.
- `CONFLICT PR#<M> …` — record the hold with `fleet-event.mjs conflict <M>`, never with the `ledger.mjs row` form; the tick then prints `DISPATCH fix-pr`.
- `ESCALATE conflict PR#<M> …` — PR M reads CONFLICTING again after two conflict fix-appliers: comment on the PR and flag it for a human, write no hold, dispatch no fix-applier.
- `ESCALATE pr-closed #<N> PR#<M>`, `… pr-unchecked …` — the maintainer's: tell them once per ticket per run; no dispatch or comment for #N. Reopening M or closing #N clears it. Only `replace #N` (`NEED resume`, same row) or `release #N` (closed-PR `release-ticket.sh --apply`, settle `released`) acts, once no live member names M.
- `HOLD (…)` — the row is held and its detail names the clearing step: dispatch nothing on that row until it clears; a tier mismatch is yours to clear by dispatching the replacement.
- `AT CAP`, `IDLE OK` — nothing to do on that row.
- `MAIN-CHECKOUT-DIRTY …` — dispatch nothing new and tell the maintainer; once they have resolved the paths, `main-checkout.mjs --record`; never revert the paths or re-baseline over them yourself.
- `MAIN-CHECKOUT-UNKNOWN …` — the tick could not look: fix what the line names and tick again, and never `--record` over it unless the line itself says re-record (an older-format baseline, or a baseline commit missing from this repository), and then only after resolving the stray paths.
- `MAIN-CHECKOUT-NO-BASELINE …` — yours: run `main-checkout.mjs --record`, after reporting a baseline that vanished mid-run.
- `PHASE0-INCOMPLETE <step>…` — every dispatching row is held: run the `phase0.mjs` command the line names; advice lines hold nothing.
- `CHECK-LIVENESS <member> (…)` — advice, never an action: take the census the **Member unaccounted** row of **Failure handling** gives before you touch the token.
- `UNRECORDED <stem> (…)` — record it with `ledger.mjs dispatch`, or confirm it is a stranger's member.
- `NO-TRANSCRIPT <member> (…)` — make the `task` call, or run the **Member confirmed dead or never dispatched** wake.
- `SETTLE <member> (report on disk …)` — a live token whose report is on disk: run that member's report wake from the wake table, which runs the `ledger.mjs settle <member> --from-report` the line prints plus the follow-on work its report calls for; `REPORT-MISMATCH`, `REPORT-UNREADABLE` and `REPORT-INVALID` name a report file that cannot be settled from, and the tick settles nothing itself.

## Phase 1 — Pull: judge, then claim or relabel

A Pull is done when `pull.mjs next` exits 0 with its `DISPATCH` line, which the dispatch under **Dispatching the Pull's member** acts on, or exits 1 with the ticket gone from the Pull: answer each question it stops at, and take the next entry after an exit 1.

Serial, main checkout, one Pull at a time. Never parallel, never inside a member —
concurrent `worktree add` and label writes race.

A Pull's entry is `~/.fleet/bin/fleet-run pull.mjs next --head <N>`, run from
the main checkout (without `--head`, the next shortlist entry). It stops at
each judgement with a `QUESTION <qid>:` block and exit 10; `pull.mjs answer <N>
<qid> <token> [--path <p>] [--] [<text>…]` records the answer and resumes it.
Exit 2 names what could not be looked at: `next --head <N>` again retries a
failed step, the same `answer` again one that failed while applying an answer,
and after a router refusal `next --head <N>` starts the ticket over. Every
other exit is in **The exit table**; the record is
`<scratch>/impl-<N>/pull.json`. See references/pull.md for what each step does, and why.

### The tick's PULL rows

**The tick's `PULL` rows name the command.** One free implementer slot is one
Pull, and each head a free slot Pulls gets its own row, read off that head's
`pull.json` and never folded:

| Row | Where the Pull stands |
|---|---|
| `PULL #N — pull.mjs next --head N` | none of this run's in progress — `next` starts it, or resumes one a failed step left |
| `PULL #N (Q2 pending — pull.mjs answer N decided …)` | a question stands: answer it; `next --head N` prints it again |
| `… (stale)` appended | that question has stood longer than `--pull-stale-minutes` (120 by default) |
| `PULL #N (dispatched, row missing — ledger.mjs row N "…")` | dispatched, yet the head holds no `impl-` row: write the row it names |

### The questions

**The questions**, each answered with `pull.mjs answer <N> <qid> <token> …`:

1. **`staleness` (Q1)** — `gone --path <p> [--] <string>`, the string the fix
   must remove from `<p>` on `origin/main`, or `present --path <p> [--]
   <string>`, the string it must add: each runs `staleness.mjs` and asks again.
   `none <why>` (no string settles it) and `done` end the question.

   **Grep for the ticket's ASKED-FOR CHANGE, not only its subject construct** —
   the construct check passes on every stale pin ticket, because the construct
   is what the pin is *about* and never went anywhere. So for a ticket asking
   for a pin, test or assertion, grep the **test file** for the assertion it
   wants; for one asking for exact wording, grep the **old** wording the ticket
   quotes as wrong, never the new wording it proposes. A proposed replacement is
   a suggestion the implementer is free to reword — an equivalent rewording
   satisfies the ticket while failing a grep for its literal text — and the
   quoted defect is the fact.

   `staleness.mjs` answers each `gone` and `present` in three values:

   | Exit | Verdict | What it does at the Pull |
   |---|---|---|
   | 0 | still reproduces | admit it |
   | 1 | provably fixed | do not admit; close citing the payload's `commit` and `subject` |
   | 2 | could not check | admit it, **and say the probe could not check** |

2. **`close` (Q1b)** — asked when the probe exits 1 naming a commit: `yes`
   closes the issue with a comment citing the commit and its subject; `no
   <why>` keeps the ticket and asks Q1 again.
3. **`decided` (Q2)** — `decided`, `needs-triage <the missing decision>`,
   `ready-for-human-fork <the options, verbatim from the brief>` or
   `ready-for-human-hands <external access|manual testing|judgment> <one
   line>`; any but `decided` posts that cause's comment and replaces
   `ready-for-agent` with its label.

   **Decided?** Would two competent implementers, reading only this ticket, build
   materially different things? "Material" by inventory, not feel:

   | Left open | Verdict |
   |---|---|
   | architecture, API shape, schema, UX | **undecided** |
   | new dependency, new seam | **undecided** |
   | naming, file layout, ordering, test arrangement | decided — ignore |

   Any undecided item → not decided. Name it; that name is the relabel comment's
   missing decision or open fork. **Torn → surface, never guess**: relabel it
   `ready-for-human` as a fork naming the open decision — the label is how a
   Pull surfaces it to the maintainer. Opposite of
   `sizing-a-ticket`'s *torn → take the heavier row*, deliberately — see that skill.

4. **`collision` (Q3)** — asked after the scan prints one line per open PR or
   live worktree branch sharing a path with the brief (`no overlap` when none,
   `could not look: <which>` for one it could not read) and the brief's `Out of
   scope` `#N` refs as candidates: `clear`; `behind-pr:#M`, an open PR or a
   branch with no PR yet by its name; `behind-issue:#M`, an open issue that
   section sequences this one after; or `paths <p>…`, which scans again.

### How a Pull ends

A head whose Pull already ended in this run — the ticket left, or the router
refused it and its claim was released — gets no row: `next` without `--head`
skips it, `next --head <N>` would start the ticket over, and the next head
fills the slot. A lifted exclusion's head (reason `excluded ·`) is the exception: it is counted and Pulled again.

**A Pull never re-admits a ticket already relabelled**: the issue step reads the
labels fresh and exits 1 `relabelled elsewhere` once `ready-for-agent` is gone.

Relabelling by cause, exclusion rows and claiming are in references/pull.md; a
worktree re-created for an already-open PR is in references/isolation.md.

**The exit table** — how a Pull ends, and what follows:

| `pull.mjs` | At the Pull | Then |
|---|---|---|
| 0 `DISPATCH {…}` | decided, live, free, claimed, routed; row, brief and dispatch recorded | the `task` call (**Dispatching the Pull's member**) |
| 1 `LEFT #N: taken …` | in-flight hit, an in-flight check that could not answer, or `claim-ticket.sh` exit 2 | next entry |
| 1 `LEFT #N: relabelled elsewhere` | no longer labelled `ready-for-agent` | next entry |
| 1 `LEFT #N: closed: fixed by …` | `close` answered `yes` | next entry |
| 1 `LEFT #N: relabelled <label>: …` | `decided` answered with a cause, or a stranded ruling | next entry |
| 1 `LEFT #N: excluded …` | `collision` answered `behind-pr:#M` or `behind-issue:#M`, or its ledger exclusion stands | next entry |
| 1 `EMPTY` | the shortlist holds no entry to pull | run `shortlist.mjs` once and Pull again; still empty, hold the slot idle until the next refresh trigger |
| 2 | could not look, named on stderr | as the entry paragraph says |
| 3 | a usage mistake, or a token the question does not take | correct it; nothing was recorded |
| 10 `QUESTION <qid>:` | a question pending | answer it |

### Dispatching the Pull's member

A dispatch is done when its `task` call is made, in the background, with the `agent` and the name `ledger.mjs dispatch` printed, and — for an implementer — the tier check has written its verdict: dispatch nothing on top of an unchecked one.

- **One claim, one dispatch, no queue.** Make one claim and then one dispatch of a new member under a name no member has held; nothing holds a queue. Claim what you dispatch and dispatch at once. Record `ledger.mjs dispatch` before the call.
- **The implementer.** Dispatch with the printed `agent`, omit `model`, keep `name: impl-<N>`. **No per-call tier or effort anywhere on this path**: tier stays the agent definition's own frontmatter, whichever `fleet-implementer-<cell>` definition the Pull names, and a member's Resolved tier stays readable from its transcript. The prompt carries only what varies, and the Pull's own read of the ticket is pasted, never a request to re-fetch. A member settling with nothing is not a bail. Confirm death first, exactly as the Member-killed row does (Failure handling, below) — its mtime discriminator, never silence alone. Only the member's own bail report counts. A confirmed-dead member recovers exactly as the Member-killed row says — new member, new name, the SAME ticket — never a demotion.
- **The tier check.** **Run the check right after the dispatch, and never reinstall the plugin or change `modelRoles` while any member is unchecked.** `tick --apply`, or `tier-check.mjs --batch <path>`, runs it. Dispatch nothing on top of an unchecked or mismatched member. **The tick holds the next Pull until that verdict exists.** Clear a mismatch by fixing the definition or the dispatch and dispatching the replacement at the right tier. A mismatch on a ticket whose issue is already CLOSED holds nothing. **After `/resume`, a carried implementer can hold the whole tick** with `HOLD (tier unchecked impl-<N>)` until it settles; reconcile its carried token meanwhile. See references/member-lifecycle.md.
- **The exploration rule.** **Every 5th Pull by ledger count goes at an exploration cell.** See references/pull.md. The printed CELL line is the whole routing decision: never re-derive `CELL`, never label a cell by hand. **Do not label it anywhere — the dispatch record already carries it.** **The readout counts DELIBERATE comparisons.** See references/pull.md.

Pointers: the `/resume` rules are in `references/phase-0.md`; the tick HOLD tier rules are in `references/tick-rows.md`; shell traps are in `references/shell-traps.md`; the fix-applier's per-PR rulings are in `agents/fleet-fix-applier.agent.md`. Rationale for these rules: `references/member-lifecycle.md`.

**The test command every gate runs.** Pass the same command to the review, to the fix-applier, and to the finisher — whose duty-2 mutation gate runs it too — so every gate runs one command: the fix-applier and the finisher get the wrapped string as `<testCmd>` — `~/.fleet/bin/fleet-run suite-slot.mjs '<command>'`, each `'` inside the command written `'\''` — and the review's args the bare command. Never substitute `<testCmd>` with nothing.

**Where `<branch>` comes from:** the PR's head branch — `gh pr view <N> --json headRefName -q .headRefName`, or the same branch you cut the worktree from. See references/reviewers.md.

## The finisher gate

Dispatch a finisher only when every test here passes at once — the review returned, the fix-applier's report arrived, your outbox to it is empty and no ruling is owed; hold otherwise, and on a repo with no CI and no declaration report it and add no label.

### The tests

- **Monitor: CI run completes** → `fleet-event.mjs ci <pr>`, which binds the run
  (`ci-state.mjs --pr <N>`) and **records it as
  `ci=<run-id>:<attempt>:<conclusion>`, not just "CI green"** — the whole key,
  never the conclusion alone, since **a conclusion is not stable** (below). The
  diff-validating `check` job green with no heavy job (not the `rebase-check`
  currency gate) in `failure` → a finisher CANDIDATE (gated below); a `check`
  **failure** that is not solely staleness → the **red-check fixer** (**Then
  dispatch a red-check fixer**, above), behind the same gate. Heavy jobs merely
  `skipped` still label. **This edge fires for every CI run the PR produces,
  and the implementer's own firing comes first for every PR** — `ci.yml`
  triggers on `pull_request`, so no review has run at all when it arrives.
  **Green is therefore not the gate: dispatch a finisher only once the PR's
  review has returned AND its fix-applier, if one was dispatched, has sent its
  report — pushed is not reported**: a push before that report is mid-work on a
  SHA the member may still move, and a report that has not arrived is asked for
  by name. An empty outbox catches neither — *vacuously* empty on the
  implementer's firing, *genuinely* empty on a mid-work push. **The outbox is
  the last test, not the only one, and it stands wherever a fix-applier
  exists**, so never dispatch off it while you do owe it a ruling: empty it
  first — including any ruling you have withdrawn or reversed — then dispatch
  (below); a final report is not proof it stopped. A PR that needs nothing fixed
  reaches a finisher through the **fix-applier reports `no-op`** bullet below,
  never by waiting for a second CI event; a red that fired before the review
  reaches the red-check fixer only through that bullet or **A review result
  lands**. Then run the tick. See references/finisher.md.
- **A fix-applier reports `no-op`, or a SHA you have already bound** → dispatch
  the finisher **now**, against the existing head — when that head's bound
  conclusion is red, the red-check fixer instead (**Then dispatch a red-check
  fixer**, above), never a finisher and never a wait: the Monitor is edge-keyed
  on `<run-id>:<attempt>:<conclusion>`, so no push means no CI event, ever.
  **Reconcile, do not wait for an event** governs here too. **This
  bullet and the one above are a pair, and on a clean PR this one carries the
  whole route to a finisher**: a `no-op` report satisfies the gate above by
  itself, so nothing further is owed and no further event is coming. Edit either bullet without the other and what strands is exactly the PR that needed no fixes.
- **`ci-state.mjs --pr <N>` reads `verdict: "no-ci"`** → the CI edge never
  fires: dispatch the finisher off the reviewer's final verdict the moment it
  lands, never while you still owe it a ruling. Its gate is then the
  `--declare-no-ci` declaration, not a `check` job: with it, label off the
  reviewer's verified suite run; **without it, do not label** — report that this
  repo has no CI configured and no declaration, and stop. See `review-and-fix.md` step 6.

Gate on the `check` job, **not** on `ci-state --quiet` exit 0, which a behind
PR never reaches; the finisher reads per-job state, without `--quiet`.

**The `--declare-no-ci` declaration is caller-side, and reading it back out of
the payload verifies nothing.** Check the two facts it stands for instead:

1. `ci-state.mjs` **without** the flag still reads `verdict: "no-ci"`; a merely
   misconfigured CI exits 2 there.
2. The reviewer's own final verdict reports a green `testCmd` run on the SHA it
   pushed.

Both → add the label, and say it rests on the reviewer's suite run, not on CI.
Either missing → halt here, same as a dirty worktree: report `no CI configured,
no verified suite run on record` and add no label.

### The dispatch and its refusals

**The fix-applier pushes and exits — it does not hold the CI wait**; you own the
persistent Monitor. When the `check` job is green **and no heavy job is in
`failure`** (a `skipped` one is fine only when **solely** off the behind-count,
per the fix-applier body's five-condition note) — or `ci-state.mjs` reads
`verdict: "no-ci"` — **and once the PR's review has returned and its
fix-applier, if one was dispatched, has sent its report**, dispatch a
**finisher** — a fresh small agent, not the fix-applier resumed. Render its brief
with `dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<pr#> …`
(`--kind repair` once an earlier finisher reported `labelled` without the label landing), record it with
`ledger.mjs dispatch <pr#> finisher-pr-<pr#>` before the call, then **dispatch
it with the `agent` that command printed and omit `model` on the call**. **Never dispatch
one while you still owe the fix-applier a ruling. The test is your OUTBOX, not the
member's last message** — anything you have decided that it has not received,
including a ruling you have since **withdrawn or reversed**, a withdrawal
recorded only in the ledger included. **That is the test of THIS condition
only**: the report condition above is the other. Relay everything — reversals
too — then dispatch. See references/finisher.md.

**That `dispatch` refuses a finisher — exit 2, nothing written — on a PR whose
latest `reviewed=` counts a survived or unverified finding, unless the
dispositions verdict answering that review's run is `ok`**: among the
`dispositions-*=fix-pr-<M>[-x]:<run>` tokens naming its run, the one
from the highest-suffixed fix-applier — so a second review at the same head is
answered by none of the first one's verdicts. A PR whose latest review counts
`0/<n>/0` is not gated. One counting `0/<n>/<u>` with `<u>` above zero is
gated like survivors, and the tick prints `DISPATCH fix-pr PR#<M>` for it: that
fix-applier's `no-op` and its `ok` verdict are what open the finisher. The
refusal names its cause. `dispositions
unchecked` — no verdict answers that review: run `dispositions-check.mjs` for
the fix-applier that answered the review, as `fleet-event.mjs`'s `fix-report`
entry states, then dispatch again. It names a `dispositions-unchecked=` verdict too —
no rule broke, but the check could not read where a deferral was filed, `gh`
unreachable or an issue unreadable: run the check again for that fix-applier
once `gh` answers (an issue that does not exist is unreadable too, and no re-run
answers that one: the check's stderr names it, and the record's issue number
needs correcting); the tick offers no fix-applier for it. `dispositions
mismatch` — no finisher: the tick prints `DISPATCH fix-pr PR#<M>` for it, and
the next-suffix fix-applier answers it (**Then dispatch a fix-applier**).
`dispositions escalate` — no finisher, no
retry and no further fix-applier: either a `critical` or `important` finding was
deferred `remedy-outside-diff`, or a second mismatch was drawn on one review, and
only a human can rule on either. Post the check's output, which names each
escalated finding or violating entry, with `gh pr comment <M>`, and flag the PR
for a human; re-running the check reprints it. Dispatch no fix-applier and no
finisher for that review, and expect no `fix-due` row for it; a new
review of the PR starts the check again. **On any PR with a
returned review, `0/<n>/0` included, it refuses too while a fix-applier on the
PR is still live, verdict or not** —
`fix-pr-<M>[-x] still live`: settle it, run the check for it, then dispatch
again. A re-review at the same head is a run of its own, so the earlier
round's verdict never answers it; once the check has run for the fix-applier
answering the new round, its verdict is the current one.

**It refuses a finisher, too, while the PR sits on a conflict hold no
fix-applier has cleared** — the same per-PR fold the tick prints `DISPATCH
fix-pr` off, ahead of the dispositions verdict. A PR known to conflict cannot
merge, and a finisher on it would race the conflict fix-applier rebasing it.
Dispatch that fix-applier, let it settle `applied:`/`no-op`, then dispatch the
finisher again.

**An unanswered question from the member is an outbox item, and it blocks dispatch with the same weight as a ruling you have already made.** See references/finisher.md.

**A final report is not proof the member stopped.** **The standing CI facts are
in the fix-applier body, not in per-event messages.**

**Once the label is on, take it off before you approve any push.** Write `label-off=<latest finisher attempt>` onto the PR's row first
(`ledger.mjs token <PR number> label-off=<latest finisher attempt>`, which keeps
every token the row already has, see references/ledger.md), then
remove `ready-to-merge`, then approve. Then
dispatch a **fresh** finisher against the new head; the first audit does not
transfer, since it verified a different tree. The merge bot refuses that head on
its own (`run-merge-bot.md`, **The labelled head**), so this is not the only
guard — but its refusal costs a pass and leaves the label lying, which is yours
to clear either way, the same way: `label-off=` first, then the removal.
See references/finisher.md.

### Own the CI waits

**Own the CI waits.** Arm a second persistent Monitor over open PRs' latest
runs from the block in references/ci-watcher.md, verbatim, keyed
`<run-id>:<attempt>:<conclusion>` so each terminal state fires once: one
`~/.fleet/bin/fleet-run ci-state.mjs --pr <N>` per open PR emits run id,
attempt, conclusion, behind-count and per-job conclusions. Call it **without
`--quiet`** — that flag drops `jobs`, `missing` and `dropped`. A `success` on a
branch 8 behind is not actionable, and `check`-green-with-heavy-skipped is the
staleness board you must not confuse with a red.

A monitor event is a wake-up, never a verdict; members re-query at labelling
time. See references/ci-and-staleness.md.

**A conclusion is not stable, even for a fixed run id on an unchanged head.** Never cache a conclusion, and test any fallback you write against `""`, `null` AND a real conclusion. See references/ci-and-staleness.md.

**Every merge invalidates every other open PR, silently.** Behind-count is the
only honest signal. See references/ci-and-staleness.md.

**A probe that cannot read is a transition event, not silence.** A `WATCHER
DEGRADED` line is a paused poll or an unread PR, and silence there is NOT green
until its `WATCHER RECOVERED` line. **One gate, not a gate plus a caveat.** See references/ci-watcher.md.
**All pacing in exactly one place — the tick loop's own tail `sleep`.** See references/ci-watcher.md.
**The budget is gated at the floor and again at the pass, and only the pass gates announce recovery.** See references/ci-watcher.md.

**Do not back off and wait.** See references/ci-watcher.md.

**While the budget is exhausted, `ledger.mjs check` reads
`verdict: "unverified"`** — the ledger was read and the tracker was not. That is
correct behaviour, but `unverified` exits **0**, the same as `clean`, so a
member treating exit 0 as "safe to file" files blind during exactly this window.
Say so when you flag the outage: members read `verdict` explicitly until you
report recovery, never the exit code alone.

## Judgement rules the drivers stop for

Each rule here is a judgement a driver stops for: answer it by the cause it names, then run the tick, and report to the maintainer what the evidence cannot settle.

### A member's claims

**Cross-check what members report about their environment.**

**Distrust negative claims hardest.** Make members state their search scope. Negative claim
vs specific finding with paths → paths win. See references/reviewers.md.

Suspect a neighbour before a member's own diff — for unexplained failures, and
equally for any **finding** that came from reading source.

**Never read a member's silence as assent**, and require members to report their *confirmation state*
alongside results — "I escalated X, received no ruling, proceeded on default Y".
After any ruling
you cannot confirm was received, re-check the artifacts it governed. See references/member-lifecycle.md.

### Re-check the instruments before a gate

**You read your instruments out of a tree every member can write to — re-check them before every gate decision.** See references/instruments.md.

- **Re-check before you act on any instrument reading** — a SHA acceptance, a CI
  verdict, the reconcile, a reap, a label gate — from the main checkout phase 0 pinned from:
  `~/.fleet/bin/fleet-run instruments.sh`. **Exit 0 is the only code that
  lets a gate proceed. Exit 1 (the set changed) and exit 2 (the check could not
  answer) both refuse: report what it printed and do NOT re-read the
  instrument** — a guard that fails open on "could not look" protects nothing.
- **Re-pin only after a change you made deliberately.** **A mid-run tooling fix**
  is the one legitimate writer. Re-pinning to clear a refusal you cannot
  explain discards the check.

### Relabel causes

- **Implementer bails before implementing** → `fleet-event.mjs impl-report impl-<N>`
  settles `impl-<N>=bailed` and acts by `bailCause`, never by parsing `bailDetail`; no cause opens a PR:

  | Cause | `bailCause` | `bailDetail` format | Issue action | Ledger |
  |---|---|---|---|---|
  | brief does not decide *what* to build | `undecided` | `<one line>` | relabel `needs-triage` | `=bailed` |
  | genuine fork — options named, none ruled | `fork` | `<options>` | relabel `ready-for-human` | `=bailed` |
  | needs human hands — external access, manual testing, judgment during the work | `hands` | `<cause>: <line>` | relabel `ready-for-human` | `=bailed` |
  | already fixed on main | `fixed` | `<sha> — <how origin/main's tree meets the acceptance>` | `verify-sha.sh main <sha>` first. Exit 0: close N with the `fixed` comment (quotes `bailDetail`), drop `ready-for-agent`, release the claim (drops `in-progress`); no label. Exit 1: relabel `needs-triage`, comment `<sha> not on origin/main`. Exit 2: `NEED`, N untouched. | `=bailed` |
  | covered by an open PR M | `covered` | `PR#M — <how M's diff meets N's acceptance>` | relabel `ready-for-human` with the `covered` comment: close N when M merges, or restore `ready-for-agent` if M closes unmerged. PR M's body is never edited. | `=bailed` |

  The call comments the cause and releases the claim — never when `fixed` neither closes nor relabels N — then ticks:
  the head the tick names next is a *different* ticket.

A member that bails demotes nothing itself; demotion by cause is yours
(**Implementer bails before implementing**).

### Resolving a finisher halt

**A rebase never gets a `reviewed=`**, and never write a `reviewed=` you did
not read off a review result file. Why `past-pin` needs the tick: See
references/finisher.md.

**Resolving a finisher halt.** A halt is the finisher working correctly — it
refused to label — so it is never `failed`, which stays for a finisher that
crashed or gave up. Record it `ledger.mjs settle finisher-pr-<M>=halted:<cause>`,
`<cause>` the word the report names; the ledger refuses any other. Every halt
escalates two ways: the cockpit flags the PR `halted:<cause>` at severity 4 off
that token, and you post the finisher's halt report — cause and evidence — with
`gh pr comment <M>`, so it outlives the run. **No label**: the missing
`ready-to-merge` already keeps the PR out of the merge queue. Then the cause
decides the rest — two resolve automatically, every other one escalates:

| Cause | Resolution |
|---|---|
| `live-editor` | **Automatic.** Ask the live member **by name** for its report, wait for it, then dispatch `finisher-pr-<M>-b` at the current head. If the head moved in the meantime, resolve it as `past-pin` instead. |
| `past-pin` | **Automatic, through the tick: re-review.** The head carries commits no reviewer read. The tick prints `DISPATCH review PR#<M>` for a PR whose latest finisher is `halted:past-pin` and whose latest `reviewed=<head>` is not its current head, until a review of it is running or has returned; record that review's tokens as any review's, with `ledger.mjs review <M>` onto the PR's row, its runner under the next letter the PR's rows do not carry yet (`review-pr-<M>-b`, or `-c` where a retry already took `-b`) — `review` refuses a second `review-pr-<M>` and names the free one — and its result reaches a fresh finisher through the same gate. |
| `rebase` | **Escalate** — comment and flag, nothing more. The report's `evidence.replay` reads `pure` only when `git range-diff origin/main <pin> HEAD` pairs every pinned commit with an unchanged one; `changed` (a commit dropped, edited or added, or a stale `origin/main`) or `unknown` means read `evidence.rangeDiff` before acting, and `evidence.remote.state` says whether that head is on the PR. No automatic rule until a live halt shows the case recurring. |
| `unreadable`, `missing`, `absent`, `other` | **Escalate** — comment and flag, no automatic retry. |

### Resolving a finisher that died

**Resolving a finisher that died.** A finisher settled `failed` or `killed`
leaves its PR without `ready-to-merge`; the cockpit flags it
`finisher:failed` or `finisher:killed`, and the tick does not retry. Resolve
it by hand: investigate why the finisher died, or dispatch the next-suffix
finisher after the finisher gate: render its brief with `dispatch-prompt.mjs
render finisher --kind fresh --member finisher-pr-<M>-<x> …` (`--kind repair`
once an earlier finisher reported `labelled` without the label landing), then
`ledger.mjs dispatch <M> finisher-pr-<M>-<x>`. You never add the label
yourself. When the flag clears: See references/finisher.md.

### Dispositions escalation

**A `DISPATCH fix-pr PR#<M>` on a dispositions mismatch** — the PR's row carries
`dispositions-mismatch=<member>:<run>` for its latest review's run, and no later
fix-applier has landed — is one automatic retry, a review fix-applier named the
next suffix (`fix-pr-<M>-b`) and dispatched like the first, its brief rendered with `--kind dispositions-retry`. Its prompt is the
first one's with the retry paragraph added: `--mismatched-record`, the mismatched member's record
`<scratch>/dispositions-<member>.json` it starts from, and `--violations`, the check's
violation list as printed — the lines
`dispositions-check.mjs` printed, each naming a bucket, an index and a rule;
re-run the check for the mismatched member to reprint them. It writes its own
record, and when it reports you run the check for it exactly as for the first
one. `ok` ends it. A second failure on the same review is written as
`dispositions-escalate=fix-pr-<M>-b:<run>` in place of a mismatch: the tick
prints no `DISPATCH fix-pr` for it, `dispatch` refuses the finisher naming
`dispositions escalate`, and you post the check's output with `gh pr comment <M>`
and flag the PR for a human. A new review of the PR counts again from none.

### The main-gain hit

| Failure | Response |
|---|---|
| Merge bot's gate finds the merge would remove lines `main` gained after the PR's work began (`main-gain-removed:<path>`, exit 1) | Relay `main-gain-removed:<path>-#<pr>` to a human with the hit list and the acknowledgement keys the bot printed. PR stays queued, label untouched, and no member is dispatched to restore the lines — the removal may be deliberate. `fleet-event.mjs merge-bot-report` parks it: a `parked=<head>:<body digest>:<reason>` token on its row, at the head and body digest the bot's gate reading `<scratch>/pr<pr>/merge-bot-<n>/ci.json` records it refused, and no bot is dispatched on its account — when nothing else queued is dispatchable the tick prints `HOLD (parked #<pr> <reason>)`, though a bot dispatched for another queued PR may still evaluate it again; a new head or an edited body lifts the park with no write. A hit line's `kind` is `modified` when its hunk also adds lines, `deleted` when it only removes lines; a gained line edited in place keeping every token is listed in `mainGain.edited[]`, not a hit. It clears when the PR stops removing them or its body carries `main-gain-removal: <path> <key> - <why>` for each hit |
| Merge bot's gate cannot answer the main-gain check (`main-gain-unanswerable`, exit 2) | Report `main-gain-unanswerable-#<pr>` with what it printed, PR stays queued, label untouched |

## Failure handling

Match the failure to its row in the table below and run that response; where the row says report or flag, stop there.

| Failure | Response |
|---|---|
| SHA not on expected branch | Flag, do not enqueue, report |
| Implementer bails before implementing | Act by the report's `bailCause` as the **Relabel causes** table says, then refill (**What a wake owes beyond its call**) |
| Implementer blocked or ambiguous *mid-implementation* | Free the slot, `ledger.mjs settle impl-<N> blocked`, leave `in-progress`, report — the ticket is not In flight and waits for a human; the row above is the pre-code bail, not this one |
| `review-pr` workflow throws or returns no tree | Retry once under the next letter (`review-pr-<pr#>-b`); still failing, report and leave the PR at review-due. Never enqueue the PR as reviewed — the workflow is not a member, so no other row here covers it |
| Reviewer, fix-applier or red-check fixer cannot reach green | Report, leave the PR unlabeled, free the slot — a fix-applier or red-check fixer settles `failed` |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot finds the worktree ahead of the PR head **on the local-rebase fallback** | `worktree-diverged-#<pr>`, PR stays queued. Read the stray commit; push-or-discard is yours, and the maintainer's if the evidence cannot settle it |
| Merge bot finds the head moved after `ready-to-merge` was applied | The label binds to the head's net change, not to one SHA: a proven rebase-carry keeps the label — the bot proceeds and reports `rebase-carry-#<pr>` with the labelled and accepted SHAs, and nothing is dispatched. Any other move is `head-moved-after-label-#<pr>`, PR stays queued, label untouched. Dispatch a **fresh** finisher against the new head — the first audit verified a different tree |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue. On a conflict the bot has already appended `conflict-hold:#<pr>` to the PR's row; the tick prints `DISPATCH fix-pr PR#<pr>` and holds the merge until that fix-applier settles. A PR that conflicts before any bot reaches it is the tick's `CONFLICT PR#<pr>` line, whose hold you record |
| Merge bot's gate refuses on its instrument re-check (`instrument-set-changed` or `instruments-unanswerable`, exit 2) | Report `<reason>-#<pr>` with what it printed, PR stays queued, label untouched. Do not re-run the gate |
| Merge bot's CI wait reaches its per-PR time bound with the run's `status` still not `completed` | The bot skips that PR and reports `ci-wait-timeout-#<pr>` with the run id and its status. PR stays queued, label untouched |
| Member silent or truncated | Send to ping or resume — same unit of work; see the state machine below |
| Member idle with work outstanding | Read the PR first, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | Confirm it is dead first — a frozen transcript does not establish that; see below — then run the **Member confirmed dead or never dispatched** wake, then new member, new name, prompt carries inherited state |
| Member **unaccounted** (a live token the tick flags `CHECK-LIVENESS`, or any live token nothing has reported on) | Registry census first: `read history://` once. A row other than `running` → `read agent://<member>` and the artifacts (PR head, worktree, labels), settle the real outcome with the existing vocabulary, and resume a `parked` member with `write agent://<member>` when its work is worth continuing. A `running` row → the mtime discriminator below, two polls: moved means BLOCKED and alive; frozen at both polls **and** no artifact movement → `write proc://<member>/kill`, the **Member confirmed dead or never dispatched** wake, fresh name. Three independent alive-signals — the first poll, the second poll, the artifacts — must all be silent before a kill; the tick settles and kills nothing |
| A claim abandoned mid-run (a collision found after the claim) | `~/.fleet/bin/fleet-run release-ticket.sh <N> impl-<N> implementer --apply`, the pair the claim took, on the spot — and over every claimed ticket with no PR when the run ends or the maintainer drains. **That refusal is the finding, never an obstacle**: a claim carrying commits or a pushed branch is not auto-released, ever — run `worktree-audit.sh` (it audits every worktree; find this claim's row in the output) and decide by hand. Update the released tickets' ledger rows in the same step. See references/reaping.md |
| A second review launch refused for an open one | Wait for that one's `reviewed=`, or, once the **Member killed** row has confirmed its runner dead, settle it `=failed` in the same `ledger.mjs review` call as the new launch. |
| `ledger.mjs settle <member> --from-report` exits 3 | A check failed: the member's claim and the world disagree, and nothing is written. You rule. |
| `ledger.mjs settle <member> --from-report` exits 2 | The report is absent or invalid, or a check could not look; nothing is written. A check that could not look is run again once `gh` and `git` answer. |
| A suite wait exits 75 naming a wedged `~/.fleet/suite-slots/<i>.lock` | Remove each named file by hand once no suite run is running, the way references/ledger.md removes `<file>.lock`, then run the suite again. |

### Recovery

A red PR never silently becomes `ready-to-merge`.

**A frozen transcript does not establish that a member is dead — the discriminator is its scratch dir.** See references/failure-handling.md.

Settle outcome and liveness are different facts, not the same table with two
spellings. Recovery is a fresh member, fresh name (`impl-<N>-b`,
`fix-pr-<M>-b`, and for a reviewer the next letter PR M's rows do not carry
yet) whose prompt states what it inherits.

Reviewers that went idle on CI recover as a **finisher, not a re-review** once
commits are pushed. See references/member-lifecycle.md.

**Audit every worktree before dispatching replacements**, with
`~/.fleet/bin/fleet-run worktree-audit.sh`. See references/failure-handling.md.

When a report is missing, **ask by name — that is what the "unless the controller asks by name" clause in every brief is for — and do not attribute the gap to the member until it answers.** See references/member-lifecycle.md.

A review that throws, returns empty or notifies a status not `completed` is a
failure event, not a clean review: retry it as the **Failure handling** row for
it says. See references/failure-handling.md.

**Verify every reported SHA** with `~/.fleet/bin/fleet-run verify-sha.sh
<branch> <sha>` before enqueueing. Exit 1, not reachable → flag, do not
enqueue, do not return the ticket to the shortlist until the maintainer rules.
**Exit 2 is not a verdict**: read its stderr, fix what it names and re-run;
escalate if it repeats, and never read it as `not reachable` or record it as a
stray commit. See references/failure-handling.md.

**Never `--delete-branch` — the merge bot deletes the head branch itself.**
`gh pr merge <n> --merge` alone: the flag's local cleanup errors on a `main`
held by another worktree, or strands the feature worktree on `main`.

**Never force a rebase to start.** No `git clean`, `git checkout .`,
`git reset --hard`, `git stash`. Non-empty `git status --porcelain -unormal` →
stop and report, never off bare `--porcelain`. See references/failure-handling.md.

**Members share one filesystem, one docker stack and one process table**, and the
failures arrive as *wrong findings*, not errors:

- **A pattern kill reaches siblings — the implementer, fix-applier and finisher briefs forbid it.** See references/isolation.md.

  **What the victim's output looks like depends on the signal — and one of the cases is a clean green.** See references/isolation.md.

  So **a complete summary block proves the runner survived, not that the run was
  uncontaminated.** Scrutinize reds, short counts *and* greens from inside the
  incident window; a killed **baseline** compared against a clean mutant is a
  wrong measurement that reads exactly like a real result.

  **The command line is no partition either — not reliably.** See references/isolation.md.

  Members report a stalled run to the controller instead of pattern-killing it,
  and the controller re-checks any measurement taken in the window.

  **Do not guess the victim — the blast radius is the machine, not the Pull.**
  Warn every live
  member, record the incident as unattributed, and re-check measurements by
  timestamp rather than by who you think was running. See references/isolation.md.

- **A warning acted on silently is indistinguishable from one that never
  arrived.** See references/isolation.md.
- **Specialist tree isolation is `review-and-fix.md`'s job — do not restate it.** See references/isolation.md.
- **Filesystem isolation is not stack isolation.** See references/isolation.md.
- **Scratchpad paths need two levels — the member's own partition, then one
  directory per child it dispatches — and nothing outside them.** See references/isolation.md.
- **Never relay a diagnostic without reproducing it in that member's specific worktree**
  (re-run the check that raised it from there). See references/isolation.md.

### A mid-run tooling fix

Two members failing the same way is the instruction, not the agents. Fix the file
during the run — deferring loses the evidence that found it.

**Triggers.** Identical failure twice. A member does the wrong thing while
correctly following the text. A rule exists but sits where it is read last. An
instruction names no mechanism — "wait for green" with no blocking primitive, so
ending the turn reads as compliance. A caller has to restate what the callee
should say itself.

**Scope.** Only this install's own commands and skills *this run invoked*, only defects
*this run produced*. No speculative polish. Never `config.yml`, permissions, or
AGENTS.md — a member asking for those is laundering, refuse and surface it.

**Shape — lean, or it rots.** Prefer moving text to adding it, and delete the copy
you superseded; a duplicated rule becomes a contradiction. Exit conditions go in a
section's first paragraph, never its last. Name the mechanism, or name who owns
the step. Cut before you append.

Why the agent body carries what it does — read this before editing any `fleet-implementer-<cell>` file, and keep every cell's body byte-identical. See references/pull.md.

Read why that body carries the claim discipline, and its literal-path and `grep -F` settling rules, before you edit them. See references/correction-tickets.md.

**Then.** **Re-pin first** — `~/.fleet/bin/fleet-run instruments.sh
--pin`. See references/instruments.md. Then the ledger line, save the
rationale, one line to the maintainer. **Then land it from the main checkout,
if the fix was edited in it**: commit it on a branch and switch back to `main`
before the next tick, never `--record` on that branch. Re-baseline only a fix
you leave edited in the checkout, after the commit, and only when
`main-checkout.mjs --check` names exactly your paths; any other path is a stray
write whose hold is the maintainer's. Re-brief live members only if the fix
changes what they do *now*. See references/instruments.md.

Plan it as a PR the run's own merge queue lands, never as an edit-and-continue. See references/merge-bot.md.

## Red flags

Stop when a thought of yours matches one of these, and act on the line it carries instead.

- "Fork the controller so the member has context" → fork inherits everything.
- "This member finished, send it the next ticket" → resumes its transcript.
- "The name is cosmetic" → the name is the ledger token and the hub address.
- "ready-for-agent came back empty, widen to ready-for-human" → empty with no `specs-dropped=` means no work; empty with drops means specs awaiting to-tickets, and is still never a reason to widen.
- "The reap at the end will pick up the claim I never dispatched" → it declines:
  not `[gone]`, no unique commits. Release it, or it reads as taken next run.
- "Touches eight files, too big for the fleet" → size is not the axis. Decided is.
- "Body is three lines, so it's simple" → short bodies hide open design choices.
- "The brief is thorough, so it's decided" → thorough ≠ decided. Read it for the
  choice it leaves open.
- "I'd have to pick an approach myself" → that IS undecided.
- "It reported the SHA, so it's on the branch" → verify.
- "Let the merge bot arm its own monitor" → it dies, the queue stops.
- "The member died, message it the state" → dead agents do not read mail.
- "Its CI is green, ship it" → check behind-count; green decays invisibly.
- "The specialist says nothing else references it" → the claim most often wrong.
  Ask what scope it searched.
- "Five implementers = five times throughput" → reviews are 3-5x longer. It means
  a backlog.
- "A quick install to set up the worktree" → the claim already ran the Recipe's
  Install step; any other install can rewrite the lockfile for the whole repo.
- "I'm on my own copy, so I'm isolated" → not from the docker stack.
- "`commit-commands:clean_gone` printed nothing, the tree is clean" → its
  `[gone]` detection works fine; it just runs `-D`/`--force` with no merged
  check, so "printed nothing" only means nothing was gone yet, not that it's safe.
- "`--force` the worktree removal, the PR merged anyway" → merged says nothing
  about uncommitted files, and the reviewer may still be in there.
- "Reap once at the end of the run" → stale worktrees make phase 0 read merged
  tickets as taken, so the starvation compounds with every Pull.

## Report

Report as one running table, updated as events land, and end it with the queue-depth line.

One running table, updated as events land:

```
#N  ticket   impl-<N>       PR #M  fix-pr-<M>      label:yes  merged
#N  ticket   impl-<N>       PR #M  fix-pr-<M>      label:no   -        red CI
#N  ticket   impl-<N>       -      -               -          -        blocked: SHA off-branch
```

Plus a queue-depth line: shortlist, supply, whether triage was suggested.

**Do not read a cell early** (references/pull.md, **Do not read a cell
early**). **Report the count the per-cell readout prints,
never one from any other query:** `~/.fleet/bin/fleet-run cell-readout.mjs`
prints `<cell> <comparisons> <run_dates> <resolved models>` for each cell past
that floor and a cell below it only as a count on stderr; a `mixed (…)` models
column means the cell's history spans more than one model behind its role. See references/pull.md.
