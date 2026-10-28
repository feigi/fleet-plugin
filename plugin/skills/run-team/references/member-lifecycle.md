# Member lifecycle: naming, fresh context, recovery

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

Why member name load-bearing, why every member single-use, how a member's job outcome (`completed`/`failed`/`cancelled`) and peer liveness (`running`/`idle`/`parked`) decide its recovery. Assertions these justify live in SKILL.md's wake table, Dispatching the members a wake names, Reading a review result, A member's claims, Failure handling sections; evidence here.

## Every member is named

The name is the ledger token and the hub address (`hub send <name>`, `agent://<name>`); omit it and the ledger cannot match the member. Names follow unit of work: `impl-<issue#>`, `fix-pr-<pr#>` (default path's applier), `review-pr-<pr#>` (the PR's first reviewer; every later one on the PR — failed-runner retry, past-pin re-review — takes the next letter the PR's row does not carry yet, `review-pr-<pr#>-b`, `-c`, …; a reviewer's launch and result are recorded on the PR's row with `ledger.mjs review <pr#>`), `finisher-pr-<pr#>` (the finisher gate's finisher), `merge-bot-<n>` (one merge pass; `ledger.mjs dispatch merge-bot` numbers it from the ledger's `## Dispatched` list — a per-run counter, never a PR).

## The coordination contract

Stated once, in this fixed vocabulary — *dispatch* (start a member),
*send* (message a live one), *wake* (a send that resumes a finished
member's transcript), *settle* (a member's job reaching a terminal
outcome), *consume* (the controller deliberately taking a settled result):

- A refill is a **new** member under a **new** name, never a wake back into the old one — waking a finished member drags its old ticket in.
- Liveness is not settlement. A member that is not currently executing is not thereby done (Settle and liveness, below).
- A settled result is consumed deliberately, never assumed — the discipline holds even where the *hazard* it guards against does not (Grandchildren, below).
- Every send is reconciled against its receipt, the `delivered`/`failed` result `hub send` returns inline (Grandchildren, below).

`hub send` is the omp messaging mechanism. It appears in the recipes below, never in this contract's own vocabulary.

## Fresh context per member

One member, one unit of work, gone. Never re-task a finished member — waking it drags the old ticket back in. Refill = **new** member, **new** name. Sending is still right for pinging a live member for a report it owes, or resuming a truncated reply — never for handing a finished member the next ticket.

`hub send` to an idle peer wakes it into its old transcript the same way; re-dispatching under the same name does not reset it — omp auto-suffixes a fresh peer (`name-2`) instead.

## Grandchildren surface to you, not to the member that spawned them

A specialist's or refuter's report routes to *you*, the controller, not to the member that spawned it.

A depth-2 helper cannot dispatch further (`task.maxRecursionDepth: 2`); measured 2026-09-09 from an actual controller session: a `hub send` to a depth-2 helper's full dotted id (`<member>.<helper>`) delivered, woke it, and got a reply — the controller reaches a member's helper directly, no transcript workaround needed.

A completed member's result is consumed deliberately, never assumed silent. Results auto-deliver, and a settled `hub jobs`/`wait` snapshot **is** the delivery itself.

`hub send` returns a structured `delivered`/`failed` receipt inline, replies thread by a 16-hex message id, and `await: true` returns the reply in the same call — the bookkeeping is native.

Grandchild surfaces as own task-notification; unrecognized task-id not a member reporting done.

## Settle and liveness are different facts

A member's settle outcome and its liveness are different facts, not the same table with two spellings.

Two axes — job outcome (`completed`/`failed`/`cancelled`) crossed with peer liveness (`running`/`idle`/`parked`). `hub cancel` → `cancelled`, the peer hard-aborted and unmessageable, `history://` still readable. A **`failed` job's peer can stay `idle` and resumable**. No distinct truncated state exists.

Recovery = fresh member, fresh name (`impl-<N>-b`, `fix-pr-<M>-b`, and for a reviewer the next letter PR M's row does not carry yet — `review-pr-<M>-b`, or `-c` where `-b` is taken), whose prompt states what it inherits:

- committed-and-pushed vs committed-only vs **uncommitted in the worktree**
- uncommitted work exists nowhere else — no `git clean`, `git checkout .`,
  `git reset --hard`, `git stash`
- for half-finished review: which specialists already reported, so it doesn't
  re-run 40-minute fan-out

Reviewers go idle waiting on CI, won't resume alone — rebased, pushed, stopped with run `in_progress`. Three of five in one run. Recovery there = **finisher, not a re-review**, whenever commits already pushed.

## React to artifacts, not agents

Liveness says nothing: `idle` means "not currently executing", not "done"; finished member's finding may never arrive. In one run every member that looked dead had its work in git or on PR — pushed commits, self-removed label, applied ruling. Read `gh pr view`, `gh run view`, `git -C <worktree> status` before messaging: one command settles what round-trip usually doesn't, and member that ignored one ping tends to ignore second. When you message, send specific next action, never "what is your status".

## A report is delivered, not implied by ending a turn

**A report is delivered, not implied by ending a turn.** Every member owes
the controller one report naming its outcome before it exits — including a
member whose prompt carries no explicit report line. A member that does the work
correctly and ends its turn has reported nothing: the controller learns the
outcome only by re-reading artifacts and pinging, and a finding held only in
that member's context is lost. Members did exactly this in one run —
finishers, a reviewer and merge bots alike, the work done and only the
delivery missing. Every brief's report paragraph says it.

## You never write the do-not-acknowledge line yourself

**The implementer, fix-applier, finisher, merge-bot and review-runner briefs
each tell the member you do not acknowledge reports; you never write that line
yourself.** A member cannot see whether its report arrived, so silence
from you is indistinguishable from loss and it re-sends — three members did in
one run, each burning a turn, and in all three the original had in fact arrived.
Each of those templates under `briefs/` carries the line: *"The controller does
not acknowledge reports. Send once and exit; never re-send unless the controller
asks by name."*

## A missing report is not evidence the member failed to send one

**But a missing report is NOT evidence the member failed to send one — the
inbound direction drops AND delays messages.** Both were measured in one run,
and they are indistinguishable at the moment you look: one finisher's report was
accepted with a msg_id and never arrived at all, while another's arrived late —
its original and its re-send landing together, after the controller had already
concluded it was missing. Measured: a finisher completed every
duty, labelled the PR, and sent its report; the send was accepted with a msg_id
and never arrived. The controller read the silence as the member ending its turn
without reporting, said so, and was wrong. The re-send it asked for by name is
the only reason the report exists. So when a report is missing, **ask by name —
that is what the "unless the controller asks by name" clause is for — and do not
attribute the gap to the member until it answers.** A member re-sending on a
named request should state the original's msg_id and that it is a re-send, which
is what distinguishes a lost message from a member that never sent one; a
controller that skips the ask cannot tell those apart and will guess wrong in
whichever direction its expectations point. The tick prints `SETTLE <member>`
for a report file on disk that passes its schema and `REPORT-INVALID` for one
that fails it, so a missing message is read off those lines before anyone is
pinged.

Note this cuts against the paragraph above only in appearance: the default stays
*send once*, because unprompted re-sends were measured 2-to-1 false. The ask is
the controller's move, not the member's.

## Never read a member's silence as assent

**Your OWN messages can vanish the same way, and that half is not recoverable by
a re-send.** Two controller rulings were lost in one run, both with a
`success: true` receipt: a member proceeded on its stated default and filed a
tracker issue the lost ruling had said not to file. The confirmation-state
sentence SKILL.md's **A member's claims** requires is the only thing that made
either loss visible.

## A member runs its test suite in the foreground and blocks on it

**A member runs its test suite in the foreground and blocks on it.**
Backgrounding a suite and polling for it makes the member's own progress
depend on a wake-up nothing in the fleet guarantees, and an idle member is
indistinguishable from a working one — you learn only by pinging. Measured
twice in one run: `fix-pr-<M>` backgrounded its suite plus a Monitor and sat
idle for roughly two hours; neither ever woke it, and the only reason no work
was lost is that you pinged it by name with a concrete next action.
`finisher-pr-<M>` reached for the same pattern minutes later — a proactive
warning is the only reason it did not repeat the stall. Its
`pgrep -f 'finish-finisher-pr-<M>'` could never have matched any process, so
the poll it was waiting on was structurally incapable of firing. This file is
yours, not theirs: the implementer, fix-applier and finisher briefs carry the
rule, as the line `A member runs its test suite in the foreground and blocks on it.`

## No workpool, and no kernel-resident handle

A pool's only refill virtue — handing a queued item to a freed worker without a controller turn — is exactly what a Pull forbids, and its completions never arrive per member. `eval`'s `agent()` is not the omp call either: a kernel-resident handle dies with the kernel and needs a `wait`, while a `task` job is process-level and its report auto-delivers on its own, like every other member's.

## One claim, one dispatch, no queue

The In-flight bound is the fleet's own accounting rather than anything the runtime enforces, and the member is fresh and never a wake of one that already ran. Admission is per slot and never batched, so there is nothing to hand a freed slot its next ticket but the next Pull.

## The prompt pastes the Pull's own read

The prompt pastes the Pull's own read of the ticket rather than telling the member to re-fetch it, and this still costs one `gh issue view` per ticket, never one per member. The fresh-context design's isolation rationale — "every implementer re-reads its Agent Brief... from scratch" — is about a member never inheriting another ticket's context, not about where the bytes come from. Pasting the Pull's own read into the prompt keeps that: the member still gets the brief verbatim and re-derives nothing from a sibling. What it drops is the unconditional re-fetch of an issue the controller already has open, on every dispatch — the fetch the agent body still carries is the backstop for a brief that turns out to be insufficient, not the default path.

## A member settling with nothing is not a bail

Each member's outcome arrives as its own job status. Settle (CONTEXT.md § Coordination) is three states on omp — `completed`, `failed`, `cancelled` — and reading `failed`/`cancelled` the same as a `completed` turn that had nothing to report is the exact collapse this line blocks: a member that died never chose to bail, so demoting its ticket on its silence demotes a ticket its member never got the chance to judge. Confirm death first, exactly as the Member-killed row does (Failure handling in SKILL.md) — its mtime discriminator, never silence alone.

## The implementer's tier is the definition's

The tier lives in that definition's frontmatter (`agents/fleet-implementer-<cell>.agent.md`; `slow-high`, the policy cell, for a row with no `tier=` or `cell=`), which is what an omitted `model` takes first — the session's tier applies only when the definition names none, and a member dispatched with `model` set does not get the declared tier back. Omitting `model` is therefore still the mechanism; what changed is that the tier it resolves to is now declared and pinned rather than inherited by accident. Keep `name: impl-<N>`: the name is what makes a member, and both the spend classifier and `member-outcomes.mjs` read it.

## The merge bot's tier buys nothing its backstop does not cover

Rebase, wait for green, check the label, merge is checklist work, and a bad merge still needs the label and the per-job CI state to have been read correctly, which is exactly what a wrong merge later surfaces and a human resolves; `no-undo-audit.sh` is the deterministic, script-driven backstop run before every push specifically to catch a wrongly-resolved conflict, so the tier buys nothing that backstop doesn't already cover.

## The red-check fixer's three edges

The Monitor is edge-keyed on `<run-id>:<attempt>:<conclusion>`, so a red that fired before the review never fires again, and with no push there is no new run — the other edges are the only route there, so do not wait for an event. Edit one of the three finisher-gate edges without the others and what strands is exactly the red-only PR.

Take the common case, the implementer's own first CI firing turning red before any review exists: the review is still dispatched against that head as normal, because a red suite is review evidence and not a blocker.

## The tier check judges the dispatch-time tier

The check reads the installed definition and the live `modelRoles` at check time, not at dispatch time, so a late check judges a member against a tier it was never dispatched under.

## The tier check after a /resume

A live implementer rotate carried forward with no verdict on its row is unchecked, and once this session has been reopened with `/resume` its transcript sits under the earlier session's directory: the check given this run's `session` finds no `<member>.jsonl` and exits 2, writing nothing.

## Dispatching on an unchecked member multiplies the damage

Dispatching the next member on top of an unchecked or mismatched dispatch multiplies whatever silently degraded.

## Ledger reads and their buffer

`board.mjs` reads `ledger.mjs read` with an explicit `maxBuffer`, so a payload past node's default is carried rather than killed mid-flight and reported as an unreachable tool — which is how the blind cockpit came back at HTTP 200 even after the pipe cut was gone.

## A carried implementer after `/resume` holds the whole tick

**After `/resume`, a carried implementer can hold the whole tick.** It holds when the check given this run's `session` finds no `<member>.jsonl` and exits 2, writing nothing. `HOLD (tier unchecked impl-<N>)` then stops the whole tick, not only that member's ticket. It clears once the member settles: one settled `killed` or `released` gets `tier-unverifiable=` from the same check, and one settled any other way ran, so its transcript exists and the `session` given is the wrong directory: pass the session directory that dispatched it, the one the exit-2 refusal in `scripts/tier-check.mjs` asks for. Until it settles, follow the carried token's reconciliation in references/phase-0.md, the "Resume the claims a dead run left without a PR" section, under its `prior: ancestor` branch: `proc://` reads `running` → wait; dead → the Member-killed row.

A mismatch on a ticket whose issue is already CLOSED holds nothing: the tick probes that issue and drops it, since there is nothing left to replace.

## The test command every gate runs

**The test command every gate runs.** Pass the same command to the review, to the fix-applier, and to the finisher — whose duty-2 mutation gate runs it too — so every gate runs one command. The fix-applier and the finisher run what you hand them, so hand them the wrapped string as `<testCmd>` — `~/.fleet/bin/fleet-run suite-slot.mjs '<command>'`, each `'` inside the command written `'\''` — and it is still one command for every gate. The review wraps its own one run, so its args carry the bare command; a wrapped string handed to it anyway is harmless, the inner wrapper being the nested case. Omit it from the review args and the review (`review-core.mjs`, in a runner) reads the same cache itself, refusing outright when there is none; the fix-applier has no such fallback, so substituting `<testCmd>` with nothing leaves it no gate at all. See `references/isolation.md` (the stack-free test command).

## Dispatching the members a wake names, in full

- **The reviewer.** **Dispatch the review, never wait on it, and act when its result lands. That is the default path.** `DISPATCH review PR#<M>`: a `task` member named `review-pr-<pr#>`, agent `fleet-review-runner`, its prompt the five args `pr`, `branch`, `worktree`, `testCmd` and `scratch`. Record `review=member:review-pr-<pr#>` on the PR's row before the call. `scratch` is the scratch root itself, never a `pr<N>` partition (`references/reviewers.md`). Write the `review=` token with `ledger.mjs review <pr> <token>`; `ledger.mjs` refuses a bad grammar. The tick names every PR owed one, oldest first, and each gets one review, once per PR. The tick counts in-flight reviews off the ledger and nowhere else, so a review you launched and never recorded is one it names again. The runner writes the result file and reports its path and `reviewed=` token.
A row with `review=` and no `reviewed=` is a review in flight, and the tick counts it as a live review unit unless gh reports its PR MERGED or CLOSED.
- **The fix-applier.** `DISPATCH fix-pr PR#<M>` on a `reviewed=` count that survived or unverified findings, with no fix-applier live: name `fix-pr-<pr#>` (the next suffix if that name is on record), never the PR's implementer; render with `dispatch-prompt.mjs render fix-applier --kind review --member fix-pr-<pr#> …`, then record `ledger.mjs dispatch <pr#> fix-pr-<pr#>` before the call. Its brief carries the PR number, the worktree abs path, the PR's branch, the same `testCmd` you passed the review, and the **path** `<scratch>/pr<pr>/<run>/review.json`, `<run>` off the PR's latest `reviewed=` — never the findings. Every `<scratch>` in that brief is the absolute path `scratch-root.mjs` printed. Its rulings are the fix-applier body's (`agents/fleet-fix-applier.agent.md`); you hold none. It holds every finding and you hold none, so there is nothing for you to rank, relay or pre-rule — and a report from a refuter it spawns that surfaces to you is its to retrieve, never yours to scan or pass on. It answers the hold and nothing else: survived or unverified findings of a returned review the row also carries stay unanswered through its settle, so the tick prints `DISPATCH fix-pr PR#<M>` again once it lands, and that one is a review fix-applier, dispatched as above. On a PR carrying `ready-to-merge`, the push moves the head after the label, so the next merge bot refuses it `head-moved-after-label-#<M>`: a fresh finisher, per **Failure handling**.
- **The conflict hold.** `DISPATCH fix-pr PR#<M>` on a conflict hold: the row carries an unresolved `conflict-hold:#<M>`, the merge bot's or one you recorded off the tick's `CONFLICT` line. It is the same slot with a different job, and no review file to hand over. Name it `fix-pr-<M>`, or the next suffix (`-b`, `-c` …) when that name is on record; render with `dispatch-prompt.mjs render fix-applier --kind conflict --member <name> …`; dispatch with the `agent` `ledger.mjs dispatch` printed, in the PR's existing worktree. Read the definition off that output (`fleet-fix-applier` whatever the row's `tier=`), never recall it. Settle `applied:<head>`, or `no-op` if no conflict was left, which lifts the merge hold; a dispatched-but-live one does not, and `failed`/`killed` leave the PR fix-due for a replacement.
- **Then dispatch a red-check fixer** — on a `check`-job `failure` bound to the PR's current head that is not **solely** staleness: a `rebase-check` red, or heavy jobs `skipped`, that comes only off the behind-count gets no fixer (the five-condition note in `agents/fleet-fix-applier.agent.md` establishes that). Name `fix-pr-<M>`, or the next free suffix; render with `dispatch-prompt.mjs render fix-applier --kind red-check --member <name> …`, record with `ledger.mjs dispatch <pr#> <name>` before the call, and dispatch with the printed `agent` in the PR's existing worktree. While a review or a review fix-applier on the PR is live or still owes its report — a dispositions mismatch awaiting its retry and a conflict hold awaiting its fix-applier included — the red-check fixer does not fire: their push starts a new run, and a fixer racing them would work on a SHA that is still moving. The common case, the implementer's own first CI firing turning red before any review exists, still dispatches the review against that head as normal. The tick prints no `DISPATCH` for it, so you reconcile it yourself, and it always goes after the review, never before. It is told outright not to watch, poll or wait for CI: your persistent Monitor owns the next run on the pushed head, and the finisher gate — review returned AND fix-applier report sent — applies to this member the same way. Settle it `applied:<head>` once a fix is pushed. Settle it `no-op` only when the red turns out not to be this member's to fix — a flake that passes on rerun, or staleness — with nothing pushed; `no-op` counts as landed, so it never stands for "could not fix". Settle it `failed` when it cannot reach green, which the **Failure handling** row "Reviewer, fix-applier or red-check fixer cannot reach green" covers. Its three dispatch edges are under **The finisher gate**; their rationale is in `references/member-lifecycle.md` (The red-check fixer's three edges).
