---
description: run an agent fleet — up to 5 implementers, up to 5 reviewers, one merge bot — over the ready-for-agent queue
argument-hint: [implementers] [reviewers]
---

Run `next-ticket`, `review-and-fix`, and `run-merge-bot` as one fleet. You are the
**controller** and you stay in the main thread — you never become a fleet member.

`$ARGUMENTS` is `[implementers] [reviewers]`, both optional, both defaulting to 5
and capped at 5. The merge bot is always at most one and is not configurable.

Design rationale: `~/.claude/docs/specs/2026-07-22-run-team-agent-fleet-design.md`.

## Two rules that fail silently if you break them

**Spawn every fleet member with a `name`.** A name makes the agent a member of the
session's implicit team, and team membership is what carries the `Agent` tool.
Omit it and the member loses the ability to delegate with no error — the tool is
simply absent and it improvises something worse. `subagent_type` is irrelevant to
this. Names follow the unit of work: `impl-<issue#>`, `review-pr-<pr#>`,
`merge-bot-<wave#>`.

**The rule inverts one level down: members must name their children `undefined`.**
A named member passing a `name` to its own spawn fails with `teammates cannot
spawn teammates`. So a reviewer's specialists are dispatched **unnamed** — they
still run, they just are not team members. Say this in the reviewer prompt.
Without it the reviewer hits the error, concludes the fan-out is unavailable, and
silently downgrades to a solo review — the exact outcome "authorize the fan-out"
exists to prevent.

**Give every member a fresh context.** One agent, one unit of work, then gone.
Never `subagent_type: "fork"` — a fork inherits your entire conversation. Never
re-task a finished agent: `SendMessage` resumes it from its transcript and drags
the previous ticket into the next one. Refilling a slot means spawning a *new*
agent under a *new* name. `SendMessage` stays correct for pinging a member for a
report it owes, or resuming a reply truncated mid-task — that is the same unit of
work.

## Phase 0 — shortlist

Run at start, and again whenever the approved pool empties.

1. Candidate scan, `next-ticket` step 1. **`--label ready-for-agent` is mandatory
   and there is no fallback.** `next-ticket` drops the label and retries against
   `ready-for-human` when the query comes back empty; you must not. Empty means
   the fleet has no work — `ready-for-human` tickets need a human to brainstorm
   the design first, and you have no channel to that human mid-flight.
2. Dependency scan, `next-ticket` step 2, on the `d` array. Open blocker → drop.
3. In-flight check, `next-ticket` step 3, all three probes per candidate:
   `gh pr list --state all --search "<N>"`, `git ls-remote --heads origin`,
   `git worktree list` + `git branch -vv`. Any hit means taken.
4. Size each survivor with the `sizing-a-ticket` skill. It reads the issue with
   `gh issue view <N> --comments`, so record the Agent Brief's `Out of scope`
   sequencing constraints while you are there.
5. **Admit light-row only.** Heavy row is not admissible here even with a complete
   Agent Brief — the fleet runs unattended and the heavy path opens with
   brainstorming, which needs the maintainer. Excluding is this command's policy;
   the skill only reports the row.
6. **Collision scan against PRs still in review.** Step 3 catches a ticket already
   taken. It does not catch a ticket that *edits a file an open PR is editing*.
   For each survivor, diff its likely file set against every open PR's
   (`gh pr diff <M> --name-only`) and against the other survivors. Any overlap →
   admit at most one, defer the rest with the reason. This is the constraint the
   tracker cannot express: no `depends on #N`, no Agent Brief entry, invisible to
   every automated probe, and it is what actually stalls a wave.
7. Present the admissible survivors, best first, as a multi-select. The maintainer
   ticks the approved pool. List excluded heavy-row tickets separately as "needs a
   solo session with you" — excluded, not dropped. List collision-deferred ones
   with what they collide with.

Never put two sequenced tickets in the same wave. That constraint lives in the
Agent Brief's `Out of scope`, is invisible to step 2's `depends on #N` scan, and
bites hardest at five wide.

## Phase 1 — claim and isolate

Serial, in the main checkout, per approved ticket. Never parallel, never inside a
member — concurrent `worktree add` and label writes race.

```bash
gh issue edit <N> --add-label in-progress
git worktree add .worktrees/<N>-slug -b <type>/<N>-slug origin/main
(cd .worktrees/<N>-slug && <install>)
```

Infer the branch/worktree convention from `git worktree list` and `git branch -r`
rather than assuming; in agent-brain it is `feat|fix|refactor/<N>-slug` and
`.worktrees/<N>-slug`.

**Infer `<install>` too — do not default to `npm install`.** A lockfile-mutating
install in a throwaway worktree corrupts the lockfile for everyone: in agent-brain
`npm install` on npm@11 prunes cross-platform `@esbuild` optional deps and breaks
CI and the Docker build. Prefer the frozen-lockfile form (`npm ci`, `pnpm i
--frozen-lockfile`, `yarn --immutable`). After the first worktree, confirm:

```bash
git -C .worktrees/<N>-slug status --porcelain package-lock.json   # must be empty
```

Non-empty → wrong install command. Fix it before creating the rest.

**Materialize the isolation envelope as a file, not a briefing.** Env vars in a
prompt get forgotten — five times in one run, including by a member I had briefed
and by a specialist whose parent was briefed but did not pass them down. Write a
runner into the worktree instead:

```bash
cat > .worktrees/<N>-slug/agent-test <<SH
#!/bin/sh
export TEST_COMPOSE_PROJECT=ab-<N> TEST_POSTGRES_PORT=\$((16000+<N>)) TEST_OLLAMA_PORT=\$((22000+<N>))
exec <isolated-test-cmd> "\$@"
SH
chmod +x .worktrees/<N>-slug/agent-test
```

Brief every member with `./agent-test <file>` and nothing else. Anyone who finds
the worktree finds the runner, so the envelope stops depending on who read which
prompt — including grandchildren you never dispatched. `.gitignore` it or add it
to `.git/info/exclude` so it never reaches a diff.

Derive the ports from `<N>`. Colliding ports are then impossible rather than
merely discouraged, which is the difference between a safeguard and a rule.

## Phase 2 — dispatch implementers

One named member per approved ticket, up to the cap, in the background. Each
prompt carries the ticket number, the worktree absolute path, the branch, and
both of these verbatim:

> You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create
> another worktree. Verify with `git rev-parse --git-dir` and
> `git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.

> Read the issue with `gh issue view <N> --comments`. The `## Agent Brief` comment
> is authoritative over the issue body. Honor its `Respec` block — it may
> explicitly rule out hypotheses the body raises.

Tell the member to run `sizing-a-ticket` first and follow the path it returns —
selection and claiming are already done, so it starts there. A heavy row means
phase 0 mis-sized it: stop and report rather than implement it unattended. Then
`next-ticket` **step 7** (rebase onto `origin/main`, re-run tests, push,
`gh pr create` with `Closes #N` and exactly one release label), report its PR
number and head SHA, exit. It never adds `ready-to-merge` and never merges.

## Phase 3 — event loop

React to events; never block on one.

**React to artifacts, not to agents.** Liveness tells you nothing: `idle` means
"not currently executing", not "done"; a finished member's finding may never
arrive, because a grandchild's report routes to *you* and a completed agent's
final text is a return value that is gone if unconsumed. In one run every member
that looked dead had its work sitting in git or on the PR — pushed commits, a
self-removed label, an applied ruling. So read `gh pr view`, `gh run view`, and
`git -C <worktree> status` **before** messaging anyone. One command settles what a
round-trip usually does not, and a member that ignored one ping tends to ignore a
second. When you do message, send the specific next action, never "what is your
status".

**Do not ask permission to run the loop.** Dispatching a reviewer, spawning a
merge bot for a labelled PR, refilling a slot, re-verifying a SHA, filing a
follow-up — all proceed unconfirmed. Invoking the command was the opt-in.

Two exceptions, nothing else: **Phase 0's multi-select**, and **a judgement the
evidence cannot settle** (proceeding either way risks discarding work, or a
finding changes what the ticket *is*). Asking beyond that costs a round-trip per
event in a loop designed to have many.

- **Implementer completes** → verify the reported SHA is reachable on the expected
  branch → enqueue the PR for review → refill the slot from the approved pool
  (phase 1, then phase 2) with a **new** agent under a new name.
- **Review slot free and a PR queued** → dispatch a reviewer.
- **Reviewer completes having labeled the PR** → merge-bot wave.
- **Monitor fires** on `ready-to-merge` appearing → merge-bot wave. This catches
  labels you add by hand.
- **Approved pool empty** → phase 0 again, subject to queue depth below.

### Reviewers

One named member per PR, never the agent that implemented it. Hand it the PR
number and tell it to read `~/.claude/commands/review-and-fix.md` and follow it —
give the file path, not a slash invocation; command availability inside a member
is not guaranteed the way skill availability is.

**Authorize the fan-out explicitly.** Members inherit the session's standing
policy line *"Do not call the AgentTool unless the user requested it."* A reviewer
holding the `Agent` tool will otherwise decline to dispatch `review-pr`'s
specialists — correctly, since nothing authorized it — and you get a thinner solo
review with no error and no signal anything was skipped. State in the prompt that
running `/pr-review-toolkit:review-pr` with its full specialist set IS the
requested work.

**Name the source when you relay a finding.** A specialist's report surfaces to
*you*, not to the reviewer that dispatched it — grandchildren are unaddressable.
Ruling on it as "your finding" makes the reviewer either verify a report it never
sent or act on one it cannot check. Say which specialist said what.

**Completion is not delivery.** Specialists finish without their reports reaching
the reviewer that dispatched them — so a reviewer can be mid-apply on a ruling
summarising a report it has never seen. Send the finding *text*, not a reference
to it, and tell reviewers to ping each specialist rather than assume. Do not hold
rulings pending confirmation; that stalls the queue for a guarantee the reviewer's
own verify-before-apply already provides.

### Merge bot

Spawn per wave, named `merge-bot-<wave#>`, never two at once. Tell it to read
`~/.claude/commands/run-merge-bot.md` and run **one** pass — hold rule, no-undo
audit, rebase, wait green, re-check the label, merge — then exit.

**You own the watcher, not the bot.** `run-merge-bot.md` ends by arming a
persistent 60s Monitor; instruct the member to skip that. A dying member would
take the watcher with it and the queue would stop silently. Arm one Monitor
yourself, `persistent: true`, seeded before the loop so PRs already handled do not
re-fire.

**Every merge invalidates every other open PR, silently.** `rebase-check` fails
fast when behind and gates the slow jobs, so the rest of the queue shows a *stale
green* until something re-triggers, then flips to `rebase-check: FAILURE` with
`integration`/`mutation` **skipped**. Green does not decay visibly, and
`rebase-check` can itself be stale-**green**. Behind-count is the only honest
signal.

Controller consequences: at 6+ open PRs, batch a merge wave rather than merging
singles as they land — each merge costs a rebase pass across the whole set. Any
behind-count you hand a bot at dispatch is expired on arrival; say so.

`run-merge-bot.md` carries the mechanics — intra-wave re-checks, SHA-binding, the
post-merge ancestry proof. Do not restate them here.

## Queue depth

Track two numbers:

- **pool** — approved tickets not yet dispatched
- **supply** — open `ready-for-agent` issues surviving both the in-flight scan and
  light-row sizing. A queue full of heavy-row tickets is zero supply.

**Reviews are the bottleneck, not tickets.** An implementation runs 4-15 minutes;
a review runs 20-40, because each fans out 4-5 specialists. So 5 implementers
saturate 5 reviewers inside the first hour and every later PR queues. If the
maintainer does not specify, default to **2 implementers and 5 reviewers** rather
than 5/5, and say why. Track a third number:

- **review backlog** — PRs verified and queued with no reviewer slot.

Backlog ≥ 2 → stop refilling implementer slots even with pool remaining. More PRs
into a full review pipeline buys nothing and costs rebases (see merge bot).

Low-water mark is the implementer cap. On a freed slot:

| pool | supply | action |
|---|---|---|
| ≥ 1 | — | dispatch from pool, silent |
| 0 | ≥ cap | re-shortlist, ask the maintainer to tick |
| 0 | < cap | re-shortlist **and** suggest `/triage` |
| 0 | 0 | suggest `/triage`, hold implementer slots idle |

`/triage` is `disable-model-invocation: true` — user-invoked only — so suggest,
never run it. The suggestion is a report, not a blocking prompt:

> ready-for-agent down to 2 workable. 14 in needs-triage, 3 in needs-info. Run
> `/triage`?

Counts come from the same cheap `gh issue list --search` shape, no bodies. A
starved implementer queue never stalls the review or merge side.

## Invariants

- ≤ 5 implementers, ≤ 5 reviewers, ≤ 1 merge bot. These bound *fleet members*, not
  total live agents — members fan out, and their children consume harness slots
  you never dispatched.
- A grandchild surfaces to you as its own task-notification. An unrecognized
  task-id is not a fleet member reporting done.
- A reviewer never reviews a PR it implemented.
- The merge bot only touches PRs whose implementer has reported done. Rebasing a
  worktree someone is still working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never you.
- **Every member acts through the maintainer's `gh` credentials, so no write is
  attributable.** Label events, comments, merges — the API shows the maintainer
  for all of them, agent and human alike. Any invariant about *who* did something
  is unenforceable and unauditable after the fact. When a label moves unexpectedly,
  the trail cannot answer it: ask the members directly, and rule out repo
  automation with `grep -rn '<label>' .github/workflows/`. Do not re-add a label
  yourself to "fix" it.
- Phase 1 is serial. Everything else may run concurrently.

## Guards

**Verify every reported SHA.** A member can create its own nested worktree and
commit there, leaving the SHA on a stray branch while its report looks perfectly
normal. Check `git log --oneline origin/<branch>` before enqueueing for review.
Not reachable → flag it, do not enqueue, do not return the ticket to the pool
until the maintainer rules on it.

**Never `--delete-branch`.** `gh pr merge <n> --delete-branch` either errors on a
`main` held by another worktree or silently strands the feature worktree on
`main`. Merge with `gh pr merge <n> --merge` alone; GitHub deletes the remote
branch anyway.

**Never force a rebase to start.** No `git clean`, `git checkout .`, or
`git reset --hard`. A worktree's uncommitted changes may exist nowhere else.
Non-empty `git status --porcelain` → stop and report.

**Cross-check what members report about their own environment.** Wrong often
enough to matter, and a confident wrong report from a reviewer flips a verdict.

**Distrust negative claims hardest.** "Nothing else references this", "the sweep
is clean" — most likely false, least likely checked: a grep that found nothing
looks like a grep never run. Make members state their search scope. Negative claim
vs specific finding with paths → paths win.

**Members share one filesystem and one docker stack.** Concurrent processes on one
machine, and the failures arrive as *wrong findings*, not errors:

- Wrong test config tears down a shared container mid-run for everyone else. Hand
  members the isolated invocation (agent-brain:
  `npx vitest run -c vitest.ci.config.ts <file>` — the default config's
  `global-setup` removes the shared postgres container on exit).
- **Specialists never touch the worktree — reading or writing.** One immutable
  snapshot per review, `git archive HEAD | tar -x -C <dir>`, and every specialist
  works there. This is the single highest-value rule in the file: it kills
  mutation-probe cross-contamination, reviewer-edits-mid-review, and grandchild
  contention in one move, and it needs no cooperation between siblings because the
  snapshot cannot change under them. Cheaper than the incidents — one `tar` per
  review.
- **Per-member scratchpad subdirectory.** One flat namespace, generic filenames
  (`b.min.js`, `probe.mjs`) — one agent overwrote a sibling's working copy
  including its `package.json`.

Observed without the snapshot rule: three specialists read two *different*
in-flight mutations, one seeing the PR's own bug as still present; on another PR
three watched their file go clean → `M` under them mid-analysis. Reverting probes
does not help — it leaves the end state clean while leaving a window in which
every concurrent reader observes a lie, and serializing does not close it because
the readers are concurrent with the mutator, not with each other.

Suspect a neighbour before a member's own diff — for unexplained failures, and
equally for any **finding** that came from reading source.

## Failure handling

| Failure | Response |
|---|---|
| SHA not on expected branch | Flag, do not enqueue, report |
| Implementer blocked or ambiguous | Free the slot, leave `in-progress`, report |
| Reviewer cannot reach green | Report, leave the PR unlabeled, free the slot |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue |
| Member silent or truncated | `SendMessage` to ping or resume — same unit of work |
| Member idle with work outstanding | Check the PR yourself, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | Spawn a **new** member, new name, prompt carries the inherited state |

A red PR never silently becomes `ready-to-merge`.

**Reviewers go idle waiting on CI and will not resume alone** — rebased, pushed,
stopped with the run `in_progress`. Three of five in one run. See *react to
artifacts* above; the recovery is a finisher, not a re-review, whenever the
commits are already pushed.

**A killed member cannot be resumed — this is the row most likely to be got
wrong.** `SendMessage` works on a member that is idle or truncated; it does
nothing for one that died, and a spend limit kills every member at once, so the
temptation to re-task is at its strongest exactly when it cannot work. Recovery is
a fresh agent under a fresh name (`impl-<N>-b`, `review-pr-<M>-b`) whose prompt
states precisely what it inherits:

- what is committed and pushed vs committed-only vs **uncommitted in the worktree**
- that uncommitted work exists nowhere else and must not be discarded — no
  `git clean`, `git checkout .`, `git reset --hard`, `git stash drop`
- for a half-finished review: which specialists already reported, so it does not
  re-run a 40-minute fan-out

Before dispatching the replacements, audit every worktree and record the state:

```bash
for w in .worktrees/*/; do
  echo "$w  $(git -C "$w" log --oneline origin/main..HEAD | wc -l) commits"
  git -C "$w" status --porcelain
done
```

## Run ledger

Keep one git-ignored file — `.fleet/ledger.md` — and update it at **every** state
change. Your context is the least durable thing in the run: it compacts, and a
controller that loses the pool, the dispatch map or the filed list redoes work
that is already done. Two duplicate tickets shipped in one run from exactly that.

One line per ticket, rewritten in place:

```
#332 impl-332 → PR#344 → MERGED 73b356de
#324 impl-324 → PR#346 · review-pr-346-b · ports=16324 · ruled:6-applies · held-behind:#313
```

Plus two append-only lists:

- **filed** — issue number + one-line subject, so the same finding is never filed
  twice. Check it before every `gh issue create`.
- **ruled** — PR + the decision and its one-line reason, so a replacement
  controller does not re-litigate a call the evidence already settled.

**Write the ledger line before dispatching, not after.** A member that dies
between spawn and ledger write is invisible — and members do die in batches.

## Report

One running table, updated as events land:

```
#N  ticket   impl-<N>       PR #M  review-pr-<M>   label:yes  merged
#N  ticket   impl-<N>       PR #M  review-pr-<M>   label:no   -        red CI
#N  ticket   impl-<N>       -      -               -          -        blocked: SHA off-branch
```

Plus a queue-depth line: pool, supply, and whether triage was suggested.

## Red flags

- "I'll just fork the controller so the member has context" → fork inherits
  everything. Fresh context, always.
- "This member finished, I'll send it the next ticket" → that resumes its
  transcript. Spawn a new one.
- "The name is cosmetic" → the name is what carries the `Agent` tool.
- "ready-for-agent came back empty, I'll widen to ready-for-human" → no. Empty
  means no work.
- "The Agent Brief is thorough, this heavy ticket is fine" → both filters must
  pass. Brief quality does not promote a heavy row.
- "The reviewer has the Agent tool, it'll fan out" → not unless you authorize it.
- "Name the specialists too, for consistency" → members cannot name children.
  Grandchildren are unnamed or the spawn errors.
- "The member reported the SHA, so the commit is on the branch" → verify it.
- "I'll let the merge bot arm its own monitor" → it dies, the queue stops.
- "The member died, I'll SendMessage it the state" → dead agents do not read mail.
  New agent, new name.
- "Its CI is green, ship it" → check how far behind `origin/main` first. Green
  decays invisibly; only `rebase-check` tells you.
- "The specialist says nothing else references it" → a clean sweep is the claim
  most often wrong. Ask what scope it searched.
- "Five implementers means five times the throughput" → reviews are 3-5x longer.
  It means a review backlog.
- "`npm install` to set the worktree up" → infer the install command; the wrong
  one mutates the lockfile for the whole repo.
