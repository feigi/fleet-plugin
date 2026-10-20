# The finisher: why its gate and duties are shaped the way they are

Evidence for the finisher rules the finisher's agent body, `agents/fleet-finisher.agent.md`, and SKILL.md's **The finisher gate** state, keyed by the rule each justifies.

## An unanswered question from the member is an outbox item

**An unanswered question from the member is an outbox item, and it blocks
dispatch with the same weight as a ruling you have already made.** It does not
feel like one — you have decided nothing yet, so the outbox reads empty — but a
member waiting on you is a member that will push once you answer, and the SHA
you are about to pin is exactly what that push moves. Measured on one run:
a `fix-pr-<M>` member asked whether to add two pins, and the finisher was held until the
member acknowledged the answer. That worked because the controller chose to
hold, not because a rule required it. Answer it, or tell the member you are not
ruling and it should proceed on its own default — either empties the outbox.
What does not empty it is noticing the question and dispatching anyway.

## Duty 2: every deferral, and every claimed APPLY, has a home that outlives the merge

**Confirm every deferral — and every claimed APPLY — has a home that outlives
   the merge.** A deferral of a finding in the review's result is not yours to
   re-judge when the PR's latest review counted a survived or unverified finding:
   `ledger.mjs dispatch` then dispatched you only once the PR's ledger row held a
   `dispositions-ok` verdict from `dispositions-check.mjs` on that review
   (`dispositionsRefusal`), and that check had already read back where the
   fix-applier's disposition record says each deferral was filed. That verdict is
   the judgement of those homes: do not halt on a home the script accepted, and
   do not re-file one as an open issue. One such home is the PR's own
   `PR #<M> review: the suggestion band, checked` issue, which counts although it
   is closed and labelled `wontfix`. Where the latest review counted no survived
   and no unverified finding, dispatch required no verdict; that record is still
   a home there when it matches the script's own definition — `homeHolds` in
   `dispositions-check.mjs`: state `CLOSED`, labelled `wontfix`, titled exactly
   `recordTitle(<M>)` — and any other closed issue is not. Everything else — a
   claimed APPLY, a deferral the review's result does not carry, and a deferral
   no verdict judged — you judge by hand, by the test below. The test is a
   durable home, not a tracker number: a tracker
   issue and a committed in-tree comment both qualify, and for a finding whose
   remedy was measured worse than the defect the in-tree note is the better one.
   What fails is a promise living only in a PR body, or on the PR's *own* source
   issue, which `Closes #N` buries on merge. Caught once at seven findings. A
   comment on an existing *follow-up* issue is filed: that is
   `review-and-fix.md` step 5, not a violation. Not filed → file it or halt,
   never label over it — and file it the way step 5 does, through
   `ledger.mjs check "<subject>"`, never a bare search, labelled `needs-triage`
   as every issue the plugin creates is, its body carrying the refuter's
   verdict or the review's votes and the candidate remedy. A duplicate is a
   comment citing that verdict on the existing issue, never a relabel: an open
   `ready-for-agent` issue triage already promoted holds the deferral as it
   stands. Only triage sets `ready-for-agent`, and step 5's guard on this rule —
   open `needs-triage` issues citing `Deferred from PR` above 40 on 3
   consecutive run dates send it back to the maintainer — counts these
   filings too. The finisher files last,
   off its own read of what the reviewer left behind, so a deferral it reads as
   unfiled may already be on the tracker under someone else's wording. Then
   record it the way step 5 does: `ledger.mjs filed <N> "<subject>"`
   immediately after `gh issue create`, with the same subject string you passed
   to `check`. If `filed` fails, retry once; if it fails again, leave the issue
   alone — it exists and is correct — and report it `unrecorded: #N <subject>`.

## `origin/main...HEAD` is right for the positive check and wrong for a negative one

**That range is right for the positive check and wrong for a negative one.**
It spans the implementer's commits too, so a constraint of the form *file X
was not touched* has to be scoped to the apply commit. Measured on one PR:
a controller wrote "neither document was touched" against
`origin/main...HEAD` on a two-commit branch whose documents the IMPLEMENTER
had correctly edited — the PR's whole point — and a finisher reading that
literally halts a correct PR. It caught the error instead, and said so; do
not rely on that.

## Whatever you verify by running, run in a tree nobody else owns

**Whatever you verify by RUNNING, run in a tree nobody else owns.**
Independently re-running the ticket's acceptance mutation — loosen the
regex, delete the guard clause, flip the per-entry reset, run `<testCmd>`,
confirm a kill by the test-run verdict rule in SKILL.md, discard — is the half of this duty reading a diff cannot
do, and it stays. But it **writes**, and the PR's worktree belongs to
another member. Measured once: a finisher was inside that worktree at the
instant the fix-applier announced one more clause to land, and neither
ordering is detectable afterwards from the diff — a restore lands on the
uncommitted clause and destroys it silently, or the mutant is still in the
tree when the fix-applier commits and a deliberately broken guard ships as
the fix, in a commit nothing re-reviews. So take your own:
`git worktree add --detach <scratch>/pr<N>/finish-<your member name> <your dispatch pin>`,
mutate and run `<testCmd>` in there, then
`git worktree remove --force <scratch>/pr<N>/finish-<your member name>`.
**At your dispatch pin, never at the fetched branch tip** — duty 1 just
proved the owned worktree sits at that pin, and `PR headRefOid` may carry
commits no reviewer read, the substitution the halt block's head-equality
check rejects for the same reason. `<scratch>` is the absolute root your dispatch prompt names. The member name is in the path because
the scratch root is shared with every sibling, so `<scratch>/pr<N>` alone
collides whenever a PR gets a second finisher, and `worktree add` on an
occupied path fails closed into a halt with a purely mechanical cause.

## Remove the verification worktree on every path

**Remove it on every path, the failing ones included** — a mutant that comes
back green, a suite that will not start, your own halt at any duty. `--force`
is required and is right only here: the tree is deliberately dirty when you
are done, so a plain `git worktree remove` refuses it (`contains modified or
untracked files`, rc 128, directory left on disk — measured, git 2.50.1),
while everywhere else in this runbook that refusal is a finding precisely
because the dirt may be someone's only copy. Here nothing in it is anyone's.
Nothing sweeps a leak for you either: `reap.sh`'s branchless sweep is bounded
to the fleet's worktree home, so a tree under `<scratch>` is a `kept` entry
it reports and never collects. No claim built the tree you added, so it has
`./agent-test` only if the repository tracks one — run that or `<testCmd>`
in it, per `references/isolation.md`, **A reused worktree may lack the runner**.

## Take the label off before you approve any push

The label is a
verdict on the tree the finisher read, and a GitHub label does not follow the
branch — on one PR it survived a push and came to sit on a commit nobody had
audited. The token is how the tick tells your
removal from a finisher that never labelled — a tick run between a removal and
its token re-dispatches a finisher into your take-off window. The label goes
before the approval because removing the artifact the merge bot gates on is
the reliable stop, where messaging the bot races it, and a label has been
observed holding until after an abort message arrived.

## A final report is not proof the member stopped

**A final report is not proof the member stopped.** Observed twice: a ruling
relayed after dispatch produced a new commit mid-audit, and a fix-applier that
reported "nothing outstanding" resumed on a ledger-only withdrawal and was
cycling mutants through the worktree when the finisher audited it. Both finishers
correctly halted. Note what that costs to detect: two reads of the same worktree
a minute apart showed *different* mutants, so a member's report and any single
`git status` are each valid only at their instant.

## The standing CI facts are in the fix-applier body

**The standing CI facts are in the fix-applier body, not in per-event messages** —
otherwise you send "your red is staleness, do not rebase" once per member per
merge. `review-and-fix.md` states them; the body says they apply.

## A halt's cause comes from one script

A halt at duty 1 reads identical from a bare SHA mismatch whatever caused it,
and the causes `finisher-audit.mjs` names are the ones seen so far, not a
closed list; the finisher's agent body gives it the cause from one script
instead of asking anyone.

## Why a `past-pin` halt needs the tick

`past-pin` needs the tick because the dead-review path cannot reach it: once a
review has **returned**, its `reviewed=` token holds the PR out of `review-due=`,
and settling that review `=failed` re-queues nothing — that path covers only a
review that died before returning. A head that moved past `reviewed=` with no
such halt — a fix-applier's push — stays not due: duty 2 verifies what it
applied. **A rebase never gets a `reviewed=`:** the earlier review still
counts, because dispositions verdicts are tied to its head. Never write a
`reviewed=` you did not read off a review result file.

## Resolving a finisher that died

**Resolving a finisher that died.** A finisher settled `failed` or `killed` left
its PR without `ready-to-merge`, and nothing else notices: the PR is out of the
merge queue, and the tick dispatches no finisher for it. The cockpit flags a
REVIEW-column open PR without the label, whose latest finisher attempt settled
so, `finisher:failed` or `finisher:killed` at severity 4 — one token per
outcome, neither the implementer's bare `killed` flag nor `unlabelled`. You
resolve it by hand: investigate why the finisher died, or dispatch the
next-suffix finisher after the finisher gate: render its brief with
`dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<M>-<x>
…` (`--kind repair` once an earlier finisher reported `labelled` without the
label landing), then `ledger.mjs dispatch <M> finisher-pr-<M>-<x>`. The flag
clears when a later attempt settles — `labelled`
(then `unlabelled` takes over while the label is still off), `halted:<cause>`,
or a live `-b` — or when the PR carries `ready-to-merge`, merges or closes.
You never add the label yourself, and the tick does not retry.
