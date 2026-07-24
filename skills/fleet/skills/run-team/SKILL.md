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

## Two rules that fail silently

**Name every member.** The name makes it a team member, and membership is what
carries the `Agent` tool. Omit it → the member loses delegation with no error.
Names follow the unit of work: `impl-<issue#>`, `review-pr-<pr#>`,
`merge-bot-<wave#>`. See references/member-lifecycle.md.

**Inverts one level down: members must name their children `undefined`.** A named
member passing a `name` fails with `teammates cannot spawn teammates`, so
specialists are dispatched **unnamed**. Say so in the reviewer prompt, or it
silently downgrades to a solo review. See references/member-lifecycle.md.

**Fresh context per member.** One agent, one unit of work, gone. Never
`subagent_type: "fork"` (inherits your whole conversation). Never re-task a
finished agent — `SendMessage` resumes its transcript and drags the old ticket in.
Refill = **new** agent, **new** name. `SendMessage` is still right for pinging a
member for a report it owes, or resuming a truncated reply.
See references/member-lifecycle.md.

## Phase 0 — shortlist

At start, and whenever the pool empties.

1. **Candidate scan** — `~/.claude/skills/fleet/scripts/candidates.mjs
   --require-label ready-for-agent`. **`--label ready-for-agent` mandatory, no
   fallback** — do NOT pass `--allow-fallback`. Empty means no work;
   `ready-for-human` needs a human to brainstorm first and you have no channel to
   one mid-flight.
2. Dependency scan, `next-ticket` step 2, on the `d` array. Open blocker → drop.
3. **In-flight check** — `~/.claude/skills/fleet/scripts/inflight.sh <N>` per
   candidate; any hit = taken. It runs all three probes (open/closed PRs, remote
   heads, local worktrees + branches) so a partial one cannot read as free.
4. Size each survivor with `sizing-a-ticket`. It reads `gh issue view <N>
   --comments`, so record the Agent Brief's `Out of scope` sequencing while there.
5. **Light row only.** Heavy is inadmissible even with a complete brief — the
   fleet runs unattended and the heavy path opens with brainstorming, which needs
   the maintainer. Excluding is this command's policy; the skill only reports.
6. **Collision scan against open PRs** — a survivor is an *un-implemented issue*
   with no diff, so infer its target files from the issue body (the paths it
   names) and compare them against each open PR's `gh pr diff <PR> --name-only`,
   and against the other survivors' inferred files. `pr-overlap.mjs` is **PR-vs-PR
   only** — it runs `gh pr diff` on *both* args and errors on an issue number, so
   use it the way the merge bot does (PR vs PR), never on a candidate issue here.
   Step 3 catches a ticket already taken, not one that *edits a file an open PR
   edits*. Overlap → admit one, defer the rest with the reason. The tracker cannot
   express this, and it is what actually stalls a wave.
7. Present admissible survivors, best first, as a multi-select. Maintainer ticks
   the pool. List heavy-row exclusions as "needs a solo session with you", and
   collision-deferred ones with what they collide with. Excluded, not dropped.

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

One named member per ticket, up to cap, background. Each prompt carries ticket
number, worktree abs path, branch, and both of these verbatim:

> You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create
> another worktree. Verify with `git rev-parse --git-dir` and
> `git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.

> Read the issue with `gh issue view <N> --comments`. The `## Agent Brief` comment
> is authoritative over the issue body. Honor its `Respec` block — it may
> explicitly rule out hypotheses the body raises.

Member runs `sizing-a-ticket` first and follows the path returned — selection and
claiming are done, so it starts there. Heavy row = phase 0 mis-sized it: stop and
report, do not implement unattended. Then `next-ticket` **step 7** (rebase, re-run
tests, push, `gh pr create` with `Closes #N` and one release label — `patch`/`minor`/`major`, the *label* not the branch *type*), report PR
number and head SHA, exit. Never labels `ready-to-merge`, never merges.

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
- **Implementer reports the row is heavy** (`sizing-a-ticket` returned heavy and the
  member bailed without implementing) → the ticket is mis-scoped for the unattended
  fleet, so take it out of the agent pool rather than leave it for the next scan:
  move it `ready-for-agent` → `ready-for-human` — `gh issue edit <N> --remove-label
  ready-for-agent --remove-label in-progress --add-label ready-for-human` — and
  comment the heavy reason (what is design-open, needs a brainstorm, or needs a
  re-scope) so the human has the context. Then discard the worktree and branch and
  refill the slot with a *different* ticket. Leaving it `ready-for-agent` guarantees
  a later Phase-0 scan re-grabs it for another claim-size-heavy-and-bail cycle; the
  relabel is the only thing that stops the loop.
- **Review slot free, PR queued** → dispatch a reviewer.
- **Reviewer labels a PR** → merge-bot wave.
- **Monitor: `ready-to-merge` appears** → merge-bot wave. Catches hand-added labels.
- **Merge-bot wave reports done** → reap merged branches and worktrees (below).
- **Monitor: CI run completes** → bind it (`ci-state.mjs --pr <N>`); the
  diff-validating `check` job green with no heavy job (the diff-validating suites,
  not the `rebase-check` currency gate) in `failure` → dispatch a finisher to
  label, a `check` **failure** → a fixer. A `check`-green board whose
  heavy jobs are merely `skipped` (behind-count staleness, the normal wave case)
  still labels — do NOT gate on `ci-state --quiet` exit 0, which a behind PR never
  reaches. Reviewers push-and-exit, so a member is rarely still waiting — ping one
  only if it genuinely is.
- **Pool empty** → phase 0 again, subject to queue depth.

**Own the CI waits.** Members are turn-based and cannot hold across a ten-minute
run — they rebase, push, stop. Arm a second persistent Monitor over open PRs'
latest runs, keyed `<run-id>:<conclusion>` so each terminal state fires once, and
emit the behind-count with it: a `success` on a branch 8 behind is not actionable.
See references/ci-and-staleness.md.

Read a run's true state with `~/.claude/skills/fleet/scripts/ci-state.mjs --pr
<N>` — it binds run id, head and conclusion from one row (branch derived from the
PR) and reports whether the green is genuine. A monitor event is a wake-up, never
a verdict; members re-query at labelling time. See references/ci-and-staleness.md.

**A conclusion is not stable, even for a fixed run id on an unchanged head.** A
rerun rewrites the run in place, so never cache a conclusion; key watchers on
`<run-id>:<conclusion>` and check `attempt` before trusting one. Also: the newest
run on a branch is frequently *not* CI, so `--limit 1` can hide the CI result
entirely. See references/ci-and-staleness.md.

### Reviewers

One named member per PR, never its implementer. Give the PR number and tell it to
read `~/.claude/skills/fleet/commands/review-and-fix.md` — the file path, not a slash
invocation; command availability inside a member is not guaranteed the way skill
availability is.

**Authorize the fan-out explicitly.** State that the full specialist set IS the
requested work — otherwise the reviewer inherits the standing "do not call the
AgentTool unless requested" and silently downgrades to a thinner solo review.
See references/member-lifecycle.md.

**Name the source when relaying a finding, and send its *text*.** Specialist
reports surface to *you*; grandchildren are unaddressable. Tell reviewers to ping
each specialist rather than assume delivery, and do not hold rulings pending
confirmation — the reviewer's own verify-before-apply already covers it.
See references/member-lifecycle.md.

**The fan-out scales itself to the diff.** `review-pr.js` sizes the PR with
`diff-stats.mjs` and drops dead dimensions — a docs-only change runs
correctness+comments, not the full five — and skips the adversarial pass on
`suggestion`s, which are deferred and never applied. So you need not compute a
count. Manual fallback (no workflow): two or three specialists for annotation-only
or single-file, the full set for production code.

**Put the standing CI facts in the reviewer prompt, not in per-event messages** —
otherwise you send "your red is staleness, do not rebase" once per reviewer per
merge. `review-and-fix.md` states them; the prompt only has to say they apply.

**The reviewer pushes and exits — it does not hold the CI wait.** You own the
persistent Monitor; a turn-based member re-reading `gh pr checks` each idle cycle
rebuilds a 100k-token context for nothing the Monitor lacks. Tell it: apply fixes,
push, report the SHA, stop. When the diff-validating `check` job is green **and no
heavy job is in `failure`** (the heavy diff-validating suites — not the
`rebase-check` currency gate; a `skipped` heavy job is behind-count staleness and
fine) dispatch a **finisher** — a fresh small agent that confirms deferrals filed
and adds `ready-to-merge`, not the reviewer resumed. Gate on the `check` job,
**not** on `ci-state --quiet` exit 0: a behind PR never reaches full green, so an
exit-0 gate strands it unlabelled. The finisher reads per-job state (`ci-state.mjs`
without `--quiet`, or its `jobs`), since `--quiet` drops `jobs`. Normal path, not
only kill-recovery. See references/ci-and-staleness.md.

**Correction tickets ship new wrong claims, and they inherit them from the
ticket.** Put the check on the **implementer**, not only the reviewer: every
factual claim it restates must have a settling command run against the tree first
— the issue body is a lead, never a citation. Tell reviewers to read each
corrected sentence literally, clause by clause. See references/correction-tickets.md.

### Merge bot

Per wave, named `merge-bot-<wave#>`, never two at once. Tell it to read
`~/.claude/skills/fleet/commands/run-merge-bot.md`, run **one** pass, then exit — and say that
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

## Queue depth

- **pool** — approved, not yet dispatched
- **supply** — open `ready-for-agent` surviving in-flight scan and light-row
  sizing. A queue of heavy tickets is zero supply.
- **review backlog** — PRs verified and queued with no reviewer slot.

**Reviews are the bottleneck, not tickets.** Implementation runs 4-15 min; review
runs 20-40, because each fans out 4-5 specialists. Five implementers saturate five
reviewers within the hour and every later PR queues. Absent instruction, default
**2 implementers / 5 reviewers** and say why. Backlog ≥ 2 → stop refilling
implementer slots even with pool left; more PRs into a full pipeline buys nothing
and costs rebases.

**The refill gate is the *review* backlog — never the merge-queue depth.** A deep
ready-to-merge queue is not a reason to stop implementing: the merge cascade is
serial and slow, but each PR rebases exactly once when it becomes the candidate, so
producing more PRs adds no rebases-per-PR and does not slow the cascade — it only
changes *when* a given PR is ready. Throttling implementers because "the pipeline is
merge-bound" is a mistake; hold refills **only** when the review backlog ≥ 2, and
never gate a refill on how many PRs are waiting to merge. Reconcile proactively:
treat "a slot is free and pool-or-supply exists" as a *level* condition to act on
**every** time it holds — a member finishing, a member sizing-heavy and bailing, a
merge landing — not an event to wait for. An edge-triggered loop that only refills
on completion silently stalls the moment the queue empties (0 implementers emit no
completion event), so re-derive the deficit on every tick. An idle implementer queue
with work available is a defect, not a throttle — the maintainer should never have
to ask you to refill.

| pool | supply | action |
|---|---|---|
| ≥ 1 | — | dispatch from pool, silent |
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
`git reset --hard`. Uncommitted changes may exist nowhere else. Non-empty
`git status --porcelain` → stop and report.

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
| Implementer blocked or ambiguous | Free the slot, leave `in-progress`, report |
| Reviewer cannot reach green | Report, leave the PR unlabeled, free the slot |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue |
| Member silent or truncated | `SendMessage` to ping or resume — same unit of work |
| Member idle with work outstanding | Read the PR first, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | New member, new name, prompt carries inherited state |

A red PR never silently becomes `ready-to-merge`.

**A killed member cannot be resumed** — `SendMessage` does nothing for dead, and a
spend limit kills every member at once. Recovery is a fresh agent, fresh name
(`impl-<N>-b`, `review-pr-<M>-b`) whose prompt states what it inherits;
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
#324 impl-324 → PR#346 · review-pr-346-b · ports=16324 · ruled:6-applies · held-behind:#313
```

Plus two append-only lists:

- **filed** (`ledger.mjs filed <issue> <subject>`, checked with `ledger.mjs check
  <subject>` before every `gh issue create`) — so no finding is filed twice.
- **ruled** (`ledger.mjs ruled <pr> <decision>`) — PR + decision + one-line reason,
  so a replacement controller does not re-litigate a settled call.

**Write the ledger line before dispatching, not after.** A member that dies
between spawn and write is invisible — and members die in batches.

## Report

One running table, updated as events land:

```
#N  ticket   impl-<N>       PR #M  review-pr-<M>   label:yes  merged
#N  ticket   impl-<N>       PR #M  review-pr-<M>   label:no   -        red CI
#N  ticket   impl-<N>       -      -               -          -        blocked: SHA off-branch
```

Plus a queue-depth line: pool, supply, whether triage was suggested.

## Red flags

- "Fork the controller so the member has context" → fork inherits everything.
- "This member finished, send it the next ticket" → resumes its transcript.
- "The name is cosmetic" → the name carries the `Agent` tool.
- "Name the specialists too" → members cannot name children.
- "ready-for-agent came back empty, widen to ready-for-human" → empty means no work.
- "The brief is thorough, this heavy ticket is fine" → brief quality never
  promotes a heavy row.
- "The reviewer has the Agent tool, it'll fan out" → not unless authorized.
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
