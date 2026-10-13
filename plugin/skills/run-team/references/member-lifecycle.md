# Member lifecycle: naming, fresh context, recovery

Why member name load-bearing, why every member single-use, how a member's job outcome (`completed`/`failed`/`cancelled`) and peer liveness (`running`/`idle`/`parked`) decide its recovery. Assertions these justify live in SKILL.md's "Rules that fail silently", Phase 3, Reviewers, Failure handling sections; evidence here.

## Every member is named

The name is the ledger token and the hub address (`hub send <name>`, `agent://<name>`); omit it and the ledger cannot match the member. Names follow unit of work: `impl-<issue#>`, `fix-pr-<pr#>` (default path's applier), `review-pr-<pr#>` (the PR's first reviewer; every later one on the PR — failed-runner retry, past-pin re-review — takes the next letter the PR's row does not carry yet, `review-pr-<pr#>-b`, `-c`, …; a reviewer's launch and result are recorded on the PR's row with `ledger.mjs review <pr#>`), `finisher-pr-<pr#>` (Phase 3's finisher), `merge-bot-<n>` (one merge pass; `ledger.mjs dispatch merge-bot` numbers it from the ledger's `## Dispatched` list — a per-run counter, never a PR).

## The coordination contract

Stated once, in this fixed vocabulary — *dispatch* (start a member),
*send* (message a live one), *wake* (a send that resumes a finished
member's transcript), *settle* (a member's job reaching a terminal
outcome), *consume* (the controller deliberately taking a settled result):

- A refill is a **new** member under a **new** name, never a wake back into the old one — waking a finished member drags its old ticket in.
- Liveness is not settlement. A member that is not currently executing is not thereby done (Settle and liveness, below).
- A settled result is consumed deliberately, never assumed — the discipline holds even where the *hazard* it guards against does not (Grandchildren, below).
- Every send is reconciled against its receipt; whoever holds the receipt is the only party that can detect a discrepancy (Grandchildren, below).

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