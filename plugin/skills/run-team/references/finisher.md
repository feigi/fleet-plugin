# The finisher: why its gate and duties are shaped the way they are

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

Evidence for the finisher rules the finisher's agent body, `agents/fleet-finisher.agent.md`, and SKILL.md's **The finisher gate** state, keyed by the rule each justifies.

## The fix-applier pushes and exits; the finisher is dispatched fresh

**The fix-applier pushes and exits — it does not hold the CI wait.** You own the
persistent Monitor; a turn-based member re-reading `gh pr checks` each idle cycle
rebuilds a 100k-token context for nothing the Monitor lacks. The body
carries the report-last rule and the brief says to push, write the report and exit; you do not have to restate either. When the
diff-validating `check` job is green **and no
heavy job is in `failure`** (the heavy diff-validating suites — not the
`rebase-check` currency gate; a `skipped` heavy job is behind-count staleness and
fine — **solely** off that count, which is a condition to establish rather than
infer, see the five-condition note in the fix-applier body) — or
`ci-state.mjs` reads `verdict: "no-ci"`, its bullet in **The finisher gate's
tests, in full** — **and once the PR's review
has returned and its fix-applier, if one was dispatched, has sent its report,
which the CI-completes edge in that section states in full** — dispatch a
**finisher** — a fresh small agent, not the fix-applier resumed. Render its brief
with `dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<pr#> …`
(`--kind repair` once an earlier finisher reported `labelled` without the label landing), record it with
`ledger.mjs dispatch <pr#> finisher-pr-<pr#>` before the call, then **dispatch
it with the `agent` that command printed and omit `model` on the call** — the
tier lives in that definition's frontmatter, `agents/fleet-finisher.agent.md`,
as the `@smol:low` route, which resolves through the operator's `modelRoles`.
Its four duties are a checklist — audit the
worktree, confirm every deferral has a tracker home and re-run the acceptance
mutation, apply one release label, report — and the
merge gate downstream still catches whatever it gets wrong. **Never dispatch
one while you still owe the fix-applier a reply**: the pinned SHA is only as good
as the guarantee nothing else is inbound. **The test is your OUTBOX, not the
member's last message** — anything you have decided that it has not received,
including a reply you have since **withdrawn or reversed**. **That is the test
of THIS condition only**: an empty outbox says nothing is inbound from you, and
nothing about whether the member considers itself finished, which is what the
report condition above is for. A withdrawal you
recorded only in the ledger is undelivered: the member still holds the original
and will act on it. Relay everything — reversals too — then dispatch.

## The finisher gate's tests, in full

- **Monitor: CI run completes** → `fleet-event.mjs ci <pr>`, which binds the run
  (`ci-state.mjs --pr <N>`) and **records it as
  `ci=<run-id>:<attempt>:<conclusion>`, not just "CI green"** — in the
  ticket's ledger row, which outlives your context. The key is what the sibling
  bullet below turns on: it tells an edge already spent from one that never
  fired. The whole key, never the conclusion alone: **a
  conclusion is not stable** (references/ci-and-staleness.md), because a rerun rewrites the run in
  place. The diff-validating `check` job green with no heavy job (the
  diff-validating suites, not the `rebase-check` currency gate) in `failure`
  → a finisher CANDIDATE (gated by *The fix-applier pushes and exits; the
  finisher is dispatched fresh*), a `check`
  **failure** that is not solely staleness → the **red-check fixer** (SKILL.md's
  **Then dispatch a red-check fixer**), behind the same review-returned and
  fix-applier-reported gate as a finisher. A `check`-green board whose heavy jobs are merely
  `skipped` (behind-count staleness, the normal case after a merge) still labels — do NOT
  gate on `ci-state --quiet` exit 0, which a behind PR never reaches. **This
  edge fires for every CI run the PR produces, and the implementer's own
  firing comes first for every PR** — `ci.yml` triggers on `pull_request`, so
  opening the PR at the end of `next-ticket` step 7 starts a run within seconds,
  while the review returns 20-40 minutes later. That first firing is
  the ordinary case for every PR, not a rarity, and no review has run at all
  when it arrives. **Green is therefore not the gate: dispatch a finisher only
  once the PR's review has returned AND its fix-applier, if one was dispatched,
  has sent its report — pushed is not reported**, and a push before that report
  is mid-work on a SHA the member may still move, which its own prompt tells it
  not to hand over. A push is therefore not an exit, and a report that has not
  arrived is asked for by name rather than read as one. Neither shape is caught
  by an empty outbox: on the implementer's firing there is no fix-applier to owe
  anything to, so the outbox is *vacuously* empty, and on a fix-applier's
  mid-work push nothing has been sent since the dispatch, so it is *genuinely*
  empty. **The outbox is the last test, not the only one, and it stands wherever
  a fix-applier exists** — that is exactly where a reply you still owe it is
  outstanding, so never dispatch off it while you do. Empty your outbox to it
  first — including any reply you have withdrawn or reversed — then dispatch
  (*The fix-applier pushes and exits; the finisher is dispatched fresh*); a final report is not proof it stopped. A PR that needs nothing fixed
  reaches a finisher through the **fix-applier reports `no-op`** bullet below,
  never by waiting for a second CI event this head will never produce. The
  same goes for a red one: a red that fired before the review never fires
  again, so the **fix-applier reports `no-op`** and **review result lands**
  bullets are also the only routes to the red-check fixer there.
  Then run the tick. These edges dispatch it, each the finisher's own: **Monitor: CI run completes** binding a red on a head whose review has returned and whose fix-applier, if any, has reported; **A fix-applier reports `no-op`**, or a SHA you have already bound, when that head's bound conclusion is red; and **A review result lands** with no finding and nothing to file, when that head's bound conclusion is red.
- **A fix-applier reports `no-op`, or a SHA you have already bound** → dispatch
  the finisher **now**, against the existing head — when that head's bound
  conclusion is red, the red-check fixer instead (SKILL.md's **Then dispatch a
  red-check fixer**), never a finisher and never a wait. No push means no new run, and
  the Monitor above is edge-keyed on `<run-id>:<attempt>:<conclusion>` — that
  head's terminal state already fired once and will never fire again, so waiting
  for the CI event waits forever. This stays a common outcome on a clean PR:
  `suggestion` is the band a clean diff produces, and every out-of-scope or
  refuted one is filed as an issue rather than committed. An edge-only label path
  therefore strands exactly the PRs with nothing wrong with them. **Reconcile, do
  not wait for an event** governs here too, not only the implementer row. **This
  bullet and the one above are a pair, and on a clean PR this one carries the
  whole route to a finisher**: a `no-op` report satisfies the gate above by
  itself — the review has returned, because a fix-applier exists only after it
  did, and the member has reported — so nothing further is owed and no further
  event is coming. Edit either bullet without the other and what strands is exactly the PR that needed no fixes. Edit one of these bullets without the others and what strands is exactly the red-only PR.
- **`ci-state.mjs --pr <N>` reads `verdict: "no-ci"`** → no workflow run will ever
  complete for this repo, so the CI-run-completion edge above never fires and
  waiting for it stalls the whole PR — the same silent-stall shape reported
  before this verdict existed. Dispatch the finisher off the reviewer's final
  verdict instead, the moment it lands — and, same as above, never while you still
  owe it a reply — or hold anything else it has not received, a reply you have
  withdrawn or reversed included. The finisher's gate is then the
  `--declare-no-ci` declaration, not a `check` job: with it, label off the
  reviewer's verified suite run; **without it, do not label** — report that this
  repo has no CI configured and no declaration, and stop. Absence never reads as
  pass. See `review-and-fix.md` step 6.
- **The PR's ruling is recorded** → an implementer's PR, one a settled
  `impl-<N>=PR#<M>` token on the ledger names, gets its finisher only once the
  main checkout's `docs/metrics/tier-outcomes.tsv` has a row for it, appended
  when you rule its review (SKILL.md's **Guard: accumulate per PR**).
  `ledger.mjs dispatch` refuses the finisher until that row exists, after its
  conflict-hold and dispositions refusals, and prints the `tier-outcomes.mjs
  append` command to run. Any row for the PR passes, so a replacement finisher
  is never held once the first passed; a PR no such token names is not gated.
  No flag skips it: a PR `append` refuses is fixed on the ledger, as at close-out.
- **The PR's closing references match its ruling and exclude its own suggestion-band record** → `ledger.mjs dispatch` reads the PR's `closingIssuesReferences` from `gh pr view <M>` before it dispatches any finisher, counting only those in the PR's own repository: a reference into another repository closes none of this repository's tickets, whatever its number. When the ruled row says `closed_own_ticket=yes`, each ticket a settled `impl-<N>=PR#<M>` token names must be closed by the body (`Closes #<N>`); when it says `no`, none may be, and no reference may be the PR's own suggestion-band record. A blank verdict is refused until it is set. A refusal names the PR and the ticket. The controller repairs the body itself with `gh pr edit <M> --body-file <file>`, then dispatches the finisher again. A `gh` read that fails refuses the dispatch and writes nothing.
- **The PR carries exactly one release label** → `ledger.mjs dispatch` reads the PR's labels from `gh pr view <M>` before it dispatches any finisher, and refuses unless exactly one of `patch`, `minor` and `major` is among them — the count `finisher-label.mjs` makes before it labels. A repository whose label list defines none of the three is not gated. A Ticketless PR with none is not refused: `finisher-label.mjs` adds `patch` to it before its count. Any other PR with none is refused naming the tickets it closes, and any PR with several naming the labels found — the bump, or which label stays, is not picked for the controller. The controller adds or removes the label itself, then dispatches the finisher again. A `gh` read that fails or answers malformed refuses the dispatch, saying the labels could not be read, and writes nothing.

A PR known to conflict cannot merge, and a finisher on it would race the conflict fix-applier rebasing it. That is why the conflict-hold refusal SKILL.md describes exists.

Gate on the `check` job, **not** on `ci-state --quiet` exit 0: a behind PR never
reaches full green, so an exit-0 gate strands it unlabelled. The finisher reads
per-job state (`ci-state.mjs` without `--quiet`, or its `jobs`), since `--quiet`
drops `jobs`, `missing` and `dropped`. Normal path, not only kill-recovery.

**`ci-state.mjs` reads `verdict: "no-ci"`** — no `check` job exists in this repo
to gate on, and that is not a third way to skip the wait. **The
`--declare-no-ci` declaration is caller-side, and reading it back out of the
payload verifies nothing**: the flag is echoed into `reasons` and flips the exit
code, so re-running with it and finding it there confirms only that you passed
it. Passing it yourself is not a second opinion. Check the two facts it stands
for instead:

1. `ci-state.mjs` **without** the flag still reads `verdict: "no-ci"`. A repo
   whose CI is merely misconfigured — workflow files present under other names,
   or `.github/workflows/` not a directory — exits 2 there rather than reading no-ci,
   so this is the check that separates real absence from misconfiguration, the
   case that must never ship silently.
2. The reviewer's own final verdict reports a green `testCmd` run on the SHA it
   pushed. `review-and-fix.md` step 3 requires it to, and that run is the only
   gate this repo actually has.

Both → add the label, and say it rests on the reviewer's suite run, not on CI.
Either missing → halt here, same as a dirty worktree: report `no CI configured,
no verified suite run on record` and add no label.

## An unanswered question from the member is an outbox item

**An unanswered question from the member is an outbox item, and it blocks
dispatch with the same weight as a reply you have already decided on.** It does not
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

## The Inert diff verdict decides whether the acceptance mutation runs

**The acceptance mutation runs unless `finisher-scope.mjs` says the diff is inert.**
A mutation that loosens a regex, deletes a guard or flips a reset has nothing to
kill in a diff made only of Markdown prose (`.md` or `.markdown` outside the
prompt surface) or only of the run-metrics files. The finisher does not decide
that by reading the diff: the script reads it, and only its exit 0 skips the
mutation. An exit 1 is not overridden, and an exit 2 is never read as a 0.

The prompt surface stays out of prose. A `.md` under a `skills`, `agents` or
`commands` directory or under any dot-directory (`.omp/rules`,
`.omp/RULES.md`, `.claude`), and any `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`, is
read by the harness, so it can change behavior. The one exception is a file
directly in the root `.out-of-scope/`, spelled exactly so: a rejection record
the triage skill writes, read as settled precedent, so it is prose unless it is
named `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`. Nested or elsewhere,
`.out-of-scope` is a dot-directory like any other. A symlink, submodule, mode
change or other non-regular entry is a code change whatever its name, so it is
not prose either. The verdict is read at the dispatch pin: the worktree's own
head is not part of it, and duty 1 audits that head separately.

## A Ticketless PR has no mutation and no ruling

**A Ticketless PR skips the acceptance mutation on `ticketless.mjs`'s exit 0 alone.** Run `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run ticketless.mjs --pr <M>`. It reads whether the PR closes an issue in its own repository and whether a settled `impl-<N>=PR#<M>` token names it; with neither, no ticket supplies a mutation to re-run, so exit 0 skips it whatever the diff, and the rest of duty 2 runs. Exit 1 and exit 2 (could not look) run duty 2 as for a ticket PR. Where a kill's evidence line would go, the report says that no mutation ran because the PR is ticketless.

**Duty 3 holds a Ticketless PR whose diff is not inert.** `finisher-label.mjs` adds `patch` to a Ticketless PR that carries no release label, then runs the Inert diff verdict in-process at your pin. A diff that is not inert, or a verdict that could not look, gets the `ready-to-merge-head:` record and no `ready-to-merge`, and the script exits 5: halt with cause `human`. No ticket gives that PR a ruling or a mutation, so the maintainer's `ready-to-merge` is the merge. The merge bot merges it off the record at the pinned head, and a head that moved after the record is merged by hand.

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
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run finisher-tree.mjs --worktree <abs-path> --pin <your dispatch pin> --pr <N> --member <your member name> --scratch <scratch>`
adds `git worktree add --detach <scratch>/pr<N>/finish-<your member name> <your dispatch pin>`
and runs the Install step in it, as a claim does: a detached worktree holds
tracked files only, so without that step a suite whose dependencies are
ignored cannot start. Mutate and run `<testCmd>` in that tree, then
`git worktree remove --force <scratch>/pr<N>/finish-<your member name>`.
**At your dispatch pin, never at the fetched branch tip** — duty 1 just
proved the owned worktree holds nothing your dispatch pin lacks, though its
`HEAD` may differ from it, and `PR headRefOid` may carry
commits no reviewer read, the substitution the halt block's head-equality
check rejects for the same reason. `<scratch>` is the absolute root your dispatch prompt names. The member name is in the path because
the scratch root is shared with every sibling, so `<scratch>/pr<N>` alone
collides whenever a PR gets a second finisher, and the script fails closed on
an occupied path.

**The script's exit code is your verdict on the tree, and its one JSON line is
the receipt.** Only exit 0 means a tree at your pin with its dependencies
installed and the tree clean; the receipt's `tree` is the path to work in.
Any other exit is a halt at duty 2: cause `other`, the receipt as the
evidence, no label, and you run none of the script's steps by hand to get past
it. The codes are distinct: 1 no usable tree (an occupied path, a failed add,
a head that is not your pin, a Recipe that could not be read, a tree dirty
before the Install step), 3 the Install step did not run (exit 126 or 127, a
broken Recipe), 4 the Install step failed, 5 the Install step changed the
tree or left its state unreadable; exit 2 is a refusal with no receipt, a
refused invocation or a receipt the script could not write. The script
removes nothing, so a tree it left behind is removed like any other below.

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

When a push moves the PR off its labelled head, the merge bot refuses the new
head on its own (`run-merge-bot.md`, **The labelled head**), so your take-off
is not the only guard — but its refusal costs a pass and leaves the label
lying, which is yours to clear either way, the same way: `label-off=` first,
then the removal.

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

## A re-review at the same head answers on its own run

A re-review at the same head is a run of its own, so the earlier round's verdict never answers it; once the check has run for the fix-applier answering the new round, its verdict is the current one.

## A halt's cause comes from one script

A worktree whose head differs from the pin because a remote rebase superseded
it is not a halt. When the newest reflog move is a `commit`, duty 1 tests
whether `pin..HEAD` holds anything the pin lacks: `git cherry <pin> HEAD`
prints no `+` line and the range holds no merge commit. A worktree that holds
nothing the pin lacks exits 0, because refreshing it would lose nothing — the
commits it holds are already in the pin, rebased. Only a range that does hold
something is a halt: `past-pin` when the branch's remote ref carries it,
`stray` otherwise. The test is by patch, so it has two limits. `git
cherry` never lists a merge commit, so a merge in the range counts as unique
whatever its parents carry. And patch ids ignore whitespace, so a local commit
that differs from a pushed one only in whitespace reads clean; it stays behind
in the owned worktree and never reaches the merge. A newest move that is a
`reset` or a `rebase` stays `rebase`, even when `pin..HEAD` would test clean.

A `stray` halt is a commit the branch's remote ref is not shown to carry — the
ref lacks it or is absent, or the read could not tell — so nothing pushes it and
nothing re-reviews it. Read the patches off `evidence.cherry` (`+` for a patch
the pin lacks; `merges` counts merge commits, which the listing never shows)
and `evidence.remote` (`carries` false: the ref lacks it; `sha` null: the ref is
absent; `carries` null: the read could not be told, and `error` says why). A
pushed stray is a head no reviewer read: record its review by hand with
`ledger.mjs review <M>`, under the next runner letter as for a `past-pin`
re-review below, before any finisher is dispatched.

A `human` halt is a Ticketless PR whose diff is not inert: the maintainer adds
`ready-to-merge` at the pinned head, which the merge bot merges off the
finisher's `ready-to-merge-head:` comment; a moved head is merged by hand.

The tick prints `DISPATCH review PR#<M>` for a PR whose latest finisher is `halted:past-pin` and whose latest `reviewed=<head>` is not its current head, until a review of it is running or has returned; record that review's tokens as any review's, with `ledger.mjs review <M>` onto the PR's row, its runner under the next letter the PR's rows do not carry yet (`review-pr-<M>-b`, or `-c` where a retry already took `-b`) — `review` refuses a second `review-pr-<M>` and names the free one — and its result reaches a fresh finisher through the same gate.

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
