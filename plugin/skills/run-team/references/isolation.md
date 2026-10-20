# Isolation: filesystem vs stack

Why isolation envelope file not briefing, why private filesystem not private stack. Assertions these justify live in references/pull.md Claiming section and SKILL.md Failure handling section; evidence here.

## Materialize the isolation envelope as a file, not a briefing

Env vars in prompt missed five times in one run — including briefed member, and specialist whose parent briefed but did not pass down. So the runner is a file in the worktree. A claim writes `agent-test` into the fresh worktree it creates: an exec of the Recipe's Test entrypoint that exports one port triple derived from `<N>`, kept out of `git status` through the repository's exclude file. A repository that tracks its own `agent-test` keeps it byte-identical — the claim exports nothing into it, so its isolation is whatever that repository built, and any convenience beyond exec'ing the Test entrypoint is that runner's own to document. Brief members with `./agent-test` and nothing else: anyone who finds worktree finds runner — including grandchildren you never dispatched. Its arguments land after the Test entrypoint, so what one may name — a test file, a test name — is that entrypoint's to say, and nothing in the runner refuses one that selects no test: a run of zero tests is a failed run, not a pass. That triple makes collisions impossible, not discouraged — difference between safeguard and rule.

The runner a claim writes is written once and never rewritten — a claim refuses a worktree that already exists — so every copy under `.worktrees/` is frozen at whenever that worktree was claimed; reading or measuring one measures that build, not what the current emitter produces. Line 2 is what tells a reader which build they are holding: `# agent-test template: <cksum>`. Reproduce the number from the installed script (`cksum $(~/.fleet/bin/fleet-run --path claim-ticket.sh)`) or from any revision of it (`git show <rev>:plugin/scripts/claim-ticket.sh | cksum`) and compare the first field — `cksum` also prints a byte count, and the path when it is given a file. It checksums the whole emitting script, not the runner template inside it, so it over-reports: a mismatch means only that `claim-ticket.sh`'s bytes differ from the ones you checksummed — a reworded die message or an edited comment moves it while the runner it produces stays byte-identical — not "the template changed", and not "older" either, because `cksum` carries no order: over `claim-ticket.sh`'s own history both the checksum and the byte count fall as well as rise. It under-reports too, so a match is not the freshness proof it looks like. The stamp covers `claim-ticket.sh` and nothing else, while the command the runner `exec`s is the Recipe cache's Test entrypoint, which it does not cover: two claims under one stamp exec different commands once the Recipe is re-derived between them. So read a match as "this runner came from these bytes of `claim-ticket.sh`"; only a fresh claim writes the current runner. Nothing reads the stamp and nothing refuses on a mismatch; it makes staleness legible to a human, it gates nothing.

## A worktree no claim built: the runner, and the commit

**A reused worktree may lack the runner.** `claim-ticket.sh` writes
`agent-test` only into the fresh worktree it claims, so a tree no claim
built — an already-open PR's worktree you sent a rebaser/resolver into,
a `git archive` snapshot, a `cp -R` subset — has no `./agent-test`
unless the repository tracks its own, and a member told to run one
stalls on a missing script (observed with a rebase-resolver in a
prior-run worktree). There, tell the member the runner is absent and to
run the Recipe's Test entrypoint directly
(`~/.fleet/bin/fleet-run derive-testcmd.sh <main checkout> test --at origin/main` prints
it).

**A reused worktree may also be on the wrong COMMIT.** `git worktree add <path>
<branch>` checks out the existing LOCAL branch and never consults the remote, so
a branch a previous run left behind wins over the rebased `origin/` ref that is
actually the PR. Measured in a scratch repo (git 2.50.1): with the branch rebased
on the remote and a stale local ref standing, `git worktree add <path> <branch>`
checked out the stale commit and printed `HEAD is now at <stale-sha> <subject>` —
the same subject the PR head carries, because a rebase preserves it. Neither
commit was an ancestor of the other, so *behind* is the wrong model; it is a
fork. Every other signal reads normal too: `git worktree list` shows the worktree
present on the expected branch, and the tree is clean. `claim-ticket.sh` never
touches this path — it claims only fresh tickets, and builds those from
`origin/main`.

**The two reuse failures are not symmetric.** A missing runner fails LOUDLY: the
member stalls on a script that is not there. A stale base fails SILENTLY and
produces confident wrong output — a review cut its immutable snapshot at the
stale commit and a fix-applier was dispatched into it, halted only before a push
that would have been a non-fast-forward.

So, when you re-create a worktree for an already-open PR:

- **Create it detached from the remote ref**, never from the bare branch name:
  `git worktree add --detach <path> origin/<branch>`. Same scratch repo, same
  moment: this landed on the remote's commit. It removes the mechanism rather
  than catching it, and leaves no local ref for the next run to inherit.
- **Then verify against the branch REF, and refuse on mismatch.** Compare
  `git -C <path> rev-parse HEAD` against
  `git ls-remote origin refs/heads/<branch> | cut -f1` — the ref itself, which
  is what the PR's head actually is, and **never `git rev-parse
  origin/<branch>`**, which is the ref the worktree was just cut from and so
  agrees with it by construction. Unequal → dispatch nothing into that
  worktree, and report it naming BOTH commits, since their subjects will not
  tell them apart. **An empty read is neither equal nor a mismatch**: the read
  failed, or that head branch is not on `origin` at all (a fork PR, where the
  creation form above cannot work either), so report the ref as unreadable
  rather than the worktree as wrong — the same hole `[ -n "$pre" ]` closes on
  the way into `run-merge-bot.md`'s step-1 poll.
- **Read `gh pr view <N> --json headRefOid -q .headRefOid` here too, and
  record it — it is NOT the gate.** A `headRefOid` that disagrees with the ref
  is the PR-object desync `run-merge-bot.md`'s step 1 says needs a controller,
  so it is a fact to carry into that decision, never the operand this refusal
  turns on.

**Why the ref and not `headRefOid`: during the PR object's lag both operands go
stale in the SAME direction, so that compare fails OPEN as readily as it fails
closed.** The PR object spends the lag sitting on the PRE-rebase sha — cleared
on re-poll attempt 24 (~2 min) in one merge pass and attempt 14 (~84s) in the next,
both after `gh pr update-branch --rebase` returned `rc=0`, measured in
`run-merge-bot.md`'s step 1 — and that is the very commit a clone which has not
fetched since the rebase still has `origin/<branch>` pointing at. So the false
REFUSAL (worktree current, PR object behind) is only half of it: cut the
worktree from the stale remote-tracking ref and both sides read the superseded
sha, the check reads EQUAL, and the dispatch lands on exactly the commit this
paragraph exists to catch. Measured in a scratch repo (git 2.50.1): with the
branch rebased onto an advanced `main`, force-pushed, and the clone not fetched
since, `git worktree add --detach <path> origin/<branch>` landed on the
pre-rebase `c774756` and printed its subject unchanged by the rebase, while
`git ls-remote origin refs/heads/<branch>` read the true tip `62ba798` from
that same unfetched clone. **Re-reading `headRefOid` on a settle window does
not reach that half at all** — it fires only where the two disagree — which is
why the operand changes here rather than the verdict gaining a window.

**A mismatch is usually one `git fetch origin` old, so `git worktree remove
--force <path>` first, then fetch and re-create once before reporting it.**
`git worktree add --detach <path> origin/<branch>` resolves the LOCAL
remote-tracking ref (measured above), so the ordinary cause is this clone's
own staleness, and re-creating after a fetch costs seconds where the refusal
costs a dispatch. **Bounded at one retry**: still unequal after the fetch →
refuse and report, because the second reading is a push that landed while
you worked, or a ref this clone cannot resolve, and neither gets better with
more waiting.

`review-core.mjs` refuses a snapshot whose head is not the branch ref's, so the
review path is backstopped — except when the operand comes back
empty, which skips the compare rather than refusing on it. A same-repo PR
still reads `refs/heads/<branch>` first and falls back to
`refs/pull/<number>/head` only when that comes back empty; a cross-repo PR (a
fork) skips the branch-ref read entirely and goes straight to the pull ref,
because a fork's branch NAME can collide with an unrelated branch the base
repo already carries under that name — so a fork PR now gets this
operand populated in the ordinary case, and the skip is rare rather than the
norm for forks. Its run log names the skip: `head ref (absent): head check
SKIPPED`. A worktree you hand to an agent directly is not backstopped at all.
Verify here anyway. **That backstop now compares against the same ref this
bullet does** — it moved its operand off `headRefOid` for the reason
above — so it is a second
chance to notice a stale snapshot on the one path it covers, never a reason
to skip the ref compare here.

## Filesystem isolation is not stack isolation

Private copy and test command solve different problems; conflating them is how second gets skipped: compose project name comes from environment, not working directory, so three agents on three snapshots still collide on one postgres. Symlinking installed dependencies in does not help. "I'm on my own copy" is exactly the intuition that skips command — say both, every time. Which command depends on audience: member in worktree uses `./agent-test`; specialist on snapshot does not, takes one `review-and-fix.md` hands out. Which runner the worktree holds decides why: the runner a claim writes is untracked, so a `git archive` snapshot never carries it; one the repository tracks does ride along, but no claim exported ports into it — its isolation is whatever that repository built, not one triple per snapshot.

## Scratchpad paths need two levels — the member's own partition, then one directory per child it dispatches

One flat namespace, generic filenames (`b.min.js`, `probe.mjs`) — one agent overwrote sibling's `package.json`. And finding ids restart at 1 every review, so two fix-appliers on different PRs both reach for `unv1`. Two levels, and nothing outside them — a probe built a git repo at the *checkout root*.

The axis is two-sided: the member partitions, and the parent assigns each child's path. `<scratch>` itself is assigned, never invented: the controller resolves it with `scratch-root.mjs` and writes the absolute path into each member's prompt. A member owns one directory — `<scratch>/impl-<N>/` for an implementer, `<scratch>/pr<N>/…` on the review side — and every agent it dispatches gets a directory under that one, unique to that child and never shared, written into the child's prompt as an absolute path; a child never derives its own. The review side is already laid out this way: `review-core.mjs` makes the run root `<scratch>/pr<N>/run-XXXXXXXX/` with `mktemp` — it appends `pr<N>/` to the scratch root it is handed and refuses a scratch already ending in one, so a review runner is given the root, never `<scratch>/pr<N>` — then writes `<run>/<dim>/` into each specialist's prompt and `<run>/verify-<dim>/f<i>-l<j>/` into each refuter's. A fix-applier makes its own run root the same way — `<scratch>/pr<N>/fix-XXXXXXXX/` with `mktemp` — then resolves `<run>/<finding>/` to an absolute path for the refuter it dispatches on a suggestion; the bare `<scratch>/pr<N>/<finding>/` is not that path, since finding ids restart at 1 each fix-applier round too, and a later round on the same PR would reach for the same directory a prior round's refuter left fixtures in. An implementer's child gets `<scratch>/impl-<N>/<childName>/`, named after its dispatch name. Refuters are grandchildren, not members, which is why the member partition alone is not the rule: the agents that actually collided were ones no member rule reaches, and a parent-assigned path is what reaches them. Read from the object store at a pinned ref, write only under own path.

## The scratch root is computed, never invented and never recorded

No harness supplies a scratch directory to a member, so a member left to name its own
invents one — and the liveness read in **The tick's rows**, which looks at the files under the
directory a member's own prompt assigned it, then watches a directory nobody
else can find.

## IDE/harness diagnostics attribute by bare filename, with no path

Probe copies carry same filenames as real tree, so specialist's throwaway mutation surfaces as errors that read exactly like live worktree's — and line numbers can plausibly line up with real in-flight edits. Never relay diagnostic without reproducing it in that member's specific worktree (re-run the check that raised it — the typechecker, the linter — from there). Ran twice in one session: clean first time (sibling's probe), genuinely broken second. Telling implementer to chase phantom in file it is mid-rewrite on is expensive failure.

## Where the omp probes ran

Measured 2026-09-09 in a throwaway clone (`/tmp/fleet-probe`)
that never touched the real checkout.

## Claim, release and reap are unchanged on omp

**Claim, release and reap are unchanged on omp.** `claim-ticket.sh`,
`release-ticket.sh`, `reap.sh` and `inflight.sh` are git-native and operate on
the single shared ref store every worktree and the main checkout read and
write directly (**Phase 1**, the tick's reap, and `release-ticket.sh` under
**Failure handling**); nothing in omp's `task` model touches that
store, so none of the four scripts carries a dialect branch.

## A fleet member is never dispatched with omp's `isolated: true`

**A fleet member is never dispatched with omp's `isolated: true`.** Measured:
an isolated spawn builds its workspace under `~/.omp/wt/<hash>/m` — an APFS
clone (on this box), never a registered `git worktree` of the repo — and,
because `apply` defaults to `true`, its changes are patch-applied into the
**calling session's own cwd** the instant the spawn completes: a file an
isolated probe created there appeared as `?? probe-isolated.txt` in the probe
session's own cwd — which for an actual fleet run is the controller's main
checkout — not in the worktree the prompt named. That is the exact
silent-spill hazard this section exists to guard against, on by default, so
`isolated` stays unused for every member and `task.isolation.enabled` stays
off.

## A member's tree is the claimed worktree, addressed by absolute path

**A member's tree is the claimed worktree, addressed by absolute path.** An
`edit` header without the worktree prefix resolves into the main checkout,
where `member-write-guard` refuses it (**You read your instruments out of a
tree every member can write to** in SKILL.md). How a
member gets its cwd: the `task` tool's item schema — `name`/`agent`/`task`/
`outputSchema`/`schemaMode` always, `effort`/`isolated` only when their own
settings enable them — carries no working-directory field; measured
directly: a member dispatched through it with none of those fields, told
only to report `pwd`, returned the calling session's own cwd, not the
claimed worktree, the same output an un-`cwd`-set `bash` call gives from
that session, so the recipe is the dispatch-prompt absolute path, plus
`bash`'s own `cwd` parameter set to it on every call and absolute paths for
`write`/`edit`.

## `task` does not accept a per-dispatch working directory

**The one open gap that probe measured: `task` does not accept a per-dispatch
working directory.** `omp://tools/task.md` documents non-isolated spawns as
running `runSubprocess(...)` "directly with parent cwd" — no `cwd` field
appears anywhere in the item schema — and the probe above confirms it in
practice: the recipe is the absolute-path discipline above, not a placeholder
for a `cwd` field that does not exist. The gap is now enforced rather than only
written down: the plugin's `member-write-guard` omp extension
refuses a fleet member's `write`/`edit`/`ast_edit` into the main checkout's
non-ignored tree and an implementer's `bash` from a main-checkout cwd, and the
missing field itself is requested upstream in `can1357/oh-my-pi`.

## `task`-dispatched members share one `eval` kernel

**The same gap reaches past the filesystem: `task`-dispatched members share one
`eval` kernel.** Measured 2026-09-21, in a live run rather than a
probe clone: two sibling implementers dispatched in the same batch, and the
controller that dispatched both, reported the same Python kernel pid and the
same runner file under `$TMPDIR/omp-python-runner/`, and each read the others'
top-level bindings out of its own `eval` cell — a bare `WT` bound by one member
was read back by a sibling and by the controller, the collision a ticket was filed
on as an unproven self-report. `omp://tools/eval.md` states the mechanism:
retained kernels are keyed by `python:${sessionId}`, normalized cwd and
interpreter — `js:${sessionId}` for the JS VM — and "Parent and ordinary task
subagents may share an inherited eval executor id; children created by eval's
own `agent()` explicitly do not." Neither key component separates two members
of one run: the session id is inherited from the controller, and the cwd is the
main checkout for all of them, because `eval`, unlike `bash`, takes no `cwd`
parameter to set. So the absolute-path discipline above is load-bearing inside
`eval` too, and it needs one rule `write`/`edit` do not — member-prefixed
binding names, since a shared global has no path to be absolute about. The
corollary is `reset`: it "is likewise destructive to concurrent work sharing
that backend session", so a member resetting its own kernel resets every
concurrent sibling's. No per-dispatch knob turns any of this off: `task`'s item
shape carries no kernel, executor or cwd field, and `python.kernelMode` set to
`"per-call"` — the one documented lever that would hand every call a fresh
kernel — is a session setting a child inherits, not something one dispatch can
set for one member. Isolating a member's kernel is an omp-side change, so
discipline is the whole of the remedy here — unlike the missing `cwd` field
above, which `member-write-guard` enforces for `write`/`edit`/`ast_edit` and
`eval` bypasses. **Dispatching the Pull's member** carries all three rules to every member.

## `release-ticket.sh` is not a no-op on omp, and a running member hides nothing from `inflight.sh`

**`release-ticket.sh` is not a no-op on omp, and `inflight.sh`'s probes are
unaffected by a running member.** Measured against a hand-built claim (a
branch plus a `git worktree add`) with a member sleeping inside it: a `bash`
call with `cwd` set to the worktree, and a non-isolated `task` spawn told to
work there, both operate inside the existing worktree and leave `git worktree
list` unchanged — they coexist with the claim rather than duplicating it. An
isolated spawn is architecturally blind to the worktree — its relative writes
land in its own `~/.omp/wt/…` workspace regardless of the prompt — but it
neither removes nor hides the claim, and `~/.omp/wt/` was empty after every
isolated run: omp's own teardown touches only omp's own workspace, never the
claim. `release-ticket.sh`'s three-artifact teardown (label, worktree, branch)
is therefore still necessary. With the member live inside
the worktree, `git worktree list` and `git branch --list` from the main
checkout reported the claim unchanged before, during and after — `inflight.sh`
hides nothing from omp.

## The controller's own cwd stays the main checkout

Nothing in the dispatch recipe above — the cwd recipe, the
isolated-workspace measurement, or the teardown scoping — moves
where the controller itself runs from.

## A pattern kill reaches siblings

**A pattern kill reaches siblings — the implementer, fix-applier and finisher briefs forbid it.** `pkill -f
  <pattern>` matches on the whole command line, machine-wide. Members hold
  separate worktrees, but the process table is not partitioned by them and a
  test file's name is identical in every one, so a pattern naming a test file
  matches whichever member happens to be running it. Measured: an implementer
  chasing its own stalled run issued a `pkill -f` on its test file's name and
  killed a `node --test` over two test files that was not
  its own.

## What a killed run's output looks like depends on the signal

**What the victim's output looks like depends on the signal — and one of the
cases is a clean green.** Each measured on node v26.8.1/darwin against a
purpose-spawned fixture killed by its own PID. `pkill -f` **defaults to
SIGTERM**, and a SIGTERMed runner prints `Interrupted while running:` followed
by a *complete* summary block with `cancelled` non-zero, exiting `rc=1` — so
`cancelled` is exactly the thing to search for in the default case. `pkill -9
-f` leaves no summary block at all and the shell reports `rc=137`: SIGKILL
means the harness never lived long enough to report. A kill landing on one of
node's per-file **child** test processes leaves a complete block with `fail`
non-zero and `cancelled 0` at `rc=1`, indistinguishable from an ordinary test
failure. And a kill landing on a process a **test itself spawns** leaves a
complete `pass N / fail 0 / cancelled 0` at the expected N over a corrupted
run: `spawnSync` reports a SIGKILLed child as `status null`, and a test
asserting only that the process it spawned exited non-zero —
`assert.notEqual(r.status, 0)`, a form used across this suite, in files that
spawn the shell scripts they cover — passes vacuously on `null`.

## The command line is no partition either

**The command line is no partition either — not reliably.** Ports are derived
per issue precisely so collisions are impossible; argv isolates a run only
sometimes. Measured with `ps -Ao pid,ppid,args -ww` (without `-ww` macOS `ps`
truncates, and the truncation reads as an absence): an invocation carrying an
**absolute** path puts a member-unique string in argv, while one carrying
repo-relative filenames is byte-identical across members. Which of the two you
get is not yours to choose — members are briefed on `./agent-test` with the
arguments the Test entrypoint takes, and the runner hands them on exactly as
its caller's shell expanded them. Clearing your own leftover process needs its
PID, not a pattern.

## Do not guess the victim — the blast radius is the machine, not the Pull

In the `pkill -f` incident "A pattern kill reaches siblings" measures, the controller reasoned from dispatch scope to "almost
certainly `impl-<N>`" and told the maintainer so; the named member then proved
it was not the victim (it had never invoked those files standalone, and its
mutation baselines post-dated the window). Idle members of *previous* runs,
other omp sessions on the same machine, and the maintainer's own shell are
all `pkill -f` targets and none of them appear in your ledger.

## A warning acted on silently is indistinguishable from one that never arrived

The same `pkill -f` incident: the controller's warning DID reach the member,
which re-ran, found nothing changed, and said nothing — correctly reading
"send once, never re-send" as covering it. The controller then had to spend a
round trip asking whether its own outbox was lossy. So the briefs say that
**confirmation state includes warnings received and acted on, even
when the outcome is no change** — one line, in the report the member already
owes. That is the cheap half of the *never read silence as assent* rule, paid
by the member rather than by the controller's guesswork.

## Specialist tree isolation is `review-and-fix.md`'s job

It owns the object-store rule, the two-tree split, snapshot provisioning, and
which suites a snapshot cannot validly run. Your only duty is to *not*
contradict it.

## Every brief carries the absolute scratch path

`<scratch>` in this file is the path it prints, resolved before you send anything: every
brief that carries one carries the absolute path you passed it — an
implementer's `<scratch>/impl-<N>/`, the recipe deriver's
`<scratch>/derive-recipe/`, a fix-applier's, a finisher's and a merge bot's
`<scratch>/pr<N>/…`, and a review runner's `scratch` argument, which is the
root itself. A member whose prompt names no path asks you by name and never
makes one up.
