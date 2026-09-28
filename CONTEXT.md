# Fleet Plugin

The **fleet**: scripts, skills, commands and agents that run parallel agents against
a repo's issue tracker, packaged as an omp.sh plugin. This glossary covers the
vocabulary those artefacts share; it is a glossary only, not a spec.

## Language

### Harness

**Harness**:
The agent environment the fleet is loaded into — omp.sh. A fleet artefact
that names another harness's tools is a defect.
_Avoid_: host, platform, client, runtime

### Platform

**Platform**:
The operating system the fleet's scripts run on — macOS, Linux, or Windows via WSL.
Native Windows is not a platform (ADR 0009). Independent of **Harness**. An
artefact that works on only some platforms is a defect.
_Avoid_: OS, host, environment

### Runtime

**Runtime pin**:
The exact node version `.nvmrc` holds — the runtime this repo's own suite is
developed and verified against in CI. It makes no promise to a consumer; that is
the **Consumer floor** (ADR 0010).
_Avoid_: supported version, minimum node, node version (bare), runtime (bare)

**Consumer floor**:
The oldest node the shipped scripts support under a consumer's own `node`,
declared in the root `package.json`'s `engines.node`. The compatibility statement
the **Runtime pin** (ADR 0010) is not.
_Avoid_: pin, required version, engines (bare)

### Claim lifecycle

**Claim**:
A ticket taken by a fleet member, represented by three artefacts together — a branch, a
worktree, and the in-progress label on the issue.
_Avoid_: lock, reservation, assignment

**Release**:
Returning a claim so the ticket reads as free again: the worktree gone, the branch
deleted, the label dropped.
_Avoid_: unclaim, close, clean up

**Reap**:
Deleting branches whose upstream is gone, and their worktrees, after each merge pass.
Distinct from Release: a reap follows a merged PR, a release follows a claim that never
became one.
_Avoid_: prune, cleanup

**Registration**:
Git's record that a directory is a worktree of this repo. Independent of whether the
directory itself exists — either can outlive the other.
_Avoid_: entry, admin dir

**Orphaned worktree directory**:
A claim's directory still on disk with its registration already cleared. Invisible to
any check that reads git's registry.
_Avoid_: stray, leftover, ghost

**Stray**:
A registered worktree matching this claim's directory name but not on the claim's
branch. A registry-visible condition — never an Orphaned worktree directory, which by
definition has no registration to be seen through.

### Consumer repo

**Recipe**:
The pair of commands the fleet needs about the repository it works on — its Install
step and its Test entrypoint — derived by agent reasoning over that repository, never
by a table of technologies the plugin knows (ADR 0015).
_Avoid_: config, manifest, detection, project type

**Install step**:
The command that materialises the repository's dependencies in a fresh worktree.
Usable only once it has run there and left every tracked file unchanged.
_Avoid_: install, setup, bootstrap

**Test entrypoint**:
The command that runs the repository's own suite. Usable only once it has been run
and shown to execute real tests — a non-zero count, or a deliberate mutation turning
it red; `tests 0` is a failed run.
_Avoid_: test command, runner, testCmd

**Recipe cache**:
The fleet-state record of a proven Recipe, carrying the commit it was derived at and
the proof. Read by scripts, written only by the agent that proved it; absent means
"derive", never "infer". Invalid when a command fails to run, not when tests fail.
_Avoid_: declaration file, fleet.json, lockfile

### Release outcome

The state of a claim's worktree after a release attempt. Named states, because the
distinction between the middle two is what an operator's next action turns on.

**Unreleased**:
Registration and directory both still present. Nothing landed.

**Deregistered**:
Registration cleared, directory still on disk. Something landed; the claim is
Partially released.

**Released**:
Registration and directory both gone.

**Indeterminate**:
The probe could not establish which state holds — typically an unsearchable parent
directory. Distinct from Unreleased: nothing is known, rather than nothing happened.
_Avoid_: unknown, failed

**Partially released**:
A release attempt in which at least one artefact was removed before a later step
refused. Reserved for that case — a run that refuses before removing anything is not
partially released, and neither is one that could not measure what it did.
_Avoid_: half-released, incomplete release

### Merge gate

**Merge gate**:
The repository **ruleset** on the default branch — its required contexts plus
strict currency — and never the CI that feeds it: CI produces signals, the gate
consumes them. Governed by ADR 0007, declared in `.github/rulesets/main.json`,
and applied only by `.github/scripts/apply-ruleset.sh`, which proves the write by
re-reading it. A claim about the gate sourced from anywhere else is unverified.
The spec is the **declared** gate and the live ruleset the **enforced** one, and
they diverge from the moment a spec change merges until someone with repository
admin applies it (#1710) — so a claim about what merging requires is a claim
about the declared gate unless `apply-ruleset.sh --check` has just exited 0.
_Avoid_: branch protection, protection rule, CI gate

**Currency**:
A branch whose merge-base with the base branch *is* the base tip. The property
`rebase-check` measures and `strict_required_status_checks_policy` enforces at the
merge button. Distinct from mergeability, which tolerates being behind.
_Avoid_: up to date, fresh, rebased

**Stale green**:
A required check that passed against an older base tip and still reads green.
Inert since ADR 0007 — the gate refuses the merge on currency directly, rather
than waiting for a workflow to flip the colour back.
_Avoid_: false green, cosmetic green

### Triage

**Review deferral**:
A ticket capturing a follow-up deferred from a prior PR review. Age carries no
signal about tree state; its premises must be verified against `origin/main`
before triage.
_Avoid_: deferred finding, follow-up

**Remedy-open**:
A defect whose existence is verified and whose fix is not yet chosen. The state
the filing-time label bar turns on.
_Avoid_: undecided, unclear

### Install

**Install root**:
The directory omp actually loaded the plugin from, as recorded in its own
registry. Never the checkout, and never a path any artefact may write down: it
is version- or commit-stamped and changes on every install.
_Avoid_: cache dir, plugin dir, install path

**Resolver**:
The shipped executable that maps a script name to the Install root and execs it there.
The single door between prose and code — a callsite naming any other path is a defect.
Placed once by hand outside the plugin, because it cannot resolve itself. Reads
omp's own registry and nothing else.
_Avoid_: shim, wrapper, launcher

**Provenance check**:
The assertion naming the live Install root, its recorded version or commit, the
Resolver's own drift against the installed copy, and the `enabledProviders`
precondition. Refuses loudly; writes nothing.
_Avoid_: doctor, healthcheck, preflight

**Dev catalog**:
The untracked marketplace outside the repo that pins a local branch of the working
checkout, so pre-merge iteration never edits the tracked catalog. Distinct from the
tracked catalog, which names the shipped branch and nothing else.
_Avoid_: local marketplace, dev source

**Install-time precondition**:
An omp setting the fleet depends on, set once by the operator at install and never
written by a run — a run that wrote one would be changing every other session on the
machine to dispatch its own members. Two exist, both session-wide:
`enabledProviders: ["claude-plugins"]` (omp's provider name for marketplace
plugins — not a Claude artefact), and `modelRoles.slow|task|smol` pointing at
models this install has, the fleet's tier routes (ADR 0011, ADR 0014). ADR
0003 point 8 carries the first's required value, its global and
project-scoped set paths, and the read that verifies it; `tier-roles.mjs
--check` is the read that verifies the second.
_Avoid_: requirement, dependency, flag

### Coordination

**Dispatch**:
Starting a fleet member — a fresh agent under a new identity, never a resumed
one. The controller-to-member vocabulary fixed on #1316.
_Avoid_: spawn, `Agent(...)`, `task`

**Send**:
Messaging a live member — `hub send`.

**Wake**:
A Send that resumes a finished member's transcript. Forbidden for a refill: a
finished member gets a new member under a new name, never a Wake back into
its old one.
_Avoid_: resume, re-task

**Settle**:
A member's job reaching a terminal outcome — `completed`/`failed`/`cancelled`.
Distinct from the member's liveness, which is a separate axis
(`running`/`idle`/`parked`).
_Avoid_: complete, truncated

**Consume**:
The controller deliberately reading and reconciling a settled result —
results auto-deliver, so the discipline is reconciliation, not retrieval.
_Avoid_: return value, retrieve

**Liveness mark**:
The RUN's liveness, not a member's — `beat` in the heartbeat's shared state
file, written only by `fleet-heartbeat` and carrying when the beat was last
seen, the interval in effect at that moment, and a deliberate stop's reason
when `--stop` recorded one. Deliberately not spelled "liveness" bare: that
word already names a member's process axis under Settle above, and the two
are different subjects — one member can be idle while the run beats, and the
run can be dead while a member's process still exists.
_Avoid_: liveness (bare), heartbeat state, pulse

**Stall report**:
What a reader says about a stale or stopped Liveness mark — when the beat was
last seen, how overdue it is against the interval that mark recorded, how many
tickets are still claimed and in flight, and whether the pool still has
supply. Detection only: naming a stall neither releases the stranded claims
nor restarts anything.
_Avoid_: dead-run warning, stale banner

### Loop

**Shortlist**:
The ordered list of tickets the controller may admit — every open `ready-for-agent`
ticket that survives the cheap filters, oldest first, built in one scan and refreshed
at a low-water mark rather than on empty. Selection is batched here; admission never
is.
_Avoid_: queue, pool, staging, backlog, wave

**Pull**:
Admitting one ticket into one free implementer slot the moment it frees: the Shortlist
head is read, judged, claimed and dispatched — or relabelled by cause, or excluded, and
the next entry tried. The only unit of supply; there is no batch admission and no human
decision per admission.
_Avoid_: refill, stage, batch, wave

**Exclusion**:
A ticket the controller has ruled inadmissible for now, recorded with its premise — the
open PR it collides with or the open issue it sequences after — and skipped until that
premise closes, when it re-enters the Shortlist in its own order.
_Avoid_: demotion, deferral, skip, hold

**Pass**:
One merge bot's lifetime: dispatched on the first `ready-to-merge` label, it merges
every labelled PR one at a time, re-evaluating after each, waits a short grace for late
labels, reports once and exits. A label seen after the exit starts a new Pass under a
fresh name.
_Avoid_: wave, batch, cycle, round

**Exploration Pull**:
A Pull whose implementer cell is drawn rather than dispatched at the
policy cell — every 5th `impl-` row by ledger count (every Pull, during
the router's burn-in). Recorded as `exploration_draw = <k>/<K>` in
`ticket-features.tsv`; the member is never told.
_Avoid_: alt-tier, A/B pull

**Exploration draw**:
The pure function (`drawCell`) that picks a cell uniformly from the
eligible cells on an Exploration Pull — deterministic from the session id
and ticket number, no RNG, no seed.
_Avoid_: random draw, coin flip

### Tier

**Declared tier**:
The agent file's own frontmatter `model: "@<role>:<level>"` — a fleet tier
route with an explicit level; what the file says, version-controlled, and
the only intent this port records — no dispatch-time ledger entry
duplicates it.
_Avoid_: recorded intent, dispatch-time intent

**Resolved tier**:
What omp wrote about the member after dispatch: `session_init.resolvedModel`
identity plus the `thinking_level_change.thinkingLevel` event — never the
`:suffix`, which is absent when resolution came from an agent's own
frontmatter rather than a `modelRoles` alias.
_Avoid_: effective tier, actual model

**Tier route**:
What turns a Declared tier's alias into a model — the operator's
`modelRoles.<role>` entry (`slow`/`task`/`smol`), never a vendor id in the
definition; no per-agent override record exists (ADR 0014).
_Avoid_: mapping, override, translation

**Cell**:
An implementer routing target, `<role>-<level>` — a Declared tier scoped
to the exploration grid and the Router below. One definition per cell
(`plugin/agents/fleet-implementer-<cell>.agent.md`, five cells — pending
`#2129`, not yet built); never a vendor model name in any cell token,
definition, or prose.
_Avoid_: tier (bare), alt-tier, model

**Router**:
The checked-in table (`router-table.json`) plus the script that reads and
fits it (`ticket-router.mjs`) — pending `#2131`, not yet built — mapping a
ticket's stratum to a Cell. Not a dispatched member — no `fleet-router`
agent definition exists; sizing a ticket for the table is one `judge()`
call in the controller's own eval.
_Avoid_: fleet-router, sizer

**Admissible row**:
A per-cell readout row whose Resolved tier matched its Declared tier and
whose recorded effort equals its cell's level — the only rows the
per-cell stopping rule and readout script (`cell-readout.mjs`, pending
`#2133`/`#2134`, not yet built) count.
_Avoid_: verified row, valid row
