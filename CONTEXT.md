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
became one. Scratch is not reaped; see **Reclaim**.
_Avoid_: prune, cleanup

**Reclaim**:
Removing what a run left under its scratch root once nothing can still want it: a
merged or closed PR's `pr<M>/` and disposition records, a closed ticket's `impl-<N>/`,
and anything else idle past 7 days with no live member's name on it, and each sibling
key (another key-shaped directory beside this run's, under the scratch parent) idle past
7 days. Authorized on GitHub state and age, by `reclaim-scratch.mjs` (ADR 0029) — never
on git evidence, which is Reap's.
_Avoid_: reap, prune, cleanup

**Upstream**:
The remote-tracking ref a claim's branch tracks. There is none at claim time
(`--no-track`); the member's first `git push -u` sets it. It decides liveness only:
Reap selects a branch whose upstream reads `[gone]`. It is never a delete-safety input;
every branch-delete guard measures against the fully qualified base (ADR 0018).

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

**Registration probe**:
The one place the fleet's shell scripts ask git about a worktree before they delete
one, delete a branch, or read an absence as free — `worktree.sh`, sourced, never
copied. Each verdict returns a status and a reason; the caller decides what a refusal
means for it. Its verdicts:
- **Recount** — the registry entries on disk counted against the linked worktrees git
  listed, re-taken before a disagreement is believed. A listing that dropped an entry
  cannot be trusted for any absence.
- **Linkage** — whether a worktree's `.git` answers for that directory itself, rather
  than for another tree it was redirected or symlinked to.
- **Lookup** — which worktree holds a given branch, read off a listing the Recount
  validated; a scan that could not finish is never "no worktree".
- **Cwd guard** — whether removing a worktree would delete the caller's own working
  directory.
- **Release outcome** — which named state a removal left behind (below).
_Avoid_: worktree check, registry guard, linkage check helper

### Consumer repo

**Recipe**:
The commands the fleet needs about the repository it works on — its Install step,
its Check step and its Test entrypoint — derived by agent reasoning over that repository, never
by a table of technologies the plugin knows (ADR 0015).
_Avoid_: config, manifest, detection, project type

**Install step**:
The command that materialises the repository's dependencies in a fresh worktree.
Usable only once it has run there and left every tracked file unchanged. The claim,
the Recipe proof, the review snapshot and the standalone claim in the next-ticket
skill run it with `CI` unset, so a setup script that skips under `CI` still
installs there.
_Avoid_: install, setup, bootstrap

**Check step**:
The command that runs the repository's merge-gating CI checks that are not tests, as
one step. Usable only once it has run green there and a deliberate mutation turns it
red; `true` when the repository's CI has no such check, which needs no proof of its
own. A check red on `origin/main` is not part of it.
_Avoid_: lint, format, static checks

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

**Check-step record**:
A member's own record, written by `recipe-check.mjs` beside its report, that the Check
step and the Test entrypoint both exited 0 on the tree it staged. Keyed to the tree,
not the commit, so a message-only amend keeps it and a content change or rebase does
not. Settle requires it of an implementer's and a fix-applier's report. The member
produced it, so it is a claim, not an attestation.
_Avoid_: test receipt, green stamp, CI record

**Valid green**:
A test run that completed — the command returned on its own, with no signal and no
timeout, deadline or kill having fired — with exit 0, `tests` above 0 and `cancelled` 0.
A summary line alone is not one; neither is a run cut short.
_Avoid_: green, passing run

**Valid red**:
A test run that completed, in which the test the claim names is reported failing.
An exit ≠ 0 with no failing test is not red, and neither is a different test
failing. A red in the full suite only triggers a narrowed run — the Test entrypoint
with arguments appended, counted only when it reports `tests` above 0 and names the
test — and is never evidence on its own.
_Avoid_: red, failing run, non-zero exit

**Kill**:
A mutant producing a Valid red in a narrowed run, plus a Valid green with the named
test passing on the same narrowed command in the same tree with the mutant reverted.
Anything short of both — the red not reproducing, the unmutated tree red too, no
usable run — is inconclusive, never a kill.
_Avoid_: reddened, caught, exit 1

**Unrun dimension**:
A dispatched specialist that returned nothing, even after the review's in-run retry.
It reviewed nothing, so its lack of findings says nothing about the code. It is named
in the review's `dimensionsUnrun`, and the state of the test suite never makes a
dimension unrun.
_Avoid_: skipped dimension, uncovered dimension

**Suite verdict**:
The review's single judgement on its shared test run. The run is usable when it
executed real tests and its exit status is explained by its counts. Otherwise it is
not usable, and the verdict gives the reason, which includes a run that never started
(install skipped, or no suite slot). Usable does not mean green: a usable run can have
failing tests. The verdict says nothing about whether any dimension reviewed.
_Avoid_: test status, run quality

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

**Expected jobs**:
The CI jobs a PR's bound run must carry for `ci-state.mjs` to read it green:
**H ∪ (D ∩ required)**, where H is the job ids of the CI workflow at the PR's
head commit, B those at its base commit (`baseRefOid`), D = B − H the jobs the
PR drops, and *required* every status-check context the base branch's rulesets
or classic branch protection still require. Both workflows are read at those
commits, never from the caller's working tree. A PR may drop a job only once no
human-owned rule still requires it; jobs it adds are covered because every job
the run reports must succeed. Applies the **Merge gate** to the tooling (#2332).
_Avoid_: required checks (that is *required* alone), the job list

**No-undo audit**:
`no-undo-audit.sh`, run by the merge bot before a rebase: it refuses a dirty
worktree, previews the rebase's conflicts, and names what `main` gained in the
conflicting files since the branch forked — the work a careless resolution
would eat. It sees only what conflicts, so a deletion that replays cleanly is
outside it; that is the **Main gain** check's.
_Avoid_: rebase audit, conflict audit

**Main gain**:
A line on `main` that landed there — by `git blame --first-parent` on
`origin/main`, its landing commit's committer date — after the PR's reference
point R, the earliest author date among the PR's own commits. A main gain the
PR's merge would remove is a hit: `merge-gate.mjs` — the merge bot's
pre-merge conjunction, not the **Merge gate** ruleset — refuses it as
`main-gain-removed:<path>` until it is undone or
acknowledged in the PR body as `main-gain-removal: <path> <key> - <why>`, a
second sign-off scoped to one file and one landing source (ADR 0023). The
post-rebase counterpart of the **No-undo audit**.
A hit's removed lines each carry a `kind`: `modified` when the hunk that removed them also adds lines, `deleted` when it only removes them. A removed line edited in place that keeps every token of its text is not a hit.
_Avoid_: lost work, reverted lines, regression

**Rebase-carry**:
A PR head that moved after `ready-to-merge` and still carries the labelled
head's net change: its diff against its own merge base with `origin/main` is
byte-identical to the labelled head's, except for each hunk header's line
numbers and function context and a text file's blob ids, and the labelled head
merges onto the moved head's own merge base into exactly the moved head's tree.
`merge-gate.mjs` proves it from git objects in the
main checkout and accepts the head with the label kept, naming both SHAs in
`rebaseCarry`; any head it cannot prove is `head-moved-after-label` (ADR 0024).
_Avoid_: clean rebase, patch-equivalent, same patch

### Triage

**Review deferral**:
A ticket capturing a follow-up deferred from a prior PR review. Age carries no
signal about tree state; its premises must be verified against `origin/main`
before triage.
_Avoid_: deferred finding, follow-up

**Remedy-open**:
A defect whose existence is verified and whose fix is not yet chosen. Filed
`needs-triage`, like every issue the plugin creates; triage, not the filer,
decides when its remedy is settled enough for `ready-for-agent`.
_Avoid_: undecided, unclear

### Install

**Install root**:
The directory omp actually loaded the plugin from — the realpath of its
`node_modules/@feigi/fleet-ctl` package entry, the one path every install kind
(marketplace, link, npm) places. Never a path any artefact may write down:
it is version- or checkout-dependent and changes across install kinds.
_Avoid_: cache dir, plugin dir, install path

**Resolver**:
The shipped executable that maps a script name to the Install root and execs it there.
The single door between prose and code — a callsite naming any other path is a defect.
Placed once by hand outside the plugin, because it cannot resolve itself. Reads
omp's extension package layout and nothing else.
_Avoid_: shim, wrapper, launcher

**Provenance check**:
The assertion naming the live Install root, its install kind and recorded version,
and the Resolver's own drift against the installed copy — with a NOTICE when the
root is a linked checkout, since then every answer came from the dev tree.
Refuses loudly; writes nothing.
_Avoid_: doctor, healthcheck

**Pre-flight**:
The check set run-team runs at the start of phase 0 (`preflight.mjs`) — what this
machine and the consumer repository must have before anything is shortlisted or
dispatched: the binaries, `gh` auth, `origin/main`, the ignore rules, the labels,
the repository settings, the Resolver. A pass is remembered in `.fleet/preflight.json`,
keyed to a hash of the check set. It checks the machine and the repository, never
the install — that is the Provenance check.
_Avoid_: doctor, healthcheck

**Dev link**:
`omp plugin link <checkout>/plugin` — the working checkout registered as the
box's live plugin, so pre-merge iteration edits reach a fresh session with no
reinstall. It outranks every installed copy of the same names until
uninstalled, so it belongs on the dev box only.
_Avoid_: dev catalog, local marketplace, dev source

**Install-time precondition**:
An omp setting the fleet depends on, set once by the operator at install and never
written by a run — a run that wrote one would be changing every other session on the
machine to dispatch its own members. One exists, session-wide:
`modelRoles.slow|task|smol` pointing at models this install has, the fleet's tier
routes (ADR 0011, ADR 0014, ADR 0021). The former `enabledProviders` gate retired
with the marketplace install route: omp exempts its own installs from it since
18.2.1, and the native package route never used it. `tier-roles.mjs --check` is
the read that verifies the one that remains.
_Avoid_: requirement, dependency, flag

### Shipped surface

**Shipped surface**:
Everything under `plugin/` — the package `files` list ships it whole, so every
file there reaches a consumer's install, comments and runtime strings included.
It names nothing that does not ship: no issue or PR
number of this repo in any form, no foreign tracker number, no repo-internal
`docs/adr`, `docs/specs`, `docs/research`, `docs/agents` or `docs/requirements`
path, no ADR number, no test-file name — it states the claim instead, and
provenance lives
in git history (ADR 0019). `tests/`, where the suite and its support modules
live, is not part of it and the rule does not apply there.
_Avoid_: package, bundle, distribution

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

**Alarm**:
The turn an in-process omp extension starts in an idle controller when its beat
falls due: an ordinary user message marked `[fleet-alarm]` that tells the
controller to run `fleet-event.mjs heartbeat`. It fires only when the session is
idle, never queues, and is inert in a member's session. Not a Wake, which
resumes a finished member.
_Avoid_: ping, timer

**Scratch root**:
The one directory per repository that every fleet member's throwaway files live
under — `~/.fleet/scratch/<repo-key>/`, `<repo-key>` being the workspace's folder
name (a trailing `.git` dropped from a git dir's name), a dash and the first 8 hex characters of the sha256 of its realpath.
Computed by `scratch-root.mjs`, never recorded and never injected by a harness:
the controller writes an absolute path under it into every Dispatch, and a
member never builds a root of its own.
_Avoid_: scratchpad, `/tmp` dir, `.fleet/scratch`

**Suite slot**:
One of N exclusive pid-stamped lock files, `~/.fleet/suite-slots/<i>.lock`, that
bound how many full test-suite runs the host executes at once (N is 2 unless
`FLEET_SUITE_SLOTS` says otherwise). Taken by `suite-slot.mjs` for a run with no
arguments and held until it ends; a narrowed run (arguments appended) takes none,
and a wrapper inside a held slot (`FLEET_SUITE_SLOT` set) takes no second. A
waiter takes over a dead holder's slot. A wait that outlasts `FLEET_SUITE_WAIT_S`
exits 75 having launched nothing — not a test result.
_Avoid_: test lock, test slot, semaphore (bare), CPU slot

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

**Controller record**:
The proof of a run's death that the Liveness mark cannot give — `controller`
in the heartbeat's shared state file, written only by the ledger rotation at
phase 0: the omp process that owns the run, its start time, when it was
written, and as `prior` the verdict the rotation reached on the record it
replaced (dead, ancestor or none). Dead means the process is gone or its
start time no longer matches. Where a record exists, only it gates an
action; no record proves nothing.
_Avoid_: pid file, lock, owner

**Stranded claim**:
A Claim a dead run left without a PR: its label and worktree outlive the run,
and nothing else holds it. Phase 0 resumes it under a new member when the
record's `prior` is dead and its worktree is in this checkout, and reports it
otherwise. A Claim with an open PR is not stranded — the fold-in owns it.
_Avoid_: orphan, abandoned ticket

**Stall report**:
What a reader says about a run gone quiet — a Liveness mark that recorded a
stop, or went stale with no recent tick or ledger write beside it, or a run with a Controller
record and no beat of its own whose latest tick, ledger write or record is past
the window — when it was last seen, how overdue that is, how many
tickets are still claimed and in flight, and whether the pool still has
supply — led by whose stall it is off the Controller record: controller alive,
controller gone, or unknown with no record. A mark older than the Controller
record is the previous run's and counts for nothing. Naming a stall acts on nothing;
Stranded claims come back through phase 0, never through the report.
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

**In flight**:
A ticket between its Claim and its PR's merge — an implementer live or owed a
replacement on it, or an open PR closing it. A PR closing nothing is never in flight.
_Avoid_: WIP, open work, backlog

**In-flight bound**:
The most tickets a run lets be In flight at once — fixed for the run, set by
`/run-team`'s one argument. Reaching it holds every Pull until a merge brings the
count below it; reviewers, finishers and the merge bot never slow for it.
_Avoid_: WIP limit, PR cap, throttle, backpressure, implementer cap, reviewer cap

**Pass**:
One merge bot's lifetime: dispatched on the first `ready-to-merge` label, it merges
every labelled PR one at a time, re-evaluating after each, waits a short grace for late
labels, reports once and exits. A label seen after the exit starts a new Pass under a
fresh name.
_Avoid_: wave, batch, cycle, round

**PR's row**:
The one ledger row that maps to PR M — the ticket row once `settle impl-<N>=PR#M`
has run, else `#M`. Every token about M lives there, its `review=`/`reviewed=`
record included (written only by `ledger.mjs review`), so the row's token order is
write order.
_Avoid_: `#M` row for a ticketed PR, review row

**Conflict hold**:
Any open PR the run tracks that GitHub reports CONFLICTING, or that a Pass would not
merge because its rebase conflicted and the merge bot will not force a resolution —
recorded as `conflict-hold:#<pr>` on the PR's own row by the merge bot, or by the
controller on the tick's `CONFLICT` line, and cleared only when a fix-applier
dispatched after it settles as landed. Merge-time, never claim-time: distinct from an
Exclusion, and from a `held-behind` hold, which waits on a lower PR rather than on a fix.
_Avoid_: exclusion, held-behind, blocked

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

**Ending**:
How one implementer dispatch finished, read from its own transcript: a PR,
a bail and its cause, a provider error or fallback model, an exhausted
request budget, an abort, a crash, or a Hollow yield. A PR is the Cell's
fault when it merged and was ruled failed; one closed unmerged counts as
spend only. Of the other Endings, a Hollow yield, an exhausted budget and
a `fixed` bail that origin/main refutes are the Cell's fault; any other
bail is the ticket's; a provider error or fallback model, an abort and a
crash are neither's, as is a dispatch that left no transcript. The
ledger's settle token (`=killed`, `=bailed`) is not an Ending.
_Avoid_: give-up

**Hollow yield**:
An implementer that ends its own turn with no PR and no valid bail report,
whatever its last message claims. The Cell's fault, unlike a bail, which
names its cause.
_Avoid_: silent bail, give-up

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
(`plugin/agents/fleet-implementer-<cell>.agent.md`); never a vendor model
name in any cell token, definition, or prose.
_Avoid_: tier (bare), alt-tier, model

**Router**:
The checked-in table (`router-table.json`) plus the script that reads and
fits it (`ticket-router.mjs`), mapping a
ticket's stratum to a Cell. Not a dispatched member — no `fleet-router`
agent definition exists; sizing a ticket for the table is one `judge()`
call in the controller's own eval.
_Avoid_: fleet-router, sizer

**Spend**:
What a Pull cost: the recorded `cost` of every member booked to it — each
implementer dispatched under it, at any cell, the review, fix and finisher
members of its PR, and every member nested under one of those. Merge-bot,
memory and advisor members and the Router's own sizing are no Pull's spend:
they cost the same whatever the Cell. A Pull with a booked member whose cost
went unrecorded is unpriced, never free.
_Avoid_: price, usd, cost (a member's figure, not a Pull's)

**Admissible row**:
A member-outcomes row whose `subagent_type` is `fleet-implementer-<cell>` for
the cell its Pull drew (`chosen_cell`), whose recorded effort equals that
cell's level, and which has a resolved model on record — the only rows the
readout script (`cell-readout.mjs`) and the per-cell stopping rule (its
exported `stoppingRule`, run by the repo-local hook) count. Whether the
Resolved tier matched the Declared tier is the run ledger's check; the readout
never makes it.
_Avoid_: verified row, valid row

**Ruling**:
The controller's verdict on one implementer PR, kept as that PR's row in
`docs/metrics/tier-outcomes.tsv`: whether the work closed its own ticket and
whether it minted a false claim. The Router counts a ticket as merged only
through its Ruling; a decision on an issue, or a reply owed to a member, is
not one.
_Avoid_: verdict row, tier outcome
