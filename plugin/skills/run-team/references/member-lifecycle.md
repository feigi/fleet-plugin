# Member lifecycle: naming, fresh context, recovery

Why member name load-bearing, why every member single-use, how killed/idle/truncated member recovered. Assertions these justify live in SKILL.md's "Rules that fail silently", Phase 3, Reviewers, Failure handling sections; evidence here.

## The name is what carries the `Agent` tool

Name makes it team member; membership carries `Agent` tool. Omit it → member loses delegation, no error, improvises something worse. `subagent_type` irrelevant — name is mechanism, not label. Names follow unit of work: `impl-<issue#>`, `fix-pr-<pr#>` (default path's applier), `review-pr-<pr#>` (hand-dispatch fallback's reviewer), `finisher-pr-<pr#>` (Phase 3's finisher), `merge-bot-<wave#>`.

## Members cannot name their children

Named member passing `name` fails with `teammates cannot spawn teammates`, so specialists dispatched **unnamed**. Must state in reviewer prompt — else reviewer hits error, concludes fan-out unavailable, silently downgrades to solo review, no error, no signal.

## Capability is not permission

Members inherit standing *"Do not call the AgentTool unless the user requested it."* Else reviewer declines to dispatch specialists — correctly — you get thinner solo review, no error, no signal. Having tool (capability) not authorization to use it (permission); reviewer prompt must state full specialist set IS requested work.

## The coordination contract

Same on both harnesses, stated once, in the vocabulary #1316 fixed — *dispatch* (start a member), *send* (message a live one), *wake* (a send that resumes a finished member's transcript), *settle* (a member's job reaching a terminal outcome), *consume* (the controller deliberately taking a settled result):

- A refill is a **new** member under a **new** name, never a wake back into the old one — waking a finished member drags its old ticket in.
- Liveness is not settlement. A member that is not currently executing is not thereby done, and a member that has settled is not thereby delivered — each axis is checked on its own terms, never inferred from the other.
- A settled result is consumed deliberately, never assumed — the discipline holds on both harnesses even where the *hazard* it guards against does not (Grandchildren, below).
- Every send is reconciled against its receipt; whoever holds the receipt is the only party that can detect a discrepancy (Grandchildren, below).

`SendMessage` and `hub` are harness terms. They appear only on a `CLAUDE:`/`OMP:` marked line, never in this contract.

## Fresh context per member

One member, one unit of work, gone. Never re-task a finished member — waking it drags the old ticket back in. Refill = **new** member, **new** name.

CLAUDE: `SendMessage` to a finished agent resumes its transcript and drags the old ticket in. Sending is still right for pinging a member for a report it owes, or resuming a truncated reply — never for handing a finished agent the next ticket.
OMP: `hub send` to an idle peer wakes it into its old transcript the same way; re-dispatching under the same name does not reset it — omp auto-suffixes a fresh peer (`name-2`) instead.

## Grandchildren surface to you, not to the member that spawned them

A specialist's report routes to *you*, the controller — a hand-dispatched reviewer has no messaging channel to a grandchild it spawned.

CLAUDE: a grandchild is unreachable by `SendMessage` — it returns `had no active task; resumed from transcript` with no report (~15 pinged in one run, 0 retrieved). Retrieve instead: `tail -1 <output-file> | jq -r '.message.content[]?|select(.type=="text").text'` yields the final report, bounded (299 KB transcript → 8 KB last record → 6.6 KB report; never read the whole file).
OMP: the tail/jq recipe does not apply — a depth-2 helper cannot dispatch further (`task.maxRecursionDepth: 2`), and the reachability question that leaves open is answered: measured 2026-09-09, a depth-2 helper is `hub send`-reachable directly by its dotted id (`<member>.<helper>`) — delivered, woken, replied; no transcript workaround needed.

Reviewer retrieves first, relay is the backup — duplicate costs nothing, missed report costs a verdict. A completed member's result is consumed deliberately, never assumed silent:

CLAUDE: a completed agent's final text is a return value, **lost if unconsumed**.
OMP: the lost-if-unconsumed hazard does not apply — results auto-deliver, and a settled `hub jobs`/`wait` snapshot **is** the delivery itself.

So relay each: name source, send its *text* (ruling on it as "your finding" makes reviewer verify a report it never sent, or act on one it cannot check). Then **reconcile every verdict against your relay receipts** — verdict claims a dimension undelivered, receipts say relayed → re-send naming the specialist, hold the verdict until it lands. Do not require reviewer-side acknowledgement: compliance depends on the same failure it catches, and the receipt check needs nothing from the reviewer.

CLAUDE: only the controller holds the message id, so only the controller detects the discrepancy — reconciliation is hand-rolled around a bare send.
OMP: `hub send` returns a structured `delivered`/`failed` receipt inline, replies thread by a 16-hex message id, and `await: true` returns the reply in the same call — the bookkeeping Claude hand-rolls is native.

Measured on Claude Code, both halves, with quotes. `review-pr-11` was sent `code-reviewer`'s report, msg `58c6bef2`, before its verdict; verdict read *"`code-reviewer` — dispatched, never delivered. No report reached me and none was relayed. Dimension not covered by a specialist."* — then ruled that dimension solo, headline claim refuted by report already sent to it. `review-pr-12` composed its first verdict *before* relays landed and reported all four as delivering nothing, found same defects in own mutation pass, credited all four by name in second verdict — convergent discovery, not silent application. Naming gap honestly is necessary, not sufficient: relay sent ≠ relay read, and relay can land after verdict composed. Neither reviewer could tell "no report exists" from "one was sent I have not received".

Grandchild surfaces as own task-notification; unrecognized task-id not a member reporting done.

## Settle and liveness: two different state machines

A member's settle outcome and its liveness are different axes — and a different *pair* of axes on each harness, not the same table with two spellings.

CLAUDE: three states on one axis — killed, idle, truncated. `SendMessage` works on idle or truncated; does nothing for dead, and a spend limit kills every member at once, so the temptation to re-task peaks exactly when it cannot work.
OMP: two axes — job outcome (`completed`/`failed`/`cancelled`) crossed with peer liveness (`running`/`idle`/`parked`). `hub cancel` → `cancelled`, the peer hard-aborted and unmessageable, `history://` still readable. A **`failed` job's peer can stay `idle` and resumable** — a bucket Claude's triad has no slot for. No distinct truncated state exists on omp.

Recovery = fresh member, fresh name (`impl-<N>-b`, `fix-pr-<M>-b`, `review-pr-<M>-b`), whose prompt states what it inherits:

- committed-and-pushed vs committed-only vs **uncommitted in the worktree**
- uncommitted work exists nowhere else — no `git clean`, `git checkout .`,
  `git reset --hard`, `git stash`
- for half-finished review: which specialists already reported, so it doesn't
  re-run 40-minute fan-out

Reviewers go idle waiting on CI, won't resume alone — rebased, pushed, stopped with run `in_progress`. Three of five in one run. Recovery there = **finisher, not a re-review**, whenever commits already pushed.

## React to artifacts, not agents

Liveness says nothing: `idle` means "not currently executing", not "done"; finished member's finding may never arrive. In one run every member that looked dead had its work in git or on PR — pushed commits, self-removed label, applied ruling. Read `gh pr view`, `gh run view`, `git -C <worktree> status` before messaging: one command settles what round-trip usually doesn't, and member that ignored one ping tends to ignore second. When you message, send specific next action, never "what is your status".