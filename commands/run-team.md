---
description: run an agent fleet — up to 5 implementers, up to 5 reviewers, one merge bot — over the ready-for-agent queue
argument-hint: [implementers] [reviewers]
---

Run `next-ticket`, `review-and-fix`, `run-merge-bot` as one fleet. You are the
**controller**, in the main thread, never a member.

`$ARGUMENTS` = `[implementers] [reviewers]`, both optional, default 5, cap 5.
Merge bot is at most one, not configurable.

Rationale: `~/.claude/docs/specs/2026-07-22-run-team-agent-fleet-design.md`.

## Two rules that fail silently

**Name every member.** The name makes it a team member, and membership is what
carries the `Agent` tool. Omit it → member loses delegation with no error and
improvises something worse. `subagent_type` is irrelevant. Names follow the unit
of work: `impl-<issue#>`, `review-pr-<pr#>`, `merge-bot-<wave#>`.

**Inverts one level down: members must name their children `undefined`.** A named
member passing a `name` fails with `teammates cannot spawn teammates`, so
specialists are dispatched **unnamed**. Say so in the reviewer prompt — otherwise
it hits the error, concludes fan-out is unavailable, and silently downgrades to a
solo review.

**Fresh context per member.** One agent, one unit of work, gone. Never
`subagent_type: "fork"` (inherits your whole conversation). Never re-task a
finished agent — `SendMessage` resumes its transcript and drags the old ticket
in. Refill = **new** agent, **new** name. `SendMessage` is still right for
pinging a member for a report it owes, or resuming a truncated reply.

## Phase 0 — shortlist

At start, and whenever the pool empties.

1. Candidate scan, `next-ticket` step 1. **`--label ready-for-agent` mandatory, no
   fallback.** `next-ticket` retries against `ready-for-human` when empty; you
   must not. Empty means no work — `ready-for-human` needs a human to brainstorm
   first and you have no channel to one mid-flight.
2. Dependency scan, step 2, on the `d` array. Open blocker → drop.
3. In-flight check, step 3, all three probes: `gh pr list --state all --search
   "<N>"`, `git ls-remote --heads origin`, `git worktree list` + `git branch -vv`.
   Any hit = taken.
4. Size each survivor with `sizing-a-ticket`. It reads `gh issue view <N>
   --comments`, so record the Agent Brief's `Out of scope` sequencing while there.
5. **Light row only.** Heavy is inadmissible even with a complete brief — the
   fleet runs unattended and the heavy path opens with brainstorming, which needs
   the maintainer. Excluding is this command's policy; the skill only reports.
6. **Collision scan against open PRs.** Step 3 catches a ticket already taken, not
   one that *edits a file an open PR edits*. Diff each survivor's likely file set
   against every open PR (`gh pr diff <M> --name-only`) and against the other
   survivors. Overlap → admit one, defer the rest with the reason. The tracker
   cannot express this: no `depends on #N`, no brief entry, invisible to every
   probe — and it is what actually stalls a wave.
7. Present admissible survivors, best first, as a multi-select. Maintainer ticks
   the pool. List heavy-row exclusions as "needs a solo session with you", and
   collision-deferred ones with what they collide with. Excluded, not dropped.

Never put two sequenced tickets in one wave. That lives in the brief's `Out of
scope`, is invisible to step 2, and bites hardest at five wide.

## Phase 1 — claim and isolate

Serial, main checkout, per ticket. Never parallel, never inside a member —
concurrent `worktree add` and label writes race.

```bash
gh issue edit <N> --add-label in-progress
git worktree add .worktrees/<N>-slug -b <type>/<N>-slug origin/main
(cd .worktrees/<N>-slug && <install>)
```

Infer branch/worktree convention from `git worktree list` and `git branch -r`.

**Infer `<install>` too — never default to `npm install`.** A lockfile-mutating
install in a throwaway worktree corrupts it for everyone: npm@11 prunes
cross-platform `@esbuild` optional deps and breaks CI and the Docker build. Use
the frozen form (`npm ci`, `pnpm i --frozen-lockfile`, `yarn --immutable`), then
confirm once:

```bash
git -C .worktrees/<N>-slug status --porcelain package-lock.json   # must be empty
```

Non-empty → wrong command. Fix before creating the rest.

**Materialize the isolation envelope as a file, not a briefing.** Env vars in a
prompt were missed five times in one run — including by a briefed member, and by
a specialist whose parent was briefed but did not pass them down.

```bash
cat > .worktrees/<N>-slug/agent-test <<SH
#!/bin/sh
export TEST_COMPOSE_PROJECT=ab-<N> TEST_POSTGRES_PORT=\$((16000+<N>)) TEST_OLLAMA_PORT=\$((22000+<N>))
exec <isolated-test-cmd> "\$@"
SH
chmod +x .worktrees/<N>-slug/agent-test
```

Brief members with `./agent-test <file>` and nothing else. Anyone who finds the
worktree finds the runner — including grandchildren you never dispatched.
`.git/info/exclude` it so it never reaches a diff. Ports derive from `<N>`, so
collisions are impossible rather than discouraged — the difference between a
safeguard and a rule.

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
tests, push, `gh pr create` with `Closes #N` and one release label), report PR
number and head SHA, exit. Never labels `ready-to-merge`, never merges.

## Phase 3 — event loop

React to events; never block on one.

**React to artifacts, not agents.** Liveness says nothing: `idle` means "not
currently executing", not "done"; a finished member's finding may never arrive,
since a grandchild's report routes to *you* and a completed agent's final text is
a return value lost if unconsumed. In one run every member that looked dead had
its work in git or on the PR — pushed commits, a self-removed label, an applied
ruling. Read `gh pr view`, `gh run view`, `git -C <worktree> status` **before**
messaging. One command settles what a round-trip usually does not, and a member
that ignored one ping tends to ignore a second. When you message, send the
specific next action, never "what is your status".

**Do not ask permission to run the loop.** Dispatching a reviewer, spawning a
merge bot, refilling a slot, re-verifying a SHA, filing a follow-up — all proceed
unconfirmed. Invoking the command was the opt-in. Two exceptions: **Phase 0's
multi-select**, and **a judgement the evidence cannot settle**. Asking beyond that
costs a round-trip per event in a loop designed to have many.

- **Implementer completes** → verify the SHA is reachable on the expected branch →
  enqueue for review → refill the slot (phase 1, then 2) with a new agent.
- **Review slot free, PR queued** → dispatch a reviewer.
- **Reviewer labels a PR** → merge-bot wave.
- **Monitor: `ready-to-merge` appears** → merge-bot wave. Catches hand-added labels.
- **Merge-bot wave reports done** → reap merged branches and worktrees (below).
- **Monitor: CI run completes** → ping the one member waiting on it, with the outcome.
- **Pool empty** → phase 0 again, subject to queue depth.

**Own the CI waits.** Members are turn-based and cannot hold across a ten-minute
run — they rebase, push, stop. One went idle three times in two minutes doing
this, and every re-ping told me nothing I could not read. Arm a second persistent
Monitor over open PRs' latest runs, keyed `<run-id>:<conclusion>` so each terminal
state fires once, and emit the behind-count with it: a `success` on a branch 8
behind is not actionable, and that distinction is most of the traffic.

Take run id, head and conclusion from **one** `gh run list --json` row. A watcher
that reads them separately stitches an event from two moments and can stream
`RUN COMPLETE: success` under a run id whose real job list is a failure. Tell
members a monitor event is a wake-up, never a verdict — they re-query
`gh run view <rid> --json jobs` at labelling time.

**A conclusion is not stable, even for a fixed run id on an unchanged head.** A
rerun rewrites the existing run in place rather than creating a new one, so a run
you read as `success` can later read `failure` with nothing pushed. Observed twice
in one run: a refresh workflow re-ran the currency check after `main` advanced and
flipped the same id on the same SHA. Consequence: **never cache a conclusion.**
Re-query at the moment of decision, and key any watcher on `<run-id>:<conclusion>`
rather than run id alone, or the second state never fires.

Also: the newest run on a branch is frequently *not* the CI workflow — a label or
policy workflow often lands later. `--limit 1` can hide the CI result entirely.

### Reviewers

One named member per PR, never its implementer. Give the PR number and tell it to
read `~/.claude/commands/review-and-fix.md` — the file path, not a slash
invocation; command availability inside a member is not guaranteed the way skill
availability is.

**Authorize the fan-out explicitly.** Members inherit the standing *"Do not call
the AgentTool unless the user requested it."* A reviewer will otherwise decline to
dispatch specialists — correctly — and you get a thinner solo review with no error
and no signal. State that the full specialist set IS the requested work.

**Name the source when relaying a finding, and send its *text*.** Specialist
reports surface to *you*; grandchildren are unaddressable. Ruling on one as "your
finding" makes the reviewer verify a report it never sent or act on one it cannot
check. Tell reviewers to ping each specialist rather than assume delivery. Do not
hold rulings pending confirmation — that stalls the queue for a guarantee the
reviewer's own verify-before-apply already provides.

**Scale the fan-out to the diff, not to the word "review".** Six specialists on an
8-line docs-banner PR costs the same wall clock as six on a vault refactor, and the
queue pays it. Say the number in the prompt: two or three for annotation-only or
single-file changes, the full set for production code. Absent a number, members
default to the full set every time.

**Put the standing CI facts in the prompt, not in per-event messages.** Otherwise
you send the same "your red is staleness, do not rebase" message once per reviewer
per merge — four times in one run here. The reviewer prompt should already carry:
`skipped` means the job did **not** execute ("not verified", never "nearly green");
a red currency check is not grounds to withhold a label and not something to rebase
for; and if labelling under those conditions, say the label rests on the checks that
*did* run rather than calling it "CI green".

**For correction tickets, make "re-verify the correction" an explicit step.** Any
ticket whose deliverable is *fixing a wrong claim* — stale docs, wrong comments,
bad citations — is unusually likely to ship a new wrong claim in the fix. Four for
four in one run: a misattributed package, a three-item list at inverted polarity
(two items were the *negations* of the claims being marked stale), a commit body
citing a line that held something else, and a banner refuting a currently-true
fact whose own supporting sentence confirmed it. Reviewers do not hunt this
unprompted, because the diff "obviously" improves accuracy. Tell them to read every
corrected sentence literally and ask whether each clause is true under that reading.

### Merge bot

Per wave, named `merge-bot-<wave#>`, never two at once. Tell it to read
`~/.claude/commands/run-merge-bot.md` and run **one** pass, then exit.

**You own the watcher, not the bot.** `run-merge-bot.md` ends by arming a
persistent Monitor; tell the member to skip it. A dying member takes the watcher
with it and the queue stops silently. Arm one yourself, `persistent: true`, seeded
before the loop so handled PRs do not re-fire.

**Every merge invalidates every other open PR, silently.** `rebase-check` fails
fast when behind and gates the slow jobs, so the rest show *stale green* until
something re-triggers, then flip to `rebase-check: FAILURE` with
`integration`/`mutation` **skipped**. `rebase-check` can itself be stale-**green**.
Behind-count is the only honest signal.

**One rebase per PR, at merge time.** Reviewers label on their own green without
requiring currency (see `review-and-fix.md`); the bot establishes currency once,
when the PR is the merge candidate. Requiring it earlier costs a full CI cycle per
sibling merge — six wasted cycles in one run. At 6+ open PRs batch a wave rather
than merging singles. Any behind-count you hand a bot is expired on arrival; say so.

`run-merge-bot.md` carries the mechanics — intra-wave re-checks, run-binding, the
ancestry proof, post-rebase red triage. Do not restate them here.

### Reap after every wave

A merge deletes the remote branch and leaves the local branch `[gone]` with its
worktree — and its `node_modules` — still on disk. Reap after **each** wave, not
once at the end. A stale worktree still answers `git worktree list`, so phase 0's
in-flight probe reads an already-merged ticket as taken and the queue quietly
shrinks as the run goes on.

**Do not invoke `/clean_gone`.** Two independent disqualifiers:

- Its detection greps `git branch -v` for `\[gone\]`. `-v` prints no tracking
  info at all, and `-vv` renders `[origin/<branch>: gone]`, so the pattern never
  matches. It prints nothing and exits 0 — identical to a clean tree. Silent.
- It removes worktrees with `git worktree remove --force`. Fatal here: members
  hold worktrees, and `--force` discards uncommitted work that exists nowhere
  else. Same class as `git reset --hard` to start a rebase.

The skill is the maintainer's to fix. Do not patch it; do the reap yourself.

Recompute every precondition **inside** the same command as the delete:

```bash
git fetch --prune origin
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads |
awk '$2=="[gone]"{print $1}' | while read -r b; do
  wt=$(git worktree list --porcelain |
       awk -v b="refs/heads/$b" '/^worktree /{w=$2} /^branch /&&$2==b{print w}')
  git cherry origin/main "$b" | grep -q '^+' && { echo "KEEP $b — unmerged commits"; continue; }
  if [ -n "$wt" ]; then
    [ -n "$(git -C "$wt" status --porcelain)" ] && { echo "KEEP $b — dirty $wt"; continue; }
    git worktree remove "$wt" || { echo "KEEP $b — remove refused"; continue; }
  fi
  git branch -D "$b" && echo "REAPED $b"
done
git worktree prune
```

Each line earns its place:

- **`for-each-ref`, not `git branch | grep`.** `%(upstream:track)` emits exactly
  `[gone]` as its own field. Nothing to pattern-match, no `-v`/`-vv` trap.
- **Recompute per branch, in this command.** A branch list from an earlier tool
  call is already false: one observed run listed 28 gone branches, and two calls
  later 27 had been reaped by a concurrent session. The benign direction is a
  no-op; the dangerous one is a worktree that gained work *after* the check.
- **`git cherry origin/main`, not `git diff main..`.** Against `origin/main` —
  a local `main` you never fast-forwarded reads every merged branch as unmerged.
  Any `+` line is a commit that exists nowhere else.
- **`-D` is authorized by that cherry check, and only by it.** `git branch -d`
  would refuse everything here: upstream is gone, so it falls back to comparing
  against `HEAD`, which is a possibly-behind local `main`. Never `-D` a branch
  whose cherry output you did not just read.
- **`worktree remove` without `--force`.** It refuses on modifications *and*
  untracked files, so it double-covers the dirty check above. A refusal is a
  finding to report, never something to force past.
- **Never reap a branch a live member is on.** Cross-check `.fleet/ledger.md`
  before running: a row without a terminal state means someone may still be in
  that worktree — a merged PR can still have a reviewer filing follow-ups. The
  dirty check does not see a member that committed but has not pushed.

Update the reaped tickets' ledger rows in the same step, and report reaped and
kept counts. Kept-with-reason is the half worth reading.

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

| pool | supply | action |
|---|---|---|
| ≥ 1 | — | dispatch from pool, silent |
| 0 | ≥ cap | re-shortlist, ask the maintainer to tick |
| 0 | < cap | re-shortlist **and** suggest `/triage` |
| 0 | 0 | suggest `/triage`, hold implementer slots idle |

`/triage` is user-invoked only — suggest, never run. The suggestion is a report,
not a blocking prompt:

> ready-for-agent down to 2 workable. 14 in needs-triage, 3 in needs-info. Run
> `/triage`?

Counts come from cheap `gh issue list --search`, no bodies. A starved implementer
queue never stalls the review or merge side.

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
  attributable.** Labels, comments, merges all show the maintainer, agent and
  human alike. Any invariant about *who* did something is unenforceable and
  unauditable after the fact. When a label moves unexpectedly the trail cannot
  answer it: ask members directly, rule out automation with
  `grep -rn '<label>' .github/workflows/`, and do not re-add it to "fix" it.
- Phase 1 is serial. Everything else may run concurrently.

## Guards

**Verify every reported SHA.** A member can create a nested worktree and commit
there, leaving the SHA on a stray branch while its report reads normally. Check
`git log --oneline origin/<branch>` before enqueueing. Not reachable → flag, do
not enqueue, do not return the ticket to the pool until the maintainer rules.

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

- **Ground truth is the git object store, not any working tree.**
  `git -C <repo> show <sha>:<path>` cannot be contaminated by any agent, needs no
  copy, and touches nothing. Make it the default for settling *what the PR
  contains*; the trees below are only for specialists that must **run** something.
- **Specialists never touch the worktree, reading or writing** — and **one
  snapshot is not enough.** Mutation probing is a *write*, so a mutating
  specialist and read-only specialists cannot share a tree: the readers then
  observe the mutant exactly as if it were the real code. Two trees:
  - `snap-ro` — pristine, **never written**, all read-only specialists.
  - one private copy **per mutating specialist**.

  Observed with a single shared snapshot: three specialists read two *different*
  in-flight mutations, one seeing the PR's own bug as still present; two reviewers
  came one step from filing a false finding. **And the obvious detection does not
  work** — `diff -rq` and `md5` both came back *clean* because the probe was
  reverted between the two reads. A clean diff against a live tree is not evidence
  in either direction. Only `snap-ro` and the object store settle it.
- **`git archive` carries tracked files only** — no `node_modules`, no test runner,
  no gitignored config. Provision the tree in the same breath or specialists
  silently have no runnable suite and quietly reason from source instead of
  measuring. Symlink `node_modules` from the worktree and copy in whatever the
  runner needs.
- **Some suites cannot be validly run from a snapshot at all.** If anything derives
  identity from the checkout — agent-brain's `derive_workspace_id` shells out to
  `git rev-parse`, and a `git archive` copy is not a git repo — it falls back to
  the directory basename and the suite fails on the *name*. Naming the directory
  after the repo makes it pass **by coincidence, not correctness**. Run those
  suites in a real worktree or not at all; a green from a snapshot is an artifact.
- **Filesystem isolation is not stack isolation.** The snapshot and `./agent-test`
  solve different problems, and conflating them is how the second gets skipped:
  the compose project name comes from the environment, not the working directory,
  so three agents on three snapshots still collide on one postgres. Symlinking
  `node_modules` does not help. "I'm on my own copy" is exactly the intuition that
  skips the runner — say both, every time.
- **Per-member scratchpad subdirectory.** One flat namespace, generic filenames
  (`b.min.js`, `probe.mjs`) — one agent overwrote a sibling's `package.json`.
- **IDE/harness diagnostics attribute by bare filename, with no path.** Probe
  copies carry the same filenames as the real tree, so a specialist's throwaway
  mutation surfaces as errors that read exactly like a live worktree's — and the
  line numbers can plausibly line up with real in-flight edits. **Never relay a
  diagnostic without reproducing it in that member's specific worktree**
  (`npx tsc --noEmit` from there). Ran twice in one session: clean the first time
  (a sibling's probe), genuinely broken the second. Telling an implementer to chase
  a phantom in a file it is mid-rewrite on is the expensive failure.

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
| Member idle with work outstanding | Read the PR first, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | New member, new name, prompt carries inherited state |

A red PR never silently becomes `ready-to-merge`.

**Reviewers go idle waiting on CI and will not resume alone** — rebased, pushed,
stopped with the run `in_progress`. Three of five in one run. Recovery is a
**finisher, not a re-review**, whenever the commits are already pushed.

**A killed member cannot be resumed — the row most often got wrong.**
`SendMessage` works on idle or truncated; it does nothing for dead, and a spend
limit kills every member at once, so the temptation to re-task peaks exactly when
it cannot work. Recovery is a fresh agent, fresh name (`impl-<N>-b`,
`review-pr-<M>-b`), whose prompt states what it inherits:

- committed-and-pushed vs committed-only vs **uncommitted in the worktree**
- that uncommitted work exists nowhere else — no `git clean`, `git checkout .`,
  `git reset --hard`, `git stash drop`
- for a half-finished review: which specialists already reported, so it does not
  re-run a 40-minute fan-out

Audit every worktree before dispatching replacements:

```bash
for w in .worktrees/*/; do
  echo "$w  $(git -C "$w" log --oneline origin/main..HEAD | wc -l) commits"
  git -C "$w" status --porcelain
done
```

## Run ledger

One git-ignored `.fleet/ledger.md`, updated at **every** state change. Your
context is the least durable thing in the run: it compacts, and a controller that
loses the pool, the dispatch map or the filed list redoes finished work. Two
duplicate tickets shipped in one run from exactly that.

One line per ticket, rewritten in place:

```
#332 impl-332 → PR#344 → MERGED 73b356de
#324 impl-324 → PR#346 · review-pr-346-b · ports=16324 · ruled:6-applies · held-behind:#313
```

Plus two append-only lists:

- **filed** — issue number + subject, checked before every `gh issue create`, so
  no finding is filed twice.
- **ruled** — PR + decision + one-line reason, so a replacement controller does
  not re-litigate a settled call. Reasons matter: a ruling outlives the condition
  that justified it.

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
- "`/clean_gone` printed nothing, the tree is clean" → its grep cannot match; a
  silent pass is its failure mode, not its success case.
- "`--force` the worktree removal, the PR merged anyway" → merged says nothing
  about uncommitted files, and the reviewer may still be in there.
- "Reap once at the end of the run" → stale worktrees make phase 0 read merged
  tickets as taken, so the starvation compounds every wave.
