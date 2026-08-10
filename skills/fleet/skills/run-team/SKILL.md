---
name: run-team
description: Run an agent fleet — up to 5 implementers, up to 5 reviewers, one merge bot — over the ready-for-agent queue. Invoke-only; the fleet writes to a live repo and must never start unasked.
argument-hint: "[implementers] [reviewers]"
disable-model-invocation: true
---

Run `next-ticket`, `review-and-fix`, `run-merge-bot` as one fleet. You are the
**controller**, in the main thread, never a member.

`$ARGUMENTS` = `[implementers] [reviewers]`, both optional, default 5, cap 5.
Merge bot is at most one, not configurable.

Rationale: `~/.claude/docs/specs/2026-07-22-run-team-agent-fleet-design.md`. The
war story behind each rule lives in `references/`; load one only when a member
needs the *why*.

## Rules that fail silently

**A report is a `SendMessage`, not the end of a turn.** Every member owes the
controller one `SendMessage` naming its outcome before it exits — including a
member whose prompt carries no explicit report line. The "report the SHA",
"report PR number" and "stop and report" instructions below *are* that message,
not a second obligation on top of it. A member that does the work correctly and
ends its turn has reported nothing: the controller learns the outcome only by
re-reading artifacts and pinging, and a finding held only in that member's
context is lost. Members did exactly this in one run — finishers, a reviewer and
merge bots alike, the work done and only the delivery missing. Say it in every
dispatch prompt. See references/member-lifecycle.md.

**Name every member.** The name makes it a team member, and membership is what
carries the `Agent` tool. Omit it → the member loses delegation with no error.
Names follow the unit of work: `impl-<issue#>`, `fix-pr-<pr#>`,
`review-pr-<pr#>`, `merge-bot-<wave#>`. See references/member-lifecycle.md.

**Inverts one level down: members must name their children `undefined`.** A named
member passing a `name` fails with `teammates cannot spawn teammates`, so
specialists are dispatched **unnamed**. Say so in a fallback reviewer's prompt, or
it silently downgrades to a solo review. See references/member-lifecycle.md.

**Fresh context per member.** One agent, one unit of work, gone. Never
`subagent_type: "fork"` (inherits your whole conversation). Never re-task a
finished agent — `SendMessage` resumes its transcript and drags the old ticket in.
Refill = **new** agent, **new** name. `SendMessage` is still right for pinging a
member for a report it owes, or resuming a truncated reply.
See references/member-lifecycle.md.

## Phase 0 — shortlist

At start, and whenever the pool empties.

0. **Launch the cockpit, once per run.** On the first phase-0 pass only:
   `node ~/.claude/skills/fleet/scripts/board.mjs serve --open &` in the
   background. It is a read-only mirror of `.fleet/ledger.md` + `gh` — you never
   feed or update it, and it survives your own compaction. Skip on later
   re-shortlists (a server is already running; a second one collides on the
   port).

1. **Candidate scan** — `~/.claude/skills/fleet/scripts/candidates.mjs
   --require-label ready-for-agent`. **`--require-label ready-for-agent` mandatory, no
   fallback** — do NOT pass `--allow-fallback`. Empty means no work;
   `ready-for-human` needs a human to brainstorm first and you have no channel to
   one mid-flight.
2. Dependency scan, `next-ticket` step 2, on the `d` array. Open blocker → drop.
3. **In-flight check** — `~/.claude/skills/fleet/scripts/inflight.sh <N>` per
   candidate; any hit = taken. It runs all three probes (PRs, remote heads, local
   worktrees + branches) so a partial one cannot read as free. The PR probe is
   two signals rather than a bare full-text match — GitHub's own closing-PR links
   plus branch-segment matching — and both drop `MERGED` and `CLOSED`, so a
   merged or abandoned PR the `gh pr list` window covers cannot hold a ticket
   forever. A linked PR that window does *not* cover has no state to read: it
   prints `?` and still counts as taken, merged or not.
4. **Read each survivor in full, once** — `gh issue view <N> --json title,body,comments
   --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`. One read
   answers both questions. Record the Agent Brief's `Out of scope` sequencing.
   Then judge **decided?** — never size.

   **Decided?** Would two competent implementers, reading only this ticket, build
   materially different things? "Material" by inventory, not feel:

   | Left open | Verdict |
   |---|---|
   | architecture, API shape, schema, UX | **undecided** |
   | new dependency, new seam | **undecided** |
   | naming, file layout, ordering, test arrangement | decided — ignore |

   Any undecided item → not decided. Name it; that name is the exclusion line.
   **Torn → surface, never guess** (step 6's `unsure` group). Opposite of
   `sizing-a-ticket`'s *torn → take the heavier row*, deliberately — see that skill.

   No sizing agent here. `sizing-a-ticket` picks the *process path*, and that is
   phase 2's call, after the ticket is claimed.

   **Class?** Second judgement off the same read, so it costs no extra tokens.
   Stale docs, wrong comments, bad citations → `class=correction`; everything
   else → `class=routine`, which dispatches at `sonnet`. **Torn → correction**:
   a misjudged routine is a missed saving, a misjudged correction runs the one
   class that demonstrably ships new wrong claims at the cheaper tier.

   Corrections keep the session's top tier as a **precaution, not a
   measurement.** references/correction-tickets.md records four tickets in one
   run each shipping a *new* wrong claim, and blames the ticket's framing and
   unasked-for prose — **not** implementer capability; it measures no tier at
   all. What it does establish is that this class fails in the reasoning
   wrapped around a correct mechanical fix, which is what a cheaper model is
   likeliest to add to. Price of the precaution: corrections never run
   `sonnet`, so the guard in phase 2 can never produce evidence either way
   about the one class it would matter most for.

   What makes `sonnet` safe for `class=routine` is the decided? judgement
   directly above — no undecided row left open — plus specialist review,
   adversarial verify, CI and the merge bot's post-rebase green all sitting
   behind the implementer. Thinner than it reads on a prose-only diff, which
   `diff-stats.mjs` gives `profile: "docs"` and the trimmed dimension set.
   Record the class in step 6's annotation; phase 2 dispatches on it.
5. **Collision scan against open PRs** — a survivor is an *un-implemented issue*
   with no diff, so infer its target files from the issue body (the paths it
   names) and compare them against each open PR's `gh pr diff <PR> --name-only`,
   and against the other survivors' inferred files. `pr-overlap.mjs` is **PR-vs-PR
   only** — it runs `gh pr diff` on *both* args and errors on an issue number, so
   use it the way the merge bot does (PR vs PR), never on a candidate issue here.
   Step 3 catches a ticket already taken, not one that *edits a file an open PR
   edits*. Overlap → admit one, defer the rest with the reason. The tracker cannot
   express this, and it is what actually stalls a wave.
6. Present survivors as a multi-select, **oldest first** (`candidates.mjs` already
   sorted; do not re-rank). Three groups:

   - **admitted** — decided;
   - **unsure** — torn, each flagged with the open decision;
   - **excluded** — undecided, each with the decision that is missing.

   Annotate every survivor with its class — `correction` or `routine` — so the
   maintainer sees which tickets are about to run at the cheaper tier before
   ticking them. Annotate any survivor the `Out of scope` read sequences after
   another survivor in the same list. Without that, FIFO puts a chain's members
   next to each other and two consecutive numbers read as two independent
   tickets — which is exactly how both land in one wave.

   Maintainer ticks what to **stage this wave** — how many, what order, what
   collides. Staging, never vetting: `ready-for-agent` already carries triage's
   verdict that an agent may take the ticket, reached with the maintainer present.
   Phase 0 does not re-litigate it, and an unticked ticket is deferred, not judged
   unfit. **unsure** is the only group asking a judgment.

   Excluded, not dropped: phase 0 never relabels an unclaimed ticket, and an
   unticked ticket keeps `ready-for-agent` and returns next wave.

Never put two sequenced tickets in one wave. That lives in the brief's `Out of
scope`, is invisible to step 2, and bites hardest at five wide.

## Phase 1 — claim and isolate

Serial, main checkout, per ticket. Never parallel, never inside a member —
concurrent `worktree add` and label writes race.

`~/.claude/skills/fleet/scripts/claim-ticket.sh <N> <slug> <type> --apply` does
the label, worktree, branch, frozen install, lockfile-clean assertion, and the
isolation runner in one serial pass. Infer branch/worktree convention from
`git worktree list` and `git branch -r` for the `<slug>`/`<type>` arguments.

**Infer `<install>` — never default to `npm install`.** A lockfile-mutating
install in a throwaway worktree corrupts it for everyone; the script derives the
frozen form from the lockfile and refuses to guess. See references/isolation.md.

**Materialize the isolation envelope as a file, not a briefing.** The script
writes `.worktrees/<N>-slug/agent-test` (ports derived from `<N>`, so collisions
are impossible) and `.git/info/exclude`s it. Brief members with `./agent-test
<file>` and nothing else — anyone who finds the worktree finds the runner,
including grandchildren you never dispatched. See references/isolation.md.

**A reused worktree may lack the runner.** `claim-ticket.sh` writes `agent-test`
only when it claims a *fresh* worktree. A worktree carried over from a prior run,
or an already-open PR's worktree you send a rebaser/resolver into, predates the
marker and has no `./agent-test` — a member told to use it stalls on a missing
script (observed with a rebase-resolver in a prior-run worktree). When you
dispatch into a NOT-freshly-claimed worktree, either re-materialize the runner
first or tell the member the runner is absent and to run docker-free suites
directly (`npx vitest run --config vitest.ci.config.ts <file>` — the CI unit
config has no `globalSetup`, so there is no stack to collide on).

## Phase 2 — dispatch implementers

**Dispatch at the tier phase 0 classed the ticket at.** `class=routine` →
`model: "sonnet"` on the Agent call. `class=correction` → **omit `model`**,
inheriting the session's tier; that omission is the whole mechanism, and a
member dispatched with `model` set does not get it back. It holds only while the
implementer's subagent type carries no `model:` frontmatter — an omitted `model`
takes the *agent definition's* tier first and the session's only after.

**No class recorded → omit `model`, and record `class=unknown`.** Never
`sonnet`: the cheap tier is the structural complement of "correction", so a lost
class silently strips protection from the one class that must keep it. Every
path that loses it lands here — a compaction, a phase-3 refill re-entering phase
1 then 2 without a fresh issue read, a killed member replaced from inherited
state. Writing the gap down is what makes it visible; re-read the issue to
recover the class when the saving is worth one `gh issue view`.

Carry the class in the ticket's ledger row, written before dispatch like every
other field:

```
ledger.mjs row <N> "impl-<N> · class=routine"
ledger.mjs row <N> "impl-<N> · class=correction"
ledger.mjs row <N> "impl-<N> · class=unknown"
```

`row` **replaces the whole line**, it does not append. Re-dispatching over a row
that already carries `KILLED`, `ports=` or `→ PR#` must repeat those tokens or
they are gone, with only `rewrote row #N` on stderr to say so. Recover a class
after a compaction with `ledger.mjs read` — `class=` is a raw-row field, and the
cockpit does not parse or surface it.

**Guard: measure per PR, not per wave.** There are no implementer waves — refill
is level-triggered, one slot at a time — so the unit is the PR. Once at least
three `class=routine` PRs have been ruled, compare their `ruled:` outcomes in
`ledger.mjs read` against the top-tier PRs above them, and the implementer-vs-review
split in `board.mjs build`'s `.spend.roles`. Per-`impl-<N>` spend is not
available: `.spend.top` labels agents by their Agent-call `description`, not
their member name.

The risk is not shipped bugs, it is economic. Reviews run 3-5x *longer* than
implementation (Red flags, below), so one extra fix-round costs a wave slot and
eats the saving the cheaper implementer made. Findings climb, or the implementer
share does → revert **`class=routine`** to top tier, never the rule wholesale.

The first run under this rule has no baseline — every routine PR in it is a
sonnet PR. The guard cannot fire until a run that mixes both, or until a prior
run's numbers are on hand. Say that; never read its silence as a pass.

One named member per ticket, up to cap, background. Each prompt carries ticket
number, worktree abs path, branch, and each of these verbatim:

> You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create
> another worktree. Verify with `git rev-parse --git-dir` and
> `git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.

> Read the issue with `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`.
> Not bare `gh issue view <N> --comments` — non-interactively that prints only
> the comments, and nothing at all when there are none, dropping the title and
> body either way, exit 0, so the loss is silent. The `## Agent Brief` comment
> is authoritative over the issue body. Honor its `Respec` block — it may
> explicitly rule out hypotheses the body raises. Read the issue **before
> touching code**: with the repo in front of you, still undecided or needing
> human hands you do not have → bail, name the cause, do not implement.

> Commit incrementally as you go. Do not accumulate a large uncommitted diff — if
> you stop for any reason, uncommitted work is invisible to the controller and
> effectively unrecoverable.

The commit-incrementally block is not optional. A member that goes idle mid-task
leaves its diff only in the worktree, and the controller cannot reap, replace,
or even see it — `worktree-audit.sh`'s committed-vs-uncommitted split is exactly
what decides whether a replacement redoes or destroys work. Observed twice in
one run.

A member that does not bail runs `sizing-a-ticket` for the process path and
proceeds on **either row** — heavy is never a bail reason, and that skill owns
the fleet's heavy-row entry point. A brief that will not support a plan is the
undecided case: bail and demote, never a heavy row. Selection and claiming are
done; the member starts there.

Then `next-ticket` **step 7** (rebase, re-run tests, push, `gh pr create` with
`Closes #N` and one release label — `patch`/`minor`/`major`, the *label* not the
branch *type*), report PR number and head SHA, exit. Never labels
`ready-to-merge`, never merges.

## Phase 3 — event loop

React to events; never block on one.

**React to artifacts, not agents.** `idle` means "not currently executing", not
"done", and a finished member's finding may never arrive. Read `gh pr view`,
`gh run view`, `git -C <worktree> status` **before** messaging; when you message,
send the specific next action, never "what is your status".
See references/member-lifecycle.md.

**Do not ask permission to run the loop.** Dispatching a reviewer, spawning a
merge bot, refilling a slot, re-verifying a SHA, filing a follow-up — all proceed
unconfirmed. Invoking the command was the opt-in. Two exceptions: **Phase 0's
multi-select**, and **a judgement the evidence cannot settle**.

- **Implementer completes** → verify the SHA is reachable on the expected branch →
  enqueue for review → refill the slot (phase 1, then 2) with a new agent.
- **Implementer bails before implementing** → demote by cause:

  | Cause | Label |
  |---|---|
  | brief does not decide *what* to build | `needs-triage` |
  | needs human hands — external access, manual testing, judgment during the work | `ready-for-human` |

  `gh issue edit <N> --remove-label ready-for-agent --remove-label in-progress
  --add-label <label>`, comment the cause, release the worktree and branch with
  `release-ticket.sh` (below — `reap.sh` declines a claim that never became a
  PR), refill with a *different* ticket. `needs-triage` routes back to
  `/triage`, which can return it as `ready-for-agent`; `ready-for-human` is the
  dead end, so use it only for hands, never for vagueness.

  **Dropping `in-progress` is the load-bearing half** — phase 1 applied it and
  `candidates.mjs` excludes it, so leaving it makes the ticket invisible to your
  scans *and* the maintainer's. It does not loop; it disappears. Phase 0 excludes
  without relabelling — an unclaimed ticket is not yours to reclassify, and it
  surfaces its exclusions to the maintainer anyway.
- **Review slot free, PR queued** → run the review workflow yourself, then
  dispatch a fix-applier for what survives (below). Nothing survived and nothing
  to file → skip the fix-applier and dispatch the **finisher** directly: no
  member will touch that PR, so no push is coming and nothing will wake you.
- **Reviewer labels a PR** → merge-bot wave.
- **Monitor: `ready-to-merge` appears** → merge-bot wave. Catches hand-added labels.
- **Merge-bot wave reports done** → reap merged branches and worktrees (below).
- **The run ends, or the maintainer says drain** → release every claim that never
  became a PR (below). Nothing else in the loop fires for those.
- **Monitor: CI run completes** → bind it (`ci-state.mjs --pr <N>`); the
  diff-validating `check` job green with no heavy job (the diff-validating suites,
  not the `rebase-check` currency gate) in `failure` → dispatch a finisher to
  label, a `check` **failure** → a fixer. A `check`-green board whose
  heavy jobs are merely `skipped` (behind-count staleness, the normal wave case)
  still labels — do NOT gate on `ci-state --quiet` exit 0, which a behind PR never
  reaches. Fix-appliers push and exit, so a member is rarely still waiting — ping
  one only if it genuinely is.
- **A fix-applier reports `no-op`, or a SHA you have already bound** → dispatch
  the finisher **now**, against the existing head. No push means no new run, and
  the Monitor above is edge-keyed on `<run-id>:<attempt>:<conclusion>` — that
  head's terminal state already fired once and will never fire again, so waiting
  for the CI event waits forever. This stays a common outcome on a clean PR:
  `suggestion` is the band a clean diff produces, and every out-of-scope or
  refuted one is filed as an issue rather than committed. An edge-only label path
  therefore strands exactly the PRs with nothing wrong with them. **Reconcile, do
  not wait for an event** governs here too, not only implementer refill.
- **Pool empty** → phase 0 again, subject to queue depth. Run phase 2's tier
  guard here once three or more `class=routine` PRs have been ruled since the
  last check; nothing else in the loop owns it.

**Own the CI waits.** Members are turn-based and cannot hold across a ten-minute
run — they rebase, push, stop. Arm a second persistent Monitor over open PRs'
latest runs, keyed `<run-id>:<attempt>:<conclusion>` so each terminal state fires once, and
emit the behind-count and the per-job conclusions with it: a `success` on a branch
8 behind is not actionable, and `check`-green-with-heavy-skipped is the staleness
board you must not confuse with a red. Do not reinvent that read: one
`~/.claude/skills/fleet/scripts/ci-state.mjs --pr <N>` per open PR already emits
run id, attempt, conclusion, behind-count and per-job conclusions, branch derived
from the PR — including the `gh api --hostname <host>` a GHE compare call needs,
without which the probe 404s and `behind` comes back `null`, never 0, so every
event reads as unknown-behind. Call it **without `--quiet`** — that flag drops
`jobs` and `missing`.

A monitor event is a wake-up, never a verdict; members re-query at labelling
time. See references/ci-and-staleness.md.

**A conclusion is not stable, even for a fixed run id on an unchanged head.** A
rerun rewrites the run in place, so never cache a conclusion; key watchers on
`<run-id>:<attempt>:<conclusion>`. Leaving `attempt` out of the key is the bug
that looks like it works: a rerun that lands on the *same* conclusion regenerates
an already-seen key and fires nothing, so the second failure is silent and reads
exactly like a run still in progress. Also: the newest
run on a branch is frequently *not* CI, so `--limit 1` can hide the CI result
entirely. See references/ci-and-staleness.md.

### Reviewers

**You run the review yourself: `Workflow({name: "review-pr", args: {pr, branch,
worktree, testCmd, scratch}})`, once per PR. That is the default path.** Only you
can run it — members have no `Workflow` tool (verified 2026-07-30 for the
`general-purpose` subagent; tool availability is per-agent-type, so recheck after
a harness change rather than treating it as permanent) — and it is the only path
on which `selectDimensions` sizes the fan-out to the diff and the verify budget
follows severity. Hand-dispatched, neither executes at all: sizing falls back to a
reviewer's own judgement and nothing budgets the adversarial pass. It cuts one
immutable snapshot, verifies every critical/important finding adversarially, and
has `agent()` return **into the script**, so no report can go undelivered and you
relay nothing — the delivery failure that cost one fleet five reports on one PR
and four on another.

**Know the trim before you rely on it — it is wider than `docsOnly` suggests.**
`diff-stats.mjs` calls a PR docs-only only when it touches **no** src, tests *or*
config, but that strictness cuts both ways and the size tier trims again on top.
Measured: a docs PR that also adds one test file is profile `tests-only` and runs
**three** (correctness+tests+comments), not six; a docs+config diff runs
correctness+comments without being docs-only at all; and any `single-file` or
`small` profile trims to correctness+silent-failure, keeping comments only when a
docs file is in the diff and tests only when a test file is. `single-file` means
one file at **any** size, so a one-file rewrite trims too. An unknown profile
widens to the full six, the safe direction, so a trim is never something to count
on in advance — and a full six is never something to assume.

**One review workflow at a time.** The workflow is not a member — count the
**fix-applier** against the reviewer cap, never the workflow — but that
accounting leaves the workflow itself ungated, and the cap bounds *members*, not
the agents members and workflows spawn. Its own fan-out is 1 snapshot + up to 6
specialists + 2 refuters per critical/important finding, and the fix-applier is
not dispatched until it returns, so the reviewer cap reads five free slots for
the whole 20-40 minutes the review runs. Queued PRs wait. A queue is not a reason
to start a second.

It returns `{pr, head, snapshot, dimensionsRun, survived, refuted, unverified}`.
`unverified` is *not* "checked and cleared" — a `suggestion` skips the pass by
policy, and a finding whose refuters all crashed lands there too. Hand those over
with the rest; never rule on them yourself. `refuted` comes back deliberately as
well — a refutation is itself a claim, and one has been reversed on new evidence —
so record it in the ledger's `ruled` line and hand it over only when you reverse
it.

**`dimensionsRun` names what ran, never what returned.** A specialist that dies
contributes zero findings while its key stays in that list, so a dimension listed
in `dimensionsRun` with nothing in `survived`/`refuted`/`unverified` is **unrun,
not clean**. Re-run it, or name it unrun in the report — an absence of findings is
not coverage. Same rule the fallback below states for a killed specialist, for
the same reason.

**A throw or an empty return is a failure event, not a clean review.** It throws
on missing `args.pr`/`args.worktree` and on a snapshot agent that returned no
tree, and it surfaces to you mid-loop, where "react, never block" makes it easy to
log and carry on — leaving a PR that *reads* as reviewed and is not. Being no
member, it has no row in **Failure handling**. Retry once; still failing →
hand-dispatch the fallback reviewer below and record in the ledger which path ran.

**Then dispatch a fix-applier** — one named member per PR, `fix-pr-<pr#>`, never
the PR's implementer. Its prompt carries the PR number, the worktree abs path, the same `testCmd` you
passed the workflow, and the returned `survived` / `unverified` findings
verbatim, plus:

**Where `testCmd` comes from:** the repo's own test command, the one you hand
specialists per **Give specialists a stack-free test command** above — in this
repo `node --test skills/fleet/scripts/*.test.mjs`. Pass the same string to the
workflow and to the fix-applier so both gates run one command. Omit it from the
workflow args and `review-pr.js` defaults to that string; the fix-applier has no
default, so substituting `<testCmd>` with nothing leaves it no gate at all.

> You are ALREADY in worktree `<abs-path>`. Do NOT create another worktree. The
> review is done and these findings are its output — do not re-review, do not
> dispatch specialists.
>
> Read `~/.claude/skills/fleet/commands/review-and-fix.md` and run **steps 2, 3
> and 5 only**: split apply-now/defer, commit, push, file every deferral as its
> own issue with the label the finding's state calls for. Skip step 1 — the
> review already ran — and steps 4 and 6: the controller owns the CI wait and
> dispatches the finisher.
>
> **Apply `survived` findings. A finding in `unverified` whose refuters ran and
> crashed always defers** — at `critical` that means every one of them died.
> Severity records how much a finding would matter if true, never whether
> anything looked. **A `suggestion` is also in `unverified`, for a different
> reason — the workflow budgets it 0 refuters by policy — and the rule below,
> not this one, covers it.**
>
> **A `suggestion` is budgeted 0 refuters, so it is unchecked until you check
> it.** For each one, first decide scope: is it inside the scope of the PR's own
> ticket, or a different piece of work? **Out of scope → defer and file, never
> apply.** **In scope → dispatch ONE refuter** against the finding before
> touching the tree, biased to refuse:
>
> > Try to REFUTE this finding. Default to refuted=true if uncertain. Verify by
> > RUNNING something — compile it, run the test, apply the mutation. Do not
> > reason your way to agreement.
>
> Survives → apply it. Refuted → defer and file it, and say the refutation in the
> issue body. **Apply only what survives — no report is not a survival.** A
> refuter you never hear from leaves the finding exactly as unchecked as it
> arrived, so it defers like a refuted one.
>
> **Retrieve that report yourself; do not wait to be handed it.** On the
> hand-dispatch path a subagent's report has surfaced to the controller rather
> than to its dispatcher, and waiting for a relay that never comes strands the
> finding. Its transcript is at the output file named in your spawn result, and
> its report is the last record:
>
> ```
> tail -1 <output-file> | jq -r '.message.content[]?|select(.type=="text").text'
> ```
>
> **Never read the whole file** — it is the full JSONL transcript and will
> overflow your context. **Pinging is not retrieval and never becomes one:**
> `SendMessage` to a finished subagent returns `had no active task; resumed from
> transcript` without the report (~15 pinged in one run, 0 retrieved). If the file
> yields nothing, ask the controller by name. Only when neither works is the
> finding **unchecked** — defer and file it, and say so in the body. This is
> `review-and-fix.md`'s **Specialists** rule; it reaches you here because the
> steps that point at it are the ones you skip.
>
> The CI facts in that file apply to you — a `rebase-check` red, or heavy jobs
> `skipped` off a non-zero behind-count, is staleness and not a failure. Never
> rebase to clear it.
>
> **Run `<testCmd>` from the worktree before committing**, copied verbatim.
> `tests 0` is a FAILED run, not a pass. Red or zero-test → fix it, or move that
> finding to defer; never commit over it. **Never `--no-verify`** — a failing
> hook is a finding you report, not an obstacle you route around. Report the test
> result with your SHA. Nothing re-reviews this commit: the review ran against a
> snapshot cut before your edits existed, and a refuter checked the finding's
> claim, never your patch.
>
> Then `SendMessage` the controller the pushed SHA, your apply/defer split, and
> the deferral issue numbers, and exit. **Deferring everything is a normal
> outcome, not a stall:** nothing is then staged, `git commit` refuses an empty
> index, `git push` prints `Everything up-to-date`, and you report `no-op, HEAD
> unchanged at <sha>` in place of a new SHA. Say it explicitly — silence there is
> indistinguishable from a member that died. Never manufacture a commit to make
> CI fire.

**Put the standing CI facts in that prompt, not in per-event messages** —
otherwise you send "your red is staleness, do not rebase" once per member per
merge. `review-and-fix.md` states them; the prompt only has to say they apply.

**The fix-applier pushes and exits — it does not hold the CI wait.** You own the
persistent Monitor; a turn-based member re-reading `gh pr checks` each idle cycle
rebuilds a 100k-token context for nothing the Monitor lacks. Tell it: apply fixes,
push, report the SHA, stop — and that a report already sent **pins that SHA**, so
resuming on new information means messaging you *before* touching the tree again.
Observed once: a finisher halted on a tree the reviewer had legitimately re-edited
after its verdict. When the diff-validating `check` job is green **and no
heavy job is in `failure`** (the heavy diff-validating suites — not the
`rebase-check` currency gate; a `skipped` heavy job is behind-count staleness and
fine) dispatch a **finisher** — a fresh small agent, not the fix-applier resumed.
Its duties, in this order:

1. **Audit the worktree** — `worktree-audit.sh`, or `git status --porcelain` in
   it. Dirty or diverged halts the finisher *here*, before the label: it reports
   what it found and labels nothing. A finisher that verifies the dirt is
   harmless and labels anyway has substituted the rule's purpose for the rule,
   and you find out at merge time.
2. **Confirm every deferral is filed as an issue** — not parked as a comment on
   the PR's *own* source issue, which the PR's `Closes #N` buries on merge.
   Caught once at seven findings. A comment on an existing *follow-up* issue is
   filed: that is `review-and-fix.md` step 5, not a violation. Not filed → file
   it or halt, never label over it.
3. Add `ready-to-merge`.
4. `SendMessage` you the label, the deferral issue numbers, and anything it
   halted on.

Gate on the `check` job, **not** on `ci-state --quiet` exit 0: a behind PR never
reaches full green, so an exit-0 gate strands it unlabelled. The finisher reads
per-job state (`ci-state.mjs` without `--quiet`, or its `jobs`), since `--quiet`
drops `jobs`. Normal path, not only kill-recovery.
See references/ci-and-staleness.md.

**Correction tickets ship new wrong claims — inherited from the ticket, and
minted in prose the ticket never asked for.** Put the check on the
**implementer**, not only the reviewer: every factual claim the diff restates
must have a settling command run against the tree first — the issue body is a
lead, never a citation — and the diff must **match the ticket's stated size**,
since added prose is where minted claims enter. No positional references (`the
closing/second/last X`); name the thing semantically. The workflow's `comments`
dimension checks every added assertion against the tree, including comments in
files the diff does not touch; a fallback reviewer has to be told that *and* told
to read each corrected sentence literally, clause by clause.
See references/correction-tickets.md.

#### Fallback: hand-dispatched reviewer member (no `Workflow` tool)

Only where the workflow is unavailable **or has failed** — never a preference.
"Unavailable" is `ToolSearch` not finding it; "failed" is the throw or empty
return above, surviving one retry. A workflow that is present and throwing is not
absent, and reading this line as absence-only leaves the likeliest failure with no
sanctioned path at all. One named member per PR, `review-pr-<pr#>`, never its
implementer. Give it the PR number and tell it to read
`~/.claude/skills/fleet/commands/review-and-fix.md` — the file
path, not a slash invocation; command availability inside a member is not
guaranteed the way skill availability is. It then does the fix-applier's job too:
apply, defer, file, push, report, exit.

**Authorize the fan-out explicitly.** State that the full specialist set IS the
requested work — otherwise the reviewer inherits the standing "do not call the
AgentTool unless requested" and silently downgrades to a thinner solo review.
Nothing computes the count here, so apply the heuristic yourself: two or three
specialists for annotation-only or single-file, the full set for production code.
See references/member-lifecycle.md.

**Delivering specialist reports is your duty on this path, not the reviewer's.**
Reports surface to *you* and grandchildren are unaddressable, so a reviewer must
never be told to ping for one. But it **can** read the report itself: a specialist
it spawned writes its transcript to the output file named in its spawn result, and
`tail -1 <file> | jq -r '.message.content[]?|select(.type=="text").text'`
extracts the final report — bounded, unlike reading the whole file. State that in
the prompt: retrieve first, ask you by name only if the file yields nothing, and
rule a dimension **unrun** only when neither works — not silently, and not after
waiting forever, since a killed specialist never reports and never gets relayed.
See references/member-lifecycle.md.

So two obligations enter the event loop for as long as a hand-dispatched reviewer
is live:

- **A specialist report lands** (a task-notification from a grandchild you never
  dispatched) → **relay it to the reviewer that owns the PR — source named, text
  included.** Relay anyway even though the reviewer can retrieve it itself — a
  duplicate costs nothing, a missed report costs a verdict. Telling it to ping the
  specialist still returns `had no active task; resumed from transcript` and
  delivers nothing.
- **A reviewer's verdict claims a dimension went undelivered** → reconcile it
  against your relay receipts before accepting it. Receipts say relayed → re-send
  naming the specialist and hold that verdict until it lands; a relay can arrive
  after a verdict is already composed. Only you hold the msg id, so only you can
  catch this — the reviewer cannot tell "no report exists" from "one was sent that
  I have not received". One reviewer ruled a relayed dimension "not covered by a
  specialist" and shipped a headline claim that report refuted.

Neither belongs in a workflow-path prompt: there `agent()` returns into the
script, no relay ever occurs, and a rule to wait for one strands every finding.

### Merge bot

Per wave, named `merge-bot-<wave#>`, never two at once. Tell it to read
`~/.claude/skills/fleet/commands/run-merge-bot.md`, run **one** pass, then
`SendMessage` you what it merged and what it held, then exit — and say that
you dispatched it, which is what makes it skip its own watcher step.

**You own the watcher, not the bot.** A dying member takes a watcher down with it
and the queue stops silently. Arm one yourself, `persistent: true`, seeded before
the loop so handled PRs do not re-fire.

**Every merge invalidates every other open PR, silently.** The rest show *stale
green* until something re-triggers, then flip to `rebase-check: FAILURE` with the
slow jobs skipped. Behind-count is the only honest signal.
See references/ci-and-staleness.md.

**One rebase per PR, at merge time.** The bot establishes currency once, when the
PR is the merge candidate; requiring it earlier costs a full CI cycle per sibling
merge. At 6+ open PRs batch a wave rather than merging singles. Any behind-count
you hand a bot is expired on arrival; say so. See references/ci-and-staleness.md.

`run-merge-bot.md` carries the mechanics — intra-wave re-checks, run-binding, the
ancestry proof, post-rebase red triage. Do not restate them here.

### Reap after every wave

A merge deletes the remote branch and leaves the local branch `[gone]` with its
worktree — and its `node_modules` — still on disk. Reap after **each** wave, not
once at the end: a stale worktree still answers `git worktree list`, so phase 0's
in-flight probe reads an already-merged ticket as taken and the queue quietly
shrinks. See references/reaping.md.

`~/.claude/skills/fleet/scripts/reap.sh --apply` recomputes every precondition
inside the same invocation as the delete — `for-each-ref` for `[gone]`, `git
cherry origin/main` to authorize `-D`, worktree removal without `--force` — and
reports reaped and kept-with-reason counts. Update the reaped tickets' ledger rows
in the same step. See references/reaping.md.

**Do not invoke `commit-commands:clean_gone`.** It runs `git branch -D` and
`git worktree remove --force` with no merged check at all — nothing there stops it
deleting a branch, or discarding a member's uncommitted work, that exists nowhere
else. The skill is the maintainer's to fix; do the reap yourself.
See references/reaping.md.

**Never reap a branch a live member is on.** Cross-check `.fleet/ledger.md` first:
a row without a terminal state means someone may still be in that worktree, and
the dirty check does not see a member that committed but has not pushed.
See references/reaping.md.

### Release the claims that never became PRs — at end of run, and on drain

Phase 1 is serial and runs ahead of dispatch, so a ticket can be legitimately
claimed and then never sent: a collision surfaces after the claim, the maintainer
says drain, the pool is re-prioritised. The claim still holds the `in-progress`
label, a worktree and a branch, and **`reap.sh` will not take them** — the branch
is not `[gone]` and has no unique commits, so it is correctly not reapable. Reaping
fires per merge wave and nothing fires at end of run, so the claim survives it and
phase 0's in-flight probe reads a free ticket as taken next run. Same silent queue
shrink as a stale merged worktree, from the opposite end.

`~/.claude/skills/fleet/scripts/release-ticket.sh <N> <slug> <type> --apply` is the
inverse of the claim, and recomputes all four preconditions inside the same
invocation as the delete: 0 commits ahead of `origin/main`, clean worktree, no
unique commits (`git cherry`), no branch on `origin`. All clear → drops the label,
removes the worktree without `--force`, deletes the branch with `-d`. Any one of
them failing → it touches nothing and names the blocker. **That refusal is the
finding, never an obstacle**: a claim carrying commits or a pushed branch is not
auto-released, ever — audit it with `worktree-audit.sh` and decide by hand.

Run it over every pool ticket with no PR when the run ends or the maintainer
drains, and on the spot for a claim abandoned mid-run (a bail before
implementing, a collision found after the claim). Update the released tickets'
ledger rows in the same step. See references/reaping.md.

## Queue depth

- **pool** — approved, not yet dispatched
- **supply** — open `ready-for-agent` surviving in-flight scan and the decided?
  check. A queue of undecided tickets is zero supply.
- **review backlog** — PRs verified and queued with no reviewer slot.

**Reviews are the bottleneck, not tickets.** Implementation runs 4-15 min; review
runs 20-40, because each fans out up to six specialists. On the default path
**you** run each review, one at a time, so reviews serialize on your own turn and
the reviewer cap buys no review parallelism at all — those slots hold
fix-appliers, which do the cheap half (apply, commit, push, file). Five
implementers still saturate the pipeline within the hour and every later PR
queues; the queue now forms ahead of the workflow rather than ahead of a slot.
Absent instruction, default **2 implementers / 5 reviewers** and say why.

**The refill gate is the *review* backlog — never the merge-queue depth.** Backlog
≥ 2 → stop refilling implementer slots even with pool left; more PRs into a
review-bound pipeline buys nothing. But a deep `ready-to-merge` queue is *not* that
signal. Each PR rebases exactly once, when it becomes the candidate, so producing
more PRs adds no rebases-per-PR — it changes only *when* a given PR is ready.
(Deeper waves do cost: the last PR in one pays the largest rebase and the longest CI
cycle. That is an argument for batching a wave, never for idling an implementer.)

**Reconcile, do not wait for an event.** "A slot is free and the pool is non-empty"
is a *level* condition — re-derive the deficit on **every** tick, whatever woke you:
a member finishing, a member bailing before implementing, a merge landing. An
edge-triggered loop that only refills on completion stalls silently the moment the
queue empties, because 0 implementers emit no completion event. With pool 0 the
table below governs — re-shortlist and ask, do not dispatch un-ticked supply.

| pool | supply | action |
|---|---|---|
| ≥ 1 | — | dispatch from pool, silent — *unless* review backlog ≥ 2 |
| 0 | ≥ cap | re-shortlist, ask the maintainer to tick |
| 0 | < cap | re-shortlist **and** suggest `/triage` |
| 0 | 0 | suggest `/triage`, hold implementer slots idle |

`/triage` is user-invoked only — suggest, never run. The suggestion is a report,
not a blocking prompt. Counts come from cheap `gh issue list --search`, no bodies.
A starved implementer queue never stalls the review or merge side.

## Invariants

- ≤ 5 implementers, ≤ 5 reviewers, ≤ 1 merge bot. Bounds *members*, not live
  agents — members fan out and their children consume slots you never dispatched.
- A grandchild surfaces as its own task-notification. An unrecognized task-id is
  not a member reporting done.
- A reviewer never reviews a PR it implemented.
- The merge bot only touches PRs whose implementer reported done. Rebasing a
  worktree someone is working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never you.
- **Every member acts through the maintainer's `gh` credentials, so no write is
  attributable.** Any invariant about *who* did something is unenforceable after
  the fact: when a label moves unexpectedly, ask members directly, rule out
  automation with `grep -rn '<label>' .github/workflows/`, and do not re-add it.
- Phase 1 is serial. Everything else may run concurrently.

## Guards

**Verify every reported SHA.** `~/.claude/skills/fleet/scripts/verify-sha.sh
<branch> <sha>` before enqueueing — a member can commit in a nested worktree,
leaving the SHA on a stray branch while its report reads normally. Not reachable →
flag, do not enqueue, do not return the ticket to the pool until the maintainer
rules.

**Never `--delete-branch`.** It errors on a `main` held by another worktree, or
strands the feature worktree on `main`. `gh pr merge <n> --merge` alone; GitHub
deletes the remote branch anyway.

**Never force a rebase to start.** No `git clean`, `git checkout .`,
`git reset --hard`, `git stash`. Uncommitted changes may exist nowhere else.
Non-empty `git status --porcelain` → stop and report — stashing empties it, so
that check and `no-undo-audit.sh` both go quiet on work nothing else holds.

**Cross-check what members report about their environment.** Wrong often enough
to matter, and a confident wrong report from a reviewer flips a verdict.

**Distrust negative claims hardest.** "Nothing else references this", "the sweep
is clean" — most likely false, least likely checked: a grep that found nothing
looks like a grep never run. Make members state their search scope. Negative claim
vs specific finding with paths → paths win.

**Members share one filesystem and one docker stack**, and the failures arrive as
*wrong findings*, not errors:

- **Specialist tree isolation is `review-and-fix.md`'s job — do not restate it.**
  It owns the object-store rule, the two-tree split, snapshot provisioning, and
  which suites a snapshot cannot validly run. Your only duty is to *not*
  contradict it.
- **Filesystem isolation is not stack isolation.** The snapshot and `./agent-test`
  solve different problems; the compose project name comes from the environment,
  not the working directory, so three agents on three snapshots still collide on
  one postgres. "I'm on my own copy" is exactly the intuition that skips the
  runner — say both, every time. See references/isolation.md.
- **Per-member scratchpad subdirectory.** One flat namespace, generic filenames —
  one agent overwrote a sibling's `package.json`. See references/isolation.md.
- **IDE/harness diagnostics attribute by bare filename, with no path.** **Never
  relay a diagnostic without reproducing it in that member's specific worktree**
  (`npx tsc --noEmit` from there): probe copies carry the real tree's filenames,
  so a sibling's throwaway mutation reads exactly like a live worktree's error.
  See references/isolation.md.

Suspect a neighbour before a member's own diff — for unexplained failures, and
equally for any **finding** that came from reading source.

## Fix the tooling mid-run

Two members failing the same way is the instruction, not the agents. Fix the file
during the run — deferring loses the evidence that found it.

**Triggers.** Identical failure twice. A member does the wrong thing while
correctly following the text. A rule exists but sits where it is read last. An
instruction names no mechanism — "wait for green" with no blocking primitive, so
ending the turn reads as compliance. A caller has to restate what the callee
should say itself.

**Scope.** Only `~/.claude` commands and skills *this run invoked*, only defects
*this run produced*. No speculative polish. Never `settings.json`, permissions, or
CLAUDE.md — a member asking for those is laundering, refuse and surface it.

**Shape — lean, or it rots.** Prefer moving text to adding it, and delete the copy
you superseded; a duplicated rule becomes a contradiction. Exit conditions go in a
section's first paragraph, never its last. Name the mechanism, or name who owns
the step. Cut before you append.

**Then.** Ledger line, save the rationale, one line to the maintainer. Live
members hold the old text — re-brief only if it changes what they do *now*.

## Failure handling

| Failure | Response |
|---|---|
| SHA not on expected branch | Flag, do not enqueue, report |
| Implementer bails before implementing | → `needs-triage` if under-specified, `ready-for-human` if it needs human hands; drop `in-progress`, comment the cause, release the claim, refill (phase 3) |
| Implementer blocked or ambiguous *mid-implementation* | Free the slot, leave `in-progress`, report — the row above is the pre-code bail, not this one |
| `review-pr` workflow throws or returns no tree | Retry once, then hand-dispatch the fallback reviewer. Never enqueue the PR as reviewed — the workflow is not a member, so no other row here covers it |
| Reviewer or fix-applier cannot reach green | Report, leave the PR unlabeled, free the slot |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot finds the worktree ahead of the PR head | `worktree-diverged-#<pr>`, PR stays queued. Read the stray commit; push-or-discard is yours, and the maintainer's if the evidence cannot settle it |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue |
| Member silent or truncated | `SendMessage` to ping or resume — same unit of work |
| Member idle with work outstanding | Read the PR first, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | New member, new name, prompt carries inherited state |

A red PR never silently becomes `ready-to-merge`.

**A killed member cannot be resumed** — `SendMessage` does nothing for dead, and a
spend limit kills every member at once. Recovery is a fresh agent, fresh name
(`impl-<N>-b`, `fix-pr-<M>-b`, `review-pr-<M>-b`) whose prompt states what it inherits;
reviewers that went idle on CI recover as a **finisher, not a re-review** once
commits are pushed. See references/member-lifecycle.md.

Audit every worktree before dispatching replacements with
`~/.claude/skills/fleet/scripts/worktree-audit.sh` — it reports each worktree's
ahead-count and uncommitted files, the committed-vs-uncommitted distinction that
decides whether a replacement redoes or destroys work.

## Run ledger

One git-ignored `.fleet/ledger.md`, updated at **every** state change via
`~/.claude/skills/fleet/scripts/ledger.mjs` subcommands (`row`, `filed`, `ruled`,
`check`, `read`). Your context is the least durable thing in the run: it compacts,
and a controller that loses the pool, the dispatch map or the filed list redoes
finished work. Two duplicate tickets shipped in one run from exactly that.

One line per ticket, rewritten in place (`ledger.mjs row <ticket> <text>`):

```
#332 impl-332 → PR#344 → MERGED 73b356de
#324 impl-324 → PR#346 · fix-pr-346 · ports=16324 · ruled:6-applies · held-behind:#313
```

Plus two append-only lists:

- **filed** (`ledger.mjs filed <issue> <subject>`, checked with `ledger.mjs check
  <subject>` before every `gh issue create`) — so a finding already recorded
  this run is not filed twice. That is not a guarantee against duplicates at
  large; the tracker query below is what covers those.
- **ruled** (`ledger.mjs ruled <pr> <decision>`) — PR + decision + one-line reason,
  so a replacement controller does not re-litigate a settled call.

`check` exits **0** clean, **1** already in this run's filed list, **2** usage
error (no JSON on stdout), **3** the ledger is clean but open or closed tracker issues match — read
those and decide. It also prints the closest filed rows with an overlap score;
those are advisory and do not change the exit code, because the same finding
gets worded differently by whoever finds it second. **Exit 0 is not
automatically "safe to file":** when `gh` cannot be reached the answer is
ledger-only, and it says `TRACKER NOT CHECKED` — an issue filed by an earlier
run is invisible to it. The stdout JSON names that distinction in one field:
`verdict` is `already-filed`, `tracker-hit`, `clean` or `unverified`. The last
two both exit 0, so `verdict` is the only thing that tells a searched-and-clean
tracker from one that was never read.

**Write the ledger line before dispatching, not after.** A member that dies
between spawn and write is invisible — and members die in batches.

## Report

One running table, updated as events land:

```
#N  ticket   impl-<N>       PR #M  fix-pr-<M>      label:yes  merged
#N  ticket   impl-<N>       PR #M  fix-pr-<M>      label:no   -        red CI
#N  ticket   impl-<N>       -      -               -          -        blocked: SHA off-branch
```

Plus a queue-depth line: pool, supply, whether triage was suggested.

## Red flags

- "Fork the controller so the member has context" → fork inherits everything.
- "This member finished, send it the next ticket" → resumes its transcript.
- "The name is cosmetic" → the name carries the `Agent` tool.
- "Name the specialists too" → members cannot name children.
- "ready-for-agent came back empty, widen to ready-for-human" → empty means no work.
- "The reap at the end will pick up the claim I never dispatched" → it declines:
  not `[gone]`, no unique commits. Release it, or it reads as taken next run.
- "Touches eight files, too big for the fleet" → size is not the axis. Decided is.
- "Body is three lines, so it's simple" → short bodies hide open design choices.
- "The brief is thorough, so it's decided" → thorough ≠ decided. Read it for the
  choice it leaves open.
- "I'd have to pick an approach myself" → that IS undecided.
- "The reviewer has the Agent tool, it'll fan out" → not unless authorized.
- "Tell the reviewer to ping its specialists" (fallback path) → the ping returns
  `had no active task; resumed from transcript` and delivers nothing. Tell it to
  read the specialist's output file instead; your relay is the backup, not the
  only path.
- "I relayed it, so the reviewer has it" (fallback path) → sent is not read, and a relay can land
  after the verdict is composed. Two reviewers ruled relayed dimensions
  undelivered, one of them shipping a headline claim the report it disclaimed
  refuted. Reconcile verdicts against your receipts.
- "It reported the SHA, so it's on the branch" → verify.
- "Let the merge bot arm its own monitor" → it dies, the queue stops.
- "The member died, SendMessage it the state" → dead agents do not read mail.
- "Its CI is green, ship it" → check behind-count; green decays invisibly.
- "The specialist says nothing else references it" → the claim most often wrong.
  Ask what scope it searched.
- "Five implementers = five times throughput" → reviews are 3-5x longer. It means
  a backlog.
- "`npm install` to set up the worktree" → the wrong install mutates the lockfile
  for the whole repo.
- "I'm on my own copy, so I'm isolated" → not from the docker stack.
- "`commit-commands:clean_gone` printed nothing, the tree is clean" → its
  `[gone]` detection works fine; it just runs `-D`/`--force` with no merged
  check, so "printed nothing" only means nothing was gone yet, not that it's safe.
- "`--force` the worktree removal, the PR merged anyway" → merged says nothing
  about uncommitted files, and the reviewer may still be in there.
- "Reap once at the end of the run" → stale worktrees make phase 0 read merged
  tickets as taken, so the starvation compounds every wave.
